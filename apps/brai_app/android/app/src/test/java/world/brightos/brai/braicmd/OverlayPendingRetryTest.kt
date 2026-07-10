package world.brightos.brai.braicmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class OverlayPendingRetryTest {
    @Before
    fun resetRetryState() {
        QueueRetryStore(RuntimeEnvironment.getApplication()).reset()
    }

    @Test
    fun retryDelayUsesCappedLadder() {
        assertEquals(15_000L, queueRetryDelayMillis(1))
        assertEquals(60_000L, queueRetryDelayMillis(2))
        assertEquals(5 * 60_000L, queueRetryDelayMillis(3))
        assertEquals(15 * 60_000L, queueRetryDelayMillis(4))
        assertEquals(60 * 60_000L, queueRetryDelayMillis(5))
        assertEquals(60 * 60_000L, queueRetryDelayMillis(99))
    }

    @Test
    fun transientAndBlockedFailuresUseTheSamePersistentSchedule() {
        val context = RuntimeEnvironment.getApplication()
        val first = QueueRetryStore(context).recordTransient(1_000L)
        val second = QueueRetryStore(context).recordTransient(2_000L)

        assertEquals(1, first.failureCount)
        assertEquals(16_000L, first.nextRetryAtMillis)
        assertEquals(2, second.failureCount)
        assertEquals(62_000L, second.nextRetryAtMillis)

        val blocked = QueueRetryStore(context).recordBlocked(3_000L)
        assertEquals(3, blocked.failureCount)
        assertEquals(303_000L, blocked.nextRetryAtMillis)
        assertTrue(QueueRetryStore(context).isBlocked)
        assertEquals(300_000L, QueueRetryStore(context).remainingDelayMillis(3_000L))

        QueueRetryStore(context).allowImmediate()
        assertFalse(QueueRetryStore(context).isBlocked)
        assertEquals(0L, QueueRetryStore(context).remainingDelayMillis(3_000L))
    }
}
