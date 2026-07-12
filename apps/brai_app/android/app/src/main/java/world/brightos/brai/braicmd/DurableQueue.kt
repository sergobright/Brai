package world.brightos.brai.braicmd

import android.content.Context
import java.io.File
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.UUID

internal enum class AudioQueueAction(val persistedValue: String) {
    MainDictation("main"),
    IdeaVoiceInbox("idea"),
    ScreenshotVoiceInbox("screenshot_voice"),
    ChatContextInbox("chat"),
    SaveContextInbox("save"),
    Unknown("unknown");

    val contextAction: ContextButtonAction?
        get() = when (this) {
            MainDictation, Unknown -> null
            IdeaVoiceInbox -> ContextButtonAction.IdeaVoiceInbox
            ScreenshotVoiceInbox -> ContextButtonAction.ScreenshotVoiceInbox
            ChatContextInbox -> ContextButtonAction.ChatContextInbox
            SaveContextInbox -> ContextButtonAction.SaveContextInbox
        }

    companion object {
        fun fromContextAction(action: ContextButtonAction?): AudioQueueAction =
            when (action) {
                null -> MainDictation
                ContextButtonAction.IdeaVoiceInbox -> IdeaVoiceInbox
                ContextButtonAction.ScreenshotVoiceInbox -> ScreenshotVoiceInbox
                ContextButtonAction.ChatContextInbox -> ChatContextInbox
                ContextButtonAction.SaveContextInbox -> SaveContextInbox
                ContextButtonAction.ScreenshotInbox -> Unknown
            }

        fun fromPersisted(value: String): AudioQueueAction =
            entries.firstOrNull { it.persistedValue == value } ?: Unknown
    }
}

internal data class QueueTransportCounts(
    val main: Int,
    val contextActions: Map<ContextButtonAction, Int>,
    val unknown: Int
) {
    val total: Int
        get() = main + unknown + contextActions.values.sum()

    operator fun get(action: ContextButtonAction): Int = contextActions[action] ?: 0
}

internal data class QueueReadyToInsertCounts(
    val mainDictation: Int,
    val chatReply: Int
) {
    val total: Int
        get() = mainDictation + chatReply
}

internal data class BraiCmdQueueSnapshot(
    val transport: QueueTransportCounts,
    val failedTransport: QueueTransportCounts,
    val readyToInsert: QueueReadyToInsertCounts
)

internal enum class QueueWorkerStatus {
    Drained,
    TransientFailure,
    Blocked
}

internal data class QueueWorkerResult(
    val status: QueueWorkerStatus,
    val snapshot: BraiCmdQueueSnapshot,
    val nextRetryAtMillis: Long? = null
)

internal object BraiCmdQueue {
    fun snapshot(context: Context): BraiCmdQueueSnapshot {
        var main = 0
        var unknown = 0
        var failedMain = 0
        var failedUnknown = 0
        val contextCounts = ContextButtonAction.entries.associateWith { 0 }.toMutableMap()
        val failedContextCounts = ContextButtonAction.entries.associateWith { 0 }.toMutableMap()
        val failedItems = FailedTransportStore.read(context)
        val audioFiles = AudioQueueStore.list(context)
        for (file in audioFiles) {
            val action = AudioQueueStore.action(file)
            val failed = FailedTransportStore.audioId(file) in failedItems
            when (action) {
                AudioQueueAction.MainDictation -> {
                    main += 1
                    if (failed) failedMain += 1
                }
                AudioQueueAction.Unknown -> {
                    unknown += 1
                    if (failed) failedUnknown += 1
                }
                else -> action.contextAction?.let {
                    contextCounts[it] = contextCounts.getValue(it) + 1
                    if (failed) failedContextCounts[it] = failedContextCounts.getValue(it) + 1
                }
            }
        }
        val screenshots = ScreenshotInboxStore.list(context)
        contextCounts[ContextButtonAction.ScreenshotInbox] = screenshots.size
        failedContextCounts[ContextButtonAction.ScreenshotInbox] = screenshots.count {
            FailedTransportStore.screenshotId(it) in failedItems
        }

        val transcripts = PendingTranscriptStore.list(context)
        val transport = QueueTransportCounts(main, contextCounts.toMap(), unknown)
        if (transport.total == 0) clearTransportFailures(context)
        return BraiCmdQueueSnapshot(
            transport = transport,
            failedTransport = QueueTransportCounts(failedMain, failedContextCounts.toMap(), failedUnknown),
            readyToInsert = QueueReadyToInsertCounts(
                mainDictation = transcripts.count { it.kind == PendingTranscriptKind.MainDictation },
                chatReply = transcripts.count { it.kind == PendingTranscriptKind.ChatReply }
            )
        )
    }

