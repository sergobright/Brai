package world.brightos.brai.braicmd

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.view.ViewConfiguration
import android.widget.Toast
import world.brightos.brai.capabilities.BraiAccessibilityService
import java.io.File

internal enum class RecordingButton {
    Main,
    Context
}

internal enum class ContextButtonAction {
    IdeaVoiceInbox,
    ScreenshotInbox,
    ScreenshotVoiceInbox,
    ChatContextInbox,
    SaveContextInbox
}

internal fun shouldShowStandaloneCancel(state: RecorderState, activeButton: RecordingButton?): Boolean =
    state is RecorderState.Recording && activeButton == RecordingButton.Main

internal fun contextRecordingStartingState(action: ContextButtonAction): RecorderState? =
    if (action == ContextButtonAction.ScreenshotInbox) null else RecorderState.Recording(0)

internal fun visibleContextButtonState(
    activeButton: RecordingButton?,
    activeAction: ContextButtonAction?,
    startingRecording: Boolean,
    action: ContextButtonAction,
    state: RecorderState
): RecorderState {
    if (activeButton != RecordingButton.Context || activeAction != action) return RecorderState.Idle
    return if (startingRecording && state is RecorderState.Uploading) {
        contextRecordingStartingState(action) ?: state
    } else {
        state
    }
}

