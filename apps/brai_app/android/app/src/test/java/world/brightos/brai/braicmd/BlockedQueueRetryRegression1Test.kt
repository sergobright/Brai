package world.brightos.brai.braicmd

import java.io.File
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
