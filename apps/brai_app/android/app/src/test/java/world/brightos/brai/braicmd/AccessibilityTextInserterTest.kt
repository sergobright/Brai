package world.brightos.brai.braicmd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessibilityTextInserterTest {
    @Test
    fun directInsertionDoesNotTouchTheClipboard() {
        val calls = mutableListOf<String>()

        val inserted = insertWithClipboardFallback(
            directInsert = { calls += "direct"; true },
            copyToClipboard = { calls += "copy" },
            pasteFromClipboard = { calls += "paste"; true },
            pasteFromContextMenu = { calls += "menu"; true }
        )

        assertTrue(inserted)
        assertEquals(listOf("direct"), calls)
    }

    @Test
    fun clipboardIsUsedOnlyAfterDirectInsertionFails() {
        val calls = mutableListOf<String>()

        val inserted = insertWithClipboardFallback(
            directInsert = { calls += "direct"; false },
            copyToClipboard = { calls += "copy" },
            pasteFromClipboard = { calls += "paste"; true },
            pasteFromContextMenu = { calls += "menu"; true }
        )

        assertTrue(inserted)
        assertEquals(listOf("direct", "copy", "paste"), calls)
    }
}
