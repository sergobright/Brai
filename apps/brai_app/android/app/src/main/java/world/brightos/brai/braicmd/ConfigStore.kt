package world.brightos.brai.braicmd

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import java.util.UUID

enum class ContextDeliveryMode {
    Json,
    Screenshot
}

internal object BraiCmdRuntimeState {
    @Volatile
    var onboardingQueuePaused: Boolean = false
}

internal data class QueueAccessSnapshot(
    val owner: QueueOwnerScope,
    val accessToken: String
)

internal data class QueueProviderSettingsSnapshot(
    val transcriptionMode: String,
    val transcriptionProviderId: String,
    val transcriptionModel: String,
    val postProcessingEnabled: Boolean,
    val postProcessingMode: String,
    val postProcessingProviderId: String,
    val postProcessingModel: String,
    val postProcessingBaseUrl: String,
    val postProcessingPrompt: String
)

class ConfigStore internal constructor(
    context: Context,
    private val secureStrings: SecureStringStore
) {
    constructor(context: Context) : this(context, SecureStringStore(context))

    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(AppConstants.PREFS, Context.MODE_PRIVATE)

    init {
        migrateLegacyPreferences()
        if (prefs.contains(AppConstants.KEY_ONBOARDING_QUEUE_PAUSED)) {
            prefs.edit().remove(AppConstants.KEY_ONBOARDING_QUEUE_PAUSED).apply()
        }
    }

    var serverUrl: String
        get() {
            val value = prefs.getString(AppConstants.KEY_SERVER_URL, AppConstants.DEFAULT_SERVER_URL).orEmpty()
            return if (isLegacyBraiServerUrl(value)) AppConstants.DEFAULT_SERVER_URL else value
        }
        set(value) = prefs.edit().putString(AppConstants.KEY_SERVER_URL, value.trim()).apply()

    var authToken: String
        get() = synchronized(ACCESS_LOCK) { migrateLegacyAccessToken() }
        set(value) = synchronized(ACCESS_LOCK) { storeAccessToken(value) }

    val accountUserId: String
        get() = synchronized(ACCESS_LOCK) { accountUserIdUnlocked() }

    fun beginAccountCredentialMode(userId: String) {
        synchronized(ACCESS_LOCK) {
            check(prefs.edit().putString(AppConstants.KEY_ACCOUNT_USER_ID, userId.trim()).commit()) {
                "account_mode_store_failed"
            }
        }
    }

    fun updateAccess(token: String, userId: String) {
        synchronized(ACCESS_LOCK) {
            val previousToken = migrateLegacyAccessToken()
            secureStrings.writeDeviceAccessToken(token)
            val editor = prefs.edit().putString(AppConstants.KEY_ACCOUNT_USER_ID, userId.trim())
            if (token.isBlank()) editor.remove(AppConstants.KEY_AUTH_TOKEN)
            else editor.putString(AppConstants.KEY_AUTH_TOKEN, SECURE_AUTH_TOKEN_MARKER)
            if (!editor.commit()) {
                secureStrings.writeDeviceAccessToken(previousToken)
                error("access_store_failed")
            }
        }
    }

    /** Captures the owner and token as one credential-boundary snapshot for durable queue work. */
    internal fun queueAccessSnapshot(): QueueAccessSnapshot = synchronized(ACCESS_LOCK) {
        QueueAccessSnapshot(queueOwnerScopeUnlocked(), migrateLegacyAccessToken())
    }

    internal fun queueOwnerScope(): QueueOwnerScope = synchronized(ACCESS_LOCK) {
        queueOwnerScopeUnlocked()
    }

    internal fun queueProviderSettingsSnapshot(): QueueProviderSettingsSnapshot = synchronized(QUEUE_SETTINGS_LOCK) {
        QueueProviderSettingsSnapshot(
            transcriptionMode = transcriptionProviderMode,
            transcriptionProviderId = transcriptionProviderId,
            transcriptionModel = transcriptionProviderModel,
            postProcessingEnabled = postProcessingEnabled,
            postProcessingMode = postProcessingProviderMode,
            postProcessingProviderId = llmProviderId,
            postProcessingModel = llmProviderModel,
            postProcessingBaseUrl = llmProviderBaseUrl,
            postProcessingPrompt = postProcessingPrompt
        )
    }

    /** Clears a rejected token only when a later account transition has not replaced it. */
    internal fun clearAuthTokenIfMatches(expectedToken: String): Boolean = synchronized(ACCESS_LOCK) {
        if (expectedToken.isBlank() || migrateLegacyAccessToken() != expectedToken) return@synchronized false
        storeAccessToken("")
        true
    }

    var displayName: String
        get() = prefs.getString(AppConstants.KEY_DISPLAY_NAME, "").orEmpty()
        set(value) = prefs.edit().putString(AppConstants.KEY_DISPLAY_NAME, value.trim()).apply()

    val installId: String
        get() {
            val saved = prefs.getString(AppConstants.KEY_INSTALL_ID, "").orEmpty().trim()
            if (saved.isNotBlank()) return saved
            val generated = UUID.randomUUID().toString()
            prefs.edit().putString(AppConstants.KEY_INSTALL_ID, generated).apply()
            return generated
        }

    var preliminaryUserId: String
        get() = prefs.getString(AppConstants.KEY_PRELIMINARY_USER_ID, "").orEmpty().trim()
        set(value) = prefs.edit().putString(AppConstants.KEY_PRELIMINARY_USER_ID, value.trim()).apply()

    var preliminaryClaimToken: String
        get() = prefs.getString(AppConstants.KEY_PRELIMINARY_CLAIM_TOKEN, "").orEmpty().trim()
        set(value) = prefs.edit().putString(AppConstants.KEY_PRELIMINARY_CLAIM_TOKEN, value.trim()).apply()

    var locale: String
        get() = prefs.getString(AppConstants.KEY_LOCALE, "").orEmpty()
        set(value) = prefs.edit().putString(AppConstants.KEY_LOCALE, value.trim()).apply()

    var headerContextEnabled: Boolean
        get() = prefs.getBoolean(AppConstants.KEY_HEADER_CONTEXT_ENABLED, AppConstants.DEFAULT_HEADER_CONTEXT_ENABLED)
        set(value) = prefs.edit().putBoolean(AppConstants.KEY_HEADER_CONTEXT_ENABLED, value).apply()

    var screenshotContextEnabled: Boolean
        get() = prefs.getBoolean(AppConstants.KEY_SCREENSHOT_CONTEXT_ENABLED, AppConstants.DEFAULT_SCREENSHOT_CONTEXT_ENABLED)
        set(value) = prefs.edit().putBoolean(AppConstants.KEY_SCREENSHOT_CONTEXT_ENABLED, value).apply()

    var contextDeliveryMode: ContextDeliveryMode
        get() = if (screenshotContextEnabled) ContextDeliveryMode.Screenshot else ContextDeliveryMode.Json
        set(value) {
            prefs.edit()
                .putBoolean(AppConstants.KEY_HEADER_CONTEXT_ENABLED, value == ContextDeliveryMode.Json)
                .putBoolean(AppConstants.KEY_SCREENSHOT_CONTEXT_ENABLED, value == ContextDeliveryMode.Screenshot)
                .apply()
        }

    var postProcessingEnabled: Boolean
        get() = prefs.getBoolean(AppConstants.KEY_POST_PROCESSING_ENABLED, false)
        set(value) = prefs.edit().putBoolean(AppConstants.KEY_POST_PROCESSING_ENABLED, value).apply()

    var postProcessingPrompt: String
        get() {
            val saved = prefs.getString(AppConstants.KEY_POST_PROCESSING_PROMPT, AppConstants.DEFAULT_POST_PROCESSING_PROMPT).orEmpty().trim()
            return saved.ifBlank { AppConstants.DEFAULT_POST_PROCESSING_PROMPT }
        }
        set(value) = prefs.edit().putString(AppConstants.KEY_POST_PROCESSING_PROMPT, value.trim()).apply()

    var postProcessingProviderMode: String
        get() = prefs.getString(AppConstants.KEY_POST_PROCESSING_PROVIDER_MODE, AppConstants.DEFAULT_LLM_PROVIDER_MODE)
            .orEmpty()
            .trim()
            .takeIf { it == "cloud" || it == "key" }
            ?: AppConstants.DEFAULT_LLM_PROVIDER_MODE
        set(value) = prefs.edit()
            .putString(
                AppConstants.KEY_POST_PROCESSING_PROVIDER_MODE,
                value.trim().takeIf { it == "key" } ?: AppConstants.DEFAULT_LLM_PROVIDER_MODE
            )
            .apply()

    var llmProviderId: String
        get() = prefs.getString(AppConstants.KEY_LLM_PROVIDER_ID, AppConstants.DEFAULT_LLM_PROVIDER_ID)
            .orEmpty()
            .trim()
            .takeIf { it in SUPPORTED_LLM_PROVIDERS }
            ?: AppConstants.DEFAULT_LLM_PROVIDER_ID
        set(value) = prefs.edit()
            .putString(AppConstants.KEY_LLM_PROVIDER_ID, value.trim().takeIf { it in SUPPORTED_LLM_PROVIDERS } ?: AppConstants.DEFAULT_LLM_PROVIDER_ID)
            .apply()

    var llmProviderModel: String
        get() = prefs.getString(AppConstants.KEY_LLM_PROVIDER_MODEL, "").orEmpty().trim()
        set(value) = prefs.edit().putString(AppConstants.KEY_LLM_PROVIDER_MODEL, value.trim()).apply()

    var llmProviderBaseUrl: String
        get() = prefs.getString(AppConstants.KEY_LLM_PROVIDER_BASE_URL, "").orEmpty().trim().trimEnd('/')
        set(value) = prefs.edit().putString(AppConstants.KEY_LLM_PROVIDER_BASE_URL, value.trim().trimEnd('/')).apply()

    var processedAudioRetentionEnabled: Boolean
        get() = prefs.getBoolean(AppConstants.KEY_PROCESSED_AUDIO_RETENTION_ENABLED, false)
        set(value) = prefs.edit().putBoolean(AppConstants.KEY_PROCESSED_AUDIO_RETENTION_ENABLED, value).apply()

    var processedAudioRetentionLimit: Int
        get() = prefs.getInt(AppConstants.KEY_PROCESSED_AUDIO_RETENTION_LIMIT, AppConstants.DEFAULT_PROCESSED_AUDIO_RETENTION_LIMIT)
            .coerceIn(AppConstants.MIN_PROCESSED_AUDIO_RETENTION_LIMIT, AppConstants.MAX_PROCESSED_AUDIO_RETENTION_LIMIT)
        set(value) = prefs.edit()
            .putInt(
                AppConstants.KEY_PROCESSED_AUDIO_RETENTION_LIMIT,
                value.coerceIn(AppConstants.MIN_PROCESSED_AUDIO_RETENTION_LIMIT, AppConstants.MAX_PROCESSED_AUDIO_RETENTION_LIMIT)
            )
            .apply()

    var onboardingVoiceOnly: Boolean
        get() = prefs.getBoolean(AppConstants.KEY_ONBOARDING_VOICE_ONLY, false)
        set(value) = prefs.edit().putBoolean(AppConstants.KEY_ONBOARDING_VOICE_ONLY, value).apply()

    var onboardingQueuePaused: Boolean
        get() = BraiCmdRuntimeState.onboardingQueuePaused
        set(value) { BraiCmdRuntimeState.onboardingQueuePaused = value }

    var overlayEnabled: Boolean
        get() = prefs.getBoolean(AppConstants.KEY_OVERLAY_ENABLED, false)
        set(value) = prefs.edit().putBoolean(AppConstants.KEY_OVERLAY_ENABLED, value).apply()

    var mainDictationEnabled: Boolean
        get() = prefs.getBoolean(AppConstants.KEY_MAIN_DICTATION_ENABLED, true)
        set(value) = prefs.edit().putBoolean(AppConstants.KEY_MAIN_DICTATION_ENABLED, value).apply()

    var transcriptionProviderMode: String
        get() = prefs.getString(AppConstants.KEY_TRANSCRIPTION_PROVIDER_MODE, AppConstants.DEFAULT_TRANSCRIPTION_PROVIDER_MODE)
            .orEmpty()
            .trim()
            .takeIf { it == "cloud" || it == "key" }
            ?: AppConstants.DEFAULT_TRANSCRIPTION_PROVIDER_MODE
        set(value) = prefs.edit()
            .putString(AppConstants.KEY_TRANSCRIPTION_PROVIDER_MODE, value.trim().takeIf { it == "key" } ?: AppConstants.DEFAULT_TRANSCRIPTION_PROVIDER_MODE)
            .apply()

    var transcriptionProviderId: String
        get() = prefs.getString(AppConstants.KEY_TRANSCRIPTION_PROVIDER_ID, AppConstants.DEFAULT_LLM_PROVIDER_ID)
            .orEmpty()
            .trim()
            .takeIf { it in SUPPORTED_TRANSCRIPTION_PROVIDERS }
            ?: AppConstants.DEFAULT_LLM_PROVIDER_ID
        set(value) = prefs.edit()
            .putString(AppConstants.KEY_TRANSCRIPTION_PROVIDER_ID, value.trim().takeIf { it in SUPPORTED_TRANSCRIPTION_PROVIDERS } ?: AppConstants.DEFAULT_LLM_PROVIDER_ID)
            .apply()

    var transcriptionProviderModel: String
        get() = prefs.getString(AppConstants.KEY_TRANSCRIPTION_PROVIDER_MODEL, "").orEmpty().trim()
        set(value) = prefs.edit().putString(AppConstants.KEY_TRANSCRIPTION_PROVIDER_MODEL, value.trim()).apply()

    var mainIconOpacityPercent: Int
        get() = prefs.getInt(AppConstants.KEY_MAIN_ICON_OPACITY_PERCENT, AppConstants.DEFAULT_ICON_OPACITY_PERCENT)
            .coerceIn(AppConstants.MIN_ICON_OPACITY_PERCENT, AppConstants.MAX_ICON_OPACITY_PERCENT)
        set(value) = prefs.edit()
            .putInt(AppConstants.KEY_MAIN_ICON_OPACITY_PERCENT, value.coerceIn(AppConstants.MIN_ICON_OPACITY_PERCENT, AppConstants.MAX_ICON_OPACITY_PERCENT))
            .apply()

    var mainIconSizePercent: Int
        get() = prefs.getInt(AppConstants.KEY_MAIN_ICON_SIZE_PERCENT, AppConstants.DEFAULT_ICON_SIZE_PERCENT)
            .coerceIn(AppConstants.MIN_ICON_SIZE_PERCENT, AppConstants.MAX_ICON_SIZE_PERCENT)
        set(value) = prefs.edit()
            .putInt(AppConstants.KEY_MAIN_ICON_SIZE_PERCENT, value.coerceIn(AppConstants.MIN_ICON_SIZE_PERCENT, AppConstants.MAX_ICON_SIZE_PERCENT))
            .apply()

    var screenshotIconOpacityPercent: Int
        get() = prefs.getInt(AppConstants.KEY_SCREENSHOT_ICON_OPACITY_PERCENT, AppConstants.DEFAULT_ICON_OPACITY_PERCENT)
            .coerceIn(AppConstants.MIN_ICON_OPACITY_PERCENT, AppConstants.MAX_ICON_OPACITY_PERCENT)
        set(value) = prefs.edit()
            .putInt(AppConstants.KEY_SCREENSHOT_ICON_OPACITY_PERCENT, value.coerceIn(AppConstants.MIN_ICON_OPACITY_PERCENT, AppConstants.MAX_ICON_OPACITY_PERCENT))
            .apply()

    var screenshotIconSizePercent: Int
        get() = prefs.getInt(AppConstants.KEY_SCREENSHOT_ICON_SIZE_PERCENT, AppConstants.DEFAULT_ICON_SIZE_PERCENT)
            .coerceIn(AppConstants.MIN_ICON_SIZE_PERCENT, AppConstants.MAX_ICON_SIZE_PERCENT)
        set(value) = prefs.edit()
            .putInt(AppConstants.KEY_SCREENSHOT_ICON_SIZE_PERCENT, value.coerceIn(AppConstants.MIN_ICON_SIZE_PERCENT, AppConstants.MAX_ICON_SIZE_PERCENT))
            .apply()

    var contextActionIdeaEnabled: Boolean
        get() = contextActionEnabled(AppConstants.KEY_CONTEXT_ACTION_IDEA_ENABLED)
        set(value) = setContextActionEnabled(AppConstants.KEY_CONTEXT_ACTION_IDEA_ENABLED, value)

    var contextActionScreenshotEnabled: Boolean
        get() = contextActionEnabled(AppConstants.KEY_CONTEXT_ACTION_SCREENSHOT_ENABLED)
        set(value) = setContextActionEnabled(AppConstants.KEY_CONTEXT_ACTION_SCREENSHOT_ENABLED, value)

    var contextActionScreenshotVoiceEnabled: Boolean
        get() = contextActionEnabled(AppConstants.KEY_CONTEXT_ACTION_SCREENSHOT_VOICE_ENABLED)
        set(value) = setContextActionEnabled(AppConstants.KEY_CONTEXT_ACTION_SCREENSHOT_VOICE_ENABLED, value)

    var contextActionChatEnabled: Boolean
        get() = contextActionEnabled(AppConstants.KEY_CONTEXT_ACTION_CHAT_ENABLED)
        set(value) = setContextActionEnabled(AppConstants.KEY_CONTEXT_ACTION_CHAT_ENABLED, value)

    var contextActionSaveEnabled: Boolean
        get() = contextActionEnabled(AppConstants.KEY_CONTEXT_ACTION_SAVE_ENABLED)
        set(value) = setContextActionEnabled(AppConstants.KEY_CONTEXT_ACTION_SAVE_ENABLED, value)

    fun registerChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) =
        prefs.registerOnSharedPreferenceChangeListener(listener)

    fun unregisterChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) =
        prefs.unregisterOnSharedPreferenceChangeListener(listener)

    fun getButtonX(defaultValue: Int): Int = prefs.getInt(AppConstants.KEY_BUTTON_X, defaultValue)

    fun getButtonY(defaultValue: Int): Int = prefs.getInt(AppConstants.KEY_BUTTON_Y, defaultValue)

    fun saveButtonPosition(x: Int, y: Int) {
        prefs.edit()
            .putInt(AppConstants.KEY_BUTTON_X, x)
            .putInt(AppConstants.KEY_BUTTON_Y, y)
            .apply()
    }

    private fun contextActionEnabled(key: String): Boolean =
        prefs.getBoolean(key, AppConstants.DEFAULT_CONTEXT_ACTION_ENABLED)

    private fun setContextActionEnabled(key: String, value: Boolean) {
        prefs.edit().putBoolean(key, value).apply()
    }

    private fun migrateLegacyPreferences() {
        if (prefs.all.isNotEmpty()) return
        val legacy = appContext.getSharedPreferences(AppConstants.LEGACY_PREFS, Context.MODE_PRIVATE)
        if (legacy.all.isEmpty()) return
        val editor = prefs.edit()
        for ((key, value) in legacy.all) {
            when (value) {
                is String -> editor.putString(key, value)
                is Boolean -> editor.putBoolean(key, value)
                is Int -> editor.putInt(key, value)
                is Long -> editor.putLong(key, value)
                is Float -> editor.putFloat(key, value)
                is Set<*> -> editor.putStringSet(key, value.filterIsInstance<String>().toSet())
            }
        }
        editor.apply()
    }

    private fun migrateLegacyAccessToken(): String {
        val encrypted = secureStrings.deviceAccessToken()
        val saved = prefs.getString(AppConstants.KEY_AUTH_TOKEN, "").orEmpty().trim()
        if (encrypted.isNotBlank()) {
            if (saved != SECURE_AUTH_TOKEN_MARKER) {
                check(prefs.edit().putString(AppConstants.KEY_AUTH_TOKEN, SECURE_AUTH_TOKEN_MARKER).commit()) {
                    "access_store_failed"
                }
            }
            return encrypted
        }
        if (saved.isBlank() || saved == LEGACY_AUTH_TOKEN_PLACEHOLDER || saved == SECURE_AUTH_TOKEN_MARKER) {
            if (saved.isNotBlank()) {
                check(prefs.edit().remove(AppConstants.KEY_AUTH_TOKEN).commit()) { "access_store_failed" }
            }
            return ""
        }
        secureStrings.writeDeviceAccessToken(saved)
        check(prefs.edit().putString(AppConstants.KEY_AUTH_TOKEN, SECURE_AUTH_TOKEN_MARKER).commit()) {
            "access_store_failed"
        }
        return saved
    }

    private fun storeAccessToken(value: String) {
        secureStrings.writeDeviceAccessToken(value)
        val editor = prefs.edit()
        if (value.isBlank()) editor.remove(AppConstants.KEY_AUTH_TOKEN)
        else editor.putString(AppConstants.KEY_AUTH_TOKEN, SECURE_AUTH_TOKEN_MARKER)
        check(editor.commit()) { "access_store_failed" }
    }

    private fun accountUserIdUnlocked(): String =
        prefs.getString(AppConstants.KEY_ACCOUNT_USER_ID, "").orEmpty().trim()

    private fun queueOwnerScopeUnlocked(): QueueOwnerScope =
        QueueOwnerScope.create(accountUserIdUnlocked(), installId)

    companion object {
        private val ACCESS_LOCK = Any()
        private val QUEUE_SETTINGS_LOCK = Any()
        private const val LEGACY_AUTH_TOKEN_PLACEHOLDER = "replace-with-local-token"
        private const val SECURE_AUTH_TOKEN_MARKER = "android-keystore"
        val SUPPORTED_LLM_PROVIDERS = setOf("openai", "groq", "openrouter", "gemini", "custom-openai")
        val ACCOUNT_PROVIDER_IDS = setOf("openai", "groq", "openrouter", "gemini")
        val SUPPORTED_TRANSCRIPTION_PROVIDERS = setOf("openai", "groq")

        private val LEGACY_SERVER_URLS = setOf(
            "https://your-server.example.com",
            "http://192.168.1.9:8787"
        )

        internal fun <T> mutateQueueSettings(block: () -> T): T = synchronized(QUEUE_SETTINGS_LOCK) { block() }

        private fun isLegacyBraiServerUrl(value: String): Boolean {
            if (value in LEGACY_SERVER_URLS) return true
            val uri = runCatching { Uri.parse(value) }.getOrNull() ?: return false
            val host = uri.host?.lowercase().orEmpty()
            return host == "api.brightos.world" ||
                host == "app.brightos.world" ||
                host == "dev.brightos.world" ||
                host.matches(Regex("^[a-e]\\.test\\.brightos\\.world$"))
        }
    }
}
