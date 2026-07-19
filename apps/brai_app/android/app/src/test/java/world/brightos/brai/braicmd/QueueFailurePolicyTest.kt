package world.brightos.brai.braicmd

import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import org.junit.Assert.assertEquals
import org.junit.Test

class QueueFailurePolicyTest {
    @Test
    fun transientFailuresRemainRetryable() {
        val failures = listOf(
            UnknownHostException(),
            SocketTimeoutException(),
            IOException(),
            QueueEmptyModelException(),
            ServerResponseException(408, "http_error", "timeout"),
            ServerResponseException(425, "http_error", "early"),
            ServerResponseException(429, "http_error", "rate"),
            ServerResponseException(503, "http_error", "down"),
            ServerResponseException(400, "upstream_error", "model"),
            ServerResponseException(409, "conflict", "retry")
        )

        failures.forEach { assertEquals(QueueFailureDisposition.Transient, classifyQueueFailure(it)) }
    }

    @Test
    fun authFailuresAreBlockedUntilExplicitRetry() {
        listOf(
            QueueAuthBlockedException(),
            ServerResponseException(401, "unauthorized", "auth"),
            ServerResponseException(403, "forbidden", "auth"),
            ServerResponseException(403, "function_disabled", "disabled")
        ).forEach { assertEquals(QueueFailureDisposition.Blocked, classifyQueueFailure(it)) }
    }

    @Test
    fun onlyLocallyCorruptPayloadsArePermanent() {
        assertEquals(QueueFailureDisposition.Permanent, classifyQueueFailure(QueueCorruptItemException("corrupt")))
        listOf(
            ServerResponseException(400, "bad_request", "bad"),
            ServerResponseException(413, "request_too_large", "large"),
            ServerResponseException(415, "unsupported_media_type", "mime"),
            ServerResponseException(422, "unprocessable", "bad")
        ).forEach { assertEquals(QueueFailureDisposition.Blocked, classifyQueueFailure(it)) }
    }
}
