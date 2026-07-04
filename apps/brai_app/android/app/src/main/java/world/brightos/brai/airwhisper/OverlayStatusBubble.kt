package world.brightos.brai.airwhisper

import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView
import world.brightos.brai.capabilities.BraiAccessibilityService
import kotlin.math.max

internal class OverlayStatusBubble(
    private val service: BraiAccessibilityService,
    private val windowManager: WindowManager,
    private val handler: Handler
) {
    private var view: TextView? = null
    private var params: WindowManager.LayoutParams? = null
    private var hideRunnable: Runnable? = null

    fun show(title: String, subtitle: String, buttonParams: WindowManager.LayoutParams) {
        val bubble = view ?: TextView(service).apply {
            setTextColor(COLOR_TEXT)
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(service.dp(12), service.dp(8), service.dp(12), service.dp(8))
            background = roundedBackground(COLOR_BUBBLE)
            view = this
        }
        bubble.text = "$title\n$subtitle"

        if (params == null) {
            params = WindowManager.LayoutParams(
                service.dp(190),
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
        hideRunnable = Runnable { hide() }.also { handler.postDelayed(it, STATUS_BUBBLE_MS) }
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

    private fun bubbleX(buttonParams: WindowManager.LayoutParams): Int =
        max(service.dp(8), buttonParams.x - service.dp(198))

    private fun bubbleY(buttonParams: WindowManager.LayoutParams): Int =
        max(service.dp(8), buttonParams.y + service.dp(2))

    private fun roundedBackground(color: Int): GradientDrawable =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = service.dp(10).toFloat()
        }

    companion object {
        private const val STATUS_BUBBLE_MS = 7_000L
        private const val COLOR_BUBBLE = 0xFF10251B.toInt()
        private const val COLOR_TEXT = 0xFFC7DCD2.toInt()
    }
}
