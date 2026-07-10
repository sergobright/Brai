package world.brightos.brai.braicmd

import android.os.Build
import android.view.WindowInsets
import android.view.WindowManager
import world.brightos.brai.capabilities.BraiAccessibilityService
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
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

internal data class OverlayBounds(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int
) {
    fun inset(value: Int): OverlayBounds = OverlayBounds(
        left = left + value,
        top = top + value,
        right = max(left + value, right - value),
        bottom = max(top + value, bottom - value)
    )
}

internal class OverlayGeometry(
    private val service: BraiAccessibilityService,
    private val mainSizePx: Int,
    private val screenshotSizePx: Int,
    private val screenshotGapPx: Int,
    private val cancelSizePx: Int,
    private val cancelGapPx: Int
) {
    fun defaultButtonX(): Int = visibleBounds().right - mainSizePx - service.dp(18)

    fun defaultButtonY(): Int = visibleBounds().bottom - mainSizePx - service.dp(132)

    fun screenshotButtonX(buttonX: Int): Int {
        val bounds = visibleBounds().inset(service.dp(8))
        val maxPosition = max(bounds.left, bounds.right - screenshotSizePx)
        return (buttonX + ((mainSizePx - screenshotSizePx) / 2)).coerceIn(bounds.left, maxPosition)
    }

    fun screenshotButtonY(buttonY: Int): Int {
        val bounds = visibleBounds().inset(service.dp(8))
        val maxPosition = max(bounds.top, bounds.bottom - screenshotSizePx)
        return (buttonY - screenshotSizePx - screenshotGapPx).coerceIn(bounds.top, maxPosition)
    }

    fun cancelX(anchor: OverlayAnchor): Int =
        cancelAxisPosition(
            preferred = anchor.x - cancelSizePx - cancelGapPx,
            fallback = anchor.x + anchor.size + cancelGapPx,
            minPosition = visibleBounds().left,
            maxPosition = visibleBounds().right - cancelSizePx
        )

    fun cancelY(anchor: OverlayAnchor): Int =
        cancelAxisPosition(
            preferred = anchor.y + ((anchor.size - cancelSizePx) / 2),
            fallback = anchor.y + ((anchor.size - cancelSizePx) / 2),
            minPosition = visibleBounds().top,
            maxPosition = visibleBounds().bottom - cancelSizePx
        )

    fun radialActionPositions(hub: OverlayAnchor, main: OverlayAnchor, actionSize: Int, count: Int): List<OverlayPoint> {
        val baseRadius = hub.size / 2 + actionSize / 2 + service.dp(8)
        return RadialActionLayout.positions(
            bounds = visibleBounds().inset(service.dp(8)),
            hub = hub,
            main = main,
            actionSize = actionSize,
            count = count,
            baseRadius = baseRadius,
            maxRadius = baseRadius + service.dp(48),
            collisionGap = service.dp(6)
        )
    }

    private fun cancelAxisPosition(preferred: Int, fallback: Int, minPosition: Int, maxPosition: Int): Int {
        val edge = service.dp(8)
        val lower = minPosition + edge
        val upper = max(lower, maxPosition - edge)
        val raw = if (preferred >= lower) preferred else fallback
        return raw.coerceIn(lower, upper)
    }

    private fun visibleBounds(): OverlayBounds {
        val metrics = service.resources.displayMetrics
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return OverlayBounds(0, statusBarHeight(), metrics.widthPixels, metrics.heightPixels - navigationBarHeight())
        }
        val windowManager = service.getSystemService(WindowManager::class.java)
        val windowMetrics = windowManager.currentWindowMetrics
        val insets = windowMetrics.windowInsets.getInsetsIgnoringVisibility(
            WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
        )
        return OverlayBounds(
            left = windowMetrics.bounds.left + insets.left,
            top = windowMetrics.bounds.top + insets.top,
            right = windowMetrics.bounds.right - insets.right,
            bottom = windowMetrics.bounds.bottom - insets.bottom
        )
    }

    private fun statusBarHeight(): Int = systemDimension("status_bar_height")

    private fun navigationBarHeight(): Int = systemDimension("navigation_bar_height")

    private fun systemDimension(name: String): Int {
        val id = service.resources.getIdentifier(name, "dimen", "android")
        return if (id == 0) 0 else service.resources.getDimensionPixelSize(id)
    }
}

