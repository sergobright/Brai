package world.brightos.brai.braicmd

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import java.util.function.BooleanSupplier
import world.brightos.brai.capabilities.BraiAccessibilityService

internal object BraiCmdBridge {
    private val ACCOUNT_USER_ID = Regex("^[A-Za-z0-9_-]{1,200}$")

    fun snapshot(context: Context): JSObject {
        val appContext = context.applicationContext
        val config = ConfigStore(appContext)
        return JSObject()
            .put("native", true)
            .put("accountCredentialsActive", config.accountUserId.isNotBlank())
            .put("overlayEnabled", config.overlayEnabled)
            .put("permissions", permissionsJson(appContext))
            .put("settings", settingsJson(appContext))
            .put("stats", BraiCmdStatsStore(appContext).snapshotJson())
            .put("audio", RecordingArchiveStore.listJson(appContext))
    }

    fun updateSettings(context: Context, patch: JSObject) {
        val config = ConfigStore(context)
        val transportChanged = listOf(
            "postProcessingEnabled",
            "postProcessingPrompt",
            "providerMode",
            "providerId",
            "providerModel",
            "providerBaseUrl",
            "transcriptionMode",
            "transcriptionProviderId",
            "transcriptionModel"
        ).any(patch::has)
        ConfigStore.mutateQueueSettings {
            if (patch.has("postProcessingEnabled")) config.postProcessingEnabled = patch.optBoolean("postProcessingEnabled")
            if (patch.has("postProcessingPrompt")) config.postProcessingPrompt = patch.optString("postProcessingPrompt")
            if (patch.has("providerMode")) config.postProcessingProviderMode = patch.optString("providerMode")
            if (patch.has("providerId")) config.llmProviderId = patch.optString("providerId")
            if (patch.has("providerModel")) config.llmProviderModel = patch.optString("providerModel")
            if (patch.has("providerBaseUrl")) config.llmProviderBaseUrl = patch.optString("providerBaseUrl")
            if (patch.has("mainDictationEnabled")) config.mainDictationEnabled = patch.optBoolean("mainDictationEnabled")
            if (patch.has("transcriptionMode")) config.transcriptionProviderMode = patch.optString("transcriptionMode")
            if (patch.has("transcriptionProviderId")) config.transcriptionProviderId = patch.optString("transcriptionProviderId")
            if (patch.has("transcriptionModel")) config.transcriptionProviderModel = patch.optString("transcriptionModel")
            if (patch.has("mainIconOpacityPercent")) config.mainIconOpacityPercent = patch.optInt("mainIconOpacityPercent")
            if (patch.has("mainIconSizePercent")) config.mainIconSizePercent = patch.optInt("mainIconSizePercent")
            if (patch.has("contextIconOpacityPercent")) config.screenshotIconOpacityPercent = patch.optInt("contextIconOpacityPercent")
            if (patch.has("contextIconSizePercent")) config.screenshotIconSizePercent = patch.optInt("contextIconSizePercent")
            if (patch.has("processedAudioRetentionEnabled")) config.processedAudioRetentionEnabled = patch.optBoolean("processedAudioRetentionEnabled")
            if (patch.has("processedAudioRetentionLimit")) config.processedAudioRetentionLimit = patch.optInt("processedAudioRetentionLimit")
            patch.optJSONObject("contextActions")?.let { actions ->
                if (actions.has("voiceCommand")) config.contextActionIdeaEnabled = actions.optBoolean("voiceCommand")
                if (actions.has("screenshotInbox")) config.contextActionScreenshotEnabled = actions.optBoolean("screenshotInbox")
                if (actions.has("screenshotVoice")) config.contextActionScreenshotVoiceEnabled = actions.optBoolean("screenshotVoice")
                if (actions.has("contextInbox")) config.contextActionChatEnabled = actions.optBoolean("contextInbox")
                if (actions.has("contextReply")) config.contextActionSaveEnabled = actions.optBoolean("contextReply")
            }
        }
        if (patch.has("processedAudioRetentionEnabled") || patch.has("processedAudioRetentionLimit")) {
            RecordingArchiveStore.reconcileProcessedRetention(context)
        }
        if (transportChanged) RecordingService.retryPending(context)
    }

    fun updateAccess(context: Context, token: String, displayName: String, userId: String) {
        require(userId.trim().isBlank()) { "account_activation_required" }
        updateAccess(context, token, displayName, userId, SecureStringStore(context))
    }

