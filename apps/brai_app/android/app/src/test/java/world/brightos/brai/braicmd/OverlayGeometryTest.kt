package world.brightos.brai.braicmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.hypot

class OverlayGeometryTest {
    @Test
    fun keepsRightEdgeMenuCompactVisibleAndSeparated() {
        val bounds = OverlayBounds(left = 24, top = 90, right = 1056, bottom = 2180)
        val hub = OverlayAnchor(x = 894, y = 1670, size = 138)
        val main = OverlayAnchor(x = 870, y = 1825, size = 186)
        val actionSize = 110
        val baseRadius = 148
        val maxRadius = 292

        val positions = RadialActionLayout.positions(
            bounds = bounds,
            hub = hub,
            main = main,
            actionSize = actionSize,
            count = 5,
            baseRadius = baseRadius,
            maxRadius = maxRadius,
            collisionGap = 18
        )

        assertEquals(5, positions.size)
        assertLayoutIsVisibleAndSeparated(positions, bounds, hub, main, actionSize, 18)
        val hubCenterX = hub.x + hub.size / 2.0
        val hubCenterY = hub.y + hub.size / 2.0
        assertTrue(positions.maxOf { point ->
            hypot(point.x + actionSize / 2.0 - hubCenterX, point.y + actionSize / 2.0 - hubCenterY)
        } <= maxRadius + 2)
    }

    @Test
    fun keepsCornerMenuInsideSystemSafeBounds() {
        val bounds = OverlayBounds(left = 24, top = 90, right = 1056, bottom = 2180)
        val hub = OverlayAnchor(x = 894, y = 98, size = 138)
        val main = OverlayAnchor(x = 870, y = 253, size = 186)
        val actionSize = 110

        val positions = RadialActionLayout.positions(
            bounds = bounds,
            hub = hub,
            main = main,
            actionSize = actionSize,
            count = 5,
            baseRadius = 148,
            maxRadius = 292,
            collisionGap = 18
        )

        assertEquals(5, positions.size)
        assertLayoutIsVisibleAndSeparated(positions, bounds, hub, main, actionSize, 18)
    }

    private fun assertLayoutIsVisibleAndSeparated(
        positions: List<OverlayPoint>,
        bounds: OverlayBounds,
        hub: OverlayAnchor,
        main: OverlayAnchor,
        actionSize: Int,
        gap: Int
    ) {
        val hubRect = TestRect(hub.x, hub.y, hub.x + hub.size, hub.y + hub.size)
        val mainRect = TestRect(main.x, main.y, main.x + main.size, main.y + main.size)
        val rects = positions.map { TestRect(it.x, it.y, it.x + actionSize, it.y + actionSize) }
        rects.forEach { rect ->
            assertTrue(rect.left >= bounds.left)
            assertTrue(rect.top >= bounds.top)
            assertTrue(rect.right <= bounds.right)
            assertTrue(rect.bottom <= bounds.bottom)
            assertFalse(rect.intersects(hubRect, gap))
            assertFalse(rect.intersects(mainRect, gap))
        }
        rects.forEachIndexed { index, rect ->
            rects.drop(index + 1).forEach { other -> assertFalse(rect.intersects(other, gap)) }
        }
    }

    private data class TestRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        fun intersects(other: TestRect, gap: Int): Boolean =
            left - gap < other.right && right + gap > other.left && top - gap < other.bottom && bottom + gap > other.top
    }
}