internal object RadialActionLayout {
    fun positions(
        bounds: OverlayBounds,
        hub: OverlayAnchor,
        main: OverlayAnchor,
        actionSize: Int,
        count: Int,
        baseRadius: Int,
        maxRadius: Int,
        collisionGap: Int
    ): List<OverlayPoint> {
        if (count <= 0) return emptyList()
        val hubCenterX = hub.x + hub.size / 2.0
        val hubCenterY = hub.y + hub.size / 2.0
        val inwardAngle = Math.toDegrees(atan2(
            (bounds.top + bounds.bottom) / 2.0 - hubCenterY,
            (bounds.left + bounds.right) / 2.0 - hubCenterX
        ))
        val mainAngle = Math.toDegrees(atan2(
            main.y + main.size / 2.0 - hubCenterY,
            main.x + main.size / 2.0 - hubCenterX
        ))
        val radiusStep = max(1, collisionGap / 2)
        var radius = baseRadius
        while (radius <= maxRadius) {
            val angleSets = listOf(
                circleAngles(count, -90.0),
                circleAngles(count, mainAngle + (180.0 / count)),
                arcAngles(count, inwardAngle, 180.0),
                arcAngles(count, inwardAngle, 144.0),
                arcAngles(count, mainAngle + 180.0, 144.0),
                arcAngles(count, inwardAngle - 36.0, 144.0),
                arcAngles(count, inwardAngle + 36.0, 144.0)
            )
            for (angles in angleSets) {
                val candidate = positionsFor(hub, actionSize, radius, angles)
                if (positionsFit(candidate, bounds, hub, main, actionSize, collisionGap)) return candidate
            }
            radius += radiusStep
        }

        return nearestRadialSlots(bounds, hub, main, actionSize, count, baseRadius, maxRadius, collisionGap)
    }

    private fun circleAngles(count: Int, start: Double): List<Double> =
        List(count) { index -> start + index * (360.0 / count) }

    private fun arcAngles(count: Int, center: Double, span: Double): List<Double> {
        if (count == 1) return listOf(center)
        val step = span / (count - 1)
        return List(count) { index -> center - span / 2.0 + index * step }
    }

    private fun positionsFor(hub: OverlayAnchor, actionSize: Int, radius: Int, angles: List<Double>): List<OverlayPoint> {
        val centerX = hub.x + hub.size / 2.0
        val centerY = hub.y + hub.size / 2.0
        return angles.map { degrees ->
            val radians = degrees * PI / 180.0
            OverlayPoint(
                x = (centerX + cos(radians) * radius - actionSize / 2.0).roundToInt(),
                y = (centerY + sin(radians) * radius - actionSize / 2.0).roundToInt()
            )
        }
    }

    private fun positionsFit(
        positions: List<OverlayPoint>,
        bounds: OverlayBounds,
        hub: OverlayAnchor,
        main: OverlayAnchor,
        actionSize: Int,
        gap: Int
    ): Boolean {
        val hubRect = OverlayRect(hub.x, hub.y, hub.x + hub.size, hub.y + hub.size)
        val mainRect = OverlayRect(main.x, main.y, main.x + main.size, main.y + main.size)
        val rects = positions.map { OverlayRect(it.x, it.y, it.x + actionSize, it.y + actionSize) }
        if (rects.any { !it.inside(bounds) || it.intersects(hubRect, gap) || it.intersects(mainRect, gap) }) return false
        for (index in rects.indices) {
            for (other in index + 1 until rects.size) {
                if (rects[index].intersects(rects[other], gap)) return false
            }
        }
        return true
    }

    private fun nearestRadialSlots(
        bounds: OverlayBounds,
        hub: OverlayAnchor,
        main: OverlayAnchor,
        actionSize: Int,
        count: Int,
        baseRadius: Int,
        maxRadius: Int,
        gap: Int
    ): List<OverlayPoint> {
        val hubCenterX = hub.x + hub.size / 2.0
        val hubCenterY = hub.y + hub.size / 2.0
        val radialCandidates = buildList {
            var radius = baseRadius
            val outerRadius = maxRadius + actionSize + gap
            while (radius <= outerRadius) {
                repeat(24) { index ->
                    addAll(positionsFor(hub, actionSize, radius, listOf(index * 15.0)))
                }
                radius += max(1, gap)
            }
        }.distinct().sortedBy { point ->
            hypot(point.x + actionSize / 2.0 - hubCenterX, point.y + actionSize / 2.0 - hubCenterY)
        }
        val selected = mutableListOf<OverlayPoint>()
        for (point in radialCandidates) {
            if (positionsFit(selected + point, bounds, hub, main, actionSize, gap)) selected += point
            if (selected.size == count) return selected
        }

        val gridStep = max(1, actionSize + gap)
        val gridCandidates = buildList {
            var y = bounds.top
            while (y + actionSize <= bounds.bottom) {
                var x = bounds.left
                while (x + actionSize <= bounds.right) {
                    add(OverlayPoint(x, y))
                    x += gridStep
                }
                y += gridStep
            }
        }.sortedBy { point ->
            hypot(point.x + actionSize / 2.0 - hubCenterX, point.y + actionSize / 2.0 - hubCenterY)
        }
        for (point in gridCandidates) {
            if (positionsFit(selected + point, bounds, hub, main, actionSize, gap)) selected += point
            if (selected.size == count) break
        }
        return selected
    }

    private data class OverlayRect(
        val left: Int,
        val top: Int,
        val right: Int,
        val bottom: Int
    ) {
        fun inside(bounds: OverlayBounds): Boolean =
            left >= bounds.left && top >= bounds.top && right <= bounds.right && bottom <= bounds.bottom

        fun intersects(other: OverlayRect, gap: Int): Boolean =
            left - gap < other.right &&
                right + gap > other.left &&
                top - gap < other.bottom &&
                bottom + gap > other.top
    }
}