    fun beginAccountCredentialMode(context: Context, userId: String) =
        beginAccountCredentialMode(context, userId, SecureStringStore(context))

    @Synchronized
    internal fun beginAccountCredentialMode(
        context: Context,
        userId: String,
        secure: SecureStringStore
    ) {
        val expectedUserId = userId.trim()
        require(ACCOUNT_USER_ID.matches(expectedUserId)) { "invalid_user_id" }
        val config = ConfigStore(context, secure)
        QueueOwnerStore.withinBoundary {
            val previousUserId = config.accountUserId
            if (previousUserId != expectedUserId) RecordingService.cancelActiveForOwnerTransition(context)
            setOf(previousUserId, expectedUserId)
                .filter { it.isNotBlank() }
                .forEach(secure::clearAccountProviderKeys)
            if (previousUserId.isNotBlank() && previousUserId != expectedUserId) {
                if (config.authToken.isNotBlank()) secure.stagePendingAccountRevocation(config.authToken)
                config.updateAccess("", expectedUserId)
            } else {
                config.beginAccountCredentialMode(expectedUserId)
            }
            config.overlayEnabled = false
            config.onboardingQueuePaused = true
        }
    }

    fun invalidateAccountProviderCredentials(context: Context) {
        val config = ConfigStore(context)
        if (config.accountUserId.isNotBlank()) {
            SecureStringStore(context).clearAccountProviderKeys(config.accountUserId)
        }
    }

    @Synchronized
    fun setAuthenticatedMode(context: Context, userId: String, enabled: Boolean) {
        val expectedUserId = userId.trim()
        require(ACCOUNT_USER_ID.matches(expectedUserId)) { "invalid_user_id" }
        val config = ConfigStore(context)
        check(config.accountUserId == expectedUserId) { "account_changed" }
        config.overlayEnabled = enabled
        config.onboardingVoiceOnly = !enabled
        config.onboardingQueuePaused = !enabled
        if (enabled) RecordingService.retryPending(context)
    }

    fun endAccountCredentialMode(context: Context) =
        endAccountCredentialMode(context, SecureStringStore(context))

    @Synchronized
    internal fun endAccountCredentialMode(context: Context, secure: SecureStringStore) {
        val config = ConfigStore(context, secure)
        if (config.accountUserId.isNotBlank() && config.authToken.isNotBlank()) {
            secure.stagePendingAccountRevocation(config.authToken)
        }
        updateAccess(context, "", "", "", secure)
        ConfigStore(context, secure).onboardingQueuePaused = false
        RecordingService.retryPending(context)
    }

    fun retryPendingAccountRevocation(context: Context): Boolean = retryPendingAccountRevocation(
        secure = SecureStringStore(context),
        client = NetworkClient(context)
    )

    internal fun retryPendingAccountRevocation(
        secure: SecureStringStore,
        client: NetworkClient,
        nowEpochMs: Long = System.currentTimeMillis()
    ): Boolean {
        while (true) {
            val token = secure.pendingAccountRevocationToken(nowEpochMs)
            if (token.isBlank()) return true
            val terminal = try {
                client.revokeAccess(token)
                true
            } catch (error: ServerResponseException) {
                error.statusCode == 401 || error.statusCode == 403
            } catch (_: Throwable) {
                false
            }
            if (!terminal) return false
            try {
                secure.acknowledgePendingAccountRevocation(token, nowEpochMs)
            } catch (_: Throwable) {
                return false
            }
        }
    }

    fun applyActivatedAccountAccess(
        context: Context,
        requestedUserId: String,
        displayName: String,
        response: AccountAccessResponse
    ) {
        applyActivatedAccountAccess(context, requestedUserId, displayName, response, SecureStringStore(context))
    }

    @Synchronized
    internal fun applyActivatedAccountAccess(
        context: Context,
        requestedUserId: String,
        displayName: String,
        response: AccountAccessResponse,
        secure: SecureStringStore
    ) {
        val expectedUserId = requestedUserId.trim()
        require(ACCOUNT_USER_ID.matches(expectedUserId)) { "invalid_user_id" }
        check(response.accountUserId == expectedUserId) { "account_changed" }
        check(ConfigStore(context, secure).accountUserId == expectedUserId) { "account_changed" }
        updateAccess(context, response.token, displayName, expectedUserId, secure)
    }

