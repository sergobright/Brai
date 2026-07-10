package world.brightos.brai.braicmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.hypot

class OverlayGeometryTest {
    @Test
    fun keepsRightEdgeMenuCompactVisibleAndSeparated() {
        val bounds = OverlayBounds(left = 24, top = 90, right = 1056, bottom = 2180)
        val hub = OverlayAnchor(x = 894, y = 1670, size = 138)
        val actionSize = 110
        val baseRadius = 148
        val maxRadius = 292

        val positions = RadialActionLayout.positions(
            bounds = bounds,
            hub = hub,
            actionSize = actionSize,
            count = 5,
            baseRadius = baseRadius,
            maxRadius = maxRadius,
            collisionGap = 18
        )

        assertEquals(5, positions.size)
        assertLayoutIsVisibleAndSeparated(positions, bounds, hub, actionSize, 18)
        val hubCenterX = hub.x + hub.size / 2.0
        val hubCenterY = hub.y + hub.size / 2.0
        val maxDistance = positions.maxOf { point ->
            hypot(point.x + actionSize / 2.0 - hubCenterX, point.y + actionSize / 2.0 - hubCenterY)
        }
        assertTrue("menu radius $maxDistance must stay compact", maxDistance <= baseRadius + 50)
    }

    @Test
    fun keepsCornerMenuInsideSystemSafeBounds() {
        val bounds = OverlayBounds(left = 24, top = 90, right = 1056, bottom = 2180)
        val hub = OverlayAnchor(x = 894, y = 98, size = 138)
        val actionSize = 110

        val positions = RadialActionLayout.positions(
            bounds = bounds,
            hub = hub,
            actionSize = actionSize,
            count = 5,
            baseRadius = 148,
            maxRadius = 292,
            collisionGap = 18
        )

        assertEquals(5, positions.size)
        assertLayoutIsVisibleAndSeparated(positions, bounds, hub, actionSize, 18)
    }

    @Test
    fun returnsNoPartialLayoutWhenBoundsCannotFitTheMenu() {
        val positions = RadialActionLayout.positions(
            bounds = OverlayBounds(left = 0, top = 0, right = 220, bottom = 220),
            hub = OverlayAnchor(x = 80, y = 80, size = 60),
            actionSize = 70,
            count = 5,
            baseRadius = 70,
            maxRadius = 100,
            collisionGap = 12
        )

        assertTrue(positions.isEmpty())
    }

    private fun assertLayoutIsVisibleAndSeparated(
        positions: List<OverlayPoint>,
        bounds: OverlayBounds,
        hub: OverlayAnchor,
        actionSize: Int,
        gap: Int
    ) {
        val rects = positions.map { TestRect(it.x, it.y, it.x + actionSize, it.y + actionSize) }
        val hubCenterX = hub.x + hub.size / 2.0
        val hubCenterY = hub.y + hub.size / 2.0
        val radii = positions.map { point ->
            hypot(point.x + actionSize / 2.0 - hubCenterX, point.y + actionSize / 2.0 - hubCenterY)
        }
        assertTrue(radii.maxOrNull()!! - radii.minOrNull()!! <= 1.5)
        rects.forEach { rect ->
            assertTrue(rect.left >= bounds.left)
            assertTrue(rect.top >= bounds.top)
            assertTrue(rect.right <= bounds.right)
            assertTrue(rect.bottom <= bounds.bottom)
        }
        val centers = positions.map { point ->
            Pair(point.x + actionSize / 2.0, point.y + actionSize / 2.0)
        }
        val hubCenter = Pair(hub.x + hub.size / 2.0, hub.y + hub.size / 2.0)
        centers.forEach { center ->
            assertTrue(distance(center, hubCenter) >= hub.size / 2.0 + actionSize / 2.0 + gap)
        }
        centers.forEachIndexed { index, center ->
            centers.drop(index + 1).forEach { other -> assertTrue(distance(center, other) >= actionSize + gap) }
        }
    }

    private fun distance(first: Pair<Double, Double>, second: Pair<Double, Double>): Double =
        hypot(first.first - second.first, first.second - second.second)

    private data class TestRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    }
}
