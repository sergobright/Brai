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
        file.writeText(text.trim(), Charsets.UTF_8)
        return file
    }

    fun list(context: Context, kind: PendingTranscriptKind? = null): List<PendingTranscript> =
        transcriptsDir(context)
            .listFiles { file -> file.isFile && file.name.endsWith(".txt", ignoreCase = true) }
            ?.sortedBy { it.lastModified() }
            ?.mapNotNull { file ->
                val text = runCatching { file.readText(Charsets.UTF_8).trim() }.getOrDefault("")
                if (text.isBlank()) {
                    file.delete()
                    null
                } else {
                    PendingTranscript(file, text, kindOf(file))
                }
            }
            ?.filter { kind == null || it.kind == kind }
            .orEmpty()

    fun delete(transcript: PendingTranscript) {
        transcript.file.delete()
    }

    private fun transcriptsDir(context: Context): File =
        File(context.filesDir, TRANSCRIPTS_DIR)

    private fun kindOf(file: File): PendingTranscriptKind =
        if (file.name.endsWith(CHAT_REPLY_SUFFIX, ignoreCase = true)) {
            PendingTranscriptKind.ChatReply
        } else {
            // Legacy .txt files and explicit main-dictation files are main dictation results.
            PendingTranscriptKind.MainDictation
        }
}
