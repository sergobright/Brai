package world.brightos.brai.braicmd

import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class AccountProviderCredentialStoreTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private lateinit var secure: SecureStringStore

    @Before
    fun setUp() {
        reset()
        secure = SecureStringStore(context, SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES"))
    }

    @After
    fun tearDown() = reset()

    @Test
    fun authenticatedAccountUsesOnlyItsSyncedKeyAndLogoutRestoresLocalKey() {
        secure.writeProviderKey("openai", "local-openai")
        assertEquals("local-openai", secure.providerKey("openai"))

        BraiCmdBridge.updateAccess(context, "device-token", "Test User", "user-a", secure)

        assertEquals("", secure.providerKey("openai"))
        secure.writeAccountProviderKey("user-a", "openai", "account-openai")
        assertEquals("account-openai", secure.providerKey("openai"))

        BraiCmdBridge.updateAccess(context, "", "", "", secure)

        assertEquals("", ConfigStore(context).accountUserId)
        assertEquals("", secure.accountProviderKey("user-a", "openai"))
        assertEquals("local-openai", secure.localProviderKey("openai"))
        assertEquals("local-openai", secure.providerKey("openai"))
    }

    @Test
    fun pendingAccountModeBlocksAnonymousKeysAndCaptureUntilCanonicalSync() {
        secure.writeProviderKey("openai", "local-openai")
        val config = ConfigStore(context, secure).apply {
            authToken = "anonymous-device-token"
            overlayEnabled = true
            onboardingQueuePaused = false
        }

        BraiCmdBridge.beginAccountCredentialMode(context, "user-a", secure)

        assertEquals("user-a", config.accountUserId)
        assertEquals("anonymous-device-token", config.authToken)
        assertEquals("", secure.providerKey("openai"))
        assertEquals("local-openai", secure.localProviderKey("openai"))
        assertFalse(config.overlayEnabled)
        assertTrue(config.onboardingQueuePaused)
    }

    @Test
    fun accountOwnerTransitionCancelsAnActiveRecordingBeforeHidingTheOverlay() {
        BraiCmdBus.post(RecorderState.Recording(0))

        BraiCmdBridge.beginAccountCredentialMode(context, "user-a", secure)

        val cancelIntent = shadowOf(context).nextStartedService
        assertNotNull(cancelIntent)
        assertEquals("world.brightos.brai.braicmd.CANCEL_RECORDING", cancelIntent.action)
        assertFalse(ConfigStore(context, secure).overlayEnabled)
    }

    @Test
    fun switchingAccountsClearsOldBoundTokenBeforeAnyProviderSync() {
        BraiCmdBridge.updateAccess(context, "account-a-token", "A", "user-a", secure)

        BraiCmdBridge.beginAccountCredentialMode(context, "user-b", secure)

        val config = ConfigStore(context, secure)
        assertEquals("user-b", config.accountUserId)
        assertEquals("", config.authToken)
        assertEquals("account-a-token", secure.pendingAccountRevocationToken())
        assertTrue(config.onboardingQueuePaused)
        assertFalse(config.overlayEnabled)
    }

    @Test
    fun logoutStagesEncryptedAccountRevocationAndKeepsAnonymousKeys() {
        secure.writeProviderKey("groq", "local-groq")
        BraiCmdBridge.updateAccess(context, "account-device-token", "Test User", "user-a", secure)

        BraiCmdBridge.endAccountCredentialMode(context, secure)

        assertEquals("", ConfigStore(context, secure).accountUserId)
        assertEquals("", ConfigStore(context, secure).authToken)
        assertEquals("account-device-token", secure.pendingAccountRevocationToken())
        assertEquals("local-groq", secure.providerKey("groq"))
        val persisted = context.getSharedPreferences("brai_cmd_secure", 0).all.values.joinToString()
        assertFalse(persisted.contains("account-device-token"))

        val now = 1_000L
        secure.clearPendingAccountRevocation()
        secure.stagePendingAccountRevocation("expiring-token", now)
        assertEquals("", secure.pendingAccountRevocationToken(now + SecureStringStore.PENDING_REVOCATION_TTL_MS))
    }

    @Test
    fun pendingAccountRevocationQueuesEveryUnrevokedAccountToken() {
        secure.stagePendingAccountRevocation("old-account-token", 1_000L)
        secure.stagePendingAccountRevocation("newer-device-token", 2_000L)

        assertEquals("old-account-token", secure.pendingAccountRevocationToken(3_000L))
        secure.acknowledgePendingAccountRevocation("old-account-token", 3_000L)
        assertEquals("newer-device-token", secure.pendingAccountRevocationToken(3_000L))
    }

    @Test
    fun accountSwitchClearsOldAndPreviouslyCachedTargetAccountKeys() {
        secure.writeProviderKey("groq", "local-groq")
        BraiCmdBridge.updateAccess(context, "token-a", "A", "user-a", secure)
        secure.writeAccountProviderKey("user-a", "groq", "account-a")
        secure.writeAccountProviderKey("user-b", "groq", "stale-account-b")

        BraiCmdBridge.updateAccess(context, "token-b", "B", "user-b", secure)

        assertEquals("user-b", ConfigStore(context).accountUserId)
        assertEquals("", secure.accountProviderKey("user-a", "groq"))
        assertEquals("", secure.accountProviderKey("user-b", "groq"))
        assertEquals("", secure.providerKey("groq"))
        assertEquals("local-groq", secure.localProviderKey("groq"))
    }

    @Test
    fun staleBootstrapCannotDisableTheNewAccountsAuthenticatedMode() {
        BraiCmdBridge.beginAccountCredentialMode(context, "user-a", secure)
        BraiCmdBridge.beginAccountCredentialMode(context, "user-b", secure)
        BraiCmdBridge.setAuthenticatedMode(context, "user-b", true)

        org.junit.Assert.assertThrows(IllegalStateException::class.java) {
            BraiCmdBridge.setAuthenticatedMode(context, "user-a", false)
        }

        val config = ConfigStore(context, secure)
        assertTrue(config.overlayEnabled)
        assertFalse(config.onboardingVoiceOnly)
        assertFalse(config.onboardingQueuePaused)
    }

    @Test
    fun failedCanonicalSyncCanInvalidateAccountCopiesWithoutTouchingLocalKeys() {
        secure.writeProviderKey("groq", "local-groq")
        BraiCmdBridge.updateAccess(context, "account-token", "A", "user-a", secure)
        secure.writeAccountProviderKey("user-a", "groq", "stale-account-groq")

        BraiCmdBridge.invalidateAccountProviderCredentials(context)

        assertEquals("", secure.accountProviderKey("user-a", "groq"))
        assertEquals("", secure.providerKey("groq"))
        assertEquals("local-groq", secure.localProviderKey("groq"))
    }

    @Test
    fun parsesAccountWinsConflictAndNeverReturnsCanonicalKeysToJavascript() {
        secure.writeProviderKey("openai", "local-secret")
        BraiCmdBridge.updateAccess(context, "device-token", "Test User", "user-a", secure)
        val result = parseProviderCredentialSync(JSONObject("""
            {
              "account_user_id": "user-a",
              "providers": [{"provider_id":"openai","api_key":"canonical-secret"}],
              "imported_provider_ids": ["groq"],
              "ignored_provider_ids": ["openai"],
              "failed": [{"provider_id":"gemini","code":"invalid_key"}]
            }
        """.trimIndent()))

        assertEquals("canonical-secret", result.accountKeys["openai"])
        assertEquals("user-a", result.accountUserId)
        assertEquals(listOf("groq"), result.importedProviderIds)
        assertEquals(listOf("openai"), result.ignoredProviderIds)
        assertEquals(ProviderCredentialSyncFailure("gemini", "invalid_key"), result.failures.single())

        val safeJson = BraiCmdBridge.applySyncResult(context, "user-a", result, secure).toString()
        assertEquals("canonical-secret", secure.providerKey("openai"))
        assertEquals("local-secret", secure.localProviderKey("openai"))
        assertFalse(safeJson.contains("canonical-secret"))
        assertTrue(safeJson.contains("openai"))
        assertTrue(safeJson.contains("invalid_key"))
    }

    @Test
    fun acknowledgedLocalVersionDoesNotResurrectDeletedAccountKey() {
        secure.writeProviderKey("openai", "local-openai")
        BraiCmdBridge.updateAccess(context, "device-token", "Test User", "user-a", secure)
        val candidate = secure.localProviderCandidates("user-a").getValue("openai")
        val imported = parseProviderCredentialSync(JSONObject("""
            {
              "account_user_id": "user-a",
              "providers": [{"provider_id":"openai","api_key":"local-openai"}],
              "imported_provider_ids": ["openai"],
              "ignored_provider_ids": [],
              "failed": []
            }
        """.trimIndent()))
        BraiCmdBridge.applySyncResult(
            context,
            "user-a",
            imported,
            secure,
            mapOf("openai" to candidate.version)
        )

        assertTrue(secure.localProviderCandidates("user-a").isEmpty())
        val deleted = parseProviderCredentialSync(JSONObject("""
            {
              "account_user_id": "user-a",
              "providers": [],
              "imported_provider_ids": [],
              "ignored_provider_ids": [],
              "failed": []
            }
        """.trimIndent()))
        BraiCmdBridge.applySyncResult(context, "user-a", deleted, secure)

        assertEquals("", secure.accountProviderKey("user-a", "openai"))
        assertEquals("local-openai", secure.localProviderKey("openai"))
        BraiCmdBridge.updateAccess(context, "", "", "", secure)
        BraiCmdBridge.beginAccountCredentialMode(context, "user-a", secure)
        val restarted = SecureStringStore(context, SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES"))
        assertTrue(restarted.localProviderCandidates("user-a").isEmpty())
        assertTrue(restarted.localProviderCandidates("user-b").isNotEmpty())
        secure.writeProviderKey("openai", "local-openai")
        assertTrue(secure.localProviderCandidates("user-a").isEmpty())
        secure.writeProviderKey("openai", "new-local-openai")
        assertEquals("new-local-openai", secure.localProviderCandidates("user-a").getValue("openai").apiKey)
        assertEquals("new-local-openai", secure.localProviderCandidates("user-b").getValue("openai").apiKey)
    }

    @Test
    fun acknowledgedCandidateIsNotResentWhenCanonicalApplyIsSuperseded() {
        secure.writeProviderKey("openai", "local-openai")
        val candidate = secure.localProviderCandidates("user-a").getValue("openai")

        secure.acknowledgeLocalProviderVersions("user-a", mapOf("openai" to candidate.version))

        val restarted = SecureStringStore(context, SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES"))
        assertTrue(restarted.localProviderCandidates("user-a").isEmpty())
        assertEquals("", restarted.accountProviderKey("user-a", "openai"))
        assertEquals("local-openai", restarted.localProviderKey("openai"))
    }

    @Test
    fun localAndAccountCredentialsUseIndependentEncryptionAliases() {
        val localKey = SecretKeySpec(ByteArray(32) { 1 }, "AES")
        val accountKey = SecretKeySpec(ByteArray(32) { 2 }, "AES")
        val wrongAccountKey = SecretKeySpec(ByteArray(32) { 3 }, "AES")
        val writer = SecureStringStore(context, localKey, accountKey)
        writer.writeProviderKey("groq", "local-groq")
        writer.writeAccountProviderKey("user-a", "groq", "account-groq")

        val wrongReader = SecureStringStore(context, localKey, wrongAccountKey)
        assertEquals("local-groq", wrongReader.localProviderKey("groq"))
        assertEquals("", wrongReader.accountProviderKey("user-a", "groq"))
        val correctReader = SecureStringStore(context, localKey, accountKey)
        assertEquals("account-groq", correctReader.accountProviderKey("user-a", "groq"))
    }

    @Test(expected = IllegalStateException::class)
    fun syncResponseForAnotherAccountIsRejected() {
        BraiCmdBridge.updateAccess(context, "token-b", "B", "user-b", secure)
        val stale = parseProviderCredentialSync(JSONObject("""
            {
              "account_user_id": "user-a",
              "providers": [{"provider_id":"openai","api_key":"stale-account-a"}],
              "imported_provider_ids": [],
              "ignored_provider_ids": [],
              "failed": []
            }
        """.trimIndent()))

        BraiCmdBridge.applySyncResult(context, "user-b", stale, secure)
    }

    @Test
    fun activationResponseForAnotherAccountKeepsAnonymousAccess() {
        val config = ConfigStore(context, secure)
        config.authToken = "anonymous-device-token"

        val error = org.junit.Assert.assertThrows(IllegalStateException::class.java) {
            BraiCmdBridge.applyActivatedAccountAccess(
                context,
                "user-a",
                "Test User",
                AccountAccessResponse("actual-account-token", "user-b"),
                secure
            )
        }

        assertEquals("account_changed", error.message)
        assertEquals("anonymous-device-token", config.authToken)
        assertEquals("", config.accountUserId)
    }

    private fun reset() {
        context.getSharedPreferences(AppConstants.PREFS, 0).edit().clear().commit()
        context.getSharedPreferences("brai_cmd_secure", 0).edit().clear().commit()
        BraiCmdRuntimeState.onboardingQueuePaused = false
        BraiCmdBus.post(RecorderState.Idle)
    }
}
