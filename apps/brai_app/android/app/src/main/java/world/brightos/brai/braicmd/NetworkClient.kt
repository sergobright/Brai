package world.brightos.brai.braicmd

import world.brightos.brai.BuildConfig

import android.content.Context
import android.media.MediaMetadataRetriever
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.URL
import java.util.UUID
import java.util.function.BooleanSupplier

data class DictationResponse(
    val text: String,
    val provider: String,
    val model: String,
    val fallbackUsed: Boolean,
    val notice: BraiCmdNotice?,
    val audioDurationMs: Long,
    val postProcessed: Boolean,
    val postProcessingProvider: String,
    val postProcessingModel: String,
    val postProcessingInputChars: Int,
    val postProcessingOutputChars: Int
)

data class AccessResponse(
    val token: String,
    val displayName: String
)

data class AccountAccessResponse(
    val token: String,
    val accountUserId: String
)

data class PreliminaryProfileResponse(
    val status: String,
    val preliminaryUserId: String,
    val preliminaryClaimToken: String,
    val displayName: String,
    val duplicateDevice: Boolean
)

data class CloudPostProcessingResponse(
    val text: String,
    val provider: String,
    val model: String,
    val inputChars: Int,
    val outputChars: Int
)

internal data class ProviderCredentialSyncFailure(
    val providerId: String,
    val code: String
)

internal data class ProviderCredentialSyncResult(
    val accountUserId: String,
    val accountKeys: Map<String, String>,
    val importedProviderIds: List<String>,
    val ignoredProviderIds: List<String>,
    val failures: List<ProviderCredentialSyncFailure>
)

internal fun parseProviderCredentialSync(json: JSONObject): ProviderCredentialSyncResult {
    val providers = json.optJSONArray("providers") ?: JSONArray()
    val accountKeys = (0 until providers.length())
        .mapNotNull { providers.optJSONObject(it) }
        .mapNotNull { item ->
            val providerId = item.optString("provider_id").trim()
            val apiKey = item.optString("api_key").trim()
            if (providerId !in ConfigStore.ACCOUNT_PROVIDER_IDS || apiKey.isBlank() || apiKey.length > 16_384) null
            else providerId to apiKey
        }
        .toMap()
    val failuresJson = json.optJSONArray("failed") ?: JSONArray()
    val failures = (0 until failuresJson.length())
        .mapNotNull { failuresJson.optJSONObject(it) }
        .mapNotNull { item ->
            val providerId = item.optString("provider_id").trim()
            if (providerId !in ConfigStore.ACCOUNT_PROVIDER_IDS) null
            else ProviderCredentialSyncFailure(providerId, item.optString("code", "sync_failed").trim().ifBlank { "sync_failed" })
        }
    return ProviderCredentialSyncResult(
        accountUserId = json.optString("account_user_id").trim(),
        accountKeys = accountKeys,
        importedProviderIds = json.optJSONArray("imported_provider_ids").providerIds(),
        ignoredProviderIds = json.optJSONArray("ignored_provider_ids").providerIds(),
        failures = failures
    )
}

private fun JSONArray?.providerIds(): List<String> {
    if (this == null) return emptyList()
    return (0 until length())
        .map { optString(it).trim() }
        .filter { it in ConfigStore.ACCOUNT_PROVIDER_IDS }
        .distinct()
}

class ServerResponseException(
    val statusCode: Int,
    val code: String,
    val json: JSONObject?,
    message: String
) : IllegalStateException(message) {
    constructor(statusCode: Int, code: String, message: String) : this(statusCode, code, null, message)
}

internal const val PRELIMINARY_TIMEOUT_MS = 15_000

internal fun preliminaryFailureCode(error: Throwable): String = when (error) {
    is SocketTimeoutException -> "preliminary_timeout"
    is UnknownHostException, is ConnectException, is IOException -> "preliminary_network"
    is ServerResponseException -> "preliminary_server"
    else -> "preliminary_unknown"
}

