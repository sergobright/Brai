package world.brightos.brai.braicmd

import world.brightos.brai.R

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
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
    private val iconBitmap by lazy { BitmapFactory.decodeResource(resources, R.drawable.bright_command_small_circle) }
    private val iconBounds = Rect()
    private val glyphPath = Path()
    private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = COLOR_BUTTON_BACKGROUND
    }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
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
        val size = minOf(width, height).toFloat()
        strokePaint.color = currentIconColor()
        strokePaint.strokeWidth = size * 0.045f
        textPaint.color = currentIconColor()
        textPaint.textSize = width * 0.34f
        when (glyph) {
            ContextButtonGlyph.Close -> drawCross(canvas, cx, cy, size)
            ContextButtonGlyph.Idea -> drawIdea(canvas, cx, cy, size)
            ContextButtonGlyph.Image -> drawImage(
                canvas,
                RectF(cx - size * 0.26f, cy - size * 0.21f, cx + size * 0.26f, cy + size * 0.20f)
            )
            ContextButtonGlyph.ImageMic -> {
                drawImage(
                    canvas,
                    RectF(cx - size * 0.30f, cy - size * 0.20f, cx + size * 0.13f, cy + size * 0.15f)
                )
                drawMic(canvas, cx + size * 0.21f, cy + size * 0.07f, size * 0.38f)
            }
            ContextButtonGlyph.Chat -> drawChat(canvas, cx, cy, size)
            ContextButtonGlyph.Save -> drawSave(canvas, cx, cy, size)
            ContextButtonGlyph.Logo -> Unit
        }
    }

    private fun drawCross(canvas: Canvas, cx: Float, cy: Float, size: Float) {
        val half = size * 0.16f
        glyphPath.reset()
        glyphPath.moveTo(cx - half, cy - half)
        glyphPath.lineTo(cx + half, cy + half)
        glyphPath.moveTo(cx + half, cy - half)
        glyphPath.lineTo(cx - half, cy + half)
        canvas.drawPath(glyphPath, strokePaint)
    }

    private fun drawIdea(canvas: Canvas, cx: Float, cy: Float, size: Float) {
        glyphPath.reset()
        glyphPath.moveTo(cx - size * 0.07f, cy + size * 0.10f)
        glyphPath.cubicTo(
            cx - size * 0.08f, cy + size * 0.04f,
            cx - size * 0.17f, cy,
            cx - size * 0.17f, cy - size * 0.11f
        )
        glyphPath.cubicTo(
            cx - size * 0.17f, cy - size * 0.22f,
            cx - size * 0.10f, cy - size * 0.29f,
            cx, cy - size * 0.29f
        )
        glyphPath.cubicTo(
            cx + size * 0.10f, cy - size * 0.29f,
            cx + size * 0.17f, cy - size * 0.22f,
            cx + size * 0.17f, cy - size * 0.11f
        )
        glyphPath.cubicTo(
            cx + size * 0.17f, cy,
            cx + size * 0.08f, cy + size * 0.04f,
            cx + size * 0.07f, cy + size * 0.10f
        )
        glyphPath.lineTo(cx - size * 0.07f, cy + size * 0.10f)
        glyphPath.moveTo(cx - size * 0.07f, cy + size * 0.18f)
        glyphPath.lineTo(cx + size * 0.07f, cy + size * 0.18f)
        canvas.drawPath(glyphPath, strokePaint)
    }

    private fun drawImage(canvas: Canvas, bounds: RectF) {
        val imageWidth = bounds.width()
        val imageHeight = bounds.height()
        glyphPath.reset()
        glyphPath.addRoundRect(bounds, imageWidth * 0.09f, imageWidth * 0.09f, Path.Direction.CW)
        glyphPath.addCircle(
            bounds.left + imageWidth * 0.72f,
            bounds.top + imageHeight * 0.27f,
            imageWidth * 0.055f,
            Path.Direction.CW
        )
        glyphPath.moveTo(bounds.left + imageWidth * 0.08f, bounds.bottom - imageHeight * 0.12f)
        glyphPath.lineTo(bounds.left + imageWidth * 0.35f, bounds.top + imageHeight * 0.50f)
        glyphPath.lineTo(bounds.left + imageWidth * 0.52f, bounds.top + imageHeight * 0.68f)
        glyphPath.lineTo(bounds.left + imageWidth * 0.68f, bounds.top + imageHeight * 0.54f)
        glyphPath.lineTo(bounds.right - imageWidth * 0.07f, bounds.bottom - imageHeight * 0.12f)
        canvas.drawPath(glyphPath, strokePaint)
    }

    private fun drawMic(canvas: Canvas, cx: Float, cy: Float, size: Float) {
        val mic = RectF(cx - size * 0.14f, cy - size * 0.30f, cx + size * 0.14f, cy + size * 0.08f)
        glyphPath.reset()
        glyphPath.addRoundRect(mic, mic.width() / 2f, mic.width() / 2f, Path.Direction.CW)
        glyphPath.moveTo(cx - size * 0.25f, cy - size * 0.01f)
        glyphPath.cubicTo(
            cx - size * 0.25f, cy + size * 0.17f,
            cx - size * 0.12f, cy + size * 0.25f,
            cx, cy + size * 0.25f
        )
        glyphPath.cubicTo(
            cx + size * 0.12f, cy + size * 0.25f,
            cx + size * 0.25f, cy + size * 0.17f,
            cx + size * 0.25f, cy - size * 0.01f
        )
        glyphPath.moveTo(cx, cy + size * 0.25f)
        glyphPath.lineTo(cx, cy + size * 0.37f)
        glyphPath.moveTo(cx - size * 0.16f, cy + size * 0.37f)
        glyphPath.lineTo(cx + size * 0.16f, cy + size * 0.37f)
        canvas.drawPath(glyphPath, strokePaint)
    }

    private fun drawChat(canvas: Canvas, cx: Float, cy: Float, size: Float) {
        glyphPath.reset()
        glyphPath.moveTo(cx - size * 0.17f, cy - size * 0.20f)
        glyphPath.cubicTo(
            cx - size * 0.25f, cy - size * 0.20f,
            cx - size * 0.29f, cy - size * 0.15f,
            cx - size * 0.29f, cy - size * 0.08f
        )
        glyphPath.lineTo(cx - size * 0.29f, cy + size * 0.10f)
        glyphPath.cubicTo(
            cx - size * 0.29f, cy + size * 0.17f,
            cx - size * 0.24f, cy + size * 0.21f,
            cx - size * 0.17f, cy + size * 0.21f
        )
        glyphPath.lineTo(cx - size * 0.10f, cy + size * 0.21f)
        glyphPath.lineTo(cx - size * 0.21f, cy + size * 0.31f)
        glyphPath.lineTo(cx + size * 0.01f, cy + size * 0.21f)
        glyphPath.lineTo(cx + size * 0.17f, cy + size * 0.21f)
        glyphPath.cubicTo(
            cx + size * 0.25f, cy + size * 0.21f,
            cx + size * 0.29f, cy + size * 0.16f,
            cx + size * 0.29f, cy + size * 0.09f
        )
        glyphPath.lineTo(cx + size * 0.29f, cy - size * 0.08f)
        glyphPath.cubicTo(
            cx + size * 0.29f, cy - size * 0.16f,
            cx + size * 0.24f, cy - size * 0.20f,
            cx + size * 0.17f, cy - size * 0.20f
        )
        glyphPath.close()
        glyphPath.moveTo(cx - size * 0.16f, cy - size * 0.05f)
        glyphPath.lineTo(cx + size * 0.16f, cy - size * 0.05f)
        glyphPath.moveTo(cx - size * 0.16f, cy + size * 0.07f)
        glyphPath.lineTo(cx + size * 0.08f, cy + size * 0.07f)
        canvas.drawPath(glyphPath, strokePaint)
    }

    private fun drawSave(canvas: Canvas, cx: Float, cy: Float, size: Float) {
        glyphPath.reset()
        glyphPath.moveTo(cx - size * 0.24f, cy - size * 0.25f)
        glyphPath.lineTo(cx + size * 0.12f, cy - size * 0.25f)
        glyphPath.lineTo(cx + size * 0.24f, cy - size * 0.13f)
        glyphPath.lineTo(cx + size * 0.24f, cy + size * 0.25f)
        glyphPath.lineTo(cx - size * 0.24f, cy + size * 0.25f)
        glyphPath.close()
        glyphPath.moveTo(cx - size * 0.11f, cy - size * 0.25f)
        glyphPath.lineTo(cx - size * 0.11f, cy - size * 0.06f)
        glyphPath.lineTo(cx + size * 0.10f, cy - size * 0.06f)
        glyphPath.lineTo(cx + size * 0.10f, cy - size * 0.25f)
        glyphPath.moveTo(cx - size * 0.12f, cy + size * 0.25f)
        glyphPath.lineTo(cx - size * 0.12f, cy + size * 0.07f)
        glyphPath.lineTo(cx + size * 0.12f, cy + size * 0.07f)
        glyphPath.lineTo(cx + size * 0.12f, cy + size * 0.25f)
        canvas.drawPath(glyphPath, strokePaint)
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
