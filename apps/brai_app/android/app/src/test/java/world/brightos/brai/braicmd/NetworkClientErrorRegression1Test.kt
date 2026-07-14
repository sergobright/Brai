package world.brightos.brai.braicmd

import java.io.Closeable
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.function.BooleanSupplier
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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
    private lateinit var secure: SecureStringStore
    private lateinit var config: ConfigStore
    private lateinit var client: NetworkClient

    @Before
    fun setUp() {
        context.getSharedPreferences(AppConstants.PREFS, 0).edit().clear().commit()
        context.getSharedPreferences("brai_cmd_secure", 0).edit().clear().commit()
        server = ErrorStubServer()
        secure = SecureStringStore(context, SecretKeySpec(ByteArray(32) { (it + 11).toByte() }, "AES"))
        config = ConfigStore(context, secure).apply {
            serverUrl = "http://127.0.0.1:${server.port}"
            authToken = "fixture-device-token"
        }
        client = NetworkClient(context, config)
    }

    @After
    fun tearDown() {
        server.close()
    }

    @Test
    fun localizesUnauthorizedNestedError() {
        server.response = 401 to """{"error":{"message":"Invalid bearer token"},"code":"unauthorized"}"""

        val error = org.junit.Assert.assertThrows(ServerResponseException::class.java) {
            client.diagnostics(false)
        }

        assertEquals("unauthorized", error.code)
        assertEquals("Токен устройства недействителен. Переподключите Brai.", error.message)
    }

    @Test
    fun unwrapsUnknownNestedErrorWithoutShowingJsonSyntax() {
        server.response = 400 to """{"error":{"message":"Подробная причина"},"code":"custom_error"}"""

        val error = org.junit.Assert.assertThrows(ServerResponseException::class.java) {
            client.diagnostics(false)
        }

        assertEquals("Подробная причина", error.message)
    }

    @Test
    fun activatesAccountAccessWithoutReturningTokenToWebLayer() {
        server.response = 200 to """{"token":"actual-account-device-token","account_user_id":"user-a"}"""

        val response = client.activateAccountAccess("one-time-link-token")

        assertEquals("actual-account-device-token", response.token)
        assertEquals("user-a", response.accountUserId)
        assertEquals("POST /v1/brai-cmd/account-access/activate HTTP/1.1", server.requests.single().line)
        assertEquals("Bearer fixture-device-token", server.requests.single().headers["authorization"])
        assertEquals("one-time-link-token", JSONObject(server.requests.single().body).getString("link_token"))
    }

    @Test
    fun revokeSelfUsesCurrentDeviceAccess() {
        server.response = 200 to """{"ok":true}"""

        client.revokeCurrentAccess()

        assertEquals("POST /v1/brai-cmd/access/revoke-self HTTP/1.1", server.requests.single().line)
        assertEquals("Bearer fixture-device-token", server.requests.single().headers["authorization"])
    }

    @Test
    fun pendingLogoutRevocationSurvivesTransientFailureAndUsesOnlyItsIsolatedToken() {
        val now = 1_000L
        secure.stagePendingAccountRevocation("pending-account-token", now)
        server.response = 503 to """{"code":"internal_error"}"""

        assertFalse(BraiCmdBridge.retryPendingAccountRevocation(secure, client, now))
        assertEquals("pending-account-token", secure.pendingAccountRevocationToken(now))
        assertEquals("Bearer pending-account-token", server.requests.single().headers["authorization"])
        assertEquals("fixture-device-token", config.authToken)

        server.response = 200 to """{"ok":true}"""
        assertTrue(BraiCmdBridge.retryPendingAccountRevocation(secure, client, now))
        assertEquals("", secure.pendingAccountRevocationToken(now))
        assertEquals("Bearer pending-account-token", server.requests.last().headers["authorization"])
        assertEquals("fixture-device-token", config.authToken)
    }

    @Test
    fun unauthorizedStoredAccessRefreshesToAnonymousToken() {
        server.enqueue(401, """{"code":"unauthorized"}""")
        server.enqueue(200, """{"token":"fresh-anonymous-device-token","displayName":"Brai"}""")
        server.enqueue(200, """{"status":"ok"}""")

        client.ensureDeviceAccess("Brai", "fingerprint")

        assertEquals("fresh-anonymous-device-token", config.authToken)
        assertEquals(
            listOf(
                "GET /v1/health HTTP/1.1",
                "POST /v1/access/request HTTP/1.1",
                "GET /v1/health HTTP/1.1"
            ),
            server.requests.map { it.line }
        )
        assertEquals("Bearer fixture-device-token", server.requests.first().headers["authorization"])
        assertEquals("Bearer fresh-anonymous-device-token", server.requests.last().headers["authorization"])
    }

    @Test
    fun missingDeviceAccessIsAcquiredAfterAccountBoundaryStarts() {
        config.authToken = ""
        config.beginAccountCredentialMode("user-a")
        server.enqueue(200, """{"token":"fresh-device-token","displayName":"Brai"}""")
        server.enqueue(200, """{"status":"ok"}""")

        client.ensureDeviceAccess("Brai", "fingerprint")

        assertEquals("user-a", config.accountUserId)
        assertEquals("fresh-device-token", config.authToken)
        assertEquals(
            listOf(
                "POST /v1/access/request HTTP/1.1",
                "GET /v1/health HTTP/1.1"
            ),
            server.requests.map { it.line }
        )
    }

    @Test
    fun transientHealthFailureKeepsStoredAccess() {
        server.response = 503 to """{"code":"internal_error"}"""

        client.ensureDeviceAccess("Brai", "fingerprint")

        assertEquals("fixture-device-token", config.authToken)
        assertEquals(1, server.requests.size)
    }

    @Test
    fun supersededAnonymousRefreshCannotOverwriteTheNextAccountBoundary() {
        config.authToken = ""
        server.response = 200 to """{"token":"stale-anonymous-token","displayName":"Brai"}"""
        val checks = AtomicInteger()

        val error = org.junit.Assert.assertThrows(IllegalStateException::class.java) {
            client.ensureDeviceAccess(
                "Brai",
                "fingerprint",
                BooleanSupplier { checks.incrementAndGet() == 1 }
            )
        }

        assertEquals("credential_operation_superseded", error.message)
        assertEquals("", config.authToken)
        assertEquals(listOf("POST /v1/access/request HTTP/1.1"), server.requests.map { it.line })
    }
}

