package world.brightos.brai.braicmd

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class PendingTranscriptStoreTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val directory get() = File(context.filesDir, "pending-transcripts")

    @Before
    @After
    fun cleanTranscripts() {
        directory.deleteRecursively()
    }

    @Test
    fun transcriptsAreSeparatedByKindAndLegacyIsMainDictation() {
        PendingTranscriptStore.add(context, "main", PendingTranscriptKind.MainDictation)
        PendingTranscriptStore.add(context, "reply", PendingTranscriptKind.ChatReply)
        directory.apply { mkdirs() }.resolve("legacy.txt").writeText("legacy", Charsets.UTF_8)

        val all = PendingTranscriptStore.list(context)

        assertEquals(3, all.size)
        assertEquals(2, all.count { it.kind == PendingTranscriptKind.MainDictation })
        assertEquals(1, all.count { it.kind == PendingTranscriptKind.ChatReply })
        assertEquals(2, PendingTranscriptStore.list(context, PendingTranscriptKind.MainDictation).size)
        assertEquals("reply", PendingTranscriptStore.list(context, PendingTranscriptKind.ChatReply).single().text)
    }
}
