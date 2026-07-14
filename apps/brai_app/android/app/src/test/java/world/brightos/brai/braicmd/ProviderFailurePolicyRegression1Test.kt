package world.brightos.brai.braicmd

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

// Regression: ISSUE-009 — неверный ключ считался временной сетью и бесконечно будил очередь.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
@RunWith(RobolectricTestRunner::class)
class ProviderFailurePolicyRegression1Test {
    private val context get() = RuntimeEnvironment.getApplication()
    private val recordings get() = File(context.filesDir, "pending-recordings")

    @Before
    @After
    fun resetState() {
        listOf("pending-recordings", "failed-recordings").forEach { File(context.filesDir, it).deleteRecursively() }
        context.getSharedPreferences(AppConstants.PREFS, 0).edit().clear().commit()
        context.getSharedPreferences("brai_cmd_secure", 0).edit().clear().commit()
        ConfigStore(context).transcriptionProviderMode = "key"
    }

    @Test
    fun invalidCredentialBlocksAndPreservesAudioForUserRepair() {
        val audio = queuedAudio("invalid-key")
        val result = QueueTransportWorker(context, { throw ProviderResponseException(401, "Invalid API key") }).run(null)

        assertEquals(QueueTransportStatus.Blocked, result.status)
        assertTrue(audio.isFile)
        assertFalse(File(context.filesDir, "failed-recordings/${audio.name}").exists())
    }

    @Test
    fun rateLimitRemainsAnAutomaticTransientRetry() {
        val audio = queuedAudio("rate-limit")
        val result = QueueTransportWorker(context, { throw ProviderResponseException(429, "Rate limited") }).run(null)

        assertEquals(QueueTransportStatus.TransientFailure, result.status)
        assertTrue(audio.isFile)
    }

    @Test
    fun providerClientErrorsUseUserRepairForFourHundredsAndRetryForServerFailures() {
        for (status in listOf(400, 401, 403, 404, 422)) {
            assertEquals(QueueFailureDisposition.Blocked, classifyQueueFailure(ProviderResponseException(status, "provider")))
        }
        for (status in listOf(408, 425, 429, 500, 503)) {
            assertEquals(QueueFailureDisposition.Transient, classifyQueueFailure(ProviderResponseException(status, "provider")))
        }
    }

    private fun queuedAudio(name: String): File = recordings.resolve("$name.m4a").apply {
        parentFile?.mkdirs()
        writeBytes(ByteArray(1_024) { 1 })
        QueueOwnerStore.claim(this, QueueOwnerStore.current(context))
    }
}
