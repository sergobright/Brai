package world.brightos.brai.braicmd

import kotlin.math.hypot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OverlayGeometryTest {
    private val bounds = OverlayBounds(left = 24, top = 90, right = 1056, bottom = 2180)

    @Test
    fun keepsHubFixedAndUsesOneRadiusPerLayoutAtCenterEdgeAndCorner() {
        val hubs = listOf(
            OverlayAnchor(x = 471, y = 980, size = 138),
            OverlayAnchor(x = 894, y = 1670, size = 138),
            OverlayAnchor(x = 894, y = 98, size = 138)
        )
        val layouts = hubs.map { hub ->
            assertNotNull(RadialActionLayout.layout(bounds, hub, 110, 5, 5, 18))
            RadialActionLayout.layout(bounds, hub, 110, 5, 5, 18)!!
        }

        layouts.forEach { assertLayoutIsVisibleAndSeparated(it, 110, 18) }
        layouts.forEachIndexed { index, layout -> assertEquals(hubs[index], layout.hub) }
        assertTrue(layouts[2].radius >= layouts[0].radius)
    }

    @Test
    fun keepsRadiusStableForFewerEnabledActions() {
        val hub = OverlayAnchor(x = 894, y = 1200, size = 138)
        val radii = (1..5).map { count ->
            RadialActionLayout.layout(bounds, hub, 110, count, 5, 18)!!.radius
        }

        assertEquals(1, radii.distinct().size)
    }

    @Test
    fun alignsTheRightEdgeArcOnAHorizontalAxis() {
        val hub = OverlayAnchor(x = 894, y = 980, size = 138)
        val layout = RadialActionLayout.layout(bounds, hub, 110, 5, 5, 18)!!
        val hubCenterX = hub.x + hub.size / 2.0
        val hubCenterY = hub.y + hub.size / 2.0
        val centers = layout.actions.map { Pair(it.x + 55.0, it.y + 55.0) }

        assertEquals(hubCenterY, centers[2].second, 1.0)
        assertEquals(hubCenterY * 2.0, centers[0].second + centers[4].second, 1.0)
        assertEquals(hubCenterY * 2.0, centers[1].second + centers[3].second, 1.0)
        assertEquals(hubCenterX, centers[0].first, 1.0)
        assertEquals(centers[0].first, centers[4].first, 1.0)
        assertEquals(centers[1].first, centers[3].first, 1.0)
    }

    @Test
    fun putsOneRightEdgeActionAboveOrBelowInsteadOfToTheLeft() {
        val hub = OverlayAnchor(x = 894, y = 1670, size = 138)
        val layout = RadialActionLayout.layout(bounds, hub, 110, 1, 5, 18)!!
        val action = layout.actions.single()

        assertEquals(hub.x + hub.size / 2.0, action.x + 55.0, 1.0)
        assertTrue(action.y + 55.0 < hub.y + hub.size / 2.0)
    }

    @Test
    fun keepsOneCornerActionAtTheBaseRadiusWhenTheVerticalPositionIsBlocked() {
        val hub = OverlayAnchor(x = 894, y = 98, size = 138)
        val main = OverlayAnchor(x = 880, y = 276, size = 150)
        val layout = RadialActionLayout.layout(bounds, hub, 110, 1, 5, 18, main)!!
        val action = layout.actions.single()

        assertEquals(RadialActionLayout.fixedRadius(138, 110, 5, 18), layout.radius)
        assertEquals(hub.y + hub.size / 2.0, action.y + 55.0, 1.0)
        assertTrue(action.x + 55.0 < hub.x + hub.size / 2.0)
    }

    @Test
    fun supportsConfiguredSizeRangeWithoutOverlap() {
        listOf(0.7, 1.0, 1.3).forEach { scale ->
            val hubSize = (138 * scale).toInt()
            val actionSize = (110 * scale).toInt()
            val hub = OverlayAnchor(bounds.right - hubSize - 24, bounds.top + 8, hubSize)
            val gap = (18 * scale).toInt().coerceAtLeast(1)
            val layout = RadialActionLayout.layout(bounds, hub, actionSize, 5, 5, gap)

            assertNotNull("missing layout at scale $scale", layout)
            assertLayoutIsVisibleAndSeparated(layout!!, actionSize, gap)
        }
    }

    @Test
    fun keepsActionsAwayFromTheMainDictationButton() {
        val hub = OverlayAnchor(x = 894, y = 1580, size = 138)
        val main = OverlayAnchor(x = 880, y = 1760, size = 150)
        val layout = RadialActionLayout.layout(bounds, hub, 110, 5, 5, 18, main)

        assertNotNull(layout)
        assertLayoutIsVisibleAndSeparated(layout!!, 110, 18)
        layout.actions.forEach { point ->
            assertTrue(
                point.x + 110 <= main.x - 18 ||
                    point.x >= main.x + main.size + 18 ||
                    point.y + 110 <= main.y - 18 ||
                    point.y >= main.y + main.size + 18
            )
        }
    }

    @Test
    fun returnsNoPartialLayoutWhenBoundsCannotFitTheMenu() {
        val layout = RadialActionLayout.layout(
            bounds = OverlayBounds(left = 0, top = 0, right = 220, bottom = 220),
            hub = OverlayAnchor(x = 80, y = 80, size = 60),
            actionSize = 70,
            count = 5,
            maxActionCount = 5,
            collisionGap = 12
        )

        assertNull(layout)
    }

    @Test
    fun centersStatusBubbleOnItsButtonAndClampsItToTheScreen() {
        assertEquals(
            500,
            centeredStatusBubbleY(
                buttonY = 480,
                buttonHeight = 80,
                bubbleHeight = 40,
                screenHeight = 1_000,
                margin = 8
            )
        )
        assertEquals(8, centeredStatusBubbleY(0, 40, 80, 1_000, 8))
        assertEquals(912, centeredStatusBubbleY(980, 40, 80, 1_000, 8))
    }

    private fun assertLayoutIsVisibleAndSeparated(layout: RadialMenuLayout, actionSize: Int, gap: Int) {
        val hubCenter = Pair(layout.hub.x + layout.hub.size / 2.0, layout.hub.y + layout.hub.size / 2.0)
        val centers = layout.actions.map { point -> Pair(point.x + actionSize / 2.0, point.y + actionSize / 2.0) }
        val radii = centers.map { center -> distance(center, hubCenter) }
        assertTrue(radii.maxOrNull()!! - radii.minOrNull()!! <= 1.5)
        assertTrue(radii.all { kotlin.math.abs(it - layout.radius) <= 1.5 })
        layout.actions.forEach { point ->
            assertTrue(point.x >= bounds.left)
            assertTrue(point.y >= bounds.top)
            assertTrue(point.x + actionSize <= bounds.right)
            assertTrue(point.y + actionSize <= bounds.bottom)
        }
        centers.forEachIndexed { index, center ->
            centers.drop(index + 1).forEach { other ->
                assertTrue(distance(center, other) >= actionSize + gap)
            }
        }
    }

    private fun distance(first: Pair<Double, Double>, second: Pair<Double, Double>): Double =
        hypot(first.first - second.first, first.second - second.second)
}