    fun markTransportFailed(context: Context, itemIds: Collection<String>) =
        FailedTransportStore.add(context, itemIds)

    fun clearTransportFailures(context: Context) = FailedTransportStore.clear(context)

    fun audioTransportId(file: File): String = FailedTransportStore.audioId(file)

    fun screenshotTransportId(file: File): String = FailedTransportStore.screenshotId(file)
}

private object FailedTransportStore {
    private const val PREFS = "brai_cmd_failed_transport"
    private const val KEY_ITEMS = "items"

    fun read(context: Context): Set<String> =
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getStringSet(KEY_ITEMS, emptySet())
            .orEmpty()
            .toSet()

    fun add(context: Context, items: Collection<String>) {
        if (items.isEmpty()) return
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putStringSet(KEY_ITEMS, read(context) + items)
            .commit()
    }

    fun clear(context: Context) {
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
    }

    fun audioId(file: File): String = "audio:${file.name}"

    fun screenshotId(file: File): String = "screenshot:${file.name}"
}

internal object AudioQueueStore {
    private const val RECORDINGS_DIR = "pending-recordings"
    private const val QUARANTINE_DIR = "failed-recordings"
    private val sidecarSuffixes = listOf(
        ".context.json",
        ".screenshot.png",
        ".screenshot.jpg",
        ".inbox.txt",
        ".receiver.txt",
        ".inbox-prefix.txt",
        ".inbox-action.txt",
        TranscriptionCheckpointStore.SUFFIX
    )

    fun list(context: Context): List<File> =
        File(context.filesDir, RECORDINGS_DIR)
            .listFiles { file ->
                file.isFile &&
                    file.name.endsWith(".m4a", ignoreCase = true) &&
                    !file.name.contains(".recording.")
            }
            ?.sortedBy { it.lastModified() }
            .orEmpty()

    fun action(audioFile: File): AudioQueueAction =
        InboxPayloadStore.readAction(audioFile) ?: inferLegacyAction(audioFile)

    fun complete(context: Context, audioFile: File): Boolean {
        if (!audioFile.exists()) return true
        if (RecordingArchiveStore.onAudioProcessed(context, audioFile)) {
            sidecarSuffixes.forEach { suffix -> File("${audioFile.absolutePath}$suffix").delete() }
            File("${audioFile.absolutePath}.metadata.json").delete()
            return true
        }
        val doneFile = File(audioFile.parentFile, "${audioFile.name}.done")
        val excludedFromQueue = audioFile.renameTo(doneFile) || audioFile.delete()
        if (!excludedFromQueue) return false
        sidecarSuffixes.forEach { suffix -> File("${audioFile.absolutePath}$suffix").delete() }
        File("${audioFile.absolutePath}.metadata.json").delete()
        doneFile.delete()
        return true
    }

    fun quarantine(context: Context, audioFile: File): Boolean {
        val quarantineDir = File(context.filesDir, QUARANTINE_DIR).apply { mkdirs() }
        val target = uniqueTarget(quarantineDir, audioFile.name)
        val sources = listOf(audioFile) + sidecarSuffixes.map { File("${audioFile.absolutePath}$it") }.filter(File::exists)
        val targets = sources.map { source ->
            if (source == audioFile) target else File("${target.absolutePath}${source.name.removePrefix(audioFile.name)}")
        }
        val copied = runCatching {
            sources.zip(targets).forEach { (source, destination) -> source.copyTo(destination, overwrite = false) }
        }.isSuccess
        if (!copied) {
            targets.forEach(File::delete)
            return false
        }
        sources.forEach(File::delete)
        return !audioFile.exists()
    }

