package world.brightos.brai.airwhisper

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
    Screenshot
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

    private var startingRecording = false
    private var longPressRunnable: Runnable? = null

    fun toggle(useScreenshot: Boolean) {
        when (AirWhisperBus.latest) {
            is RecorderState.Recording -> {
                Haptics.recordingStop(service)
                RecordingService.stop(service)
            }
            is RecorderState.Uploading -> Unit
            else -> if (!startingRecording) startNewRecording(useScreenshot)
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

    fun onStateChanged(state: RecorderState) {
        if (state is RecorderState.Idle) activeButton = null
    }

    fun mainButtonState(state: RecorderState): RecorderState =
        if (activeButton == RecordingButton.Screenshot) RecorderState.Idle else state

    fun screenshotButtonState(state: RecorderState): RecorderState =
        if (activeButton == RecordingButton.Screenshot) state else RecorderState.Idle

    private fun insertNextSavedTranscript() {
        when (AirWhisperBus.latest) {
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
            AirWhisperBus.post(RecorderState.Error("Откройте AirWhisper и разрешите доступ к микрофону"))
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            service.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            AirWhisperBus.post(RecorderState.Error("Откройте AirWhisper и разрешите уведомления"))
            return
        }
        if (useScreenshot && !config.receiverReady()) {
            config.appendReceiverLog("Кнопка: получатель не настроен или тест не пройден")
            AirWhisperBus.post(RecorderState.Error("Подключите получателя данных"))
            return
        }
        if (config.authToken.isBlank()) {
            AirWhisperBus.post(RecorderState.Error("Откройте AirWhisper и получите доступ"))
            return
        }
        activeButton = if (useScreenshot) RecordingButton.Screenshot else RecordingButton.Main
        val conversationContext = if (!useScreenshot && config.headerContextEnabled) service.captureVisibleConversationContext() else null
        startRecordingWithScreenshot(conversationContext, useScreenshot)
    }

    private fun startRecordingWithScreenshot(conversationContext: VisibleConversationContext?, useScreenshot: Boolean) {
        if (!useScreenshot) {
            beginRecording(conversationContext, null, sendToReceiver = false)
            return
        }
        if (!config.screenshotContextEnabled || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            activeButton = null
            config.appendReceiverLog("Кнопка: скриншот недоступен")
            AirWhisperBus.post(RecorderState.Error("Скриншот недоступен"))
            return
        }

        startingRecording = true
        val hiddenForScreenshot = Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        if (hiddenForScreenshot) hideForScreenshot()
        handler.postDelayed({
            service.captureActiveWindowScreenshot { screenshotFile ->
                if (hiddenForScreenshot) restoreAfterScreenshot()
                if (screenshotFile == null) {
                    startingRecording = false
                    activeButton = null
                    config.appendReceiverLog("Кнопка: Android не вернул скриншот")
                    AirWhisperBus.post(RecorderState.Error("Скриншот недоступен"))
                    return@captureActiveWindowScreenshot
                }
                beginRecording(conversationContext, screenshotFile, sendToReceiver = true)
            }
        }, if (hiddenForScreenshot) SCREENSHOT_HIDE_DELAY_MS else 0L)
    }

    private fun beginRecording(conversationContext: VisibleConversationContext?, screenshotFile: File?, sendToReceiver: Boolean) {
        startingRecording = false
        Haptics.recordingStart(service)
        RecordingService.start(service, conversationContext, screenshotFile, sendToReceiver = sendToReceiver)
    }

    companion object {
        private const val SCREENSHOT_HIDE_DELAY_MS = 140L
    }
}
