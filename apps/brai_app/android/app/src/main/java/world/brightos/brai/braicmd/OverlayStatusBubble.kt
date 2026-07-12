package world.brightos.brai.braicmd

import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView
import world.brightos.brai.capabilities.BraiAccessibilityService
import kotlin.math.max
import kotlin.math.min

internal class OverlayStatusBubble(
    private val service: BraiAccessibilityService,
    private val windowManager: WindowManager,
    private val handler: Handler
) {
    private var view: TextView? = null
    private var params: WindowManager.LayoutParams? = null
    private var hideRunnable: Runnable? = null

    fun show(
        notice: BraiCmdNotice,
        buttonParams: WindowManager.LayoutParams,
        durationMs: Long = STATUS_BUBBLE_MS
    ) {
        val text = braiCmdNoticeText(notice.text)
        if (text.isBlank()) return
        val bubble = view ?: TextView(service).apply {
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(service.dp(12), service.dp(8), service.dp(12), service.dp(8))
            view = this
        }
        bubble.text = text
        bubble.setTextColor(textColor(notice.tone))
        bubble.background = roundedBackground(backgroundColor(notice.tone))

        if (params == null) {
            params = WindowManager.LayoutParams(
                service.dp(BUBBLE_WIDTH_DP),
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.TOP or Gravity.START
                x = bubbleX(buttonParams)
                y = bubbleY(buttonParams)
            }
            runCatching { windowManager.addView(bubble, params) }
        } else {
            update(buttonParams)
        }

        hideRunnable?.let { handler.removeCallbacks(it) }
        hideRunnable = Runnable { hide() }.also { handler.postDelayed(it, durationMs) }
    }

    fun update(buttonParams: WindowManager.LayoutParams?) {
        val bubble = view ?: return
        val lp = params ?: return
        buttonParams ?: return
        lp.x = bubbleX(buttonParams)
        lp.y = bubbleY(buttonParams)
        runCatching { windowManager.updateViewLayout(bubble, lp) }
    }

    fun hide() {
        hideRunnable?.let { handler.removeCallbacks(it) }
        hideRunnable = null
        val bubble = view ?: return
        runCatching { windowManager.removeView(bubble) }
        view = null
        params = null
    }

    private fun bubbleX(buttonParams: WindowManager.LayoutParams): Int {
        val screenWidth = service.resources.displayMetrics.widthPixels
        val margin = service.dp(8)
        val width = service.dp(BUBBLE_WIDTH_DP)
        val gap = service.dp(8)
        val buttonCenter = buttonParams.x + (buttonParams.width / 2)
        val preferred = if (buttonCenter < screenWidth / 2) {
            buttonParams.x + buttonParams.width + gap
        } else {
            buttonParams.x - width - gap
        }
        return preferred.coerceIn(margin, max(margin, screenWidth - width - margin))
    }

    private fun bubbleY(buttonParams: WindowManager.LayoutParams): Int {
        val screenHeight = service.resources.displayMetrics.heightPixels
        val margin = service.dp(8)
        return min(max(margin, buttonParams.y + service.dp(2)), max(margin, screenHeight - service.dp(56)))
    }

    private fun roundedBackground(color: Int): GradientDrawable =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = service.dp(10).toFloat()
        }

    private fun backgroundColor(tone: BraiCmdNoticeTone): Int = when (tone) {
        BraiCmdNoticeTone.Update -> COLOR_UPDATE
        BraiCmdNoticeTone.LocalError -> COLOR_RED
        BraiCmdNoticeTone.LocalSuccess,
        BraiCmdNoticeTone.ServerSuccess -> COLOR_GREEN
    }

    private fun textColor(tone: BraiCmdNoticeTone): Int =
        if (tone == BraiCmdNoticeTone.Update) COLOR_UPDATE_TEXT else COLOR_WHITE

    companion object {
        const val STATUS_BUBBLE_MS = 3_000L
        const val UPDATE_BUBBLE_MS = 1_500L
        private const val BUBBLE_WIDTH_DP = 190
        private const val COLOR_RED = 0xFF7A1212.toInt()
        private const val COLOR_GREEN = 0xFF0B4A2B.toInt()
        private const val COLOR_UPDATE = 0xFFFFD24A.toInt()
        private const val COLOR_WHITE = 0xFFFFFFFF.toInt()
        private const val COLOR_UPDATE_TEXT = 0xFF1B1600.toInt()
    }
}
