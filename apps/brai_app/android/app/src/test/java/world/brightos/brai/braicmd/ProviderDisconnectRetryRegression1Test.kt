package world.brightos.brai.braicmd

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

// Regression: ISSUE-012 — возврат с недействительного профиля на Brai cloud не запускал заблокированную очередь.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
@RunWith(RobolectricTestRunner::class)
class ProviderDisconnectRetryRegression1Test {
    private val context get() = RuntimeEnvironment.getApplication()

    @Before
    @After
    fun resetState() {
        File(context.filesDir, "pending-recordings").deleteRecursively()
        context.getSharedPreferences(AppConstants.PREFS, 0).edit().clear().commit()
        BraiCmdBus.post(RecorderState.Idle)
    }

    @Test
    fun disconnectingAnActiveProviderFallsBackToCloudAndStartsPendingWork() {
        ConfigStore(context).apply {
            transcriptionProviderMode = "key"
            transcriptionProviderId = "openai"
            postProcessingProviderMode = "key"
            llmProviderId = "openai"
        }
        File(context.filesDir, "pending-recordings/waiting.m4a").apply {
            parentFile?.mkdirs()
            writeBytes(ByteArray(1_024) { 1 })
        }

        BraiCmdBridge.disconnectProvider(context, "openai")

        val config = ConfigStore(context)
        assertEquals("cloud", config.transcriptionProviderMode)
        assertEquals("cloud", config.postProcessingProviderMode)
        val retryIntent = shadowOf(context).nextStartedService
        assertNotNull(retryIntent)
        assertEquals("world.brightos.brai.braicmd.RETRY_RECORDINGS", retryIntent.action)
    }
}
