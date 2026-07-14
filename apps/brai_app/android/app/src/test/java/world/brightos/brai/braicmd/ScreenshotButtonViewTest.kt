package world.brightos.brai.braicmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenshotButtonViewTest {
    @Test
    fun floatingButtonMarkerUsesOnlyFirstVisibleLetter() {
        assertEquals("", normalizeFloatingButtonMarker(null))
        assertEquals("", normalizeFloatingButtonMarker("   "))
        assertEquals("V", normalizeFloatingButtonMarker(" v"))
        assertEquals("D", normalizeFloatingButtonMarker(" dev"))
        assertEquals("A", normalizeFloatingButtonMarker("abc"))
    }

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
    fun successfulActionReplacesItsGlyphWithTheCleanCheckState() {
        assertFalse(shouldDrawContextActionGlyph(ContextButtonGlyph.Image, RecorderState.InboxDelivered()))
    }

    @Test
    fun queueBadgeShowsOnlyFailedAudioCount() {
        assertEquals(QueueBadgeState(2), resolveQueueBadgeState(failedAudioCount = 2))
        assertNull(resolveQueueBadgeState(failedAudioCount = 0))
        assertNull(resolveQueueBadgeState(failedAudioCount = -1))
    }
}
