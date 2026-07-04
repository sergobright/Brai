package world.brightos.brai.airwhisper

import world.brightos.brai.BuildConfig

import android.content.Context
import android.media.MediaMetadataRetriever
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

data class DictationResponse(
    val text: String,
    val provider: String,
    val model: String,
    val fallbackUsed: Boolean
)

data class AccessResponse(
    val token: String,
    val displayName: String
)

class ServerResponseException(
    val statusCode: Int,
    val code: String,
    message: String
) : IllegalStateException(message)

class NetworkClient(context: Context) {
    private val appContext = context.applicationContext
    private val config = ConfigStore(appContext)

    fun publicHealthCheck(): String {
        val connection = openPublicConnection("/health", "GET")
        return healthStatus(readJson(connection))
    }

    fun healthCheck(): String {
        val connection = openAuthenticatedConnection("/v1/health", "GET")
        return healthStatus(readJson(connection))
    }

    fun requestAccess(displayName: String): AccessResponse {
        val connection = openPublicConnection("/v1/access/request", "POST").apply {
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        val body = JSONObject()
            .put("displayName", displayName)
            .put("deviceId", config.installId)
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
        screenshotFile: File? = null
    ): DictationResponse {
        val boundary = "AirWhisper-${UUID.randomUUID()}"
        val connection = openAuthenticatedConnection("/v1/dictate", "POST").apply {
            doOutput = true
            readTimeout = DICTATE_READ_TIMEOUT_MS
            setChunkedStreamingMode(64 * 1024)
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        }
        val shouldPostProcess = config.postProcessingEnabled
        val shouldSendHeaderContext = config.headerContextEnabled && conversationContext?.isReliable() == true
        val shouldSendScreenshot = screenshotFile?.isFile == true && screenshotFile.length() > 0L
        BufferedOutputStream(connection.outputStream).use { out ->
            writeField(out, boundary, "locale", config.locale)
            writeField(out, boundary, "deviceId", config.installId)
            writeField(out, boundary, "clientVersion", BuildConfig.VERSION_NAME)
            writeField(out, boundary, "appPackage", appContext.packageName)
            writeField(out, boundary, "audioDurationMs", audioDurationMs(file).toString())
            if (shouldSendHeaderContext) {
                writeField(out, boundary, "headerContextEnabled", "true")
                writeField(out, boundary, "screenTitle", conversationContext?.recipientName.orEmpty())
                writeField(out, boundary, "screenAppPackage", conversationContext?.appPackage.orEmpty())
                writeField(out, boundary, "screenAppLabel", conversationContext?.appLabel.orEmpty())
                writeField(out, boundary, "pageContextJson", conversationContext?.toJson()?.toString().orEmpty())
                writeField(out, boundary, "normalizedContextJson", conversationContext?.toNormalizedJson()?.toString().orEmpty())
            }
            if (shouldSendScreenshot) {
                writeField(out, boundary, "screenshotContextEnabled", "true")
                writeFile(out, boundary, "screenshot", screenshotFile!!.name, "image/jpeg", screenshotFile)
            }
            if (shouldPostProcess) {
                writeField(out, boundary, "postProcessingEnabled", "true")
                writeField(out, boundary, "postProcessingPrompt", postProcessingPrompt())
            }
            writeFile(out, boundary, "audio", file.name, "audio/mp4", file)
            out.write("--$boundary--\r\n".toByteArray())
        }
        val json = readJson(connection)
        return DictationResponse(
            text = json.optString("text"),
            provider = json.optString("provider"),
            model = json.optString("model"),
            fallbackUsed = json.optBoolean("fallbackUsed", false)
        )
    }

    fun receiverHandshake(): Int {
        Log.i(TAG, "receiver handshake GET")
        return openReceiverConnection("GET").let { ensureReceiverSuccess(it) }
    }

    fun uploadReceiverCommand(transcript: String, screenshotFile: File): Int {
        Log.i(TAG, "receiver POST textChars=${transcript.length} imageBytes=${screenshotFile.length()}")
        val connection = openReceiverConnection("POST").apply {
            doOutput = true
            readTimeout = RECEIVER_READ_TIMEOUT_MS
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        val body = JSONObject()
            .put("text", transcript)
            .put("image_base64", Base64.encodeToString(screenshotFile.readBytes(), Base64.NO_WRAP))
            .put("image_mime", "image/png")
            .put("source", "airwhisper")
            .put("idempotency_key", screenshotFile.name)
            .toString()
            .toByteArray(Charsets.UTF_8)
        connection.outputStream.use { it.write(body) }
        return ensureReceiverSuccess(connection)
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
        val token = config.authToken
        require(token.isNotBlank()) { "Не указан токен доступа" }
        return openPublicConnection(path, method).apply {
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("X-AirWhisper-Device-Id", config.installId)
            setRequestProperty("X-AirWhisper-Client-Version", BuildConfig.VERSION_NAME)
        }
    }

    private fun openReceiverConnection(method: String): HttpURLConnection {
        val endpoint = config.receiverUrl
        val token = config.receiverToken
        require(endpoint.startsWith("http://") || endpoint.startsWith("https://")) { "URL получателя должен начинаться с http:// или https://" }
        require(token.isNotBlank()) { "Не указан токен получателя" }
        return (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = DEFAULT_READ_TIMEOUT_MS
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("X-AirWhisper-Device-Id", config.installId)
            setRequestProperty("X-AirWhisper-Client-Version", BuildConfig.VERSION_NAME)
        }
    }

    private fun ensureReceiverSuccess(connection: HttpURLConnection): Int {
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (status !in 200..299) {
            Log.w(TAG, "receiver HTTP $status: ${body.take(300)}")
            throw IOException("HTTP $status: ${body.ifBlank { "получатель не принял запрос" }}")
        }
        Log.i(TAG, "receiver HTTP $status")
        return status
    }

    private fun readJson(connection: HttpURLConnection): JSONObject {
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (status !in 200..299) {
            val json = runCatching { JSONObject(body) }.getOrNull()
            val message = json?.optString("error")?.takeUnless { it.isBlank() } ?: body
            val code = json?.optString("code")?.takeUnless { it.isBlank() } ?: "http_error"
            throw ServerResponseException(status, code, "HTTP $status: $message")
        }
        return JSONObject(body)
    }

    private fun healthStatus(json: JSONObject): String =
        json.optString("status").takeIf { it.isNotBlank() } ?: if (json.optBoolean("ok", false)) "ok" else "unknown"

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
        private const val TAG = "AirWhisperReceiver"
        const val MAX_AUDIO_BYTES = 25L * 1024L * 1024L
        private const val MAX_POST_PROCESSING_PROMPT_CHARS = 4000
        private const val DEFAULT_READ_TIMEOUT_MS = 70_000
        private const val DICTATE_READ_TIMEOUT_MS = 240_000
        private const val RECEIVER_READ_TIMEOUT_MS = 70_000
    }
}
