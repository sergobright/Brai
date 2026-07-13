package world.brightos.brai.braicmd

import android.content.Context
import android.media.MediaMetadataRetriever
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
    val serverNotice: BraiCmdNotice? = null,
    val permanentFailureMessage: String? = null
)

internal class QueueTransportWorker(
    context: Context,
    private val directTranscriber: ((File) -> SpeechProviderResult)? = null,
    private val directPostProcessor: ((String, String) -> LlmProviderResult)? = null,
    private val cloudPostProcessor: ((String, String) -> CloudPostProcessingResponse)? = null
) {
    private val appContext = context.applicationContext
    private val client = NetworkClient(appContext)
    private var autoInsertTranscriptFile: String? = null
    private var fallbackUsed = false
    private var provider = ""
    private var model = ""
    private var inboxDelivered = false
    private var serverNotice: BraiCmdNotice? = null
    private var permanentFailureMessage: String? = null

    fun run(autoInsertAudioFileName: String?): QueueTransportResult {
        val items = (
            AudioQueueStore.list(appContext).map { PendingItem.Audio(it) } +
                ScreenshotInboxStore.list(appContext).map { PendingItem.Screenshot(it) }
            ).sortedBy { it.file.lastModified() }

        for (item in items) {
            if (!item.file.exists()) continue
            try {
                when (item) {
                    is PendingItem.Audio -> processAudio(item.file, autoInsertAudioFileName)
                    is PendingItem.Screenshot -> processScreenshot(item.file)
                }
            } catch (error: Throwable) {
                if (error is ServerResponseException && error.statusCode == 401) {
                    ConfigStore(appContext).authToken = ""
                    BraiCmdPlugin.notifyCredentialRefreshRequired()
                }
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
                throw QueueCorruptItemException("Данные повреждены")
            file.length() > NetworkClient.MAX_AUDIO_BYTES ->
                throw QueueCorruptItemException("Файл слишком большой")
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
        val response = transcribeAudio(
            file,
            ConversationContextStore.read(file),
            ScreenshotContextStore.read(file),
            AudioQueueAction.MainDictation.functionKey
        )
        val text = response.text.trim()
        if (text.isBlank()) throw QueueEmptyModelException()
        val transcriptFile = PendingTranscriptStore.addForAudio(
            appContext,
            file,
            text,
            PendingTranscriptKind.MainDictation
        )
        recordStatsOnce(file, response)
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
            val response = transcribeAudio(file, null, null, action.functionKey)
            transcript = response.text.trim()
            if (transcript.isBlank()) throw QueueEmptyModelException()
            recordStatsOnce(file, response)
            // Persist before Inbox delivery so retries never retranscribe a completed upload.
            InboxPayloadStore.saveTranscript(file, transcript)
        }
        serverNotice = client.uploadInboxCommand(
            transcript = inboxDeliveryText(action, InboxPayloadStore.readTextPrefix(file), transcript),
            conversationContext = ConversationContextStore.read(file),
            screenshotFile = ScreenshotContextStore.read(file),
            idempotencyKey = file.name,
            braiCmdFunction = action.functionKey
        )
        completeAudio(file)
        inboxDelivered = true
    }

    private fun processScreenshot(file: File) {
        if (file.length() <= 0L) throw QueueCorruptItemException("Данные повреждены")
        serverNotice = client.uploadInboxCommand(
            transcript = SCREENSHOT_INBOX_TEXT,
            conversationContext = null,
            screenshotFile = file,
            idempotencyKey = file.name,
            braiCmdFunction = BRAI_CMD_FUNCTION_SCREENSHOT_INBOX
        )
        if (!ScreenshotInboxStore.delete(file)) throw IOException("Не удалось удалить отправленный скриншот")
        inboxDelivered = true
    }

    private fun completeAudio(file: File) {
        if (!AudioQueueStore.complete(appContext, file)) {
            throw IOException("Не удалось исключить отправленную запись из очереди")
        }
    }

    private fun transcribeAudio(
        file: File,
        conversationContext: VisibleConversationContext?,
        screenshotFile: File?,
        braiCmdFunction: String
    ): DictationResponse {
        val config = ConfigStore(appContext)
        val checkpoint = TranscriptionCheckpointStore.read(file)
        val raw = checkpoint?.response ?: if (config.transcriptionProviderMode == "key") {
            val speech = directTranscriber?.invoke(file) ?: SpeechProviderClient(appContext).transcribe(file)
            DictationResponse(
                text = speech.text,
                provider = speech.provider,
                model = speech.model,
                fallbackUsed = false,
                notice = null,
                audioDurationMs = audioDurationMs(file),
                postProcessed = false,
                postProcessingProvider = "",
                postProcessingModel = "",
                postProcessingInputChars = 0,
                postProcessingOutputChars = 0
            )
        } else {
            client.uploadAudio(file, conversationContext, screenshotFile, braiCmdFunction)
        }
        if (checkpoint == null && raw.text.isNotBlank()) TranscriptionCheckpointStore.save(file, raw)
        if (!config.postProcessingEnabled || raw.postProcessed || raw.text.isBlank()) return raw

        return if (config.postProcessingProviderMode == "key") {
            val result = directPostProcessor?.invoke(raw.text, config.postProcessingPrompt)
                ?: LlmProviderClient(appContext).postProcess(raw.text, config.postProcessingPrompt)
            raw.copy(
                text = result.text,
                postProcessed = true,
                postProcessingProvider = result.provider,
                postProcessingModel = result.model,
                postProcessingInputChars = result.inputChars,
                postProcessingOutputChars = result.outputChars
            )
        } else {
            val result = cloudPostProcessor?.invoke(raw.text, config.postProcessingPrompt)
                ?: client.postProcessText(raw.text, config.postProcessingPrompt)
            raw.copy(
                text = result.text,
                postProcessed = true,
                postProcessingProvider = result.provider,
                postProcessingModel = result.model,
                postProcessingInputChars = result.inputChars,
                postProcessingOutputChars = result.outputChars
            )
        }
    }

    private fun audioDurationMs(file: File): Long = runCatching {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        } finally {
            retriever.release()
        }
    }.getOrDefault(0L)

    private fun recordStats(file: File, response: DictationResponse) {
        BraiCmdStatsStore(appContext).recordSuccess(
            BraiCmdStatsInput(
                audioBytes = file.length(),
                audioDurationMs = response.audioDurationMs,
                transcriptChars = response.text.length,
                cloudInputChars = response.postProcessingInputChars,
                cloudOutputChars = response.postProcessingOutputChars,
                cloudRequest = response.postProcessed && response.postProcessingProvider == "brai-cloud"
            )
        )
    }

    private fun recordStatsOnce(file: File, response: DictationResponse) {
        if (TranscriptionCheckpointStore.read(file)?.statsRecorded == true) return
        recordStats(file, response)
        TranscriptionCheckpointStore.markStatsRecorded(file, response)
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
            serverNotice = serverNotice,
            permanentFailureMessage = permanentFailureMessage
        )

    private fun permanentFailureMessage(error: Throwable): String =
        when (error) {
            is QueueCorruptItemException -> error.message.orEmpty()
            is ServerResponseException -> when (error.statusCode) {
                413 -> "Файл слишком большой"
                415 -> "Формат не поддержан"
                422 -> "Данные повреждены"
                else -> "Запрос отклонён"
            }
            else -> "Данные повреждены"
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
