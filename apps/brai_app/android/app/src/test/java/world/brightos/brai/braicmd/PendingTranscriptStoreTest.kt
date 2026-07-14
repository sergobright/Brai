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
        File(context.filesDir, "failed-transcripts").deleteRecursively()
        context.getSharedPreferences(AppConstants.PREFS, 0).edit().clear().commit()
        context.getSharedPreferences("brai_cmd_secure", 0).edit().clear().commit()
    }

    @Test
    fun transcriptsAreSeparatedByKindAndLegacyIsQuarantined() {
        PendingTranscriptStore.add(context, "main", PendingTranscriptKind.MainDictation)
        PendingTranscriptStore.add(context, "reply", PendingTranscriptKind.ChatReply)
        directory.apply { mkdirs() }.resolve("legacy.txt").writeText("legacy", Charsets.UTF_8)

        val all = PendingTranscriptStore.list(context)

        assertEquals(2, all.size)
        assertEquals(1, all.count { it.kind == PendingTranscriptKind.MainDictation })
        assertEquals(1, all.count { it.kind == PendingTranscriptKind.ChatReply })
        assertEquals(1, PendingTranscriptStore.list(context, PendingTranscriptKind.MainDictation).size)
        assertEquals("reply", PendingTranscriptStore.list(context, PendingTranscriptKind.ChatReply).single().text)
        assertEquals("legacy", File(context.filesDir, "failed-transcripts/legacy.txt").readText(Charsets.UTF_8))
    }

    @Test
    fun accountTranscriptsStayHiddenUntilTheirOwnerIsCurrentAgain() {
        val config = ConfigStore(context)
        config.beginAccountCredentialMode("account-a")
        PendingTranscriptStore.add(context, "from-a")
        config.beginAccountCredentialMode("account-b")
        PendingTranscriptStore.add(context, "from-b")

        assertEquals(listOf("from-b"), PendingTranscriptStore.list(context).map { it.text })

        config.beginAccountCredentialMode("account-a")
        assertEquals(listOf("from-a"), PendingTranscriptStore.list(context).map { it.text })
    }
}
