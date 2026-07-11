package world.brightos.brai.braicmd

import java.io.File
import kotlin.io.path.createTempDirectory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InboxPayloadStoreTest {
    @Test
    fun prefixMovesWithInboxPayload() {
        val dir = createTempDirectory("brai-inbox-payload").toFile()
        try {
            val audio = File(dir, "recording.m4a").apply { writeText("audio", Charsets.UTF_8) }
            val moved = File(dir, "pending.m4a")

            InboxPayloadStore.mark(audio, " Добавить в контекст контакта ")
            InboxPayloadStore.saveTranscript(audio, " hello ")
            InboxPayloadStore.saveAction(audio, AudioQueueAction.ChatContextInbox)

            assertTrue(InboxPayloadStore.isInboxPayload(audio))
            assertEquals("Добавить в контекст контакта", InboxPayloadStore.readTextPrefix(audio))
            assertEquals("hello", InboxPayloadStore.readTranscript(audio))
            assertEquals(AudioQueueAction.ChatContextInbox, InboxPayloadStore.readAction(audio))

            InboxPayloadStore.move(audio, moved)

            assertFalse(InboxPayloadStore.isInboxPayload(audio))
            assertEquals("", InboxPayloadStore.readTextPrefix(audio))
            assertEquals(null, InboxPayloadStore.readAction(audio))
            assertTrue(InboxPayloadStore.isInboxPayload(moved))
            assertEquals("Добавить в контекст контакта", InboxPayloadStore.readTextPrefix(moved))
            assertEquals("hello", InboxPayloadStore.readTranscript(moved))
            assertEquals(AudioQueueAction.ChatContextInbox, InboxPayloadStore.readAction(moved))

            InboxPayloadStore.delete(moved)

            assertFalse(InboxPayloadStore.isInboxPayload(moved))
            assertEquals("", InboxPayloadStore.readTextPrefix(moved))
            assertEquals(null, InboxPayloadStore.readAction(moved))
        } finally {
            dir.deleteRecursively()
        }
    }
}
