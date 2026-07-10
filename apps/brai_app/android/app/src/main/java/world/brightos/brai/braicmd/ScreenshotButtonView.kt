package world.brightos.brai.braicmd

import world.brightos.brai.R

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.os.SystemClock
import android.view.View
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.roundToInt
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
    private var glyphDrawable: Drawable? = null

    fun setRecorderState(next: RecorderState) {
        state = next
        invalidate()
    }

    fun setGlyph(next: ContextButtonGlyph) {
        glyph = next
        glyphDrawable = glyphDrawableResource(next)?.let { context.getDrawable(it)?.mutate() }
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
            is RecorderState.InboxDelivered -> drawCheck(canvas, cx, cy)
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
        strokePaint.strokeWidth = minOf(width, height) * 0.025f
        canvas.drawCircle(cx, cy, radius - strokePaint.strokeWidth / 2f, strokePaint)
    }

    private fun drawGlyph(canvas: Canvas, cx: Float, cy: Float) {
        val size = minOf(width, height).toFloat()
        when (glyph) {
            ContextButtonGlyph.Close -> {
                strokePaint.color = currentIconColor()
                strokePaint.strokeWidth = size * 0.035f
                drawCross(canvas, cx, cy, size)
            }
            ContextButtonGlyph.Logo -> Unit
            else -> drawVectorGlyph(canvas, cx, cy, size)
        }
    }

    private fun drawVectorGlyph(canvas: Canvas, cx: Float, cy: Float, size: Float) {
        val drawable = glyphDrawable ?: return
        val iconSize = (size * 0.58f).roundToInt()
        val left = (cx - iconSize / 2f).roundToInt()
        val top = (cy - iconSize / 2f).roundToInt()
        drawable.setTint(currentIconColor())
        drawable.setBounds(left, top, left + iconSize, top + iconSize)
        drawable.draw(canvas)
    }

    private fun glyphDrawableResource(glyph: ContextButtonGlyph): Int? =
        when (glyph) {
            ContextButtonGlyph.Idea -> R.drawable.brai_context_idea
            ContextButtonGlyph.Image -> R.drawable.brai_context_image
            ContextButtonGlyph.ImageMic -> R.drawable.brai_context_image_mic
            ContextButtonGlyph.Chat -> R.drawable.brai_context_chat
            ContextButtonGlyph.Save -> R.drawable.brai_context_save
            ContextButtonGlyph.Logo,
            ContextButtonGlyph.Close -> null
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

    private fun drawCheck(canvas: Canvas, cx: Float, cy: Float) {
        val size = minOf(width, height).toFloat()
        val unit = size * 0.58f / 24f
        strokePaint.color = currentIconColor()
        strokePaint.strokeWidth = size * 0.045f
        glyphPath.reset()
        glyphPath.moveTo(cx - 8f * unit, cy)
        glyphPath.lineTo(cx - 3f * unit, cy + 5f * unit)
        glyphPath.lineTo(cx + 8f * unit, cy - 6f * unit)
        canvas.drawPath(glyphPath, strokePaint)
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
