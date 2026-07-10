package world.brightos.brai.braicmd

import android.annotation.SuppressLint
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject
import world.brightos.brai.capabilities.BraiAccessibilityService
import kotlin.math.min

internal class AccessibilityContextReader(private val service: BraiAccessibilityService) {
    fun capture(): VisibleConversationContext? {
        val displayHeight = service.resources.displayMetrics.heightPixels
        val displayWidth = service.resources.displayMetrics.widthPixels
        return visibleApplicationRoots().mapNotNull { root ->
            val appLabel = appLabelFor(root.appPackage)
            val candidates = mutableListOf<HeaderTextCandidate>()
            val pageItems = mutableListOf<PageTextItem>()
            collectPageText(root.root, root.appPackage, candidates, pageItems, depth = 0)
            val best = candidates.asSequence()
                .mapNotNull { candidate ->
                    scoreHeaderCandidate(candidate, appLabel, displayWidth, displayHeight, service::dp)
                        ?.let { scored -> candidate to scored }
                }
                .maxByOrNull { it.second.confidence }
            if (best == null && pageItems.isEmpty()) return@mapNotNull null
            val capturedAtMs = System.currentTimeMillis()
            val title = best?.first?.text.orEmpty()
            VisibleConversationContext(
                recipientName = title,
                appPackage = root.appPackage,
                appLabel = appLabel,
                confidence = best?.second?.confidence ?: 0f,
                source = best?.second?.source.orEmpty(),
                capturedAtMs = capturedAtMs,
                pageJson = pageJson(
                    appPackage = root.appPackage,
                    appLabel = appLabel,
                    title = title,
                    titleSource = best?.second?.source.orEmpty(),
                    capturedAtMs = capturedAtMs,
                    displayWidth = displayWidth,
                    displayHeight = displayHeight,
                    items = pageItems
                )
            )
        }.maxByOrNull { it.confidence }
    }

    private fun visibleApplicationRoots(): List<ApplicationRoot> {
        val windowRoots = service.windows
            .filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            .sortedWith(
                compareByDescending<AccessibilityWindowInfo> { it.isActive }
                    .thenByDescending { it.isFocused }
            )
            .mapNotNull { window ->
                val root = window.root ?: return@mapNotNull null
                val appPackage = root.packageName?.toString().orEmpty()
                if (appPackage.isBlank() || appPackage == service.packageName) return@mapNotNull null
                ApplicationRoot(root, appPackage)
            }
        if (windowRoots.isNotEmpty()) return windowRoots

        val root = service.rootInActiveWindow ?: return emptyList()
        val appPackage = root.packageName?.toString().orEmpty()
        if (appPackage.isBlank() || appPackage == service.packageName) return emptyList()
        return listOf(ApplicationRoot(root, appPackage))
    }

