package world.brightos.brai.capabilities

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityService.ScreenshotResult
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback
import android.app.KeyguardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.os.Build
import android.os.PowerManager
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import world.brightos.brai.braicmd.AccessibilityContextReader
import world.brightos.brai.braicmd.AccessibilityTextInserter
import world.brightos.brai.braicmd.BraiCmdBus
import world.brightos.brai.braicmd.BraiCmdPlugin
import world.brightos.brai.braicmd.OverlayController
import world.brightos.brai.braicmd.PendingReason
import world.brightos.brai.braicmd.PendingTranscript
import world.brightos.brai.braicmd.PendingTranscriptKind
import world.brightos.brai.braicmd.PendingTranscriptStore
import world.brightos.brai.braicmd.RecorderState
import world.brightos.brai.braicmd.RecordingService
import world.brightos.brai.braicmd.VisibleConversationContext
import java.io.File
import kotlin.math.max

class BraiAccessibilityService : AccessibilityService() {
    private lateinit var overlay: OverlayController
    private val contextReader by lazy { AccessibilityContextReader(this) }
    private val textInserter by lazy { AccessibilityTextInserter(this) }
    private var focusedNode: AccessibilityNodeInfo? = null
    private var autoInsertTranscriptFile: String? = null
    private var retryingAutoInsert = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        overlay = OverlayController(this)
        overlay.start()
        updateFocusedNode()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        when (event?.eventType) {
            AccessibilityEvent.TYPE_VIEW_CLICKED -> {
                overlay.onExternalInteraction(event.packageName?.toString())
                updateFocusedNode()
            }
            AccessibilityEvent.TYPE_VIEW_FOCUSED,
            AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED,
            AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
            AccessibilityEvent.TYPE_WINDOWS_CHANGED,
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> updateFocusedNode()
        }
    }

    override fun onInterrupt() {
        overlay.hide()
    }

    override fun onDestroy() {
        focusedNode = null
        overlay.stop()
        super.onDestroy()
    }

    fun insertTextIntoFocusedField(text: String): Boolean {
        val inserted = textInserter.insert(text, focusedNode) { findEditableNode() }
        if (inserted) updateFocusedNode()
        return inserted
    }

    fun captureVisibleConversationContext(): VisibleConversationContext? =
        if (isDeviceInteractive()) contextReader.capture() else null

    fun canCaptureWindowWithoutHidingOverlays(): Boolean =
        shouldUseWindowScreenshot(Build.VERSION.SDK_INT, activeWindowId())

    fun captureActiveWindowScreenshot(onComplete: (File?) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || !isDeviceInteractive()) {
            onComplete(null)
            return
        }

        val callback = object : TakeScreenshotCallback {
            override fun onSuccess(screenshot: ScreenshotResult) {
                onComplete(writeScreenshot(screenshot))
            }

            override fun onFailure(errorCode: Int) {
                onComplete(null)
            }
        }

        val windowId = activeWindowId()
        if (shouldUseWindowScreenshot(Build.VERSION.SDK_INT, windowId)) {
            takeScreenshotOfWindow(windowId!!, mainExecutor, callback)
        } else {
            takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, callback)
        }
    }

    fun insertNextPendingTranscriptIntoFocusedField(
        showToast: Boolean,
        kind: PendingTranscriptKind = PendingTranscriptKind.MainDictation
    ): Boolean {
        val pending = PendingTranscriptStore.list(this, kind)
        if (pending.isEmpty()) return false
        return insertPendingTranscriptIntoFocusedField(pending.first(), pending.size, showToast)
    }

    fun insertPendingTranscriptIntoFocusedField(fileName: String, showToast: Boolean): Boolean {
        val pending = PendingTranscriptStore.list(this)
        val transcript = pending.firstOrNull { it.file.name == fileName }
        if (transcript == null) {
            if (autoInsertTranscriptFile == fileName) autoInsertTranscriptFile = null
            return false
        }
        return insertPendingTranscriptIntoFocusedField(transcript, pending.size, showToast, retryOnFocus = !showToast)
    }

    private fun insertPendingTranscriptIntoFocusedField(
        transcript: PendingTranscript,
        pendingCount: Int,
        showToast: Boolean,
        retryOnFocus: Boolean = false
    ): Boolean {
        val text = transcript.text.trim()
        if (text.isBlank()) return false

        if (retryOnFocus && !retryingAutoInsert) autoInsertTranscriptFile = null
        val inserted = insertTextIntoFocusedField(text)
        if (!inserted) {
            if (retryOnFocus && !retryingAutoInsert) autoInsertTranscriptFile = transcript.file.name
            BraiCmdBus.post(
                RecorderState.Pending(
                    message = "Текст скопирован",
                    recordings = RecordingService.pendingRecordingsCount(this),
                    transcripts = pendingCount,
                    reason = PendingReason.Unknown
                )
            )
            return false
        }

        if (autoInsertTranscriptFile == transcript.file.name) autoInsertTranscriptFile = null
        PendingTranscriptStore.delete(transcript)
        BraiCmdPlugin.notifyOnboardingEvent("voiceTextInserted", text)
        val pendingRecordings = RecordingService.pendingRecordingsCount(this)
        val pendingTranscripts = PendingTranscriptStore.list(this).size
        if (pendingRecordings == 0 && pendingTranscripts == 0) {
            BraiCmdBus.post(RecorderState.Idle)
        } else {
            BraiCmdBus.post(
                RecorderState.Pending(
                    message = if (pendingTranscripts > 0) "Текст скопирован" else "Ждёт интернет",
                    recordings = pendingRecordings,
                    transcripts = pendingTranscripts,
                    reason = if (pendingRecordings > 0) PendingReason.Network else PendingReason.Unknown
                )
            )
        }
        return true
    }

    fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun updateFocusedNode() {
        if (!isDeviceInteractive()) {
            overlay.hide()
            focusedNode = null
            return
        }
        val editable = findEditableNode() ?: refreshedFocusedNode()
        focusedNode = editable
        if (shouldShowDictationButton(editable != null, isInputMethodVisible())) {
            overlay.showIfAllowed()
        } else {
            overlay.hideInputButton()
        }
        overlay.showScreenshotIfAllowed()
        if (editable != null) retryAutoInsertTranscript()
    }

    private fun isInputMethodVisible(): Boolean =
        windows.any { window -> window.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }

    private fun findEditableNode(): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.let { focused ->
            if (isEditable(focused)) return focused
        }
        return findEditableFocused(root) ?: findEditableCandidate(root)
    }

    private fun findEditableFocused(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isFocused && isEditable(node)) return node
        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            findEditableFocused(child)?.let { return it }
        }
        return null
    }

    private fun isEditable(node: AccessibilityNodeInfo): Boolean {
        if (node.isEditable) return true
        if (node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SET_TEXT }) return true
        val className = node.className?.toString().orEmpty()
        return className.contains("EditText", ignoreCase = true)
    }

    private fun findEditableCandidate(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var bestNode: AccessibilityNodeInfo? = null
        var bestScore = Int.MIN_VALUE
        val appPackage = root.packageName?.toString().orEmpty()

        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            if (node.packageName?.toString().orEmpty() == appPackage && node.isVisibleToUser && node.isEnabled && isEditable(node)) {
                val score = editableCandidateScore(node, depth)
                if (score > bestScore) {
                    bestScore = score
                    bestNode = node
                }
            }
            for (index in 0 until node.childCount) {
                visit(node.getChild(index) ?: continue, depth + 1)
            }
        }

        visit(root, 0)
        return bestNode
    }

    private fun editableCandidateScore(node: AccessibilityNodeInfo, depth: Int): Int {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        val area = (bounds.width().coerceAtLeast(0) * bounds.height().coerceAtLeast(0)) / 10_000
        val hasSelection = node.textSelectionStart >= 0 || node.textSelectionEnd >= 0
        return depth + area + if (hasSelection) 1_000 else 0
    }

    private fun refreshedFocusedNode(): AccessibilityNodeInfo? {
        val node = focusedNode ?: return null
        if (!node.refresh() || !isEditable(node)) return null
        val activePackage = rootInActiveWindow?.packageName?.toString().orEmpty()
        if (activePackage.isBlank()) return null
        val nodePackage = node.packageName?.toString().orEmpty()
        if (nodePackage != activePackage) return null
        return node
    }

    private fun activeWindowId(): Int? =
        rootInActiveWindow?.windowId?.takeIf { it >= 0 }

    private fun retryAutoInsertTranscript() {
        val fileName = autoInsertTranscriptFile ?: return
        autoInsertTranscriptFile = null
        retryingAutoInsert = true
        try {
            insertPendingTranscriptIntoFocusedField(fileName, showToast = false)
        } finally {
            retryingAutoInsert = false
        }
    }

    private fun isDeviceInteractive(): Boolean {
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        val interactive = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH) power.isInteractive else power.isScreenOn
        if (!interactive) return false
        val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        return !keyguard.isKeyguardLocked
    }

    private fun writeScreenshot(screenshot: ScreenshotResult): File? {
        val source = runCatching {
            Bitmap.wrapHardwareBuffer(screenshot.hardwareBuffer, screenshot.colorSpace)
        }.getOrNull()
        screenshot.hardwareBuffer.close()
        if (source == null) return null

        val bitmap = runCatching { screenshotBitmapForStorage(source) }.getOrNull()
        source.recycle()
        if (bitmap == null) return null

        val scaled = scaleBitmap(bitmap)
        val dir = File(filesDir, SCREENSHOT_DIR).apply { mkdirs() }
        val output = File(dir, "brai-cmd-${System.currentTimeMillis()}.png")
        val written = runCatching {
            output.outputStream().use { stream ->
                scaled.compress(Bitmap.CompressFormat.PNG, 100, stream)
            }
        }.getOrDefault(false)
        if (scaled !== bitmap) scaled.recycle()
        bitmap.recycle()
        return output.takeIf { written && it.isFile && it.length() > 0L }
    }

    private fun scaleBitmap(bitmap: Bitmap): Bitmap {
        val longest = max(bitmap.width, bitmap.height)
        if (longest <= MAX_SCREENSHOT_DIMENSION) return bitmap
        val scale = MAX_SCREENSHOT_DIMENSION.toFloat() / longest.toFloat()
        val width = (bitmap.width * scale).toInt().coerceAtLeast(1)
        val height = (bitmap.height * scale).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, width, height, true)
    }

    companion object {
        private const val SCREENSHOT_DIR = "pending-screenshots"
        private const val MAX_SCREENSHOT_DIMENSION = 1440
    }
}

internal fun shouldShowDictationButton(hasEditableField: Boolean, inputMethodVisible: Boolean): Boolean =
    hasEditableField && inputMethodVisible

internal fun shouldUseWindowScreenshot(sdkInt: Int, windowId: Int?): Boolean =
    sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && windowId != null && windowId >= 0

internal fun opaqueScreenshotBitmap(source: Bitmap): Bitmap {
    require(source.config != Bitmap.Config.HARDWARE) {
        "Hardware bitmap must be copied before software composition"
    }
    return Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888).also { output ->
        Canvas(output).apply {
            drawColor(Color.BLACK)
            drawBitmap(source, 0f, 0f, null)
        }
        output.setHasAlpha(false)
    }
}

internal fun screenshotBitmapForStorage(source: Bitmap): Bitmap {
    val softwareCopy = source.copy(Bitmap.Config.ARGB_8888, false)
        ?: error("Unable to copy screenshot into software memory")
    return try {
        opaqueScreenshotBitmap(softwareCopy)
    } finally {
        softwareCopy.recycle()
    }
}
