package world.brightos.brai.braicmd

import java.io.File
import java.io.IOException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

// Regression: ISSUE-002 — повтор после сбоя постобработки снова оплачивал расшифровку и мог дублировать текст.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
@RunWith(RobolectricTestRunner::class)
class TranscriptionCheckpointRegression1Test {
    private val context get() = RuntimeEnvironment.getApplication()
    private val recordings get() = File(context.filesDir, "pending-recordings")

    @Before
    @After
    fun resetState() {
        listOf("pending-recordings", "pending-transcripts", "failed-transcripts", "processed-recordings").forEach {
            File(context.filesDir, it).deleteRecursively()
        }
        context.getSharedPreferences(AppConstants.PREFS, 0).edit().clear().commit()
        context.getSharedPreferences("brai_cmd_secure", 0).edit().clear().commit()
        context.getSharedPreferences("brai_cmd_stats", 0).edit().clear().commit()
    }

    @Test
    fun retryReusesTranscriptionAfterPostProcessingFailure() {
        val config = ConfigStore(context).apply {
            transcriptionProviderMode = "key"
            postProcessingEnabled = true
            postProcessingProviderMode = "key"
        }
        assertEquals("key", config.transcriptionProviderMode)
        val audio = recordings.resolve("paid-once.m4a").apply {
            parentFile?.mkdirs()
            writeBytes(ByteArray(1_024) { 1 })
            QueueOwnerStore.claim(this, QueueOwnerStore.current(context))
        }
        var transcriptionCalls = 0
        var postProcessingCalls = 0
        val transcriber: (File) -> SpeechProviderResult = {
            transcriptionCalls += 1
            SpeechProviderResult("исходный текст", "openai", "gpt-4o-mini-transcribe")
        }
        val postProcessor: (String, String) -> LlmProviderResult = { text, _ ->
            postProcessingCalls += 1
            if (postProcessingCalls == 1) throw IOException("temporary provider outage")
            LlmProviderResult("$text обработан", "openai", "gpt-4.1-mini", text.length, text.length + 9)
        }

        val first = QueueTransportWorker(context, transcriber, postProcessor).run(null)

        assertEquals(QueueTransportStatus.TransientFailure, first.status)
        assertTrue(audio.isFile)
        assertNotNull(TranscriptionCheckpointStore.read(audio))

        val second = QueueTransportWorker(context, transcriber, postProcessor).run(null)

        assertEquals(QueueTransportStatus.Drained, second.status)
        assertEquals(1, transcriptionCalls)
        assertEquals(2, postProcessingCalls)
        assertFalse(audio.exists())
        assertFalse(File("${audio.absolutePath}${TranscriptionCheckpointStore.SUFFIX}").exists())
        assertEquals(listOf("исходный текст обработан"), PendingTranscriptStore.list(context).map { it.text })
    }

    @Test
    fun readyTranscriptIsIdempotentForTheSameQueuedAudio() {
        val audio = recordings.resolve("same-audio.m4a").apply {
            parentFile?.mkdirs()
            writeBytes(ByteArray(1_024) { 1 })
            QueueOwnerStore.claim(this, QueueOwnerStore.current(context))
        }

        PendingTranscriptStore.addForAudio(context, audio, "первый", PendingTranscriptKind.MainDictation)
        PendingTranscriptStore.addForAudio(context, audio, "окончательный", PendingTranscriptKind.MainDictation)

        val transcripts = PendingTranscriptStore.list(context)
        assertEquals(1, transcripts.size)
        assertEquals("окончательный", transcripts.single().text)
    }
}