    private fun collectPageText(
        node: AccessibilityNodeInfo,
        appPackage: String,
        candidates: MutableList<HeaderTextCandidate>,
        pageItems: MutableList<PageTextItem>,
        depth: Int
    ) {
        if (depth > MAX_ACCESSIBILITY_DEPTH) return
        if (node.packageName?.toString().orEmpty() == appPackage) {
            val textItem = pageTextItemFrom(node, node.text, "text")
            textItem?.let {
                if (pageItems.size < MAX_PAGE_TEXT_ITEMS) pageItems.add(it)
                candidateFrom(node, node.text, fromContentDescription = false)?.let(candidates::add)
            }
            val contentDescriptionItem = pageTextItemFrom(node, node.contentDescription, "contentDescription")
            if (contentDescriptionItem != null && contentDescriptionItem.text != textItem?.text) {
                if (pageItems.size < MAX_PAGE_TEXT_ITEMS) pageItems.add(contentDescriptionItem)
                candidateFrom(node, node.contentDescription, fromContentDescription = true)?.let(candidates::add)
            }
            val hintItem = pageTextItemFrom(node, node.hintText, "hint")
            if (hintItem != null && hintItem.text != textItem?.text && hintItem.text != contentDescriptionItem?.text) {
                if (pageItems.size < MAX_PAGE_TEXT_ITEMS) pageItems.add(hintItem)
            }
        }
        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            collectPageText(child, appPackage, candidates, pageItems, depth + 1)
        }
    }

    private fun pageTextItemFrom(node: AccessibilityNodeInfo, rawText: CharSequence?, source: String): PageTextItem? {
        val text = normalizePageText(rawText)
        if (text.isBlank()) return null
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        if (bounds.isEmpty || bounds.width() <= 0 || bounds.height() <= 0) return null
        return PageTextItem(
            text = text,
            source = source,
            bounds = bounds,
            className = node.className?.toString().orEmpty(),
            viewId = node.viewIdResourceName?.substringAfterLast('/').orEmpty(),
            isEditable = isEditable(node),
            isClickable = node.isClickable,
            isEnabled = node.isEnabled
        )
    }

    private fun candidateFrom(node: AccessibilityNodeInfo, rawText: CharSequence?, fromContentDescription: Boolean): HeaderTextCandidate? {
        val text = normalizeCandidateText(rawText)
        if (!isPossibleConversationName(text)) return null
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        if (bounds.isEmpty || bounds.width() <= 0 || bounds.height() <= 0) return null
        return HeaderTextCandidate(
            text = text,
            bounds = bounds,
            className = node.className?.toString().orEmpty(),
            viewId = node.viewIdResourceName?.substringAfterLast('/').orEmpty(),
            fromContentDescription = fromContentDescription,
            isEditable = isEditable(node),
            isClickable = node.isClickable
        )
    }

    private fun pageJson(
        appPackage: String,
        appLabel: String,
        title: String,
        titleSource: String,
        capturedAtMs: Long,
        displayWidth: Int,
        displayHeight: Int,
        items: List<PageTextItem>
    ): String {
        val jsonItems = JSONArray()
        items.forEach { item ->
            jsonItems.put(
                JSONObject()
                    .put("kind", pageItemKind(item, displayHeight, service::dp))
                    .put("text", item.text)
                    .put("source", item.source)
                    .put("viewId", item.viewId)
                    .put("className", item.className)
                    .put("enabled", item.isEnabled)
                    .put("clickable", item.isClickable)
                    .put("editable", item.isEditable)
                    .put("bounds", boundsJson(item.bounds))
            )
        }
        return JSONObject()
            .put("appPackage", appPackage)
            .put("appLabel", appLabel)
            .put("capturedAtMs", capturedAtMs)
            .put("screen", JSONObject().put("width", displayWidth).put("height", displayHeight))
            .put("title", title)
            .put("titleSource", titleSource)
            .put("items", jsonItems)
            .toString()
    }

    private fun boundsJson(bounds: Rect): JSONObject =
        JSONObject()
            .put("left", bounds.left)
            .put("top", bounds.top)
            .put("right", bounds.right)
            .put("bottom", bounds.bottom)

    private fun isEditable(node: AccessibilityNodeInfo): Boolean {
        if (node.isEditable) return true
        if (node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SET_TEXT }) return true
        val className = node.className?.toString().orEmpty()
        return className.contains("EditText", ignoreCase = true)
    }

    @SuppressLint("DiscouragedPrivateApi")
    @Suppress("DEPRECATION")
    private fun appLabelFor(appPackage: String): String =
        runCatching {
            val info = service.packageManager.getApplicationInfo(appPackage, 0)
            service.packageManager.getApplicationLabel(info).toString()
        }.getOrDefault("")

}

private data class ApplicationRoot(
    val root: AccessibilityNodeInfo,
    val appPackage: String
)

private data class HeaderTextCandidate(
    val text: String,
    val bounds: Rect,
    val className: String,
    val viewId: String,
    val fromContentDescription: Boolean,
    val isEditable: Boolean,
    val isClickable: Boolean
)

private data class ScoredHeaderCandidate(
    val confidence: Float,
    val source: String
)

private data class PageTextItem(
    val text: String,
    val source: String,
    val bounds: Rect,
    val className: String,
    val viewId: String,
    val isEditable: Boolean,
    val isClickable: Boolean,
    val isEnabled: Boolean
)

private const val MAX_ACCESSIBILITY_DEPTH = 64
private const val MAX_PAGE_TEXT_ITEMS = 80
private const val MIN_HEADER_SCORE = 6.5f
private const val MAX_PAGE_TEXT_CHARS = 500
private const val PARAGRAPH_TEXT_CHARS = 80