private data class AuthStubRequest(val line: String, val headers: Map<String, String>, val body: String)

private class ErrorStubServer : Closeable {
    var response: Pair<Int, String> = 500 to "{}"
    val requests = CopyOnWriteArrayList<AuthStubRequest>()
    private val responses = ConcurrentLinkedQueue<Pair<Int, String>>()
    private val running = AtomicBoolean(true)
    private val socket = ServerSocket().apply { bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0)) }
    val port: Int = socket.localPort
    private val thread = Thread {
        while (running.get()) {
            val client = runCatching { socket.accept() }.getOrNull() ?: break
            client.use {
                val reader = it.getInputStream().bufferedReader()
                val requestLine = reader.readLine().orEmpty()
                val headers = linkedMapOf<String, String>()
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                    val separator = line.indexOf(':')
                    if (separator > 0) {
                        headers[line.substring(0, separator).trim().lowercase()] = line.substring(separator + 1).trim()
                    }
                }
                val length = headers["content-length"]?.toIntOrNull() ?: 0
                val bodyChars = CharArray(length)
                var offset = 0
                while (offset < length) {
                    val read = reader.read(bodyChars, offset, length - offset)
                    if (read < 0) break
                    offset += read
                }
                requests.add(AuthStubRequest(requestLine, headers, String(bodyChars, 0, offset)))
                val (status, body) = responses.poll() ?: response
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

    fun enqueue(status: Int, body: String) {
        responses.add(status to body)
    }

    override fun close() {
        running.set(false)
        socket.close()
        thread.join(1_000)
    }
}
