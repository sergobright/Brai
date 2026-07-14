package world.brightos.brai.braicmd

import java.io.File
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

// Regression: ISSUE-001 — режим «Только очередь» скрывал отказ удаления аудиофайла.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
@RunWith(RobolectricTestRunner::class)
class RecordingArchiveStoreRegression1Test {
    private val context get() = RuntimeEnvironment.getApplication()
    private lateinit var undeletableAudio: File

    @Before
    fun setUp() {
        ConfigStore(context).processedAudioRetentionEnabled = false
        undeletableAudio = File(context.filesDir, "undeletable.m4a").apply {
            mkdirs()
            resolve("open-handle-fixture").writeText("still in use")
        }
    }

    @After
    fun tearDown() {
        undeletableAudio.deleteRecursively()
    }

    @Test
    fun reportsFailureWhenProcessedAudioCannotBeDeleted() {
        assertFalse(RecordingArchiveStore.onAudioProcessed(context, undeletableAudio))
    }
}
