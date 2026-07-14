package world.brightos.brai.braicmd

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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
    private val quarantineDir get() = File(context.filesDir, "failed-processed-recordings")

    @Before
    @After
    fun cleanRecordings() {
        queueDir.deleteRecursively()
        processedDir.deleteRecursively()
        quarantineDir.deleteRecursively()
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

    @Test
    fun accountSwitchHidesAndProtectsQueuedAndProcessedAudio() {
        val config = ConfigStore(context)
        config.processedAudioRetentionEnabled = true
        config.beginAccountCredentialMode("account-a")
        val queuedA = audio("queued-a")
        val processedA = audio("processed-a")
        assertTrue(RecordingArchiveStore.onAudioProcessed(context, processedA))
        val archivedA = requireNotNull(processedDir.listFiles()?.singleOrNull { it.name.endsWith(".m4a") })
        val accountAOwner = QueueOwnerStore.readOwnerId(archivedA)
        assertNotNull(accountAOwner)

        config.beginAccountCredentialMode("account-b")
        val queuedB = audio("queued-b")

        assertEquals(1, RecordingArchiveStore.listJson(context).countStatus("queued"))
        assertEquals(0, RecordingArchiveStore.listJson(context).countStatus("processed"))
        assertFalse(RecordingArchiveStore.delete(context, "queued:${queuedA.name}"))
        assertFalse(RecordingArchiveStore.delete(context, "processed:${archivedA.name}"))
        assertTrue(queuedA.isFile)
        assertTrue(archivedA.isFile)
        assertEquals("audio_not_found", runCatching {
            RecordingArchiveStore.download(context, "processed:${archivedA.name}")
        }.exceptionOrNull()?.message)

        config.beginAccountCredentialMode("account-a")
        assertEquals(1, RecordingArchiveStore.listJson(context).countStatus("queued"))
        assertEquals(1, RecordingArchiveStore.listJson(context).countStatus("processed"))
        assertTrue(RecordingArchiveStore.delete(context, "processed:${archivedA.name}"))
        assertFalse(archivedA.exists())
        assertFalse(QueueOwnerStore.sidecar(archivedA).exists())
        assertTrue(queuedB.isFile)
    }

    @Test
    fun processedArchiveKeepsSourceOwnerAcrossAccountSwitch() {
        val config = ConfigStore(context)
        config.processedAudioRetentionEnabled = true
        config.beginAccountCredentialMode("account-a")
        val source = audio("account-a")
        val accountAOwner = QueueOwnerStore.readOwnerId(source)

        config.beginAccountCredentialMode("account-b")
        assertTrue(RecordingArchiveStore.onAudioProcessed(context, source))

        val archived = requireNotNull(processedDir.listFiles()?.singleOrNull { it.name.endsWith(".m4a") })
        assertEquals(accountAOwner, QueueOwnerStore.readOwnerId(archived))
        assertEquals(0, RecordingArchiveStore.listJson(context).countStatus("processed"))
        config.beginAccountCredentialMode("account-a")
        assertEquals(1, RecordingArchiveStore.listJson(context).countStatus("processed"))
    }

    @Test
    fun ownerlessProcessedAudioIsQuarantinedAndNeverExposed() {
        processedDir.mkdirs()
        val legacy = processedDir.resolve("legacy.m4a").apply { writeBytes(byteArrayOf(1)) }
        File("${legacy.absolutePath}.metadata.json").writeText("{}")

        assertEquals(0, RecordingArchiveStore.listJson(context).countStatus("processed"))
        assertFalse(legacy.exists())
        assertNull(processedDir.listFiles()?.singleOrNull { it.name.endsWith(".m4a") })
        assertTrue(quarantineDir.listFiles()?.any { it.name.endsWith(".m4a") } == true)
    }

    private fun audio(name: String): File =
        queueDir.resolve("$name.m4a").apply {
            parentFile?.mkdirs()
            writeBytes(byteArrayOf(1))
            QueueOwnerStore.claim(this, QueueOwnerStore.current(context))
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
