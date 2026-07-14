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
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class ScreenshotInboxStoreTest {
    private val context get() = RuntimeEnvironment.getApplication()

    @Before
    @After
    fun cleanQueue() {
        File(context.filesDir, "pending-screenshot-inbox").deleteRecursively()
        File(context.filesDir, "failed-screenshot-inbox").deleteRecursively()
        File(context.filesDir, "pending-recordings").deleteRecursively()
        context.getSharedPreferences(AppConstants.PREFS, 0).edit().clear().commit()
        context.getSharedPreferences("brai_cmd_secure", 0).edit().clear().commit()
    }

    @Test
    fun screenshotSurvivesReloadUntilExplicitCompletion() {
        val bytes = byteArrayOf(1, 2, 3, 4)
        val source = File(context.cacheDir, "captured-${System.nanoTime()}.png").apply { writeBytes(bytes) }

        val queued = requireNotNull(ScreenshotInboxStore.enqueue(context, source))
        val idempotencyKey = queued.name

        assertFalse(source.exists())
        assertArrayEquals(bytes, queued.readBytes())
        assertEquals(QueueOwnerStore.current(context).ownerId, QueueOwnerStore.readOwnerId(queued))
        assertEquals(idempotencyKey, ScreenshotInboxStore.list(context).single().name)
        assertEquals(idempotencyKey, ScreenshotInboxStore.list(context).single().name)

        assertTrue(ScreenshotInboxStore.delete(queued))
        assertTrue(ScreenshotInboxStore.list(context).isEmpty())
        assertFalse(QueueOwnerStore.sidecar(queued).exists())
    }

    @Test
    fun accountSwitchDoesNotRewriteScreenshotOwner() {
        val config = ConfigStore(context)
        config.beginAccountCredentialMode("account-a")
        val source = File(context.cacheDir, "captured-${System.nanoTime()}.png").apply { writeBytes(byteArrayOf(1)) }
        val queued = requireNotNull(ScreenshotInboxStore.enqueue(context, source))
        val accountAOwner = requireNotNull(QueueOwnerStore.readOwnerId(queued))

        config.beginAccountCredentialMode("account-b")

        assertFalse(accountAOwner == QueueOwnerStore.current(context).ownerId)
        assertEquals(accountAOwner, QueueOwnerStore.readOwnerId(queued))
    }

    @Test
    fun unownedFileAlreadyInsideQueueFailsClosedIntoQuarantine() {
        val legacy = File(context.filesDir, "pending-screenshot-inbox/legacy.png").apply {
            parentFile?.mkdirs()
            writeBytes(byteArrayOf(1, 2, 3))
        }

        assertEquals(null, ScreenshotInboxStore.enqueue(context, legacy))
        assertFalse(legacy.exists())
        assertTrue(File(context.filesDir, "failed-screenshot-inbox/legacy.png").isFile)
    }

    @Test
    fun delayedRecordingStartCannotCrossAnAccountSwitch() {
        val config = ConfigStore(context)
        config.beginAccountCredentialMode("account-a")
        val ownerA = QueueOwnerStore.current(context)
        val screenshot = File(context.cacheDir, "captured-${System.nanoTime()}.png").apply {
            writeBytes(byteArrayOf(1, 2, 3))
        }
        RecordingService.start(context, screenshotFile = screenshot, owner = ownerA)
        val startIntent = requireNotNull(shadowOf(context).nextStartedService)
        assertEquals(ownerA.ownerId, RecordingService.capturedOwnerIdFromIntent(startIntent))

        config.beginAccountCredentialMode("account-b")
        Robolectric.buildService(RecordingService::class.java).create().get()
            .onStartCommand(startIntent, 0, 1)

        assertFalse(screenshot.exists())
        assertTrue(File(context.filesDir, "pending-recordings").listFiles().isNullOrEmpty())
        assertTrue(BraiCmdBus.latest is RecorderState.Error)
    }

    @Test
    fun completedScreenshotCannotCrossAnAccountSwitch() {
        val config = ConfigStore(context)
        config.beginAccountCredentialMode("account-a")
        val ownerA = QueueOwnerStore.current(context)
        val screenshot = File(context.cacheDir, "captured-${System.nanoTime()}.png").apply {
            writeBytes(byteArrayOf(1, 2, 3))
        }

        config.beginAccountCredentialMode("account-b")

        assertFalse(RecordingService.enqueueScreenshot(context, screenshot, ownerA))
        assertFalse(screenshot.exists())
        assertTrue(ScreenshotInboxStore.list(context).isEmpty())
    }
}