    @Synchronized
    internal fun updateAccess(
        context: Context,
        token: String,
        displayName: String,
        userId: String,
        secure: SecureStringStore
    ) {
        val config = ConfigStore(context, secure)
        val cleanToken = token.trim()
        val requestedUserId = userId.trim()
        require(requestedUserId.isBlank() || ACCOUNT_USER_ID.matches(requestedUserId)) { "invalid_user_id" }
        val nextUserId = requestedUserId.takeIf { cleanToken.isNotBlank() }.orEmpty()
        QueueOwnerStore.withinBoundary {
            val previousUserId = config.accountUserId
            if (previousUserId != nextUserId) {
                RecordingService.cancelActiveForOwnerTransition(context)
                secure.clearAccountProviderKeys(previousUserId)
                secure.clearAccountProviderKeys(nextUserId)
            }
            config.updateAccess(cleanToken, nextUserId)
            if (displayName.isNotBlank()) config.displayName = displayName
        }
    }

    fun syncProviderCredentials(context: Context): JSObject {
        val userId = ConfigStore(context).accountUserId
        return syncProviderCredentials(context, userId, BooleanSupplier { true })
    }

    fun syncProviderCredentials(
        context: Context,
        expectedUserId: String,
        canApply: BooleanSupplier
    ): JSObject {
        val userId = expectedUserId.trim()
        check(userId.isNotBlank() && ConfigStore(context).accountUserId == userId) { "account_changed" }
        val secure = SecureStringStore(context)
        val candidates = secure.localProviderCandidates(userId)
        val result = NetworkClient(context).syncProviderCredentials(candidates.mapValues { it.value.apiKey })
        check(result.accountUserId == userId) { "account_changed" }
        val acknowledgedProviderIds = result.importedProviderIds + result.ignoredProviderIds +
            result.failures.filter { it.code == "invalid_key" }.map { it.providerId }
        val acknowledgedVersions = acknowledgedProviderIds.distinct().mapNotNull { providerId ->
            candidates[providerId]?.version?.let { providerId to it }
        }.toMap()
        secure.acknowledgeLocalProviderVersions(userId, acknowledgedVersions)
        check(canApply.asBoolean) { "credential_operation_superseded" }
        return applySyncResult(context, userId, result, secure)
    }

    @Synchronized
    internal fun applySyncResult(
        context: Context,
        userId: String,
        result: ProviderCredentialSyncResult,
        secure: SecureStringStore,
        acknowledgedLocalVersions: Map<String, String> = emptyMap()
    ): JSObject {
        check(ConfigStore(context, secure).accountUserId == userId) { "account_changed" }
        check(result.accountUserId == userId) { "account_changed" }
        secure.replaceAccountProviderKeys(userId, result.accountKeys, acknowledgedLocalVersions)
        RecordingService.retryPending(context)
        return syncStatusJson(result)
    }

    internal fun syncStatusJson(result: ProviderCredentialSyncResult): JSObject = JSObject()
        .put("ok", true)
        .put("configuredProviderIds", JSArray(result.accountKeys.keys.sorted()))
        .put("importedProviderIds", JSArray(result.importedProviderIds))
        .put("ignoredProviderIds", JSArray(result.ignoredProviderIds))
        .put("failed", JSArray().apply {
            result.failures.forEach { failure ->
                put(JSObject().put("providerId", failure.providerId).put("code", failure.code))
            }
        })
        .put("counts", JSObject()
            .put("configured", result.accountKeys.size)
            .put("imported", result.importedProviderIds.size)
            .put("ignored", result.ignoredProviderIds.size)
            .put("failed", result.failures.size))

    fun saveProvider(context: Context, input: JSObject) {
        val config = ConfigStore(context)
        require(config.accountUserId.isBlank() || input.optString("apiKey", "").isBlank()) {
            "account_key_managed_in_settings"
        }
        ConfigStore.mutateQueueSettings {
            val capability = input.optString("capability", "text")
            val providerId = input.optString("providerId", config.llmProviderId)
            val apiKey = input.optString("apiKey", "")
            if (apiKey.isNotBlank()) SecureStringStore(context).writeProviderKey(providerId, apiKey)
            if (capability == "speech") {
                config.transcriptionProviderMode = "key"
                config.transcriptionProviderId = providerId
                config.transcriptionProviderModel = input.optString("model", config.transcriptionProviderModel)
            } else {
                config.postProcessingProviderMode = "key"
                config.llmProviderId = providerId
                config.llmProviderModel = input.optString("model", config.llmProviderModel)
                config.llmProviderBaseUrl = input.optString("baseUrl", config.llmProviderBaseUrl)
            }
        }
    }

