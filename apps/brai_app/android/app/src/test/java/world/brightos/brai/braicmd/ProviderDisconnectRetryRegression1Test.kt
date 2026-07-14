package world.brightos.brai.braicmd

import java.io.File
import javax.crypto.spec.SecretKeySpec
import com.getcapacitor.JSObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
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
            QueueOwnerStore.claim(this, QueueOwnerStore.current(context))
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

@RunWith(RobolectricTestRunner::class)
class ProviderSettingsRetryTest {
    private val context get() = RuntimeEnvironment.getApplication()

    @Before
    @After
    fun resetState() = resetProviderRetryState(context)

    @Test
    fun changingProviderSettingsUnblocksAndStartsPendingWork() {
        seedOwnedPending(context, "settings.m4a")
        QueueRetryStore(context).recordBlocked(System.currentTimeMillis())

        BraiCmdBridge.updateSettings(context, JSObject().put("transcriptionModel", "whisper-large-v3"))

        assertFalse(QueueRetryStore(context).isBlocked)
        assertRetryStarted(context)
    }
}

@RunWith(RobolectricTestRunner::class)
class ProviderSyncRetryTest {
    private val context get() = RuntimeEnvironment.getApplication()

    @Before
    @After
    fun resetState() = resetProviderRetryState(context)

    @Test
    fun successfulAccountKeySyncUnblocksAndStartsPendingWork() {
        val secure = SecureStringStore(context, SecretKeySpec(ByteArray(32) { 7 }, "AES"))
        BraiCmdBridge.updateAccess(context, "account-token", "Test User", "user-a", secure)
        seedOwnedPending(context, "sync.m4a")
        QueueRetryStore(context).recordBlocked(System.currentTimeMillis())

        BraiCmdBridge.applySyncResult(
            context,
            "user-a",
            ProviderCredentialSyncResult(
                accountUserId = "user-a",
                accountKeys = mapOf("openai" to "account-openai"),
                importedProviderIds = emptyList(),
                ignoredProviderIds = emptyList(),
                failures = emptyList()
            ),
            secure
        )

        assertEquals("account-openai", secure.accountProviderKey("user-a", "openai"))
        assertFalse(QueueRetryStore(context).isBlocked)
        assertRetryStarted(context)
    }
}

@RunWith(RobolectricTestRunner::class)
class AnonymousQueueResumeTest {
    private val context get() = RuntimeEnvironment.getApplication()

    @Before
    @After
    fun resetState() = resetProviderRetryState(context)

    @Test
    fun logoutRestoresAndStartsTheAnonymousQueue() {
        seedOwnedPending(context, "anonymous.m4a")
        val secure = SecureStringStore(context, SecretKeySpec(ByteArray(32) { 9 }, "AES"))
        BraiCmdBridge.updateAccess(context, "account-token", "Test User", "user-a", secure)
        ConfigStore(context, secure).onboardingQueuePaused = true
        QueueRetryStore(context).recordBlocked(System.currentTimeMillis())

        BraiCmdBridge.endAccountCredentialMode(context, secure)

        assertEquals(null, QueueOwnerStore.current(context).accountUserId)
        assertFalse(QueueRetryStore(context).isBlocked)
        assertRetryStarted(context)
    }

    @Test
    fun logoutDuringRecordingRetriesAnonymousQueueAfterCancelCompletes() {
        seedOwnedPending(context, "anonymous.m4a")
        val secure = SecureStringStore(context, SecretKeySpec(ByteArray(32) { 9 }, "AES"))
        BraiCmdBridge.updateAccess(context, "account-token", "Test User", "user-a", secure)
        BraiCmdBus.post(RecorderState.Recording(0))

        BraiCmdBridge.endAccountCredentialMode(context, secure)

        val cancelIntent = shadowOf(context).nextStartedService
        assertNotNull(cancelIntent)
        assertEquals("world.brightos.brai.braicmd.CANCEL_RECORDING", cancelIntent.action)
        assertEquals(null, shadowOf(context).nextStartedService)

        val service = Robolectric.buildService(RecordingService::class.java).create().get()
        service.onStartCommand(cancelIntent, 0, 1)

        assertEquals(null, QueueOwnerStore.current(context).accountUserId)
        assertTrue(shadowOf(service).isStoppedBySelf)
        assertRetryStarted(context)
    }
}

private fun seedOwnedPending(context: android.app.Application, name: String) {
    File(context.filesDir, "pending-recordings/$name").apply {
        parentFile?.mkdirs()
        writeBytes(ByteArray(1_024) { 1 })
        QueueOwnerStore.claim(this, QueueOwnerStore.current(context))
    }
}

private fun assertRetryStarted(context: android.app.Application) {
    val retryIntent = shadowOf(context).nextStartedService
    assertNotNull(retryIntent)
    assertEquals("world.brightos.brai.braicmd.RETRY_RECORDINGS", retryIntent.action)
}

private fun resetProviderRetryState(context: android.app.Application) {
    File(context.filesDir, "pending-recordings").deleteRecursively()
    File(context.filesDir, "pending-screenshot-inbox").deleteRecursively()
    context.getSharedPreferences(AppConstants.PREFS, 0).edit().clear().commit()
    context.getSharedPreferences("brai_cmd_secure", 0).edit().clear().commit()
    QueueRetryStore(context).reset()
    RecordingService::class.java.getDeclaredField("workerStartRequested").run {
        isAccessible = true
        (get(null) as java.util.concurrent.atomic.AtomicBoolean).set(false)
    }
    BraiCmdBus.post(RecorderState.Idle)
}
