package world.brightos.brai.braicmd

import android.content.Context
import java.io.File
import java.io.IOException

internal enum class QueueTransportStatus {
    Drained,
    TransientFailure,
    Blocked
}

internal data class QueueTransportResult(
    val status: QueueTransportStatus,
    val failure: Throwable? = null,
    val failedTransportIds: Set<String> = emptySet(),
    val autoInsertTranscriptFile: String? = null,
    val fallbackUsed: Boolean = false,
    val provider: String = "",
    val model: String = "",
    val inboxDelivered: Boolean = false,
    val permanentFailureMessage: String? = null
)

internal class QueueTransportWorker(context: Context) {
    private val appContext = context.applicationContext
    private val client = NetworkClient(appContext)
    private var autoInsertTranscriptFile: String? = null
    private var fallbackUsed = false
    private var provider = ""
    private var model = ""
    private var inboxDelivered = false
    private var permanentFailureMessage: String? = null

    fun run(autoInsertAudioFileName: String?): QueueTransportResult {
        val items = (
            AudioQueueStore.list(appContext).map { PendingItem.Audio(it) } +
                ScreenshotInboxStore.list(appContext).map { PendingItem.Screenshot(it) }
            ).sortedBy { it.file.lastModified() }
        if (ConfigStore(appContext).authToken.isBlank()) {
            return result(
                QueueTransportStatus.Blocked,
                QueueAuthBlockedException(),
                items.mapTo(mutableSetOf()) { it.transportId }
            )
        }

        for (item in items) {
            if (!item.file.exists()) continue
            try {
                when (item) {
                    is PendingItem.Audio -> processAudio(item.file, autoInsertAudioFileName)
                    is PendingItem.Screenshot -> processScreenshot(item.file)
                }
            } catch (error: Throwable) {
                when (classifyQueueFailure(error)) {
                    QueueFailureDisposition.Transient ->
                        return result(QueueTransportStatus.TransientFailure, error, setOf(item.transportId))
                    QueueFailureDisposition.Blocked ->
                        return result(QueueTransportStatus.Blocked, error, setOf(item.transportId))
                    QueueFailureDisposition.Permanent -> {
                        val quarantined = when (item) {
                            is PendingItem.Audio -> AudioQueueStore.quarantine(appContext, item.file)
                            is PendingItem.Screenshot -> ScreenshotInboxStore.quarantine(appContext, item.file)
                        }
                        if (!quarantined) {
                            return result(
                                QueueTransportStatus.TransientFailure,
                                IOException("Не удалось переместить поврежденный элемент очереди"),
                                setOf(item.transportId)
                            )
                        }
                        permanentFailureMessage = permanentFailureMessage(error)
                    }
                }
            }
        }
        return result(QueueTransportStatus.Drained)
    }

    private fun processAudio(file: File, autoInsertAudioFileName: String?) {
        when {
            file.length() < MIN_AUDIO_BYTES ->
                throw QueueCorruptItemException("Запись повреждена и перемещена в карантин.")
            file.length() > NetworkClient.MAX_AUDIO_BYTES ->
                throw QueueCorruptItemException("Запись слишком большая и перемещена в карантин.")
        }

        val action = AudioQueueStore.action(file)
        val serverBound = InboxPayloadStore.isInboxPayload(file) || action.contextAction != null
        if (serverBound) {
            processInboxAudio(file, action)
        } else {
            processMainDictation(file, autoInsertAudioFileName)
        }
    }

    private fun processMainDictation(file: File, autoInsertAudioFileName: String?) {
        val response = client.uploadAudio(
            file,
            ConversationContextStore.read(file),
            ScreenshotContextStore.read(file)
        )
        val text = response.text.trim()
        if (text.isBlank()) throw QueueEmptyModelException()
        val transcriptFile = PendingTranscriptStore.add(
            appContext,
            text,
            PendingTranscriptKind.MainDictation
        )
        if (file.name == autoInsertAudioFileName) autoInsertTranscriptFile = transcriptFile.name
        if (response.fallbackUsed) {
            fallbackUsed = true
            provider = response.provider
            model = response.model
        }
        completeAudio(file)
    }

    private fun processInboxAudio(file: File, action: AudioQueueAction) {
        var transcript = InboxPayloadStore.readTranscript(file)
        if (transcript == null) {
            val response = client.uploadAudio(file, null, null)
            transcript = response.text.trim()
            if (transcript.isBlank()) throw QueueEmptyModelException()
            // Persist before Inbox delivery so retries never retranscribe a completed upload.
            InboxPayloadStore.saveTranscript(file, transcript)
        }
        client.uploadInboxCommand(
            transcript = inboxDeliveryText(action, InboxPayloadStore.readTextPrefix(file), transcript),
            conversationContext = ConversationContextStore.read(file),
            screenshotFile = ScreenshotContextStore.read(file),
            idempotencyKey = file.name
        )
        completeAudio(file)
        inboxDelivered = true
    }

    private fun processScreenshot(file: File) {
        if (file.length() <= 0L) throw QueueCorruptItemException("Скриншот поврежден и перемещен в карантин.")
        client.uploadInboxCommand(
            transcript = SCREENSHOT_INBOX_TEXT,
            conversationContext = null,
            screenshotFile = file,
            idempotencyKey = file.name
        )
        if (!ScreenshotInboxStore.delete(file)) throw IOException("Не удалось удалить отправленный скриншот")
        inboxDelivered = true
    }

    private fun completeAudio(file: File) {
        if (!AudioQueueStore.complete(file)) {
            throw IOException("Не удалось исключить отправленную запись из очереди")
        }
    }

    private fun result(
        status: QueueTransportStatus,
        failure: Throwable? = null,
        failedTransportIds: Set<String> = emptySet()
    ) =
        QueueTransportResult(
            status = status,
            failure = failure,
            failedTransportIds = failedTransportIds,
            autoInsertTranscriptFile = autoInsertTranscriptFile,
            fallbackUsed = fallbackUsed,
            provider = provider,
            model = model,
            inboxDelivered = inboxDelivered,
            permanentFailureMessage = permanentFailureMessage
        )

    private fun permanentFailureMessage(error: Throwable): String =
        when (error) {
            is QueueCorruptItemException -> error.message.orEmpty()
            is ServerResponseException -> when (error.statusCode) {
                413 -> "Данные слишком большие и перемещены в карантин."
                415 -> "Формат данных не поддерживается; элемент перемещен в карантин."
                422 -> "Данные повреждены; элемент перемещен в карантин."
                else -> "Сервер отклонил данные; элемент перемещен в карантин."
            }
            else -> "Элемент очереди поврежден и перемещен в карантин."
        }

    private sealed class PendingItem(open val file: File) {
        abstract val transportId: String

        data class Audio(override val file: File) : PendingItem(file) {
            override val transportId: String = BraiCmdQueue.audioTransportId(file)
        }

        data class Screenshot(override val file: File) : PendingItem(file) {
            override val transportId: String = BraiCmdQueue.screenshotTransportId(file)
        }
    }

    private companion object {
        const val MIN_AUDIO_BYTES = 512L
        const val SCREENSHOT_INBOX_TEXT = "Скриншот"
    }
}
