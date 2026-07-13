package world.brightos.brai.braicmd

import android.content.Context
import com.getcapacitor.JSObject
import kotlin.math.roundToLong

internal data class BraiCmdStatsInput(
    val audioBytes: Long,
    val audioDurationMs: Long,
    val transcriptChars: Int,
    val cloudInputChars: Int = 0,
    val cloudOutputChars: Int = 0,
    val cloudRequest: Boolean = false
)

internal class BraiCmdStatsStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun recordSuccess(input: BraiCmdStatsInput) {
        prefs.edit()
            .putLong(KEY_REQUESTS, prefs.getLong(KEY_REQUESTS, 0L) + 1L)
            .putLong(KEY_AUDIO_BYTES, prefs.getLong(KEY_AUDIO_BYTES, 0L) + input.audioBytes.coerceAtLeast(0L))
            .putLong(KEY_AUDIO_DURATION_MS, prefs.getLong(KEY_AUDIO_DURATION_MS, 0L) + input.audioDurationMs.coerceAtLeast(0L))
            .putLong(KEY_TRANSCRIPT_CHARS, prefs.getLong(KEY_TRANSCRIPT_CHARS, 0L) + input.transcriptChars.coerceAtLeast(0))
            .apply {
                if (input.cloudRequest) {
                    putLong(KEY_CLOUD_REQUESTS, prefs.getLong(KEY_CLOUD_REQUESTS, 0L) + 1L)
                    putLong(KEY_CLOUD_INPUT_CHARS, prefs.getLong(KEY_CLOUD_INPUT_CHARS, 0L) + input.cloudInputChars.coerceAtLeast(0))
                    putLong(KEY_CLOUD_OUTPUT_CHARS, prefs.getLong(KEY_CLOUD_OUTPUT_CHARS, 0L) + input.cloudOutputChars.coerceAtLeast(0))
                }
            }
            .apply()
    }

    fun snapshotJson(): JSObject {
        val audioBytes = prefs.getLong(KEY_AUDIO_BYTES, 0L)
        val audioDurationMs = prefs.getLong(KEY_AUDIO_DURATION_MS, 0L)
        return JSObject()
            .put("requests", prefs.getLong(KEY_REQUESTS, 0L))
            .put("audioSeconds", (audioDurationMs / 1000.0).roundToLong())
            .put("audioMegabytes", audioBytes / 1_000_000.0)
            .put("transcriptChars", prefs.getLong(KEY_TRANSCRIPT_CHARS, 0L))
            .put("cloudRequests", prefs.getLong(KEY_CLOUD_REQUESTS, 0L))
            .put("cloudInputChars", prefs.getLong(KEY_CLOUD_INPUT_CHARS, 0L))
            .put("cloudOutputChars", prefs.getLong(KEY_CLOUD_OUTPUT_CHARS, 0L))
    }

    companion object {
        private const val PREFS = "brai_cmd_stats"
        private const val KEY_REQUESTS = "requests"
        private const val KEY_AUDIO_BYTES = "audio_bytes"
        private const val KEY_AUDIO_DURATION_MS = "audio_duration_ms"
        private const val KEY_TRANSCRIPT_CHARS = "transcript_chars"
        private const val KEY_CLOUD_REQUESTS = "cloud_requests"
        private const val KEY_CLOUD_INPUT_CHARS = "cloud_input_chars"
        private const val KEY_CLOUD_OUTPUT_CHARS = "cloud_output_chars"
    }
}
