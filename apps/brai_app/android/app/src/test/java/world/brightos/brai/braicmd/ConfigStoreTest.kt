package world.brightos.brai.braicmd

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ConfigStoreTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private lateinit var store: ConfigStore
    private lateinit var secure: SecureStringStore

    @Before
    fun setUp() {
        context.getSharedPreferences(AppConstants.PREFS, 0).edit().clear().commit()
        context.getSharedPreferences("airwhisper", 0).edit().clear().commit()
        context.getSharedPreferences("brai_cmd_secure", 0).edit().clear().commit()
        secure = SecureStringStore(context, SecretKeySpec(ByteArray(32) { (it + 7).toByte() }, "AES"))
        store = ConfigStore(context, secure)
    }

    @Test
    fun secondaryContextButtonsDefaultEnabled() {
        assertTrue(store.contextActionIdeaEnabled)
        assertTrue(store.contextActionScreenshotEnabled)
        assertTrue(store.contextActionScreenshotVoiceEnabled)
        assertTrue(store.contextActionChatEnabled)
        assertTrue(store.contextActionSaveEnabled)
    }

    @Test
    fun secondaryContextButtonsPersistToggles() {
        store.contextActionIdeaEnabled = false
        store.contextActionScreenshotEnabled = false
        store.contextActionScreenshotVoiceEnabled = false
        store.contextActionChatEnabled = false
        store.contextActionSaveEnabled = false

        val reloaded = ConfigStore(RuntimeEnvironment.getApplication())

        assertFalse(reloaded.contextActionIdeaEnabled)
        assertFalse(reloaded.contextActionScreenshotEnabled)
        assertFalse(reloaded.contextActionScreenshotVoiceEnabled)
        assertFalse(reloaded.contextActionChatEnabled)
        assertFalse(reloaded.contextActionSaveEnabled)
    }

    @Test
    fun overlayIsLockedByDefaultAndPersistsExplicitEnablement() {
        assertFalse(store.overlayEnabled)

        store.overlayEnabled = true

        assertTrue(ConfigStore(RuntimeEnvironment.getApplication()).overlayEnabled)
    }

    @Test
    fun airwhisperPreferencesAreNotImported() {
        context.getSharedPreferences("airwhisper", 0).edit()
            .putBoolean(AppConstants.KEY_OVERLAY_ENABLED, true)
            .commit()

        assertFalse(ConfigStore(context, secure).overlayEnabled)
    }

    @Test
    fun mainDictationToggleIsIndependentFromContextActions() {
        store.mainDictationEnabled = false

        assertFalse(ConfigStore(RuntimeEnvironment.getApplication()).mainDictationEnabled)
        assertTrue(store.contextActionIdeaEnabled)
        assertTrue(store.contextActionScreenshotEnabled)
    }

    @Test
    fun onboardingQueuePauseNeverPersists() {
        store.onboardingQueuePaused = true
        assertTrue(store.onboardingQueuePaused)

        BraiCmdRuntimeState.onboardingQueuePaused = false

        assertFalse(ConfigStore(RuntimeEnvironment.getApplication()).onboardingQueuePaused)
    }

    @Test
    fun preliminaryProfileDataPersists() {
        store.preliminaryUserId = "prelim-user"
        store.preliminaryClaimToken = "claim-token"

        val reloaded = ConfigStore(RuntimeEnvironment.getApplication())

        assertEquals("prelim-user", reloaded.preliminaryUserId)
        assertEquals("claim-token", reloaded.preliminaryClaimToken)
    }

    @Test
    fun settingsSnapshotIncludesOverlayEnabled() {
        store.overlayEnabled = true

        val snapshot = BraiCmdBridge.snapshot(RuntimeEnvironment.getApplication())

        assertTrue(snapshot.optBoolean("overlayEnabled"))
    }

    @Test
    fun oldBraiApiDomainMigratesToCurrentBuildFlavor() {
        store.serverUrl = "https://e.test.brightos.world/api"

        assertEquals(AppConstants.DEFAULT_SERVER_URL, store.serverUrl)
    }

    @Test
    fun customServerUrlIsPreserved() {
        store.serverUrl = "https://brai.example.org/api"

        assertEquals("https://brai.example.org/api", store.serverUrl)
    }

    @Test
    fun deviceAccessTokenIsEncryptedOutsideRegularPreferences() {
        store.authToken = "secret-device-token"

        val regularValue = context.getSharedPreferences(AppConstants.PREFS, 0)
            .getString(AppConstants.KEY_AUTH_TOKEN, "")
            .orEmpty()
        val encryptedValue = context.getSharedPreferences("brai_cmd_secure", 0)
            .getString("device_access_token", "")
            .orEmpty()

        assertFalse(regularValue.contains("secret-device-token"))
        assertFalse(encryptedValue.contains("secret-device-token"))
        assertEquals("secret-device-token", ConfigStore(context, secure).authToken)
    }

    @Test
    fun legacyPlaintextAccessTokenMigratesToSecureStore() {
        context.getSharedPreferences(AppConstants.PREFS, 0).edit()
            .putString(AppConstants.KEY_AUTH_TOKEN, "legacy-device-token")
            .commit()

        assertEquals("legacy-device-token", ConfigStore(context, secure).authToken)
        assertEquals("legacy-device-token", secure.deviceAccessToken())
        assertFalse(
            context.getSharedPreferences(AppConstants.PREFS, 0)
                .getString(AppConstants.KEY_AUTH_TOKEN, "")
                .orEmpty()
                .contains("legacy-device-token")
        )
    }

    @Test
    fun lateUnauthorizedResponseCannotClearReplacementAccountToken() {
        store.updateAccess("account-a-token", "account-a")
        val accountA = store.queueAccessSnapshot()
        store.updateAccess("account-b-token", "account-b")

        assertFalse(store.clearAuthTokenIfMatches(accountA.accessToken))
        assertEquals("account-b-token", store.authToken)
        assertEquals("account-b", store.accountUserId)

        assertTrue(store.clearAuthTokenIfMatches("account-b-token"))
        assertEquals("", store.authToken)
    }

    @Test
    fun queueProviderSnapshotCannotObserveHalfAppliedProviderPatch() {
        store.transcriptionProviderId = "openai"
        store.transcriptionProviderModel = "whisper-1"
        store.llmProviderId = "openai"
        store.llmProviderModel = "gpt-4.1-mini"
        val mutationEntered = CountDownLatch(1)
        val releaseMutation = CountDownLatch(1)
        val captured = AtomicReference<QueueProviderSettingsSnapshot>()

        val mutation = Thread {
            ConfigStore.mutateQueueSettings {
                store.transcriptionProviderId = "groq"
                store.llmProviderId = "groq"
                mutationEntered.countDown()
                check(releaseMutation.await(5, TimeUnit.SECONDS))
                store.transcriptionProviderModel = "whisper-large-v3"
                store.llmProviderModel = "llama-3.3-70b-versatile"
            }
        }.apply { start() }
        assertTrue(mutationEntered.await(5, TimeUnit.SECONDS))
        val capture = Thread { captured.set(store.queueProviderSettingsSnapshot()) }.apply { start() }
        repeat(1_000) {
            if (capture.state != Thread.State.BLOCKED) Thread.yield()
        }
        assertEquals(Thread.State.BLOCKED, capture.state)

        releaseMutation.countDown()
        mutation.join(5_000)
        capture.join(5_000)

        assertEquals("groq", captured.get().transcriptionProviderId)
        assertEquals("whisper-large-v3", captured.get().transcriptionModel)
        assertEquals("groq", captured.get().postProcessingProviderId)
        assertEquals("llama-3.3-70b-versatile", captured.get().postProcessingModel)
    }
}