internal class OverlayRecordingCoordinator(
    private val service: BraiAccessibilityService,
    private val config: ConfigStore,
    private val handler: Handler,
    private val onLongPress: () -> Unit,
    private val hideForScreenshot: () -> Unit,
    private val restoreAfterScreenshot: () -> Unit
) {
    var activeButton: RecordingButton? = null
        private set

    var activeContextAction: ContextButtonAction? = null
        private set

    private var startingRecording = false
    private var recordingStartDispatched = false
    private var captureGeneration = 0
    private var longPressRunnable: Runnable? = null

    val isStartingContextAction: Boolean
        get() = activeButton == RecordingButton.Context && startingRecording

    val isStartingRecording: Boolean
        get() = startingRecording

    fun toggle(useScreenshot: Boolean) {
        when (BraiCmdBus.latest) {
            is RecorderState.Recording -> {
                Haptics.recordingStop(service)
                RecordingService.stop(service)
            }
            is RecorderState.Uploading -> Unit
            else -> if (!startingRecording) startNewRecording(useScreenshot)
        }
    }

    fun toggleContextAction(action: ContextButtonAction) {
        when (BraiCmdBus.latest) {
            is RecorderState.Recording -> {
                Haptics.recordingStop(service)
                RecordingService.stop(service)
            }
            is RecorderState.Uploading -> Unit
            else -> if (!startingRecording) startContextAction(action)
        }
    }

    fun scheduleLongPress() {
        cancelLongPress()
        longPressRunnable = Runnable {
            onLongPress()
            insertNextSavedTranscript()
        }.also { handler.postDelayed(it, ViewConfiguration.getLongPressTimeout().toLong()) }
    }

    fun cancelLongPress() {
        val pendingLongPress = longPressRunnable ?: return
        handler.removeCallbacks(pendingLongPress)
        longPressRunnable = null
    }

    fun cancelActiveRecording() {
        cancelLongPress()
        Haptics.recordingStop(service)
        RecordingService.cancel(service)
    }

    fun cancelActiveContextAction() {
        cancelLongPress()
        if (activeButton != RecordingButton.Context) return
        if (BraiCmdBus.latest is RecorderState.Recording) {
            Haptics.recordingStop(service)
            RecordingService.cancel(service)
            return
        }
        if (startingRecording) {
            captureGeneration += 1
            startingRecording = false
            activeButton = null
            activeContextAction = null
            restoreAfterScreenshot()
            if (recordingStartDispatched) RecordingService.cancel(service)
            recordingStartDispatched = false
            BraiCmdBus.post(RecorderState.Idle)
        }
    }

    fun completeContextAction() {
        captureGeneration += 1
        startingRecording = false
        recordingStartDispatched = false
        activeButton = null
        activeContextAction = null
    }

    fun onStateChanged(state: RecorderState) {
        if (state !is RecorderState.Uploading) {
            startingRecording = false
            recordingStartDispatched = false
        }
        if (state is RecorderState.Idle) {
            activeButton = null
            activeContextAction = null
        }
    }

    fun mainButtonState(state: RecorderState): RecorderState =
        if (activeButton == RecordingButton.Context) RecorderState.Idle else state

    fun contextButtonState(action: ContextButtonAction, state: RecorderState): RecorderState =
        visibleContextButtonState(activeButton, activeContextAction, startingRecording, action, state)

    private fun insertNextSavedTranscript() {
        when (BraiCmdBus.latest) {
            is RecorderState.Recording,
            is RecorderState.Uploading -> return
            else -> Unit
        }
        if (service.insertNextPendingTranscriptIntoFocusedField(showToast = true)) {
            Haptics.transcriptionReady(service)
        } else {
            Toast.makeText(service, "Нет сохраненных текстов для вставки", Toast.LENGTH_SHORT).show()
        }
    }

    private fun startNewRecording(useScreenshot: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            service.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) {
            BraiCmdBus.post(RecorderState.Error("Откройте Brai Cmd и разрешите доступ к микрофону"))
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            service.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            BraiCmdBus.post(RecorderState.Error("Откройте Brai Cmd и разрешите уведомления"))
            return
        }
        if (config.authToken.isBlank()) {
            BraiCmdBus.post(RecorderState.Error("Откройте Brai Cmd и получите доступ"))
            return
        }
        activeButton = if (useScreenshot) RecordingButton.Context else RecordingButton.Main
        activeContextAction = if (useScreenshot) ContextButtonAction.ScreenshotVoiceInbox else null
        if (!useScreenshot) {
            beginRecording(null, null, deliverToInbox = false)
            return
        }
        when (config.contextDeliveryMode) {
            ContextDeliveryMode.Json -> {
                val conversationContext = service.captureVisibleConversationContext()
                if (conversationContext == null) {
                    activeButton = null
                    activeContextAction = null
                    BraiCmdBus.post(RecorderState.Error("JSON страницы недоступен"))
                    return
                }
                beginRecording(conversationContext, null, deliverToInbox = true, inboxTextPrefix = "")
            }
            ContextDeliveryMode.Screenshot -> startRecordingWithScreenshot()
        }
    }

    private fun startContextAction(action: ContextButtonAction) {
        if (action == ContextButtonAction.ScreenshotInbox) {
            startScreenshotOnlyInbox()
            return
        }
        if (!canRecord()) return
        activeButton = RecordingButton.Context
        activeContextAction = action
        when (action) {
            ContextButtonAction.IdeaVoiceInbox ->
                beginRecording(null, null, deliverToInbox = true, inboxTextPrefix = "")
            ContextButtonAction.ScreenshotVoiceInbox ->
                startRecordingWithScreenshot(inboxTextPrefix = "")
            ContextButtonAction.ChatContextInbox ->
                startRecordingWithJson(inboxTextPrefix = "Добавить в контекст контакта")
            ContextButtonAction.SaveContextInbox ->
                startRecordingWithJson(inboxTextPrefix = "")
            ContextButtonAction.ScreenshotInbox -> Unit
        }
    }

    private fun canRecord(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            service.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) {
            BraiCmdBus.post(RecorderState.Error("Откройте Brai Cmd и разрешите доступ к микрофону"))
            return false
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            service.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            BraiCmdBus.post(RecorderState.Error("Откройте Brai Cmd и разрешите уведомления"))
            return false
        }
        if (config.authToken.isBlank()) {
            BraiCmdBus.post(RecorderState.Error("Откройте Brai Cmd и получите доступ"))
            return false
        }
        return true
    }

    private fun startRecordingWithJson(inboxTextPrefix: String) {
        val conversationContext = service.captureVisibleConversationContext()
        if (conversationContext == null) {
            activeButton = null
            activeContextAction = null
            BraiCmdBus.post(RecorderState.Error("JSON страницы недоступен"))
            return
        }
        beginRecording(conversationContext, null, deliverToInbox = true, inboxTextPrefix = inboxTextPrefix)
    }

    private fun startScreenshotOnlyInbox() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            BraiCmdBus.post(RecorderState.Error("Скриншот недоступен"))
            return
        }
        if (config.authToken.isBlank()) {
            BraiCmdBus.post(RecorderState.Error("Откройте Brai Cmd и получите доступ"))
            return
        }
        activeButton = RecordingButton.Context
        activeContextAction = ContextButtonAction.ScreenshotInbox
        startingRecording = true
        recordingStartDispatched = false
        val generation = ++captureGeneration
        BraiCmdBus.post(RecorderState.Uploading)
        captureScreenshot(generation) capture@{ screenshotFile ->
            if (generation != captureGeneration) {
                screenshotFile?.delete()
                return@capture
            }
            startingRecording = false
            if (screenshotFile == null) {
                BraiCmdBus.post(RecorderState.Error("Скриншот недоступен"))
                return@capture
            }
            if (!RecordingService.enqueueScreenshot(service, screenshotFile)) {
                screenshotFile.delete()
                BraiCmdBus.post(RecorderState.Error("Не удалось сохранить скриншот в очереди"))
            }
        }
    }

    private fun startRecordingWithScreenshot(inboxTextPrefix: String = "") {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            activeButton = null
            activeContextAction = null
            BraiCmdBus.post(RecorderState.Error("Скриншот недоступен"))
            return
        }

        startingRecording = true
        recordingStartDispatched = false
        val generation = ++captureGeneration
        BraiCmdBus.post(RecorderState.Uploading)
        captureScreenshot(generation) capture@{ screenshotFile ->
            if (generation != captureGeneration) {
                screenshotFile?.delete()
                return@capture
            }
            if (screenshotFile == null) {
                startingRecording = false
                activeButton = null
                activeContextAction = null
                BraiCmdBus.post(RecorderState.Error("Скриншот недоступен"))
                return@capture
            }
            beginRecording(null, screenshotFile, deliverToInbox = true, inboxTextPrefix = inboxTextPrefix)
        }
    }

    private fun captureScreenshot(generation: Int, onComplete: (File?) -> Unit) {
        val hideOverlay = !service.canCaptureWindowWithoutHidingOverlays()
        if (hideOverlay) hideForScreenshot()
        val capture = Runnable {
            if (generation != captureGeneration) {
                if (hideOverlay) restoreAfterScreenshot()
                return@Runnable
            }
            service.captureActiveWindowScreenshot { screenshotFile ->
                if (hideOverlay) restoreAfterScreenshot()
                onComplete(screenshotFile)
            }
        }
        if (hideOverlay) handler.postDelayed(capture, SCREENSHOT_HIDE_DELAY_MS) else capture.run()
    }

    private fun beginRecording(
        conversationContext: VisibleConversationContext?,
        screenshotFile: File?,
        deliverToInbox: Boolean,
        inboxTextPrefix: String = ""
    ) {
        startingRecording = true
        recordingStartDispatched = true
        Haptics.recordingStart(service)
        RecordingService.start(
            service,
            conversationContext,
            screenshotFile,
            deliverToInbox = deliverToInbox,
            inboxTextPrefix = inboxTextPrefix,
            contextAction = activeContextAction
        )
    }

    companion object {
        private const val SCREENSHOT_HIDE_DELAY_MS = 140L
    }
}
