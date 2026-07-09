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
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

enum class ContextButtonGlyph {
    Logo,
    Close,
    Idea,
    Image,
    ImageMic,
    Chat,
    Save
}

class ScreenshotButtonView(context: Context) : View(context) {
    private val iconBitmap = BitmapFactory.decodeResource(resources, R.drawable.bright_command_small_circle)
    private val iconBounds = Rect()
    private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = COLOR_BUTTON_BACKGROUND
    }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        color = COLOR_ICON_RED
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = COLOR_ICON_RED
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
    }

    private var state: RecorderState = RecorderState.Idle
    private var glyph: ContextButtonGlyph = ContextButtonGlyph.Logo

    fun setRecorderState(next: RecorderState) {
        state = next
        invalidate()
    }

    fun setGlyph(next: ContextButtonGlyph) {
        glyph = next
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val cy = height / 2f
        val radius = minOf(width, height) * 0.46f

        if (glyph == ContextButtonGlyph.Logo) {
            drawIcon(canvas)
        } else {
            drawButtonShell(canvas, cx, cy, radius)
        }
        if (glyph == ContextButtonGlyph.Close) {
            drawGlyph(canvas, cx, cy)
            return
        }

        when (val current = state) {
            is RecorderState.Recording -> drawAmplitude(canvas, cx, cy, radius, current.amplitude)
            is RecorderState.Uploading -> drawSpinner(canvas, cx, cy, radius)
            is RecorderState.Pending -> drawPendingCount(canvas, cx, cy, current.recordings + current.transcripts)
            is RecorderState.TranscriptReady -> drawPendingCount(canvas, cx, cy, current.transcripts)
            is RecorderState.Error -> drawError(canvas, cx, cy)
            else -> drawGlyph(canvas, cx, cy)
        }

        if (state is RecorderState.Recording || state is RecorderState.Uploading) {
            postInvalidateOnAnimation()
        }
    }

    private fun drawIcon(canvas: Canvas) {
        iconBounds.set(0, 0, width, height)
        canvas.drawBitmap(iconBitmap, null, iconBounds, bitmapPaint)
    }

    private fun drawButtonShell(canvas: Canvas, cx: Float, cy: Float, radius: Float) {
        canvas.drawCircle(cx, cy, radius, fillPaint)
        strokePaint.color = COLOR_ICON_RED
        strokePaint.strokeWidth = width * 0.055f
        canvas.drawCircle(cx, cy, radius - strokePaint.strokeWidth / 2f, strokePaint)
    }

    private fun drawGlyph(canvas: Canvas, cx: Float, cy: Float) {
        if (glyph == ContextButtonGlyph.Logo) return
        strokePaint.color = currentIconColor()
        strokePaint.strokeWidth = width * 0.065f
        textPaint.color = currentIconColor()
        textPaint.textSize = width * 0.34f
        when (glyph) {
            ContextButtonGlyph.Close -> drawCross(canvas)
            ContextButtonGlyph.Idea -> drawIdea(canvas, cx, cy)
            ContextButtonGlyph.Image -> drawImage(canvas)
            ContextButtonGlyph.ImageMic -> {
                drawImage(canvas)
                drawMic(canvas, cx + width * 0.18f, cy + height * 0.13f, width * 0.34f)
            }
            ContextButtonGlyph.Chat -> drawChat(canvas)
            ContextButtonGlyph.Save -> drawSave(canvas)
            ContextButtonGlyph.Logo -> Unit
        }
    }

    private fun drawCross(canvas: Canvas) {
        val inset = width * 0.34f
        canvas.drawLine(inset, inset, width - inset, height - inset, strokePaint)
        canvas.drawLine(width - inset, inset, inset, height - inset, strokePaint)
    }

    private fun drawIdea(canvas: Canvas, cx: Float, cy: Float) {
        canvas.drawCircle(cx, cy - height * 0.08f, width * 0.15f, strokePaint)
        canvas.drawLine(cx - width * 0.08f, cy + height * 0.11f, cx + width * 0.08f, cy + height * 0.11f, strokePaint)
        canvas.drawLine(cx - width * 0.05f, cy + height * 0.19f, cx + width * 0.05f, cy + height * 0.19f, strokePaint)
    }

    private fun drawImage(canvas: Canvas) {
        val rect = RectF(width * 0.27f, height * 0.29f, width * 0.73f, height * 0.66f)
        canvas.drawRoundRect(rect, width * 0.04f, width * 0.04f, strokePaint)
        canvas.drawCircle(width * 0.62f, height * 0.39f, width * 0.035f, strokePaint)
        canvas.drawLine(rect.left + width * 0.05f, rect.bottom - width * 0.06f, width * 0.44f, height * 0.51f, strokePaint)
        canvas.drawLine(width * 0.44f, height * 0.51f, rect.right - width * 0.04f, rect.bottom - width * 0.06f, strokePaint)
    }

    private fun drawMic(canvas: Canvas, cx: Float, cy: Float, size: Float) {
        val rect = RectF(cx - size * 0.16f, cy - size * 0.28f, cx + size * 0.16f, cy + size * 0.12f)
        canvas.drawRoundRect(rect, size * 0.14f, size * 0.14f, strokePaint)
        canvas.drawLine(cx, cy + size * 0.17f, cx, cy + size * 0.34f, strokePaint)
        canvas.drawLine(cx - size * 0.16f, cy + size * 0.34f, cx + size * 0.16f, cy + size * 0.34f, strokePaint)
    }

    private fun drawChat(canvas: Canvas) {
        val rect = RectF(width * 0.25f, height * 0.30f, width * 0.75f, height * 0.62f)
        canvas.drawRoundRect(rect, width * 0.10f, width * 0.10f, strokePaint)
        canvas.drawLine(width * 0.40f, rect.bottom, width * 0.32f, height * 0.73f, strokePaint)
    }

    private fun drawSave(canvas: Canvas) {
        val rect = RectF(width * 0.28f, height * 0.27f, width * 0.72f, height * 0.72f)
        canvas.drawRoundRect(rect, width * 0.04f, width * 0.04f, strokePaint)
        canvas.drawLine(width * 0.38f, rect.top, width * 0.38f, height * 0.43f, strokePaint)
        canvas.drawLine(width * 0.60f, rect.top, width * 0.60f, height * 0.43f, strokePaint)
        canvas.drawLine(width * 0.38f, height * 0.43f, width * 0.60f, height * 0.43f, strokePaint)
        canvas.drawLine(width * 0.38f, height * 0.60f, width * 0.62f, height * 0.60f, strokePaint)
    }

    private fun drawAmplitude(canvas: Canvas, cx: Float, cy: Float, radius: Float, amplitude: Int) {
        val normalized = max(0.1f, (amplitude.coerceAtMost(12000) / 12000f))
        strokePaint.color = currentIconSoftColor()
        strokePaint.strokeWidth = width * 0.035f
        val time = SystemClock.uptimeMillis() / 130.0
        repeat(12) { index ->
            val angle = (PI * 2.0 * index / 12.0) + time * 0.04
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

    private fun drawPendingCount(canvas: Canvas, cx: Float, cy: Float, count: Int) {
        val label = count.coerceAtLeast(1).coerceAtMost(99).toString()
        textPaint.color = currentIconColor()
        textPaint.textSize = if (label.length == 1) width * 0.42f else width * 0.34f
        canvas.drawText(label, cx, cy - ((textPaint.descent() + textPaint.ascent()) / 2f) - height * 0.05f, textPaint)
    }

    private fun drawError(canvas: Canvas, cx: Float, cy: Float) {
        textPaint.color = currentIconColor()
        textPaint.textSize = width * 0.46f
        canvas.drawText("!", cx, cy - ((textPaint.descent() + textPaint.ascent()) / 2f), textPaint)
    }

    private fun currentIconColor(): Int =
        when (state) {
            is RecorderState.Pending,
            is RecorderState.TranscriptReady,
            is RecorderState.Error -> COLOR_ICON_LIGHT
            else -> COLOR_ICON_RED
        }

    private fun currentIconSoftColor(): Int =
        when (state) {
            is RecorderState.Error -> COLOR_ICON_LIGHT_SOFT
            else -> COLOR_ICON_RED_SOFT
        }

    companion object {
        private const val COLOR_BUTTON_BACKGROUND = 0xFF050505.toInt()
        private const val COLOR_ICON_RED = 0xFFFF2020.toInt()
        private const val COLOR_ICON_LIGHT = 0xFFEFF4F7.toInt()
        private const val COLOR_ICON_RED_SOFT = 0xB8FF2020.toInt()
        private const val COLOR_ICON_LIGHT_SOFT = 0xB8EFF4F7.toInt()
    }
}