    private fun inferLegacyAction(audioFile: File): AudioQueueAction {
        if (!InboxPayloadStore.isInboxPayload(audioFile)) return AudioQueueAction.MainDictation
        val prefix = InboxPayloadStore.readTextPrefix(audioFile)
        return when {
            prefix.equals(IDEA_PREFIX, ignoreCase = true) -> AudioQueueAction.IdeaVoiceInbox
            ScreenshotContextStore.read(audioFile) != null -> AudioQueueAction.ScreenshotVoiceInbox
            prefix.equals(CHAT_PREFIX, ignoreCase = true) -> AudioQueueAction.ChatContextInbox
            prefix.isBlank() && File("${audioFile.absolutePath}.context.json").isFile -> AudioQueueAction.SaveContextInbox
            else -> AudioQueueAction.Unknown
        }
    }

    private fun uniqueTarget(directory: File, name: String): File {
        val direct = File(directory, name)
        return if (!direct.exists()) direct else File(directory, "${UUID.randomUUID()}-$name")
    }

    const val IDEA_PREFIX = "Идея"
    const val CHAT_PREFIX = "Добавить в контекст контакта"
}

internal object ScreenshotInboxStore {
    private const val QUEUE_DIR = "pending-screenshot-inbox"
    private const val QUARANTINE_DIR = "failed-screenshot-inbox"

    fun enqueue(context: Context, screenshotFile: File): File? {
        if (!screenshotFile.isFile || screenshotFile.length() <= 0L) return null
        val directory = File(context.filesDir, QUEUE_DIR).apply { mkdirs() }
        if (screenshotFile.parentFile?.absolutePath == directory.absolutePath) return screenshotFile
        val target = File(directory, "brai-cmd-${System.currentTimeMillis()}-${UUID.randomUUID()}.png")
        if (screenshotFile.renameTo(target)) return target
        val temporary = File(directory, "${target.name}.pending")
        return runCatching {
            screenshotFile.copyTo(temporary, overwrite = false)
            check(temporary.renameTo(target)) { "Не удалось зафиксировать скриншот в очереди" }
            screenshotFile.delete()
            target
        }.getOrElse {
            temporary.delete()
            target.delete()
            null
        }
    }

    fun list(context: Context): List<File> =
        File(context.filesDir, QUEUE_DIR)
            .listFiles { file -> file.isFile && file.name.endsWith(".png", ignoreCase = true) }
            ?.sortedBy { it.lastModified() }
            .orEmpty()

    fun delete(file: File): Boolean = file.delete() || !file.exists()

    fun quarantine(context: Context, file: File): Boolean {
        val directory = File(context.filesDir, QUARANTINE_DIR).apply { mkdirs() }
        val target = File(directory, file.name).let { if (it.exists()) File(directory, "${UUID.randomUUID()}-${file.name}") else it }
        return runCatching {
            file.copyTo(target, overwrite = false)
            file.delete() || !file.exists()
        }.getOrDefault(false)
    }
}

internal fun inboxDeliveryText(action: AudioQueueAction, prefix: String, transcript: String): String {
    val text = transcript.trim()
    if (action == AudioQueueAction.IdeaVoiceInbox) return text
    return prefix.trim().takeIf { it.isNotBlank() }?.let { "$it\n$text" } ?: text
}

internal enum class QueueFailureDisposition {
    Transient,
    Blocked,
    Permanent
}

internal class QueueCorruptItemException(message: String) : IOException(message)
internal class QueueEmptyModelException : IOException("Модель вернула пустой текст")
internal class QueueAuthBlockedException : IOException("Не указан токен доступа")

internal fun classifyQueueFailure(error: Throwable): QueueFailureDisposition =
    when (error) {
        is QueueCorruptItemException -> QueueFailureDisposition.Permanent
        is QueueAuthBlockedException -> QueueFailureDisposition.Blocked
        is QueueEmptyModelException,
        is UnknownHostException,
        is SocketTimeoutException -> QueueFailureDisposition.Transient
        is ServerResponseException -> when {
            error.statusCode == 401 || error.statusCode == 403 -> QueueFailureDisposition.Blocked
            error.code == "upstream_error" -> QueueFailureDisposition.Transient
            error.statusCode in setOf(400, 413, 415, 422) -> QueueFailureDisposition.Permanent
            error.statusCode in setOf(408, 425, 429) || error.statusCode >= 500 -> QueueFailureDisposition.Transient
            else -> QueueFailureDisposition.Transient
        }
        is IOException -> QueueFailureDisposition.Transient
        else -> QueueFailureDisposition.Transient
    }
