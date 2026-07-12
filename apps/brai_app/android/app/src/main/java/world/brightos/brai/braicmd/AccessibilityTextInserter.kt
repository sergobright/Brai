package world.brightos.brai.braicmd

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import world.brightos.brai.capabilities.BraiAccessibilityService
import kotlin.math.max
import kotlin.math.min

internal class AccessibilityTextInserter(private val service: BraiAccessibilityService) {
    fun insert(text: String, focusedNode: AccessibilityNodeInfo?, findNode: () -> AccessibilityNodeInfo?): Boolean {
        if (text.isBlank()) return false
        copyToClipboard(text)
        val node = focusedNode?.takeIf { it.refresh() } ?: findNode()
        if (node == null) {
            return false
        }
        val direct = runCatching { insertDirect(node, text) }.getOrDefault(false)
        if (!direct) {
            val pasted = runCatching { pasteViaClipboard(node) }.getOrDefault(false)
            if (!pasted) {
                val menuPasted = runCatching { pasteViaContextMenu(node) }.getOrDefault(false)
                if (!menuPasted) {
                    return false
                }
            }
        }
        return true
    }

    private fun copyToClipboard(text: String) {
        val clipboard = service.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Brai Cmd", text))
    }

    private fun insertDirect(node: AccessibilityNodeInfo, insertText: String): Boolean {
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val current = currentEditableText(node)
        val length = current.length
        var start = node.textSelectionStart
        var end = node.textSelectionEnd
        if (start < 0 || start > length) start = length
        if (end < 0 || end > length) end = start
        val left = min(start, end)
        val right = max(start, end)
        val replacement = buildReplacement(current, left, right, insertText.trim())
        val updated = current.substring(0, left) + replacement.text + current.substring(right)

        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, updated)
        }
        val didSet = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        if (!didSet) return false

        val cursor = left + replacement.cursorAdvance
        val selectionArgs = Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
        }
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selectionArgs)
        return true
    }

    private fun currentEditableText(node: AccessibilityNodeInfo): String {
        val text = node.text?.toString().orEmpty()
        val hint = node.hintText?.toString()?.trim().orEmpty()
        val selectionUnknown = node.textSelectionStart < 0 && node.textSelectionEnd < 0
        if (selectionUnknown && isPlaceholderText(text, hint)) return ""
        return text
    }

    private fun isPlaceholderText(text: String, hint: String): Boolean {
        val normalized = text.trim()
        if (normalized.isEmpty()) return false
        if (hint.isNotEmpty() && normalized.equals(hint, ignoreCase = true)) return true
        return normalized.equals("Сообщение", ignoreCase = true) ||
            normalized.equals("Message", ignoreCase = true) ||
            normalized.equals("Введите сообщение", ignoreCase = true) ||
            normalized.equals("Напишите сообщение", ignoreCase = true)
    }

    private data class Replacement(val text: String, val cursorAdvance: Int)

    private fun buildReplacement(current: String, start: Int, end: Int, raw: String): Replacement {
        if (start != end) return Replacement(raw, raw.length)
        val prefix = current.substring(0, start)
        val suffix = current.substring(start)
        val needsLeftSpace = prefix.isNotEmpty() &&
            !prefix.last().isWhitespace() &&
            raw.firstOrNull()?.let { it.isLetterOrDigit() } == true
        val needsRightSpace = suffix.isNotEmpty() &&
            !suffix.first().isWhitespace() &&
            raw.lastOrNull()?.let { it.isLetterOrDigit() } == true
        val text = buildString {
            if (needsLeftSpace) append(' ')
            append(raw)
            if (needsRightSpace) append(' ')
        }
        return Replacement(text, text.length)
    }

    private fun pasteViaClipboard(node: AccessibilityNodeInfo): Boolean {
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        return node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
    }

    private fun pasteViaContextMenu(node: AccessibilityNodeInfo): Boolean {
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        if (!node.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)) return false
        repeat(PASTE_MENU_ATTEMPTS) {
            SystemClock.sleep(PASTE_MENU_DELAY_MS)
            if (clickPasteMenuItem()) return true
        }
        return false
    }

    private fun clickPasteMenuItem(): Boolean {
        service.windows.forEach { window ->
            findPasteMenuItem(window.root ?: return@forEach)?.let { item ->
                return item.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }
        }
        return false
    }

    private fun findPasteMenuItem(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isVisibleToUser && node.isEnabled && isPasteLabel(node)) {
            clickableNode(node)?.let { return it }
        }
        for (index in 0 until node.childCount) {
            findPasteMenuItem(node.getChild(index) ?: continue)?.let { return it }
        }
        return null
    }

    private fun clickableNode(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var current: AccessibilityNodeInfo? = node
        repeat(4) {
            val candidate = current ?: return null
            if (candidate.isEnabled && candidate.isClickable) return candidate
            current = candidate.parent
        }
        return null
    }

    private fun isPasteLabel(node: AccessibilityNodeInfo): Boolean {
        val label = (node.text ?: node.contentDescription)?.toString()?.trim()?.lowercase().orEmpty()
        return label == "вставить" || label == "paste"
    }

    companion object {
        private const val PASTE_MENU_ATTEMPTS = 6
        private const val PASTE_MENU_DELAY_MS = 90L
    }
}
