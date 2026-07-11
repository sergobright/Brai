package world.brightos.brai.braicmd

import java.io.File

object ScreenshotContextStore {
    fun save(audioFile: File, screenshotFile: File?) {
        val sidecar = sidecarFile(audioFile)
        if (screenshotFile == null || !screenshotFile.isFile || screenshotFile.length() <= 0L) {
            sidecar.delete()
            legacySidecarFile(audioFile).delete()
            screenshotFile?.delete()
            return
        }
        if (screenshotFile.absolutePath == sidecar.absolutePath) return
        runCatching {
            sidecar.parentFile?.mkdirs()
            screenshotFile.copyTo(sidecar, overwrite = true)
            screenshotFile.delete()
        }.onFailure {
            sidecar.delete()
        }
    }

    fun read(audioFile: File): File? {
        val sidecar = sidecarFile(audioFile)
        if (sidecar.isFile && sidecar.length() > 0L) return sidecar
        return legacySidecarFile(audioFile).takeIf { it.isFile && it.length() > 0L }
    }

    fun move(fromAudioFile: File, toAudioFile: File) {
        moveSidecar(sidecarFile(fromAudioFile), sidecarFile(toAudioFile))
        moveSidecar(legacySidecarFile(fromAudioFile), legacySidecarFile(toAudioFile))
    }

    fun delete(audioFile: File) {
        sidecarFile(audioFile).delete()
        legacySidecarFile(audioFile).delete()
    }

    private fun moveSidecar(from: File, to: File) {
        if (!from.exists()) return
        if (from.renameTo(to)) return
        runCatching {
            from.copyTo(to, overwrite = true)
            from.delete()
        }
    }

    private fun sidecarFile(audioFile: File): File =
        File("${audioFile.absolutePath}.screenshot.png")

    private fun legacySidecarFile(audioFile: File): File =
        File("${audioFile.absolutePath}.screenshot.jpg")
}

object InboxPayloadStore {
    fun mark(audioFile: File, textPrefix: String = "") {
        sidecarFile(audioFile).apply {
            parentFile?.mkdirs()
            if (!exists()) writeText("", Charsets.UTF_8)
        }
        val prefix = textPrefix.trim()
        val prefixFile = prefixFile(audioFile)
        if (prefix.isBlank()) {
            prefixFile.delete()
        } else {
            prefixFile.writeText(prefix, Charsets.UTF_8)
        }
    }

    fun isInboxPayload(audioFile: File): Boolean =
        sidecarFile(audioFile).isFile || legacySidecarFile(audioFile).isFile

    fun saveTranscript(audioFile: File, transcript: String) {
        sidecarFile(audioFile).writeText(transcript.trim(), Charsets.UTF_8)
        legacySidecarFile(audioFile).delete()
    }

    fun readTranscript(audioFile: File): String? {
        val file = listOf(sidecarFile(audioFile), legacySidecarFile(audioFile)).firstOrNull { it.isFile } ?: return null
        if (!file.isFile) return null
        return file.readText(Charsets.UTF_8).trim().takeIf { it.isNotBlank() }
    }

    fun readTextPrefix(audioFile: File): String =
        prefixFile(audioFile).takeIf { it.isFile }?.readText(Charsets.UTF_8).orEmpty().trim()

    internal fun saveAction(audioFile: File, action: AudioQueueAction) {
        actionFile(audioFile).apply {
            parentFile?.mkdirs()
            writeText(action.persistedValue, Charsets.UTF_8)
        }
    }

    internal fun readAction(audioFile: File): AudioQueueAction? {
        val file = actionFile(audioFile)
        if (!file.isFile) return null
        return AudioQueueAction.fromPersisted(file.readText(Charsets.UTF_8).trim())
    }

    fun move(fromAudioFile: File, toAudioFile: File) {
        moveSidecar(sidecarFile(fromAudioFile), sidecarFile(toAudioFile))
        moveSidecar(legacySidecarFile(fromAudioFile), legacySidecarFile(toAudioFile))
        moveSidecar(prefixFile(fromAudioFile), prefixFile(toAudioFile))
        moveSidecar(actionFile(fromAudioFile), actionFile(toAudioFile))
    }

    private fun moveSidecar(from: File, to: File) {
        if (!from.exists()) return
        if (from.renameTo(to)) return
        runCatching {
            from.copyTo(to, overwrite = true)
            from.delete()
        }
    }

    fun delete(audioFile: File) {
        sidecarFile(audioFile).delete()
        legacySidecarFile(audioFile).delete()
        prefixFile(audioFile).delete()
        actionFile(audioFile).delete()
    }

    private fun sidecarFile(audioFile: File): File =
        File("${audioFile.absolutePath}.inbox.txt")

    private fun legacySidecarFile(audioFile: File): File =
        File("${audioFile.absolutePath}.receiver.txt")

    private fun prefixFile(audioFile: File): File =
        File("${audioFile.absolutePath}.inbox-prefix.txt")

    private fun actionFile(audioFile: File): File =
        File("${audioFile.absolutePath}.inbox-action.txt")
}
