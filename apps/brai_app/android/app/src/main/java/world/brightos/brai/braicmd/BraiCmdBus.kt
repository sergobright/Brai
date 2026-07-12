package world.brightos.brai.braicmd

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArraySet

enum class PendingReason {
    Network,
    Transcription,
    Server,
    Unknown
}

enum class BraiCmdNoticeTone {
    LocalError,
    LocalSuccess,
    ServerSuccess,
    Update
}

data class BraiCmdNotice(
    val text: String,
    val tone: BraiCmdNoticeTone,
    val key: String = ""
)

internal fun braiCmdNoticeText(raw: String): String =
    raw.trim().trimEnd('.', '。', '．').trim().take(120)

internal fun serverNoticeTone(raw: String): BraiCmdNoticeTone =
    if (raw == "success") BraiCmdNoticeTone.ServerSuccess else BraiCmdNoticeTone.ServerSuccess

internal fun shouldShowUpdateNoticeAfter(notice: BraiCmdNotice?): Boolean =
    notice?.tone == BraiCmdNoticeTone.ServerSuccess && notice.text.isNotBlank()

internal fun shouldShowUpdateDot(updateAvailable: Boolean, apkUpdateRequired: Boolean): Boolean =
    updateAvailable || apkUpdateRequired

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
    data class InboxDelivered(val notice: BraiCmdNotice? = null) : RecorderState()
    data class Error(val message: String) : RecorderState()
    data class Notice(val notice: BraiCmdNotice) : RecorderState()
    data class InsertText(val text: String) : RecorderState()
}

object BraiCmdBus {
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
