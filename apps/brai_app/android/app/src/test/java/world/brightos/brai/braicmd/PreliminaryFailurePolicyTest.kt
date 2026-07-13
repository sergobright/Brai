package world.brightos.brai.braicmd

import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import org.junit.Assert.assertEquals
import org.junit.Test

class PreliminaryFailurePolicyTest {
    @Test
    fun usesShortTimeoutAndSafeFailureCategories() {
        assertEquals(15_000, PRELIMINARY_TIMEOUT_MS)
        assertEquals("preliminary_timeout", preliminaryFailureCode(SocketTimeoutException()))
        assertEquals("preliminary_network", preliminaryFailureCode(UnknownHostException()))
        assertEquals("preliminary_network", preliminaryFailureCode(IOException()))
        assertEquals("preliminary_server", preliminaryFailureCode(ServerResponseException(503, "unavailable", null, "private detail")))
        assertEquals("preliminary_unknown", preliminaryFailureCode(IllegalStateException("private detail")))
    }
}
