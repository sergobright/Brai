package world.brightos.brai.braicmd

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

// Regression: ISSUE-013 — очередь с неверным ключом продолжала фоновую отправку по таймеру и сети.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
@RunWith(RobolectricTestRunner::class)
class BlockedQueueRetryRegression1Test {
    private val context get() = RuntimeEnvironment.getApplication()

    @Before
    @After
    fun resetState() {
        File(context.filesDir, "pending-recordings").deleteRecursively()
        QueueRetryStore(context).reset()
        BraiCmdBus.post(RecorderState.Idle)
    }

    @Test
    fun scheduledRetryDoesNotWakeAQueueBlockedByUserConfiguration() {
        File(context.filesDir, "pending-recordings/blocked.m4a").apply {
            parentFile?.mkdirs()
            writeBytes(ByteArray(1_024) { 1 })
        }
        QueueRetryStore(context).recordBlocked(System.currentTimeMillis())

        assertFalse(RecordingService.retryPending(context, QueueRetryTrigger.Scheduled))
        assertFalse(RecordingService.retryPending(context, QueueRetryTrigger.Network))
        assertNull(shadowOf(context).nextStartedService)
    }
}

class QueueUploadHandoffTest {
    @Test
    fun cleanupFinishesBeforeTheDeferredOwnerCanStart() {
        val handoff = QueueUploadHandoff()
        assertTrue(handoff.tryBegin())
        assertFalse(handoff.tryBegin())
        assertTrue(handoff.deferIfActive("account-b", QueueRetryTrigger.Manual))

        val cleanupStarted = CountDownLatch(1)
        val releaseCleanup = CountDownLatch(1)
        val deferredOwner = AtomicReference<String?>()
        val finisher = thread {
            handoff.finish { ownerId ->
                deferredOwner.set(ownerId)
                cleanupStarted.countDown()
                assertTrue(releaseCleanup.await(2, TimeUnit.SECONDS))
            }
        }
        assertTrue(cleanupStarted.await(2, TimeUnit.SECONDS))

        val startAttempted = CountDownLatch(1)
        val startFinished = CountDownLatch(1)
        val startResult = AtomicReference<Boolean>()
        val starter = thread {
            startAttempted.countDown()
            startResult.set(handoff.tryBegin())
            startFinished.countDown()
        }
        assertTrue(startAttempted.await(2, TimeUnit.SECONDS))
        assertFalse(startFinished.await(100, TimeUnit.MILLISECONDS))

        releaseCleanup.countDown()
        finisher.join(2_000)
        starter.join(2_000)
        assertEquals("account-b", deferredOwner.get())
        assertEquals(true, startResult.get())
        handoff.finish { }
    }
}
