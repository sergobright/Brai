package world.brightos.brai.braicmd

import java.io.File
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ScreenshotInboxStoreTest {
    private val context get() = RuntimeEnvironment.getApplication()

    @Before
    @After
    fun cleanQueue() {
        File(context.filesDir, "pending-screenshot-inbox").deleteRecursively()
        File(context.filesDir, "failed-screenshot-inbox").deleteRecursively()
    }

    @Test
    fun screenshotSurvivesReloadUntilExplicitCompletion() {
        val bytes = byteArrayOf(1, 2, 3, 4)
        val source = File(context.cacheDir, "captured-${System.nanoTime()}.png").apply { writeBytes(bytes) }

        val queued = requireNotNull(ScreenshotInboxStore.enqueue(context, source))
        val idempotencyKey = queued.name

        assertFalse(source.exists())
        assertArrayEquals(bytes, queued.readBytes())
        assertEquals(idempotencyKey, ScreenshotInboxStore.list(context).single().name)
        assertEquals(idempotencyKey, ScreenshotInboxStore.list(context).single().name)

        assertTrue(ScreenshotInboxStore.delete(queued))
        assertTrue(ScreenshotInboxStore.list(context).isEmpty())
    }
}
