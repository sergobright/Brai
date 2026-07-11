package world.brightos.brai.braicmd

import world.brightos.brai.R

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.os.SystemClock
import android.view.View
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

class AirButtonView(context: Context) : View(context) {
    private val iconBitmap = BitmapFactory.decodeResource(resources, R.drawable.bright_command_large_hex)
    private val iconBounds = Rect()
    private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeWidth = 5f
        color = COLOR_ICON_RED
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = COLOR_ICON_RED
        textAlign = Paint.Align.CENTER
        textSize = 24f
        isFakeBoldText = true
    }

    private var state: RecorderState = RecorderState.Idle
    private var queueBadge: QueueBadgeState? = null

    fun setRecorderState(next: RecorderState) {
        state = next
        invalidate()
    }

    fun setQueueState(failedCount: Int, readyCount: Int) {
        queueBadge = resolveQueueBadgeState(failedCount, readyCount)
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val cy = height / 2f
        val radius = minOf(width, height) * 0.46f

        drawIcon(canvas)

        when (val current = state) {
            is RecorderState.Recording -> drawAmplitude(canvas, cx, cy, radius, current.amplitude)
            is RecorderState.Uploading -> drawSpinner(canvas, cx, cy, radius)
            is RecorderState.Error -> drawError(canvas, cx, cy)
            else -> Unit
        }
        queueBadge?.let { drawQueueBadge(canvas, it) }

        if (state is RecorderState.Recording || state is RecorderState.Uploading) {
            postInvalidateOnAnimation()
        }
    }

    private fun drawIcon(canvas: Canvas) {
        iconBounds.set(0, 0, width, height)
        canvas.drawBitmap(iconBitmap, null, iconBounds, bitmapPaint)
    }

    private fun drawAmplitude(canvas: Canvas, cx: Float, cy: Float, radius: Float, amplitude: Int) {
        val normalized = max(0.1f, (amplitude.coerceAtMost(12000) / 12000f))
        strokePaint.color = currentIconSoftColor()
        strokePaint.strokeWidth = width * 0.035f
        val time = SystemClock.uptimeMillis() / 130.0
        repeat(14) { index ->
            val angle = (Math.PI * 2.0 * index / 14.0) + time * 0.04
            val wave = ((sin(time + index) + 1.0) / 2.0).toFloat()
            val inner = radius * 0.82f
            val outer = radius * (0.98f + normalized * 0.34f * wave)
            canvas.drawLine(
                cx + cos(angle).toFloat() * inner,
                cy + sin(angle).toFloat() * inner,
                cx + cos(angle).toFloat() * outer,
                cy + sin(angle).toFloat() * outer,
                strokePaint
            )
        }
    }

    private fun drawSpinner(canvas: Canvas, cx: Float, cy: Float, radius: Float) {
        strokePaint.color = currentIconColor()
        strokePaint.strokeWidth = width * 0.07f
        val phase = ((SystemClock.uptimeMillis() / 6L) % 360).toFloat()
        canvas.drawArc(RectF(cx - radius * 0.55f, cy - radius * 0.55f, cx + radius * 0.55f, cy + radius * 0.55f), phase, 250f, false, strokePaint)
    }

    private fun drawQueueBadge(canvas: Canvas, badge: QueueBadgeState) {
        val label = if (badge.count > 99) "99+" else badge.count.toString()
        val badgeRadius = width * 0.15f
        val badgeX = width * 0.77f
        val badgeY = height * 0.23f
        val badgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL
            color = if (badge.tone == QueueBadgeTone.Ready) COLOR_BADGE_GREEN else COLOR_ICON_RED
        }
        canvas.drawCircle(badgeX, badgeY, badgeRadius, badgePaint)
        textPaint.color = COLOR_BADGE_TEXT
        textPaint.textSize = if (label.length == 1) width * 0.2f else width * 0.14f
        canvas.drawText(label, badgeX, badgeY - (textPaint.descent() + textPaint.ascent()) / 2f, textPaint)
    }

    private fun drawError(canvas: Canvas, cx: Float, cy: Float) {
        textPaint.color = currentIconColor()
        textPaint.textSize = width * 0.26f
        canvas.drawText("!", cx - width * 0.2f, cy + height * 0.3f, textPaint)
    }

    private fun currentIconColor(): Int = COLOR_ICON_RED

    private fun currentIconSoftColor(): Int = COLOR_ICON_RED_SOFT

    companion object {
        private const val COLOR_ICON_RED = 0xFFFF2020.toInt()
        private const val COLOR_ICON_RED_SOFT = 0xB8FF2020.toInt()
        private const val COLOR_BADGE_GREEN = 0xFF2ED36F.toInt()
        private const val COLOR_BADGE_TEXT = 0xFF050505.toInt()
    }
}

internal enum class QueueBadgeTone {
    Pending,
    Ready
}

internal data class QueueBadgeState(
    val count: Int,
    val tone: QueueBadgeTone
)

internal fun resolveQueueBadgeState(failedCount: Int, readyCount: Int): QueueBadgeState? = when {
    readyCount > 0 -> QueueBadgeState(readyCount, QueueBadgeTone.Ready)
    failedCount > 0 -> QueueBadgeState(failedCount, QueueBadgeTone.Pending)
    else -> null
}
