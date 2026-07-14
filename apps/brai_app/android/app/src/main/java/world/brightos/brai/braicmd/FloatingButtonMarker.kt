package world.brightos.brai.braicmd

import world.brightos.brai.BuildConfig

import android.graphics.Canvas
import android.graphics.Paint
import java.util.Locale

internal fun braiFloatingButtonMarker(): String =
    // Preview flavors render their slot letter on both Brai CMD buttons; Production stays unmarked.
    normalizeFloatingButtonMarker(BuildConfig.BRAI_FLOATING_BUTTON_LABEL)

internal fun normalizeFloatingButtonMarker(value: String?): String =
    value?.trim()?.take(1)?.uppercase(Locale.ROOT).orEmpty()

internal fun drawFloatingButtonMarker(
    canvas: Canvas,
    label: String,
    cx: Float,
    cy: Float,
    size: Float,
    paint: Paint,
    alpha: Int = 255
) {
    if (label.isBlank() || alpha <= 0) return

    val oldStyle = paint.style
    val oldColor = paint.color
    val oldStrokeWidth = paint.strokeWidth
    val oldTextSize = paint.textSize
    val oldAlpha = paint.alpha
    val oldFakeBold = paint.isFakeBoldText
    val oldTextAlign = paint.textAlign

    paint.textAlign = Paint.Align.CENTER
    paint.textSize = size * 0.34f
    paint.isFakeBoldText = true
    paint.alpha = alpha

    paint.style = Paint.Style.STROKE
    paint.strokeWidth = size * 0.045f
    paint.color = 0xE6000000.toInt()
    canvas.drawText(label, cx, cy - (paint.descent() + paint.ascent()) / 2f, paint)

    paint.style = Paint.Style.FILL
    paint.color = 0xFFFFFFFF.toInt()
    canvas.drawText(label, cx, cy - (paint.descent() + paint.ascent()) / 2f, paint)

    paint.style = oldStyle
    paint.color = oldColor
    paint.strokeWidth = oldStrokeWidth
    paint.textSize = oldTextSize
    paint.alpha = oldAlpha
    paint.isFakeBoldText = oldFakeBold
    paint.textAlign = oldTextAlign
}
