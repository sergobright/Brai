package world.brightos.brai.capabilities

import android.graphics.Bitmap
import android.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BraiAccessibilityServiceTest {
    @Test
    fun dictationButtonRequiresBothEditableFieldAndVisibleKeyboard() {
        assertTrue(shouldShowDictationButton(hasEditableField = true, inputMethodVisible = true))
        assertFalse(shouldShowDictationButton(hasEditableField = true, inputMethodVisible = false))
        assertFalse(shouldShowDictationButton(hasEditableField = false, inputMethodVisible = true))
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
}