private val WHITESPACE = Regex("\\s+")
private val TIME_TEXT = Regex("""^\d{1,2}[:.]\d{2}$""")
private val TITLE_VIEW_ID_HINTS = listOf("title", "name", "contact", "conversation", "recipient", "toolbar", "chat")
private val NON_TITLE_VIEW_ID_HINTS = listOf("subtitle", "status", "typing", "time", "message", "input", "edit")
private val HEADER_STOP_WORDS = setOf(
    "brai cmd",
    "back",
    "call",
    "chats",
    "close",
    "contacts",
    "edit",
    "message",
    "messages",
    "more options",
    "online",
    "search",
    "telegram",
    "today",
    "video call",
    "voice call",
    "whatsapp",
    "yesterday",
    "в сети",
    "вызов",
    "еще",
    "ещё",
    "закрыть",
    "звонок",
    "контакты",
    "назад",
    "поиск",
    "сегодня",
    "сообщение",
    "сообщения",
    "чаты"
)
private val HEADER_STOP_PREFIXES = listOf(
    "active ",
    "last seen",
    "typing",
    "был ",
    "была ",
    "был(а)",
    "печатает"
)
private val HEADER_STOP_CONTAINS = listOf(
    " members",
    " subscribers",
    " участник",
    " подписчик"
)

private fun normalizeCandidateText(rawText: CharSequence?): String =
    WHITESPACE.replace(rawText?.toString().orEmpty(), " ")
        .trim()
        .trim('"', '\'', '`', '«', '»')

private fun normalizePageText(rawText: CharSequence?): String {
    val text = WHITESPACE.replace(rawText?.toString().orEmpty(), " ").trim()
    return if (text.length <= MAX_PAGE_TEXT_CHARS) text else text.take(MAX_PAGE_TEXT_CHARS).trimEnd() + "..."
}

private fun isPossibleConversationName(text: String): Boolean {
    if (text.length < 2 || text.length > 64) return false
    if (!text.any { it.isLetter() }) return false
    if (TIME_TEXT.matches(text)) return false
    val lower = text.lowercase()
    if (HEADER_STOP_WORDS.contains(lower)) return false
    if (HEADER_STOP_PREFIXES.any { lower.startsWith(it) }) return false
    if (HEADER_STOP_CONTAINS.any { lower.contains(it) }) return false
    return true
}

private fun scoreHeaderCandidate(
    candidate: HeaderTextCandidate,
    appLabel: String,
    displayWidth: Int,
    displayHeight: Int,
    dp: (Int) -> Int
): ScoredHeaderCandidate? {
    val headerBottom = min((displayHeight * 0.28f).toInt(), dp(190))
    val centerY = candidate.bounds.centerY()
    val lowerViewId = candidate.viewId.lowercase()
    var score = 0f

    if (candidate.bounds.top in 0..headerBottom || centerY in dp(20)..headerBottom) score += 4f else score -= 5f
    if (centerY in dp(24)..dp(118)) score += 2f
    if (candidate.bounds.top > dp(150)) score -= 2.5f
    if (candidate.bounds.left < displayWidth - dp(72) && candidate.bounds.right > dp(48)) score += 1f
    if (candidate.bounds.height() in dp(12)..dp(72)) score += 1f
    if (candidate.bounds.width() >= dp(28)) score += 0.5f
    if (candidate.className.contains("TextView", ignoreCase = true)) score += 1.25f
    if (candidate.isClickable) score += 0.25f
    if (candidate.fromContentDescription) score -= 1.25f
    if (candidate.isEditable) score -= 8f
    if (candidate.text.equals(appLabel, ignoreCase = true)) score -= 4f

    if (TITLE_VIEW_ID_HINTS.any { lowerViewId.contains(it) }) score += 3f
    if (NON_TITLE_VIEW_ID_HINTS.any { lowerViewId.contains(it) }) score -= 4f

    val wordCount = candidate.text.split(' ').count { it.isNotBlank() }
    if (candidate.text.length in 2..36) score += 1f else score -= 1f
    if (wordCount in 1..4) score += 1f else score -= 2f

    if (score < MIN_HEADER_SCORE) return null
    val confidence = (score / 12f).coerceIn(VisibleConversationContext.MIN_CONFIDENCE, 0.98f)
    val source = candidate.viewId.ifBlank {
        if (candidate.fromContentDescription) "contentDescription" else candidate.className.ifBlank { "text" }
    }
    return ScoredHeaderCandidate(confidence, source)
}

private fun pageItemKind(item: PageTextItem, displayHeight: Int, dp: (Int) -> Int): String {
    val lowerViewId = item.viewId.lowercase()
    val lowerClassName = item.className.lowercase()
    val headerBottom = min((displayHeight * 0.28f).toInt(), dp(190))
    if (item.isEditable) return "input"
    if (lowerClassName.contains("button") || lowerViewId.contains("button")) return "button"
    if (item.bounds.top <= headerBottom && TITLE_VIEW_ID_HINTS.any { lowerViewId.contains(it) }) return "title"
    if (lowerViewId.contains("message")) return "message"
    if (item.text.length >= PARAGRAPH_TEXT_CHARS) return "paragraph"
    return "text"
}
