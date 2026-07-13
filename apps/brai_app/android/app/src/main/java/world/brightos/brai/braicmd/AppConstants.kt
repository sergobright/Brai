package world.brightos.brai.braicmd

import world.brightos.brai.BuildConfig

object AppConstants {
    const val PREFS = "brai_cmd"
    const val LEGACY_PREFS = "airwhisper"
    const val KEY_SERVER_URL = "server_url"
    const val KEY_AUTH_TOKEN = "auth_token"
    const val KEY_DISPLAY_NAME = "display_name"
    const val KEY_INSTALL_ID = "install_id"
    const val KEY_PRELIMINARY_USER_ID = "preliminary_user_id"
    const val KEY_PRELIMINARY_CLAIM_TOKEN = "preliminary_claim_token"
    const val KEY_LOCALE = "locale"
    const val KEY_HEADER_CONTEXT_ENABLED = "header_context_enabled"
    const val KEY_SCREENSHOT_CONTEXT_ENABLED = "screenshot_context_enabled"
    const val KEY_POST_PROCESSING_ENABLED = "post_processing_enabled"
    const val KEY_POST_PROCESSING_PROMPT = "post_processing_prompt"
    const val KEY_ONBOARDING_VOICE_ONLY = "onboarding_voice_only"
    const val KEY_ONBOARDING_QUEUE_PAUSED = "onboarding_queue_paused"
    const val KEY_OVERLAY_ENABLED = "overlay_enabled"
    const val KEY_MAIN_DICTATION_ENABLED = "main_dictation_enabled"
    const val KEY_BUTTON_X = "button_x"
    const val KEY_BUTTON_Y = "button_y"
    const val KEY_MAIN_ICON_OPACITY_PERCENT = "main_icon_opacity_percent"
    const val KEY_MAIN_ICON_SIZE_PERCENT = "main_icon_size_percent"
    const val KEY_SCREENSHOT_ICON_OPACITY_PERCENT = "screenshot_icon_opacity_percent"
    const val KEY_SCREENSHOT_ICON_SIZE_PERCENT = "screenshot_icon_size_percent"
    const val KEY_CONTEXT_ACTION_IDEA_ENABLED = "context_action_idea_enabled"
    const val KEY_CONTEXT_ACTION_SCREENSHOT_ENABLED = "context_action_screenshot_enabled"
    const val KEY_CONTEXT_ACTION_SCREENSHOT_VOICE_ENABLED = "context_action_screenshot_voice_enabled"
    const val KEY_CONTEXT_ACTION_CHAT_ENABLED = "context_action_chat_enabled"
    const val KEY_CONTEXT_ACTION_SAVE_ENABLED = "context_action_save_enabled"
    const val KEY_POST_PROCESSING_PROVIDER_MODE = "post_processing_provider_mode"
    const val KEY_LLM_PROVIDER_ID = "llm_provider_id"
    const val KEY_LLM_PROVIDER_MODEL = "llm_provider_model"
    const val KEY_LLM_PROVIDER_BASE_URL = "llm_provider_base_url"
    const val KEY_TRANSCRIPTION_PROVIDER_MODE = "transcription_provider_mode"
    const val KEY_TRANSCRIPTION_PROVIDER_ID = "transcription_provider_id"
    const val KEY_TRANSCRIPTION_PROVIDER_MODEL = "transcription_provider_model"
    const val KEY_PROCESSED_AUDIO_RETENTION_ENABLED = "processed_audio_retention_enabled"
    const val KEY_PROCESSED_AUDIO_RETENTION_LIMIT = "processed_audio_retention_limit"

    const val DEFAULT_SERVER_URL = BuildConfig.BRAI_ANDROID_API
    const val DEFAULT_HEADER_CONTEXT_ENABLED = true
    const val DEFAULT_SCREENSHOT_CONTEXT_ENABLED = false
    const val DEFAULT_ICON_OPACITY_PERCENT = 100
    const val MIN_ICON_OPACITY_PERCENT = 35
    const val MAX_ICON_OPACITY_PERCENT = 100
    const val DEFAULT_ICON_SIZE_PERCENT = 100
    const val MIN_ICON_SIZE_PERCENT = 70
    const val MAX_ICON_SIZE_PERCENT = 130
    const val DEFAULT_CONTEXT_ACTION_ENABLED = true
    const val DEFAULT_LLM_PROVIDER_MODE = "cloud"
    const val DEFAULT_LLM_PROVIDER_ID = "openai"
    const val DEFAULT_TRANSCRIPTION_PROVIDER_MODE = "cloud"
    const val DEFAULT_PROCESSED_AUDIO_RETENTION_LIMIT = 25
    const val MIN_PROCESSED_AUDIO_RETENTION_LIMIT = 1
    const val MAX_PROCESSED_AUDIO_RETENTION_LIMIT = 999
    const val DEFAULT_POST_PROCESSING_PROMPT =
        "Исправь пунктуацию, заглавные буквы и очевидные ошибки распознавания речи. " +
            "Не меняй смысл, стиль и язык текста. Верни только готовый текст."
}
