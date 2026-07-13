package world.brightos.brai.braicmd

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.Closeable
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(RobolectricTestRunner::class)
class ProviderClientContractTest {
    private lateinit var server: StubServer
    private lateinit var client: LlmProviderClient
    private var response: (StubRequest) -> Pair<Int, String> = { 404 to "{}" }

    @Before
    fun setUp() {
        server = StubServer { request -> response(request) }
        val endpoint = "http://127.0.0.1:${server.port}"
        client = LlmProviderClient(
            RuntimeEnvironment.getApplication(),
            mapOf("openai" to endpoint, "groq" to endpoint, "gemini" to endpoint)
        )
    }

    @After
    fun tearDown() {
        server.close()
    }

    @Test
    fun openAiProbeReturnsOnlySupportedSpeechModels() {
        response = { request ->
            assertEquals("Bearer valid-key", request.headers["authorization"])
            200 to """{"data":[{"id":"gpt-4o-transcribe"},{"id":"gpt-4o-mini-transcribe"},{"id":"whisper-1"},{"id":"gpt-4.1"},{"id":"gpt-4o-transcribe-diarize"}]}"""
        }

        val result = client.probe("openai", "valid-key", "", "speech")

        assertTrue(result.optBoolean("ok"))
        assertEquals(
            listOf("gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"),
            result.getJSONArray("models").let { models -> (0 until models.length()).map(models::getString) }
        )
    }

    @Test
    fun groqSpeechConnectionPerformsMultipartModelProbe() {
        response = { request ->
            assertEquals("/audio/transcriptions", request.path)
            assertEquals("Bearer valid-key", request.headers["authorization"])
            200 to """{"text":""}"""
        }

        val result = client.connect("groq", "valid-key", "whisper-large-v3-turbo", "", "speech")

        assertTrue(result.optBoolean("ok"))
    }

    @Test
    fun emptyModelListAllowsManualSelectionOnlyAfterSuccessfulProbe() {
        response = { 200 to """{"data":[]}""" }

        val result = client.probe("openai", "valid-key", "", "speech")

        assertTrue(result.optBoolean("ok"))
        assertTrue(result.optBoolean("manualModel"))
        assertEquals(0, result.getJSONArray("models").length())
    }

    @Test
    fun authorizationFailureDoesNotBecomeManualModelFlow() {
        response = { 401 to """{"error":{"message":"Неверный API-ключ"}}""" }

        val error = assertThrows(IllegalStateException::class.java) {
            client.probe("openai", "bad-key", "", "speech")
        }

        assertEquals("Неверный API-ключ", error.message)
    }

    @Test
    fun incompatibleSpeechModelIsRejectedBeforeProviderRequest() {
        val error = assertThrows(IllegalArgumentException::class.java) {
            client.connect("openai", "valid-key", "gpt-4.1", "", "speech")
        }

        assertEquals("Выбранная модель не поддерживает распознавание речи", error.message)
    }

    @Test
    fun geminiKeyUsesHeaderAndNeverAppearsInRequestUrl() {
        response = { request ->
            assertFalse(request.path.contains("private-gemini-key"))
            assertEquals("private-gemini-key", request.headers["x-goog-api-key"])
            if (request.path == "/models") {
                200 to """{"models":[{"name":"models/gemini-2.0-flash","supportedGenerationMethods":["generateContent"]}]}"""
            } else {
                assertEquals("/models/gemini-2.0-flash:generateContent", request.path)
                200 to """{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}"""
            }
        }

        val probe = client.probe("gemini", "private-gemini-key", "", "text")
        val connected = client.connect("gemini", "private-gemini-key", "gemini-2.0-flash", "", "text")

        assertTrue(probe.optBoolean("ok"))
        assertTrue(connected.optBoolean("ok"))
    }
}

private data class StubRequest(val path: String, val headers: Map<String, String>)

private class StubServer(private val handler: (StubRequest) -> Pair<Int, String>) : Closeable {
    private val running = AtomicBoolean(true)
    private val socket = ServerSocket().apply { bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0)) }
    val port: Int = socket.localPort
    private val thread = Thread {
        while (running.get()) {
            val client = runCatching { socket.accept() }.getOrNull() ?: break
            client.use {
                val reader = it.getInputStream().bufferedReader()
                val requestLine = reader.readLine().orEmpty()
                val headers = buildMap {
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        val separator = line.indexOf(':')
                        if (separator > 0) put(line.substring(0, separator).lowercase(), line.substring(separator + 1).trim())
                    }
                }
                val path = requestLine.split(' ').getOrNull(1).orEmpty()
                val (status, body) = handler(StubRequest(path, headers))
                val bytes = body.toByteArray()
                it.getOutputStream().apply {
                    write("HTTP/1.1 $status ${if (status in 200..299) "OK" else "Error"}\r\n".toByteArray())
                    write("Content-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    write(bytes)
                    flush()
                }
            }
        }
    }.apply { isDaemon = true; start() }

    override fun close() {
        running.set(false)
        socket.close()
        thread.join(1_000)
    }
}
