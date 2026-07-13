package world.brightos.brai.braicmd

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class RecordingArchiveStoreTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val queueDir get() = File(context.filesDir, "pending-recordings")
    private val processedDir get() = File(context.filesDir, "processed-recordings")

    @Before
    @After
    fun cleanRecordings() {
        queueDir.deleteRecursively()
        processedDir.deleteRecursively()
        context.getSharedPreferences(AppConstants.PREFS, 0).edit().clear().commit()
    }

    @Test
    fun processedRetentionLimitDoesNotPruneQueue() {
        val config = ConfigStore(context)
        config.processedAudioRetentionEnabled = true
        config.processedAudioRetentionLimit = 1
        queueDir.mkdirs()
        val queuedOne = audio("queued-one")
        val queuedTwo = audio("queued-two")
        val processedOne = audio("processed-one")
        val processedTwo = audio("processed-two")

        assertTrue(RecordingArchiveStore.onAudioProcessed(context, processedOne))
        assertTrue(RecordingArchiveStore.onAudioProcessed(context, processedTwo))

        assertTrue(queuedOne.isFile)
        assertTrue(queuedTwo.isFile)
        assertEquals(2, RecordingArchiveStore.listJson(context).countStatus("queued"))
        assertEquals(1, RecordingArchiveStore.listJson(context).countStatus("processed"))
    }

    @Test
    fun changingRetentionImmediatelyPrunesProcessedAudioOnly() {
        val config = ConfigStore(context)
        config.processedAudioRetentionEnabled = true
        config.processedAudioRetentionLimit = 5
        queueDir.mkdirs()
        val queued = audio("queued")
        repeat(5) { index ->
            assertTrue(RecordingArchiveStore.onAudioProcessed(context, audio("processed-$index")))
        }

        config.processedAudioRetentionLimit = 3
        RecordingArchiveStore.reconcileProcessedRetention(context)

        assertTrue(queued.isFile)
        assertEquals(1, RecordingArchiveStore.listJson(context).countStatus("queued"))
        assertEquals(3, RecordingArchiveStore.listJson(context).countStatus("processed"))
    }

    private fun audio(name: String): File =
        queueDir.resolve("$name.m4a").apply {
            writeBytes(byteArrayOf(1))
            RecordingArchiveStore.saveNewMetadata(this)
        }

    private fun com.getcapacitor.JSArray.countStatus(status: String): Int {
        var count = 0
        for (index in 0 until length()) {
            if (getJSONObject(index).optString("status") == status) count += 1
        }
        return count
    }
}
