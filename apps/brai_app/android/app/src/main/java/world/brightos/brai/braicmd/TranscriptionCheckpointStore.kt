package world.brightos.brai.braicmd

import org.json.JSONObject
import java.io.File

internal data class TranscriptionCheckpoint(
    val response: DictationResponse,
    val statsRecorded: Boolean
)

/** Keeps a paid transcription result beside queued audio until every later stage succeeds. */
internal object TranscriptionCheckpointStore {
    const val SUFFIX = ".transcription.json"

    fun read(audioFile: File): TranscriptionCheckpoint? = runCatching {
        val json = JSONObject(file(audioFile).readText(Charsets.UTF_8))
        val text = json.optString("text").trim()
        if (text.isBlank()) return null
        TranscriptionCheckpoint(
            response = DictationResponse(
                text = text,
                provider = json.optString("provider"),
                model = json.optString("model"),
                fallbackUsed = json.optBoolean("fallbackUsed"),
                audioDurationMs = json.optLong("audioDurationMs"),
                postProcessed = json.optBoolean("postProcessed"),
                postProcessingProvider = json.optString("postProcessingProvider"),
                postProcessingModel = json.optString("postProcessingModel"),
                postProcessingInputChars = json.optInt("postProcessingInputChars"),
                postProcessingOutputChars = json.optInt("postProcessingOutputChars")
            ),
            statsRecorded = json.optBoolean("statsRecorded")
        )
    }.getOrNull()

    fun save(audioFile: File, response: DictationResponse, statsRecorded: Boolean = false) {
        file(audioFile).writeText(
            JSONObject()
                .put("text", response.text.trim())
                .put("provider", response.provider)
                .put("model", response.model)
                .put("fallbackUsed", response.fallbackUsed)
                .put("audioDurationMs", response.audioDurationMs)
                .put("postProcessed", response.postProcessed)
                .put("postProcessingProvider", response.postProcessingProvider)
                .put("postProcessingModel", response.postProcessingModel)
                .put("postProcessingInputChars", response.postProcessingInputChars)
                .put("postProcessingOutputChars", response.postProcessingOutputChars)
                .put("statsRecorded", statsRecorded)
                .toString(),
            Charsets.UTF_8
        )
    }

    fun markStatsRecorded(audioFile: File, response: DictationResponse) = save(audioFile, response, true)

    private fun file(audioFile: File) = File("${audioFile.absolutePath}$SUFFIX")
}
