package world.brightos.brai.braicmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

// Regression: ISSUE-014 — пользователь видел общий текст вместо причины блокировки своего провайдера.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
@RunWith(RobolectricTestRunner::class)
class ProviderQueueMessageRegression1Test {
    private val service get() = Robolectric.buildService(RecordingService::class.java).create().get()

    @Test
    fun providerFailuresProduceActionableRussianMessages() {
        val invalidKey = service.pendingStatusFor(ProviderResponseException(401, "raw provider body"))
        val invalidModel = service.pendingStatusFor(ProviderResponseException(422, "model_required"))
        val limited = service.pendingStatusFor(ProviderResponseException(429, "rate_limit"))
        val unavailable = service.pendingStatusFor(ProviderResponseException(503, "upstream"))

        assertEquals(PendingReason.Transcription, invalidKey.second)
        assertEquals("Данные сохранены. Проверьте API-ключ поставщика в настройках.", invalidKey.first)
        assertEquals("Данные сохранены. Проверьте выбранную модель и настройки поставщика.", invalidModel.first)
        assertEquals("Данные сохранены. Поставщик временно ограничил запросы; повторю автоматически.", limited.first)
        assertEquals("Данные сохранены. Поставщик сейчас не отвечает; повторю автоматически.", unavailable.first)
        listOf(invalidKey, invalidModel, limited, unavailable).forEach { (message) ->
            assertFalse(message.contains("raw provider body"))
            assertFalse(message.contains("model_required"))
        }
    }
}
