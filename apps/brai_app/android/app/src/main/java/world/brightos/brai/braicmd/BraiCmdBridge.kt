package world.brightos.brai.braicmd

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import com.getcapacitor.JSObject
import world.brightos.brai.capabilities.BraiAccessibilityService

internal object BraiCmdBridge {
    fun snapshot(context: Context): JSObject {
        val appContext = context.applicationContext
        val config = ConfigStore(appContext)
        return JSObject()
            .put("native", true)
            .put("overlayEnabled", config.overlayEnabled)
            .put("permissions", permissionsJson(appContext))
            .put("settings", settingsJson(appContext))
            .put("stats", BraiCmdStatsStore(appContext).snapshotJson())
            .put("audio", RecordingArchiveStore.listJson(appContext))
    }

    fun updateSettings(context: Context, patch: JSObject) {
        val config = ConfigStore(context)
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
        if (patch.has("processedAudioRetentionEnabled") || patch.has("processedAudioRetentionLimit")) {
            RecordingArchiveStore.reconcileProcessedRetention(context)
        }
        patch.optJSONObject("contextActions")?.let { actions ->
            if (actions.has("voiceCommand")) config.contextActionIdeaEnabled = actions.optBoolean("voiceCommand")
            if (actions.has("screenshotInbox")) config.contextActionScreenshotEnabled = actions.optBoolean("screenshotInbox")
            if (actions.has("screenshotVoice")) config.contextActionScreenshotVoiceEnabled = actions.optBoolean("screenshotVoice")
            if (actions.has("contextInbox")) config.contextActionChatEnabled = actions.optBoolean("contextInbox")
            if (actions.has("contextReply")) config.contextActionSaveEnabled = actions.optBoolean("contextReply")
        }
    }

    fun saveProvider(context: Context, input: JSObject) {
        val config = ConfigStore(context)
        val capability = input.optString("capability", "text")
        val providerId = input.optString("providerId", config.llmProviderId)
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
        val apiKey = input.optString("apiKey", "")
        if (apiKey.isNotBlank()) SecureStringStore(context).writeProviderKey(providerId, apiKey)
    }

    fun disconnectProvider(context: Context, providerId: String): JSObject {
        val config = ConfigStore(context)
        val cleanProviderId = providerId.trim()
        SecureStringStore(context).clearProviderKey(cleanProviderId)
        val transcriptionAffected = cleanProviderId == config.transcriptionProviderId
        val postProcessingAffected = cleanProviderId == config.llmProviderId
        if (transcriptionAffected) config.transcriptionProviderMode = "cloud"
        if (postProcessingAffected) config.postProcessingProviderMode = "cloud"
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