class NetworkClient internal constructor(
    context: Context,
    private val config: ConfigStore
) {
    constructor(context: Context) : this(context, ConfigStore(context))

    private val appContext = context.applicationContext

    fun publicHealthCheck(): String {
        val connection = openPublicConnection("/health", "GET")
        return healthStatus(readJson(connection))
    }

    fun healthCheck(): String {
        val connection = openAuthenticatedConnection("/v1/health", "GET")
        return healthStatus(readJson(connection))
    }

    fun ensureDeviceAccess(displayName: String, deviceFingerprint: String) =
        ensureDeviceAccess(displayName, deviceFingerprint, BooleanSupplier { true })

    fun ensureDeviceAccess(
        displayName: String,
        deviceFingerprint: String,
        canApply: BooleanSupplier
    ) {
        check(canApply.asBoolean) { "credential_operation_superseded" }
        if (config.authToken.isNotBlank()) {
            try {
                healthCheck()
                check(canApply.asBoolean) { "credential_operation_superseded" }
                return
            } catch (error: ServerResponseException) {
                if (error.statusCode != 401 && error.statusCode != 403) return
                check(canApply.asBoolean) { "credential_operation_superseded" }
                config.authToken = ""
            } catch (_: Throwable) {
                return
            }
        }
        val access = requestAccess(displayName, deviceFingerprint)
        check(access.token.isNotBlank()) { "missing_access_token" }
        check(canApply.asBoolean) { "credential_operation_superseded" }
        config.authToken = access.token
        config.displayName = access.displayName.ifBlank { displayName }
        healthCheck()
        check(canApply.asBoolean) { "credential_operation_superseded" }
    }

    fun diagnostics(includeCloudTranscription: Boolean): JSONObject {
        val connection = openAuthenticatedConnection("/v1/brai-cmd/diagnostics", "POST").apply {
            doOutput = true
            readTimeout = DEFAULT_READ_TIMEOUT_MS
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        val body = JSONObject()
            .put("includeCloudTranscription", includeCloudTranscription)
            .toString()
            .toByteArray(Charsets.UTF_8)
        connection.outputStream.use { it.write(body) }
        return readJson(connection)
    }

    internal fun syncProviderCredentials(localProviders: Map<String, String>): ProviderCredentialSyncResult {
        val connection = openAuthenticatedConnection("/v1/brai-cmd/provider-credentials/sync", "POST").apply {
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        val providers = JSONArray()
        val candidates = localProviders.entries
            .filter { it.key in ConfigStore.ACCOUNT_PROVIDER_IDS }
        val invalidProviderIds = candidates
            .filter { (_, apiKey) -> apiKey.length !in 8..2_048 || apiKey.contains('\r') || apiKey.contains('\n') }
            .map { it.key }
        candidates
            .filterNot { it.key in invalidProviderIds }
            .sortedBy { it.key }
            .take(ConfigStore.ACCOUNT_PROVIDER_IDS.size)
            .forEach { (providerId, apiKey) ->
                providers.put(JSONObject().put("provider_id", providerId).put("api_key", apiKey))
            }
        val body = JSONObject().put("providers", providers).toString().toByteArray(Charsets.UTF_8)
        connection.outputStream.use { it.write(body) }
        val result = parseProviderCredentialSync(readJson(connection))
        val ignoredInvalid = invalidProviderIds.filter { it in result.accountKeys }
        val failedInvalid = invalidProviderIds.filterNot { it in result.accountKeys }
        return result.copy(
            ignoredProviderIds = (result.ignoredProviderIds + ignoredInvalid).distinct(),
            failures = result.failures + failedInvalid.map { ProviderCredentialSyncFailure(it, "invalid_key") }
        )
    }

    fun activateAccountAccess(linkToken: String): AccountAccessResponse {
        val cleanToken = linkToken.trim()
        require(cleanToken.length in 8..4_096 && !cleanToken.contains('\r') && !cleanToken.contains('\n')) {
            "invalid_link_token"
        }
        val connection = openAuthenticatedConnection("/v1/brai-cmd/account-access/activate", "POST").apply {
            doOutput = true
            connectTimeout = ACCOUNT_ACCESS_TIMEOUT_MS
            readTimeout = ACCOUNT_ACCESS_TIMEOUT_MS
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        val body = JSONObject().put("link_token", cleanToken).toString().toByteArray(Charsets.UTF_8)
        connection.outputStream.use { it.write(body) }
        val json = readJson(connection)
        val token = json.optString("token").trim()
        val userId = json.optString("account_user_id").trim()
        check(token.length in 8..4_096 && !token.contains('\r') && !token.contains('\n') && userId.isNotBlank()) {
            "invalid_account_access_response"
        }
        return AccountAccessResponse(token, userId)
    }

    fun revokeCurrentAccess() {
        revokeAccess(config.authToken)
    }

    fun revokeAccess(token: String) {
        val connection = openAuthenticatedConnection("/v1/brai-cmd/access/revoke-self", "POST", token).apply {
            doOutput = true
            connectTimeout = ACCOUNT_ACCESS_TIMEOUT_MS
            readTimeout = ACCOUNT_ACCESS_TIMEOUT_MS
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        connection.outputStream.use { it.write("{}".toByteArray(Charsets.UTF_8)) }
        readJson(connection)
    }

    fun requestPreliminaryProfile(displayName: String, deviceFingerprint: String): PreliminaryProfileResponse {
        val connection = openPublicConnection("/v1/brai-cmd/preliminary-profile", "POST").apply {
            doOutput = true
            connectTimeout = PRELIMINARY_TIMEOUT_MS
            readTimeout = PRELIMINARY_TIMEOUT_MS
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        val body = JSONObject()
            .put("displayName", displayName)
            .put("deviceFingerprint", deviceFingerprint)
            .put("deviceFingerprintKind", "android_id")
            .put("deviceId", config.installId)
            .put("preliminaryUserId", config.preliminaryUserId)
            .put("preliminaryClaimToken", config.preliminaryClaimToken)
            .put("clientVersion", BuildConfig.VERSION_NAME)
            .put("appPackage", appContext.packageName)
            .toString()
            .toByteArray(Charsets.UTF_8)
        connection.outputStream.use { it.write(body) }
        return try {
            val json = readJson(connection)
            PreliminaryProfileResponse(
                status = json.optString("status", "ready"),
                preliminaryUserId = json.optString("preliminaryUserId"),
                preliminaryClaimToken = json.optString("preliminaryClaimToken"),
                displayName = json.optString("displayName", displayName),
                duplicateDevice = false
            )
        } catch (error: ServerResponseException) {
            if (error.statusCode == 409 && error.code == "duplicate_device") {
                PreliminaryProfileResponse(
                    status = "duplicate",
                    preliminaryUserId = error.json?.optString("preliminaryUserId").orEmpty(),
                    preliminaryClaimToken = "",
                    displayName = displayName,
                    duplicateDevice = true
                )
            } else {
                throw error
            }
        }
    }

    fun requestAccess(displayName: String, deviceFingerprint: String = ""): AccessResponse {
        val connection = openPublicConnection("/v1/access/request", "POST").apply {
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        val body = JSONObject()
            .put("displayName", displayName)
            .put("deviceId", config.installId)
            .put("deviceFingerprint", deviceFingerprint)
            .put("preliminaryUserId", config.preliminaryUserId)
            .put("preliminaryClaimToken", config.preliminaryClaimToken)
            .put("clientVersion", BuildConfig.VERSION_NAME)
            .put("appPackage", appContext.packageName)
            .toString()
            .toByteArray(Charsets.UTF_8)
        connection.outputStream.use { it.write(body) }
        val json = readJson(connection)
        return AccessResponse(
            token = json.optString("token"),
            displayName = json.optString("displayName")
        )
    }

    fun uploadAudio(
        file: File,
        conversationContext: VisibleConversationContext? = null,
        screenshotFile: File? = null,
        braiCmdFunction: String = AudioQueueAction.MainDictation.functionKey,
        cloudPostProcessingEnabled: Boolean = config.postProcessingEnabled && config.postProcessingProviderMode != "key",
        cloudPostProcessingPrompt: String = postProcessingPrompt(),
        accessToken: String = config.authToken
    ): DictationResponse {
        val boundary = "BraiCmd-${UUID.randomUUID()}"
        val connection = openAuthenticatedConnection("/v1/dictate", "POST", accessToken).apply {
            doOutput = true
            readTimeout = DICTATE_READ_TIMEOUT_MS
            setChunkedStreamingMode(64 * 1024)
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        }
        val durationMs = audioDurationMs(file)
        val shouldSendHeaderContext = conversationContext?.isReliable() == true
        val shouldSendScreenshot = screenshotFile?.isFile == true && screenshotFile.length() > 0L
        BufferedOutputStream(connection.outputStream).use { out ->
            writeField(out, boundary, "locale", config.locale)
            writeField(out, boundary, "deviceId", config.installId)
            writeField(out, boundary, "clientVersion", BuildConfig.VERSION_NAME)
            writeField(out, boundary, "appPackage", appContext.packageName)
            writeField(out, boundary, "braiCmdFunction", braiCmdFunction)
            writeField(out, boundary, "audioDurationMs", durationMs.toString())
            if (shouldSendHeaderContext) {
                writeField(out, boundary, "headerContextEnabled", "true")
                writeField(out, boundary, "screenTitle", conversationContext.recipientName)
                writeField(out, boundary, "screenAppPackage", conversationContext.appPackage)
                writeField(out, boundary, "screenAppLabel", conversationContext.appLabel)
                writeField(out, boundary, "pageContextJson", conversationContext.toJson().toString())
                writeField(out, boundary, "normalizedContextJson", conversationContext.toNormalizedJson().toString())
            }
            if (shouldSendScreenshot) {
                writeField(out, boundary, "screenshotContextEnabled", "true")
                writeFile(out, boundary, "screenshot", screenshotFile.name, "image/jpeg", screenshotFile)
            }
            if (cloudPostProcessingEnabled) {
                writeField(out, boundary, "postProcessingEnabled", "true")
                writeField(out, boundary, "postProcessingPrompt", cloudPostProcessingPrompt)
            }
            writeFile(out, boundary, "audio", file.name, "audio/mp4", file)
            out.write("--$boundary--\r\n".toByteArray())
        }
        val json = readJson(connection)
        val serverText = json.optString("text")
        return DictationResponse(
            text = serverText,
            provider = json.optString("provider"),
            model = json.optString("model"),
            fallbackUsed = json.optBoolean("fallbackUsed", false),
            notice = noticeFromJson(json.optJSONObject("notice")),
            audioDurationMs = durationMs,
            postProcessed = json.optBoolean("postProcessed", false),
            postProcessingProvider = if (json.optBoolean("postProcessed", false)) "brai-cloud" else "",
            postProcessingModel = json.optString("postProcessingModel"),
            postProcessingInputChars = json.optInt("postProcessingInputChars", 0),
            postProcessingOutputChars = json.optInt("postProcessingOutputChars", 0)
        )
    }

    fun uploadInboxCommand(
        transcript: String,
        conversationContext: VisibleConversationContext?,
        screenshotFile: File?,
        idempotencyKey: String,
        braiCmdFunction: String = AudioQueueAction.IdeaVoiceInbox.functionKey,
        accessToken: String = config.authToken
    ): BraiCmdNotice? {
        val connection = openAuthenticatedConnection("/v1/brai-cmd/inbox", "POST", accessToken).apply {
            doOutput = true
            readTimeout = DEFAULT_READ_TIMEOUT_MS
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        val attachments = JSONArray()
        if (screenshotFile?.isFile == true && screenshotFile.length() > 0L) {
            val mime = if (screenshotFile.name.endsWith(".jpg", ignoreCase = true) ||
                screenshotFile.name.endsWith(".jpeg", ignoreCase = true)
            ) {
                "image/jpeg"
            } else {
                "image/png"
            }
            attachments.put(JSONObject()
                .put("base64", Base64.encodeToString(screenshotFile.readBytes(), Base64.NO_WRAP))
                .put("mime", mime)
                .put("name", screenshotFile.name)
            )
        }
        val body = JSONObject()
            .put("text", transcript)
            .put("source", "brai-cmd")
            .put("source_key", config.installId)
            .put("record_type_id", 1)
            .put("brai_cmd_function", braiCmdFunction)
            .put("idempotency_key", idempotencyKey)
        if (conversationContext?.isReliable() == true) body.put("description_json", conversationContext.toJson())
        if (attachments.length() > 0) body.put("attachments", attachments)
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        connection.outputStream.use { it.write(bytes) }
        return noticeFromJson(readJson(connection).optJSONObject("notice"))
    }

    private fun noticeFromJson(json: JSONObject?): BraiCmdNotice? {
        json ?: return null
        val text = braiCmdNoticeText(json.optString("text"))
        if (text.isBlank()) return null
        return BraiCmdNotice(
            key = json.optString("key"),
            text = text,
            tone = serverNoticeTone(json.optString("tone"))
        )
    }

    fun postProcessText(
        text: String,
        prompt: String,
        accessToken: String = config.authToken
    ): CloudPostProcessingResponse {
        val connection = openAuthenticatedConnection("/v1/brai-cmd/post-process", "POST", accessToken).apply {
            doOutput = true
            readTimeout = DEFAULT_READ_TIMEOUT_MS
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        val body = JSONObject()
            .put("text", text.trim())
            .put("prompt", prompt.trim())
            .toString()
            .toByteArray(Charsets.UTF_8)
        connection.outputStream.use { it.write(body) }
        val json = readJson(connection)
        return CloudPostProcessingResponse(
            text = json.optString("text").trim(),
            provider = json.optString("provider", "brai-cloud"),
            model = json.optString("model"),
            inputChars = json.optInt("inputChars", text.length + prompt.length),
            outputChars = json.optInt("outputChars", json.optString("text").length)
        )
    }

    private fun openPublicConnection(path: String, method: String): HttpURLConnection {
        val base = config.serverUrl.trim().trimEnd('/')
        require(base.startsWith("http://") || base.startsWith("https://")) { "Адрес сервера должен начинаться с http:// или https://" }
        return (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = DEFAULT_READ_TIMEOUT_MS
            setRequestProperty("Accept", "application/json")
        }
    }

    private fun openAuthenticatedConnection(path: String, method: String): HttpURLConnection {
        return openAuthenticatedConnection(path, method, config.authToken)
    }

    private fun openAuthenticatedConnection(path: String, method: String, accessToken: String): HttpURLConnection {
        val token = accessToken.trim()
        if (token.isBlank()) throw QueueAuthBlockedException()
        return openPublicConnection(path, method).apply {
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("X-Brai-Cmd-Device-Id", config.installId)
            setRequestProperty("X-Brai-Cmd-Client-Version", BuildConfig.VERSION_NAME)
        }
    }

    private fun readJson(connection: HttpURLConnection): JSONObject {
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (status !in 200..299) {
            val json = runCatching { JSONObject(body) }.getOrNull()
            val code = json?.optString("code")?.takeUnless { it.isBlank() }
                ?: (json?.opt("error") as? String)?.takeUnless { it.isBlank() }
                ?: "http_error"
            val providerMessage = json?.optJSONObject("error")?.optString("message")?.takeUnless { it.isBlank() }
                ?: (json?.opt("error") as? String)?.takeUnless { it.isBlank() }
                ?: body
            throw ServerResponseException(status, code, json, serverErrorMessage(status, code, providerMessage))
        }
        return JSONObject(body)
    }

    private fun serverErrorMessage(status: Int, code: String, detail: String): String = when (code) {
        "unauthorized" -> "Токен устройства недействителен. Переподключите Brai."
        "missing_device_id" -> "Не удалось определить устройство. Перезапустите приложение."
        "text_required" -> "Нет текста для обработки."
        "prompt_required", "post_processing_prompt_required" -> "Заполните промпт постобработки."
        "prompt_too_long", "post_processing_prompt_too_long" -> "Промпт постобработки слишком длинный."
        "request_too_large", "audio_too_large" -> "Аудиозапись слишком большая."
        "unsupported_media_type", "unsupported_audio" -> "Формат аудиозаписи не поддерживается."
        "upstream_error" -> "AI-провайдер Brai временно недоступен. Попробуйте ещё раз."
        "internal_error" -> "Сервер Brai временно не может обработать запрос."
        else -> detail.trim().takeIf { it.isNotBlank() } ?: "Сервер Brai вернул ошибку $status."
    }

    private fun healthStatus(json: JSONObject): String =
        json.optString("status").takeIf { it.isNotBlank() && it != "unknown" } ?: "ok"

    private fun writeField(out: BufferedOutputStream, boundary: String, name: String, value: String) {
        out.write("--$boundary\r\n".toByteArray())
        out.write("Content-Disposition: form-data; name=\"$name\"\r\n\r\n".toByteArray())
        out.write(value.toByteArray(Charsets.UTF_8))
        out.write("\r\n".toByteArray())
    }

    private fun writeFile(out: BufferedOutputStream, boundary: String, name: String, filename: String, contentType: String, file: File) {
        out.write("--$boundary\r\n".toByteArray())
        out.write("Content-Disposition: form-data; name=\"$name\"; filename=\"$filename\"\r\n".toByteArray())
        out.write("Content-Type: $contentType\r\n\r\n".toByteArray())
        file.inputStream().use { input -> input.copyTo(out) }
        out.write("\r\n".toByteArray())
    }

    private fun audioDurationMs(file: File): Long {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(file.absolutePath)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        } catch (_: Throwable) {
            0L
        } finally {
            retriever.release()
        }
    }

    private fun postProcessingPrompt(): String =
        config.postProcessingPrompt.take(MAX_POST_PROCESSING_PROMPT_CHARS)

    companion object {
        const val MAX_AUDIO_BYTES = 25L * 1024L * 1024L
        private const val MAX_POST_PROCESSING_PROMPT_CHARS = 4000
        private const val DEFAULT_READ_TIMEOUT_MS = 70_000
        private const val DICTATE_READ_TIMEOUT_MS = 240_000
        private const val ACCOUNT_ACCESS_TIMEOUT_MS = 10_000
    }
}
