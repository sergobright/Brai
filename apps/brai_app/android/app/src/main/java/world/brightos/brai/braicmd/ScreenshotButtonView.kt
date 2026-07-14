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
    private val marker = braiFloatingButtonMarker()
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
    private var menuExpansionProgress = 0f
    private var queueBadge: QueueBadgeState? = null

    fun setRecorderState(next: RecorderState) {
        state = next
        invalidate()
    }

    fun setGlyph(next: ContextButtonGlyph) {
        glyph = next
        glyphDrawable = glyphDrawableResource(next)?.let { context.getDrawable(it)?.mutate() }
        invalidate()
    }

    fun setMenuExpansionProgress(progress: Float) {
        menuExpansionProgress = progress.coerceIn(0f, 1f)
        invalidate()
    }

    fun setQueueState(failedAudioCount: Int) {
        queueBadge = resolveQueueBadgeState(failedAudioCount)
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val cy = height / 2f
        val radius = minOf(width, height) * 0.46f

        if (glyph == ContextButtonGlyph.Logo && menuExpansionProgress > 0f) {
            drawHubTransition(canvas, cx, cy, radius)
            return
        }
        if (state is RecorderState.InboxDelivered) {
            drawButtonShell(canvas, cx, cy, radius)
            drawCheck(canvas, cx, cy)
            return
        }
        if (glyph == ContextButtonGlyph.Logo) {
            drawIcon(canvas)
            drawFloatingButtonMarker(canvas, marker, cx, cy, minOf(width, height).toFloat(), textPaint)
        } else {
            drawButtonShell(canvas, cx, cy, radius)
        }
        if (glyph == ContextButtonGlyph.Close) {
            drawGlyph(canvas, cx, cy)
            return
        }

        if (shouldDrawContextActionGlyph(glyph, state)) drawGlyph(canvas, cx, cy)
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

    private fun drawIcon(canvas: Canvas, alpha: Int = 255) {
        iconBounds.set(0, 0, width, height)
        bitmapPaint.alpha = alpha
        canvas.drawBitmap(iconBitmap, null, iconBounds, bitmapPaint)
        bitmapPaint.alpha = 255
    }

    private fun drawButtonShell(canvas: Canvas, cx: Float, cy: Float, radius: Float, alpha: Int = 255) {
        fillPaint.alpha = alpha
        strokePaint.alpha = alpha
        canvas.drawCircle(cx, cy, radius, fillPaint)
        strokePaint.color = currentIconColor()
        strokePaint.strokeWidth = minOf(width, height) * 0.025f
        canvas.drawCircle(cx, cy, radius - strokePaint.strokeWidth / 2f, strokePaint)
        fillPaint.alpha = 255
        strokePaint.alpha = 255
    }

    private fun drawHubTransition(canvas: Canvas, cx: Float, cy: Float, radius: Float) {
        val logoAlpha = ((1f - menuExpansionProgress) * 255).roundToInt()
        val crossAlpha = (menuExpansionProgress * 255).roundToInt()
        if (logoAlpha > 0) {
            drawIcon(canvas, logoAlpha)
            drawFloatingButtonMarker(canvas, marker, cx, cy, minOf(width, height).toFloat(), textPaint, logoAlpha)
        }
        if (crossAlpha <= 0) return
        drawButtonShell(canvas, cx, cy, radius, crossAlpha)
        strokePaint.color = COLOR_ICON_RED
        strokePaint.alpha = crossAlpha
        strokePaint.strokeWidth = minOf(width, height) * 0.035f
        drawCross(canvas, cx, cy, minOf(width, height).toFloat())
        strokePaint.alpha = 255
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

    private fun drawQueueBadge(canvas: Canvas, badge: QueueBadgeState) {
        val label = if (badge.count > 99) "99+" else badge.count.toString()
        val badgeRadius = width * 0.17f
        val badgeX = width * 0.76f
        val badgeY = height * 0.24f
        fillPaint.color = COLOR_ICON_RED
        canvas.drawCircle(badgeX, badgeY, badgeRadius, fillPaint)
        fillPaint.color = COLOR_BUTTON_BACKGROUND
        textPaint.color = COLOR_BUTTON_BACKGROUND
        textPaint.textSize = if (label.length == 1) width * 0.22f else width * 0.16f
        canvas.drawText(label, badgeX, badgeY - (textPaint.descent() + textPaint.ascent()) / 2f, textPaint)
    }

    private fun drawError(canvas: Canvas, cx: Float, cy: Float) {
        textPaint.color = currentIconColor()
        textPaint.textSize = width * 0.28f
        canvas.drawText("!", cx - width * 0.22f, cy + height * 0.3f, textPaint)
    }

    private fun currentIconColor(): Int = COLOR_ICON_RED

    private fun currentIconSoftColor(): Int = COLOR_ICON_RED_SOFT

    companion object {
        private const val COLOR_BUTTON_BACKGROUND = 0xFF050505.toInt()
        private const val COLOR_ICON_RED = 0xFFFF2020.toInt()
        private const val COLOR_ICON_RED_SOFT = 0xB8FF2020.toInt()
    }
}

internal fun shouldDrawContextActionGlyph(
    glyph: ContextButtonGlyph,
    state: RecorderState = RecorderState.Idle
): Boolean = state !is RecorderState.InboxDelivered &&
    glyph != ContextButtonGlyph.Logo && glyph != ContextButtonGlyph.Close
