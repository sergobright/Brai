package world.brightos.brai.braicmd

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

// Regression: ISSUE-011 — неизвестный providerId молча превращался в OpenAI.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
@RunWith(RobolectricTestRunner::class)
class UnsupportedProviderRegression1Test {
    private val client get() = LlmProviderClient(RuntimeEnvironment.getApplication())

    @Test
    fun unknownProviderIsRejectedBeforeAnyNetworkRequest() {
        val error = try {
            client.probe("deepgram", "test-key", "", "speech")
            fail("unsupported provider must fail")
            null
        } catch (caught: IllegalArgumentException) {
            caught
        }

        assertEquals("unsupported_provider", error?.message)
    }
}