    fun disconnectProvider(context: Context, providerId: String): JSObject {
        val config = ConfigStore(context)
        val cleanProviderId = providerId.trim()
        val (transcriptionAffected, postProcessingAffected) = ConfigStore.mutateQueueSettings {
            if (config.accountUserId.isBlank()) SecureStringStore(context).clearProviderKey(cleanProviderId)
            val transcription = cleanProviderId == config.transcriptionProviderId
            val postProcessing = cleanProviderId == config.llmProviderId
            if (transcription) config.transcriptionProviderMode = "cloud"
            if (postProcessing) config.postProcessingProviderMode = "cloud"
            transcription to postProcessing
        }
        if (transcriptionAffected || postProcessingAffected) RecordingService.retryPending(context)
        return snapshot(context)
    }

    private fun settingsJson(context: Context): JSObject {
        val config = ConfigStore(context)
        val secure = SecureStringStore(context)
        secure.migrateLegacyProviderKey(config.llmProviderId)
        val keyConfigured = secure.hasProviderKey(config.llmProviderId)
        val transcriptionConfigured = secure.hasProviderKey(config.transcriptionProviderId) && config.transcriptionProviderModel.isNotBlank()
        return JSObject()
            .put("postProcessingEnabled", config.postProcessingEnabled)
            .put("postProcessingPrompt", config.postProcessingPrompt)
            .put("providerMode", config.postProcessingProviderMode)
            .put("providerId", config.llmProviderId)
            .put("providerModel", config.llmProviderModel)
            .put("providerBaseUrl", config.llmProviderBaseUrl)
            .put("providerConfigured", config.postProcessingProviderMode == "cloud" || (keyConfigured && config.llmProviderModel.isNotBlank()))
            .put("mainDictationEnabled", config.mainDictationEnabled)
            .put("transcriptionMode", config.transcriptionProviderMode)
            .put("transcriptionProviderId", config.transcriptionProviderId)
            .put("transcriptionModel", config.transcriptionProviderModel)
            .put("transcriptionConfigured", config.transcriptionProviderMode == "cloud" || transcriptionConfigured)
            .put("providerProfiles", com.getcapacitor.JSArray().apply {
                ConfigStore.SUPPORTED_LLM_PROVIDERS.sorted().forEach { providerId ->
                    if (secure.hasProviderKey(providerId)) put(JSObject().put("providerId", providerId).put("configured", true))
                }
            })
            .put("mainIconOpacityPercent", config.mainIconOpacityPercent)
            .put("mainIconSizePercent", config.mainIconSizePercent)
            .put("contextIconOpacityPercent", config.screenshotIconOpacityPercent)
            .put("contextIconSizePercent", config.screenshotIconSizePercent)
            .put("processedAudioRetentionEnabled", config.processedAudioRetentionEnabled)
            .put("processedAudioRetentionLimit", config.processedAudioRetentionLimit)
            .put("contextActions", JSObject()
                .put("voiceCommand", config.contextActionIdeaEnabled)
                .put("screenshotInbox", config.contextActionScreenshotEnabled)
                .put("screenshotVoice", config.contextActionScreenshotVoiceEnabled)
                .put("contextInbox", config.contextActionChatEnabled)
                .put("contextReply", config.contextActionSaveEnabled))
    }

    private fun permissionsJson(context: Context): JSObject =
        JSObject()
            .put("accessibility", isAccessibilityEnabled(context))
            .put("overlay", Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context))
            .put("microphone", hasPermission(context, Manifest.permission.RECORD_AUDIO))
            .put("notifications", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasPermission(context, Manifest.permission.POST_NOTIFICATIONS))

    private fun hasPermission(context: Context, permission: String): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun isAccessibilityEnabled(context: Context): Boolean {
        val manager = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager ?: return false
        return manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any { it.resolveInfo.serviceInfo.packageName == context.packageName && it.resolveInfo.serviceInfo.name == BraiAccessibilityService::class.java.name }
    }
}
