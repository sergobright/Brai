package world.brightos.brai.braicmd

import world.brightos.brai.capabilities.BraiAccessibilityService
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin

internal data class OverlayAnchor(
    val x: Int,
    val y: Int,
    val size: Int
)

internal data class OverlayPoint(
    val x: Int,
    val y: Int
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

    fun radialActionPositions(hub: OverlayAnchor, main: OverlayAnchor, actionSize: Int, count: Int): List<OverlayPoint> {
        val baseRadius = hub.size / 2 + actionSize / 2 + service.dp(16)
        val maxRadius = baseRadius + service.dp(112)
        val step = service.dp(8).coerceAtLeast(1)
        val angleSets = listOf(
            listOf(-90.0, -18.0, 54.0, 126.0, 198.0),
            sideArcAngles(hub)
        )
        for (angles in angleSets) {
            var radius = baseRadius
            while (radius <= maxRadius) {
                val positions = positionsFor(hub, actionSize, radius, angles, count)
                if (positionsFit(positions, main, actionSize)) return positions
                radius += step
            }
        }
        return positionsFor(hub, actionSize, maxRadius, sideArcAngles(hub), count)
    }

    private fun cancelAxisPosition(preferred: Int, fallback: Int, maxPosition: Int): Int {
        val edge = service.dp(8)
        val upper = max(edge, maxPosition - edge)
        val raw = if (preferred >= edge) preferred else fallback
        return raw.coerceIn(edge, upper)
    }

    private fun sideArcAngles(hub: OverlayAnchor): List<Double> {
        val hubCenterX = hub.x + hub.size / 2
        return if (hubCenterX < service.resources.displayMetrics.widthPixels / 2) {
            listOf(-80.0, -40.0, 0.0, 40.0, 80.0)
        } else {
            listOf(-100.0, -140.0, 180.0, 140.0, 100.0)
        }
    }

    private fun positionsFor(
        hub: OverlayAnchor,
        actionSize: Int,
        radius: Int,
        angles: List<Double>,
        count: Int
    ): List<OverlayPoint> {
        val edge = service.dp(8)
        val maxX = max(edge, service.resources.displayMetrics.widthPixels - actionSize - edge)
        val maxY = max(edge, service.resources.displayMetrics.heightPixels - actionSize - edge)
        val centerX = hub.x + hub.size / 2
        val centerY = hub.y + hub.size / 2
        return angles.take(count).map { degrees ->
            val radians = degrees * PI / 180.0
            OverlayPoint(
                x = (centerX + cos(radians) * radius - actionSize / 2.0).roundToInt().coerceIn(edge, maxX),
                y = (centerY + sin(radians) * radius - actionSize / 2.0).roundToInt().coerceIn(edge, maxY)
            )
        }
    }

    private fun positionsFit(positions: List<OverlayPoint>, main: OverlayAnchor, actionSize: Int): Boolean {
        val gap = service.dp(6)
        val mainRect = OverlayRect(main.x, main.y, main.x + main.size, main.y + main.size)
        val rects = positions.map { OverlayRect(it.x, it.y, it.x + actionSize, it.y + actionSize) }
        if (rects.any { it.intersects(mainRect, gap) }) return false
        for (index in rects.indices) {
            for (other in index + 1 until rects.size) {
                if (rects[index].intersects(rects[other], gap)) return false
            }
        }
        return true
    }

    private data class OverlayRect(
        val left: Int,
        val top: Int,
        val right: Int,
        val bottom: Int
    ) {
        fun intersects(other: OverlayRect, gap: Int): Boolean =
            left - gap < other.right &&
                right + gap > other.left &&
                top - gap < other.bottom &&
                bottom + gap > other.top
    }
}
