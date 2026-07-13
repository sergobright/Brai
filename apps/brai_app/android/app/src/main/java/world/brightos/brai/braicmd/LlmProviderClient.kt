package world.brightos.brai.braicmd

import android.content.Context
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.net.HttpURLConnection
import java.net.URL

internal data class LlmProviderResult(
    val text: String,
    val provider: String,
    val model: String,
    val inputChars: Int,
    val outputChars: Int
)

internal class ProviderResponseException(
    val statusCode: Int,
    message: String
) : IllegalStateException(message)

internal class LlmProviderClient @JvmOverloads constructor(
    private val context: Context,
    private val endpointOverrides: Map<String, String> = emptyMap()
) {
    private val appContext = context.applicationContext

    fun test(providerId: String, apiKey: String, model: String, baseUrl: String): JSObject {
        return connect(providerId, apiKey, model, baseUrl, "text")
    }

    fun probe(providerId: String, apiKey: String, baseUrl: String, capability: String): JSObject {
        val cleanProvider = cleanProvider(providerId)
        val cleanKey = resolvedKey(cleanProvider, apiKey)
        val models = compatibleModels(cleanProvider, capability, listModels(cleanProvider, cleanKey, baseUrl))
        val array = JSArray()
        models.forEach { array.put(it) }
        return JSObject()
            .put("ok", true)
            .put("message", "Подключение проверено. Выберите модель.")
            .put("providerId", cleanProvider)
            .put("models", array)
            .put("manualModel", models.isEmpty())
    }

    fun connect(providerId: String, apiKey: String, model: String, baseUrl: String, capability: String): JSObject {
        val cleanProvider = cleanProvider(providerId)
        val cleanKey = resolvedKey(cleanProvider, apiKey)
        val selectedModel = model.trim()
        if (selectedModel.isBlank()) throw IllegalArgumentException("Выберите модель")
        if (capability == "speech") {
            require(compatibleModels(cleanProvider, capability, listOf(selectedModel)).isNotEmpty()) {
                "Выбранная модель не поддерживает распознавание речи"
            }
            SpeechProviderClient(appContext, endpointOverrides).test(cleanProvider, cleanKey, selectedModel)
        } else {
            val response = complete(
            providerId = cleanProvider,
            apiKey = cleanKey,
            model = selectedModel,
            baseUrl = baseUrl,
            system = "Return only the word ok.",
            user = "ping",
            maxTokens = 16
            )
            if (response.text.isBlank()) throw IllegalStateException("Поставщик вернул пустой ответ")
        }
        return JSObject()
            .put("ok", true)
            .put("message", "Подключено")
            .put("providerId", cleanProvider)
            .put("model", selectedModel)
    }

    fun postProcess(sourceText: String, prompt: String): LlmProviderResult {
        val config = ConfigStore(appContext)
        val secure = SecureStringStore(appContext)
        secure.migrateLegacyProviderKey(config.llmProviderId)
        val apiKey = secure.providerKey(config.llmProviderId)
        val providerId = cleanProvider(config.llmProviderId)
        val model = config.llmProviderModel
        if (apiKey.isBlank() || model.isBlank()) throw IllegalStateException("llm_provider_not_configured")
        val cleanPrompt = prompt.trim()
        val cleanText = sourceText.trim()
        if (cleanText.isBlank()) return LlmProviderResult("", providerId, model, 0, 0)
        val result = complete(
            providerId = providerId,
            apiKey = apiKey,
            model = model,
            baseUrl = config.llmProviderBaseUrl,
            system = "You post-process speech transcripts. Follow the user's editing instruction, preserve the original meaning and language unless explicitly asked otherwise, and return only the final text.",
            user = "Instruction:\n$cleanPrompt\n\nTranscript:\n$cleanText",
            maxTokens = 4096
        )
        return result.copy(inputChars = cleanPrompt.length + cleanText.length, outputChars = result.text.length)
    }

    private fun listModels(providerId: String, apiKey: String, baseUrl: String): List<String> {
        val url = when (providerId) {
            "openai" -> "${endpoint("openai", "https://api.openai.com/v1")}/models"
            "groq" -> "${endpoint("groq", "https://api.groq.com/openai/v1")}/models"
            "openrouter" -> "${endpoint("openrouter", "https://openrouter.ai/api/v1")}/models"
            "gemini" -> "https://generativelanguage.googleapis.com/v1beta/models?key=${urlEncode(apiKey)}"
            "custom-openai" -> "${openAiBaseUrl(baseUrl)}/models"
            else -> error("unsupported_provider")
        }
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15_000
            readTimeout = 45_000
            setRequestProperty("Accept", "application/json")
            if (providerId != "gemini") setRequestProperty("Authorization", "Bearer $apiKey")
        }
        val json = readJson(connection)
        return if (providerId == "gemini") {
            val models = json.optJSONArray("models") ?: JSONArray()
            (0 until models.length())
                .mapNotNull { models.optJSONObject(it) }
                .filter { model ->
                    val actions = model.optJSONArray("supportedGenerationMethods") ?: JSONArray()
                    (0 until actions.length()).any { actions.optString(it) == "generateContent" }
                }
                .mapNotNull { it.optString("name").removePrefix("models/").takeIf(String::isNotBlank) }
                .sorted()
        } else {
            val models = json.optJSONArray("data") ?: JSONArray()
            (0 until models.length())
                .mapNotNull { models.optJSONObject(it)?.optString("id")?.takeIf(String::isNotBlank) }
                .sorted()
        }
    }

    private fun complete(
        providerId: String,
        apiKey: String,
        model: String,
        baseUrl: String,
        system: String,
        user: String,
        maxTokens: Int
    ): LlmProviderResult {
        if (providerId == "gemini") {
            val url = "https://generativelanguage.googleapis.com/v1beta/models/${urlEncode(model)}:generateContent?key=${urlEncode(apiKey)}"
            val body = JSONObject()
                .put("contents", JSONArray().put(JSONObject()
                    .put("role", "user")
                    .put("parts", JSONArray().put(JSONObject().put("text", "$system\n\n$user")))))
                .put("generationConfig", JSONObject()
                    .put("temperature", 0)
                    .put("maxOutputTokens", maxTokens.coerceIn(16, 8192)))
            val json = postJson(url, body, null)
            val text = json.optJSONArray("candidates")
                ?.optJSONObject(0)
                ?.optJSONObject("content")
                ?.optJSONArray("parts")
                ?.optJSONObject(0)
                ?.optString("text")
                .orEmpty()
                .trim()
            return LlmProviderResult(text, providerId, model, 0, text.length)
        }

        val url = when (providerId) {
            "openai" -> "${endpoint("openai", "https://api.openai.com/v1")}/chat/completions"
            "groq" -> "${endpoint("groq", "https://api.groq.com/openai/v1")}/chat/completions"
            "openrouter" -> "${endpoint("openrouter", "https://openrouter.ai/api/v1")}/chat/completions"
            "custom-openai" -> "${openAiBaseUrl(baseUrl)}/chat/completions"
            else -> error("unsupported_provider")
        }
        val body = JSONObject()
            .put("model", model)
            .put("temperature", 0)
            .put("max_tokens", maxTokens.coerceIn(16, 8192))
            .put("messages", JSONArray()
                .put(JSONObject().put("role", "system").put("content", system))
                .put(JSONObject().put("role", "user").put("content", user)))
        val json = postJson(url, body, apiKey)
        val text = json.optJSONArray("choices")
            ?.optJSONObject(0)
            ?.optJSONObject("message")
            ?.optString("content")
            .orEmpty()
            .trim()
        return LlmProviderResult(text, providerId, model, 0, text.length)
    }

    private fun postJson(url: String, body: JSONObject, apiKey: String?): JSONObject {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 60_000
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Accept", "application/json")
            if (!apiKey.isNullOrBlank()) setRequestProperty("Authorization", "Bearer $apiKey")
        }
        BufferedOutputStream(connection.outputStream).use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        return readJson(connection)
    }

    private fun readJson(connection: HttpURLConnection): JSONObject {
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (status !in 200..299) {
            val json = runCatching { JSONObject(body) }.getOrNull()
            val message = json?.optJSONObject("error")?.optString("message")?.takeIf { it.isNotBlank() }
                ?: (json?.opt("error") as? String)?.takeIf { it.isNotBlank() }
                ?: body.ifBlank { "provider_http_$status" }
            throw ProviderResponseException(status, message)
        }
        return JSONObject(body)
    }

    private fun cleanProvider(value: String): String =
        value.trim().takeIf { it in ConfigStore.SUPPORTED_LLM_PROVIDERS }
            ?: throw IllegalArgumentException("unsupported_provider")

    private fun defaultModel(providerId: String, models: List<String>): String =
        models.firstOrNull { model ->
            when (providerId) {
                "openai" -> model.startsWith("gpt-") || model.startsWith("o")
                "groq" -> model.contains("gpt-oss", ignoreCase = true) ||
                    model.contains("llama", ignoreCase = true) ||
                    model.contains("gemma", ignoreCase = true) ||
                    model.contains("mixtral", ignoreCase = true)
                "gemini" -> model.startsWith("gemini", ignoreCase = true)
                "openrouter" -> !model.contains("embedding", ignoreCase = true) && !model.contains("whisper", ignoreCase = true)
                else -> true
            }
        } ?: models.firstOrNull().orEmpty()

    private fun resolvedKey(providerId: String, supplied: String): String {
        val clean = supplied.trim().ifBlank { SecureStringStore(appContext).providerKey(providerId) }
        if (clean.isBlank()) throw IllegalArgumentException("Введите API-ключ")
        return clean
    }

    private fun compatibleModels(providerId: String, capability: String, models: List<String>): List<String> {
        if (capability == "speech") {
            return models.filter { model ->
                when (providerId) {
                    "openai" -> model == "whisper-1" ||
                        (model.startsWith("gpt-4o") && model.contains("transcribe") && !model.contains("diarize"))
                    "groq" -> model == "whisper-large-v3" || model == "whisper-large-v3-turbo"
                    else -> false
                }
            }
        }
        return models.filterNot { model ->
            model.contains("embedding", true) || model.contains("whisper", true) ||
                model.contains("transcribe", true) || model.contains("tts", true)
        }
    }

    private fun openAiBaseUrl(value: String): String {
        val clean = value.trim().trimEnd('/')
        require(clean.startsWith("https://") || clean.startsWith("http://")) { "base_url_required" }
        return if (clean.endsWith("/v1")) clean else "$clean/v1"
    }

    private fun endpoint(providerId: String, fallback: String): String =
        endpointOverrides[providerId]?.trimEnd('/') ?: fallback

    private fun urlEncode(value: String): String =
        java.net.URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}
