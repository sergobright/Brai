package world.brightos.brai.braicmd

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream

@RunWith(AndroidJUnit4::class)
class OverlayScreenshotInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun rendersEveryContextGlyphToPng() {
        val size = 144
        val gap = 16
        val glyphs = ContextButtonGlyph.entries
        val bitmap = Bitmap.createBitmap(glyphs.size * (size + gap) + gap, size + gap * 2, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap).apply { drawColor(Color.WHITE) }

        glyphs.forEachIndexed { index, glyph ->
            val view = ScreenshotButtonView(context).apply { setGlyph(glyph) }
            drawView(view, canvas, gap + index * (size + gap), gap, size)
        }

        assertTrue(bitmapHasNonBackgroundPixels(bitmap, Color.WHITE))
        assertPngWritten("overlay-glyphs.png", bitmap)
    }

    @Test
    fun rendersRadialMenusAtEveryScreenCorner() {
        val width = 1080
        val height = 1920
        val hubSize = 144
        val actionSize = 112
        val bounds = OverlayBounds(0, 0, width, height)
        val hubs = listOf(
            OverlayAnchor(0, 0, hubSize),
            OverlayAnchor(width - hubSize, 0, hubSize),
            OverlayAnchor(0, height - hubSize, hubSize),
            OverlayAnchor(width - hubSize, height - hubSize, hubSize)
        )

        hubs.forEachIndexed { index, hub ->
            val layout = RadialActionLayout.layout(bounds, hub, actionSize, 5, 5, 12)
            assertNotNull("corner $index must produce a layout", layout)
            layout!!.actions.forEach { point ->
                assertTrue(point.x >= bounds.left && point.y >= bounds.top)
                assertTrue(point.x + actionSize <= bounds.right && point.y + actionSize <= bounds.bottom)
            }

            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap).apply { drawColor(Color.WHITE) }
            drawView(ScreenshotButtonView(context), canvas, hub.x, hub.y, hubSize)
            layout.actions.forEachIndexed { actionIndex, point ->
                val glyph = ContextButtonGlyph.entries[actionIndex + 2]
                val view = ScreenshotButtonView(context).apply { setGlyph(glyph) }
                drawView(view, canvas, point.x, point.y, actionSize)
            }
            assertPngWritten("overlay-radial-corner-$index.png", bitmap)
        }
    }

    private fun drawView(view: View, canvas: Canvas, left: Int, top: Int, size: Int) {
        val spec = View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY)
        view.measure(spec, spec)
        view.layout(0, 0, size, size)
        canvas.save()
        canvas.translate(left.toFloat(), top.toFloat())
        view.draw(canvas)
        canvas.restore()
    }

    private fun assertPngWritten(name: String, bitmap: Bitmap) {
        val directory = File(context.getExternalFilesDir(null), "overlay-screenshots").apply { mkdirs() }
        val output = File(directory, name)
        FileOutputStream(output).use { stream ->
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream))
        }
        assertTrue(output.length() > 0)
        assertEquals(0x89, output.inputStream().use { it.read() })
    }

    private fun bitmapHasNonBackgroundPixels(bitmap: Bitmap, background: Int): Boolean {
        for (y in 0 until bitmap.height step 8) {
            for (x in 0 until bitmap.width step 8) {
                if (bitmap.getPixel(x, y) != background) return true
            }
        }
        return false
    }
}
