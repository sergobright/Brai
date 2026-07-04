package world.brightos.brai.airwhisper

import world.brightos.brai.capabilities.BraiAccessibilityService
import kotlin.math.max

internal data class OverlayAnchor(
    val x: Int,
    val y: Int,
    val size: Int
)

internal class OverlayGeometry(
    private val service: BraiAccessibilityService,
    private val mainSizePx: Int,
    private val screenshotSizePx: Int,
    private val screenshotGapPx: Int,
    private val cancelSizePx: Int,
    private val cancelGapPx: Int
) {
    fun defaultButtonX(): Int =
        service.resources.displayMetrics.widthPixels - mainSizePx - service.dp(18)

    fun defaultButtonY(): Int =
        service.resources.displayMetrics.heightPixels - mainSizePx - service.dp(180)

    fun screenshotButtonX(buttonX: Int): Int {
        val edge = service.dp(8)
        val maxPosition = service.resources.displayMetrics.widthPixels - screenshotSizePx - edge
        return (buttonX + ((mainSizePx - screenshotSizePx) / 2)).coerceIn(edge, max(edge, maxPosition))
    }

    fun screenshotButtonY(buttonY: Int): Int =
        max(service.dp(8), buttonY - screenshotSizePx - screenshotGapPx)

    fun cancelX(anchor: OverlayAnchor): Int =
        cancelAxisPosition(
            preferred = anchor.x - cancelSizePx - cancelGapPx,
            fallback = anchor.x + anchor.size + cancelGapPx,
            maxPosition = service.resources.displayMetrics.widthPixels - cancelSizePx
        )

    fun cancelY(anchor: OverlayAnchor): Int =
        cancelAxisPosition(
            preferred = anchor.y + ((anchor.size - cancelSizePx) / 2),
            fallback = anchor.y + ((anchor.size - cancelSizePx) / 2),
            maxPosition = service.resources.displayMetrics.heightPixels - cancelSizePx
        )

    private fun cancelAxisPosition(preferred: Int, fallback: Int, maxPosition: Int): Int {
        val edge = service.dp(8)
        val upper = max(edge, maxPosition - edge)
        val raw = if (preferred >= edge) preferred else fallback
        return raw.coerceIn(edge, upper)
    }
}
