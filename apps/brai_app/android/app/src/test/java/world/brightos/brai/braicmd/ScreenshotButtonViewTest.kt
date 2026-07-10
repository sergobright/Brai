package world.brightos.brai.braicmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenshotButtonViewTest {
    @Test
    fun actionGlyphIsAlwaysPartOfTheRecordingAndUploadingLayers() {
        listOf(
            ContextButtonGlyph.Idea,
            ContextButtonGlyph.Image,
            ContextButtonGlyph.ImageMic,
            ContextButtonGlyph.Chat,
            ContextButtonGlyph.Save
        ).forEach { glyph -> assertTrue(shouldDrawContextActionGlyph(glyph)) }
    }

    @Test
    fun hubVisualsDoNotDrawAnExtraActionGlyph() {
        assertFalse(shouldDrawContextActionGlyph(ContextButtonGlyph.Logo))
        assertFalse(shouldDrawContextActionGlyph(ContextButtonGlyph.Close))
    }

    @Test
    fun queueBadgeUsesRedForTransportAndGreenForReadyText() {
        assertEquals(
            QueueBadgeState(2, QueueBadgeTone.Pending),
            resolveQueueBadgeState(count = 2, ready = false)
        )
        assertEquals(
            QueueBadgeState(3, QueueBadgeTone.Ready),
            resolveQueueBadgeState(count = 3, ready = true)
        )
        assertNull(resolveQueueBadgeState(count = 0, ready = false))
    }
}
