package world.brightos.brai.braicmd

import java.io.Closeable
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

// Regression: ISSUE-008 — вложенная server error отображалась как сырой JSON и английский HTTP-текст.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
@RunWith(RobolectricTestRunner::class)
class NetworkClientErrorRegression1Test {
    private val context get() = RuntimeEnvironment.getApplication()
    private lateinit var server: ErrorStubServer

    @Before
    fun setUp() {
        server = ErrorStubServer()
        ConfigStore(context).apply {
            serverUrl = "http://127.0.0.1:${server.port}"
            authToken = "fixture-device-token"
        }
    }

    @After
    fun tearDown() {
        server.close()
    }

    @Test
    fun localizesUnauthorizedNestedError() {
        server.response = 401 to """{"error":{"message":"Invalid bearer token"},"code":"unauthorized"}"""

        val error = org.junit.Assert.assertThrows(ServerResponseException::class.java) {
            NetworkClient(context).diagnostics(false)
        }

        assertEquals("unauthorized", error.code)
        assertEquals("Токен устройства недействителен. Переподключите Brai.", error.message)
    }

    @Test
    fun unwrapsUnknownNestedErrorWithoutShowingJsonSyntax() {
        server.response = 400 to """{"error":{"message":"Подробная причина"},"code":"custom_error"}"""

        val error = org.junit.Assert.assertThrows(ServerResponseException::class.java) {
            NetworkClient(context).diagnostics(false)
        }

        assertEquals("Подробная причина", error.message)
    }
}

private class ErrorStubServer : Closeable {
    var response: Pair<Int, String> = 500 to "{}"
    private val running = AtomicBoolean(true)
    private val socket = ServerSocket().apply { bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0)) }
    val port: Int = socket.localPort
    private val thread = Thread {
        while (running.get()) {
            val client = runCatching { socket.accept() }.getOrNull() ?: break
            client.use {
                val reader = it.getInputStream().bufferedReader()
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                }
                val (status, body) = response
                val bytes = body.toByteArray()
                it.getOutputStream().apply {
                    write("HTTP/1.1 $status Error\r\n".toByteArray())
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
