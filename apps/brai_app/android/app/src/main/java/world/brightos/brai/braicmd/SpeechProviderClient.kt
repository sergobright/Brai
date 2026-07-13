package world.brightos.brai.braicmd

import android.content.Context
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

internal data class SpeechProviderResult(
    val text: String,
    val provider: String,
    val model: String
)

internal class SpeechProviderClient(
    context: Context,
    private val endpointOverrides: Map<String, String> = emptyMap()
) {
    private val appContext = context.applicationContext

    fun transcribe(file: File): SpeechProviderResult {
        val config = ConfigStore(appContext)
        val providerId = config.transcriptionProviderId
        val model = config.transcriptionProviderModel
        val apiKey = SecureStringStore(appContext).providerKey(providerId)
        return transcribe(file, providerId, apiKey, model)
    }

    fun transcribe(file: File, providerId: String, apiKey: String, model: String): SpeechProviderResult {
        if (apiKey.isBlank()) throw IllegalStateException("Ключ поставщика не настроен")
        if (model.isBlank()) throw IllegalStateException("Модель распознавания не выбрана")
        return requestTranscription(file, providerId, apiKey, model, requireText = true)
    }

    fun test(providerId: String, apiKey: String, model: String): SpeechProviderResult {
        val probe = File.createTempFile("brai-provider-probe-", ".wav", appContext.cacheDir)
        return try {
            probe.writeBytes(silentWav())
            requestTranscription(probe, providerId, apiKey, model, requireText = false)
        } finally {
            probe.delete()
        }
    }

    private fun requestTranscription(
        file: File,
        providerId: String,
        apiKey: String,
        model: String,
        requireText: Boolean
    ): SpeechProviderResult {
        val url = when (providerId) {
            "openai" -> "${endpoint("openai", "https://api.openai.com/v1")}/audio/transcriptions"
            "groq" -> "${endpoint("groq", "https://api.groq.com/openai/v1")}/audio/transcriptions"
            else -> throw IllegalArgumentException("Поставщик не поддерживает распознавание речи")
        }
        val boundary = "BraiSpeech-${System.currentTimeMillis()}"
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 60_000
            setChunkedStreamingMode(64 * 1024)
            setRequestProperty("Authorization", "Bearer $apiKey")
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            setRequestProperty("Accept", "application/json")
        }
        BufferedOutputStream(connection.outputStream).use { out ->
            field(out, boundary, "model", model)
            out.write("--$boundary\r\n".toByteArray())
            out.write("Content-Disposition: form-data; name=\"file\"; filename=\"${file.name}\"\r\n".toByteArray())
            val mime = if (file.name.endsWith(".wav", true)) "audio/wav" else "audio/mp4"
            out.write("Content-Type: $mime\r\n\r\n".toByteArray())
            file.inputStream().use { it.copyTo(out) }
            out.write("\r\n--$boundary--\r\n".toByteArray())
        }
        val json = readJson(connection)
        val text = json.optString("text").trim()
        if (requireText && text.isBlank()) throw IllegalStateException("Модель вернула пустой текст")
        return SpeechProviderResult(text, providerId, model)
    }

    private fun field(out: BufferedOutputStream, boundary: String, name: String, value: String) {
        out.write("--$boundary\r\n".toByteArray())
        out.write("Content-Disposition: form-data; name=\"$name\"\r\n\r\n".toByteArray())
        out.write(value.toByteArray())
        out.write("\r\n".toByteArray())
    }

    private fun readJson(connection: HttpURLConnection): JSONObject {
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (status !in 200..299) {
            val json = runCatching { JSONObject(body) }.getOrNull()
            val message = json?.optJSONObject("error")?.optString("message")?.takeIf(String::isNotBlank)
                ?: body.take(240).ifBlank { "Поставщик вернул HTTP $status" }
            throw ProviderResponseException(status, message)
        }
        return JSONObject(body.ifBlank { "{}" })
    }

    private fun silentWav(): ByteArray {
        val pcmSize = 3_200
        val output = java.nio.ByteBuffer.allocate(44 + pcmSize).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        output.put("RIFF".toByteArray()).putInt(36 + pcmSize).put("WAVE".toByteArray())
        output.put("fmt ".toByteArray()).putInt(16).putShort(1.toShort()).putShort(1.toShort())
        output.putInt(16_000).putInt(32_000).putShort(2.toShort()).putShort(16.toShort())
        output.put("data".toByteArray()).putInt(pcmSize).put(ByteArray(pcmSize))
        return output.array()
    }

    private fun endpoint(providerId: String, fallback: String): String =
        endpointOverrides[providerId]?.trimEnd('/') ?: fallback
}
