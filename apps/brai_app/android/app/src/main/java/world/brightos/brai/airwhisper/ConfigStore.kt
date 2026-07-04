package world.brightos.brai.airwhisper

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

enum class ContextDeliveryMode {
    Json,
    Screenshot
}

class ConfigStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(AppConstants.PREFS, Context.MODE_PRIVATE)

    var serverUrl: String
        get() {
            val value = prefs.getString(AppConstants.KEY_SERVER_URL, AppConstants.DEFAULT_SERVER_URL).orEmpty()
            return if (value in LEGACY_SERVER_URLS) AppConstants.DEFAULT_SERVER_URL else value
        }
        set(value) = prefs.edit().putString(AppConstants.KEY_SERVER_URL, value.trim()).apply()

    var authToken: String
        get() {
            val saved = prefs.getString(AppConstants.KEY_AUTH_TOKEN, "").orEmpty().trim()
            return if (saved == LEGACY_AUTH_TOKEN_PLACEHOLDER) "" else saved
        }
        set(value) = prefs.edit().putString(AppConstants.KEY_AUTH_TOKEN, value.trim()).apply()

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

    companion object {
        private const val LEGACY_AUTH_TOKEN_PLACEHOLDER = "replace-with-local-token"

        private val LEGACY_SERVER_URLS = setOf(
            "https://your-server.example.com",
            "http://192.168.1.9:8787"
        )
    }
}
