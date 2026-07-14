package world.brightos.brai.braicmd

import android.content.Context
import java.io.File
import java.util.UUID

enum class PendingTranscriptKind {
    MainDictation,
    ChatReply
}

data class PendingTranscript(
    val file: File,
    val text: String,
    val kind: PendingTranscriptKind
)

object PendingTranscriptStore {
    private const val TRANSCRIPTS_DIR = "pending-transcripts"
    private const val QUARANTINE_DIR = "failed-transcripts"
    private const val MAIN_DICTATION_SUFFIX = ".main-dictation.txt"
    private const val CHAT_REPLY_SUFFIX = ".chat-reply.txt"

    fun add(
        context: Context,
        text: String,
        kind: PendingTranscriptKind = PendingTranscriptKind.MainDictation
    ): File {
        val dir = transcriptsDir(context).apply { mkdirs() }
        val suffix = when (kind) {
            PendingTranscriptKind.MainDictation -> MAIN_DICTATION_SUFFIX
            PendingTranscriptKind.ChatReply -> CHAT_REPLY_SUFFIX
        }
        val file = File(dir, "brai-cmd-${System.currentTimeMillis()}-${UUID.randomUUID()}$suffix")
        QueueOwnerStore.claim(file, QueueOwnerStore.current(context))
        return try {
            file.apply { writeText(text.trim(), Charsets.UTF_8) }
        } catch (error: Throwable) {
            QueueOwnerStore.delete(file)
            file.delete()
            throw error
        }
    }

    fun addForAudio(
        context: Context,
        audioFile: File,
        text: String,
        kind: PendingTranscriptKind = PendingTranscriptKind.MainDictation
    ): File {
        val dir = transcriptsDir(context).apply { mkdirs() }
        val suffix = when (kind) {
            PendingTranscriptKind.MainDictation -> MAIN_DICTATION_SUFFIX
            PendingTranscriptKind.ChatReply -> CHAT_REPLY_SUFFIX
        }
        val safeAudioName = audioFile.name.replace(Regex("[^A-Za-z0-9._-]"), "_")
        val ownerId = QueueOwnerStore.readOwnerId(audioFile) ?: error("queue_owner_missing")
        val file = File(dir, "$safeAudioName$suffix")
        val existed = file.exists()
        QueueOwnerStore.claim(file, ownerId)
        return try {
            file.apply { writeText(text.trim(), Charsets.UTF_8) }
        } catch (error: Throwable) {
            if (!existed) {
                QueueOwnerStore.delete(file)
                file.delete()
            }
            throw error
        }
    }

    fun list(context: Context, kind: PendingTranscriptKind? = null): List<PendingTranscript> {
        val currentOwnerId = QueueOwnerStore.current(context).ownerId
        return transcriptsDir(context)
            .listFiles { file -> file.isFile && file.name.endsWith(".txt", ignoreCase = true) }
            ?.sortedBy { it.lastModified() }
            ?.mapNotNull { file ->
                val ownerId = QueueOwnerStore.readOwnerId(file)
                if (ownerId == null) {
                    quarantineLegacy(context, file)
                    return@mapNotNull null
                }
                if (ownerId != currentOwnerId) return@mapNotNull null
                val text = runCatching { file.readText(Charsets.UTF_8).trim() }.getOrDefault("")
                if (text.isBlank()) {
                    QueueOwnerStore.delete(file)
                    file.delete()
                    null
                } else {
                    PendingTranscript(file, text, kindOf(file))
                }
            }
            ?.filter { kind == null || it.kind == kind }
            .orEmpty()
    }

    fun delete(transcript: PendingTranscript) {
        QueueOwnerStore.delete(transcript.file)
        transcript.file.delete()
    }

    private fun transcriptsDir(context: Context): File =
        File(context.filesDir, TRANSCRIPTS_DIR)

    private fun quarantineLegacy(context: Context, file: File) {
        val directory = File(context.filesDir, QUARANTINE_DIR).apply { mkdirs() }
        val direct = File(directory, file.name)
        val target = if (!direct.exists()) direct else File(directory, "${UUID.randomUUID()}-${file.name}")
        runCatching {
            file.copyTo(target, overwrite = false)
            if (file.delete() || !file.exists()) QueueOwnerStore.delete(file)
        }.onFailure { target.delete() }
    }

    private fun kindOf(file: File): PendingTranscriptKind =
        if (file.name.endsWith(CHAT_REPLY_SUFFIX, ignoreCase = true)) {
            PendingTranscriptKind.ChatReply
        } else {
            // Legacy .txt files and explicit main-dictation files are main dictation results.
            PendingTranscriptKind.MainDictation
        }
}
