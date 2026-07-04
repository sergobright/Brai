package world.brightos.brai.airwhisper

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArraySet

enum class PendingReason {
    Network,
    Transcription,
    Server,
    Unknown
}

sealed class RecorderState {
    data object Idle : RecorderState()
    data class Recording(val amplitude: Int) : RecorderState()
    data object Uploading : RecorderState()
    data class Pending(
        val message: String,
        val recordings: Int,
        val transcripts: Int,
        val reason: PendingReason
    ) : RecorderState()
    data class TranscriptReady(
        val transcripts: Int,
        val autoInsertTranscriptFile: String? = null,
        val fallbackUsed: Boolean = false,
        val provider: String = "",
        val model: String = ""
    ) : RecorderState()
    data object InboxDelivered : RecorderState()
    data class Error(val message: String) : RecorderState()
    data class InsertText(val text: String) : RecorderState()
}

object AirWhisperBus {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<(RecorderState) -> Unit>()

    @Volatile
    var latest: RecorderState = RecorderState.Idle
        private set

    fun addListener(listener: (RecorderState) -> Unit) {
        listeners.add(listener)
        mainHandler.post { listener(latest) }
    }

    fun removeListener(listener: (RecorderState) -> Unit) {
        listeners.remove(listener)
    }

    fun post(state: RecorderState) {
        latest = state
        mainHandler.post {
            listeners.forEach { it(state) }
        }
    }
}
