package world.brightos.brai.capabilities

import android.graphics.Bitmap
import android.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BraiAccessibilityServiceTest {
    @Test
    fun dictationButtonRequiresBothEditableFieldAndVisibleKeyboard() {
        assertTrue(shouldShowDictationButton(hasEditableField = true, inputMethodVisible = true))
        assertFalse(shouldShowDictationButton(hasEditableField = true, inputMethodVisible = false))
        assertFalse(shouldShowDictationButton(hasEditableField = false, inputMethodVisible = true))
    }

    @Test
    fun modernAndroidCapturesTheTargetWindowWithoutHidingAccessibilityOverlays() {
        assertFalse(shouldUseWindowScreenshot(sdkInt = 33, windowId = 7))
        assertTrue(shouldUseWindowScreenshot(sdkInt = 34, windowId = 7))
        assertFalse(shouldUseWindowScreenshot(sdkInt = 35, windowId = null))
    }

    @Test
    fun screenshotBitmapIsFlattenedOntoAnOpaqueBackground() {
        val source = Bitmap.createBitmap(2, 1, Bitmap.Config.ARGB_8888).apply {
            setPixel(0, 0, Color.TRANSPARENT)
            setPixel(1, 0, Color.RED)
        }

        val result = opaqueScreenshotBitmap(source)

        assertEquals(Color.RED, result.getPixel(1, 0))
        assertFalse(result.hasAlpha())
    }

    @Test
    fun hardwareScreenshotIsCopiedBeforeSoftwareComposition() {
        val software = Bitmap.createBitmap(2, 1, Bitmap.Config.ARGB_8888).apply {
            setPixel(0, 0, Color.TRANSPARENT)
            setPixel(1, 0, Color.RED)
        }
        val hardware = software.copy(Bitmap.Config.HARDWARE, false)

        val result = screenshotBitmapForStorage(hardware)

        assertEquals(Bitmap.Config.HARDWARE, hardware.config)
        assertEquals(Color.RED, result.getPixel(1, 0))
        assertFalse(result.hasAlpha())
    }
}
