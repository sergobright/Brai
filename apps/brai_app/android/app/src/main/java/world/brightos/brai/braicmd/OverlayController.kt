package world.brightos.brai.braicmd

import android.content.Context
import android.content.SharedPreferences
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.Toast
import world.brightos.brai.capabilities.BraiAccessibilityService
import kotlin.math.abs
import kotlin.math.roundToInt

class OverlayController(private val service: BraiAccessibilityService) {
    private val windowManager = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val config = ConfigStore(service)
    private val retryHandler = Handler(Looper.getMainLooper())
    private val screenshotButtonGapPx = service.dp(7)
    private val cancelSizePx = service.dp(31)
    private val cancelGapPx = service.dp(10)
    private val touchSlop = ViewConfiguration.get(service).scaledTouchSlop
    private val statusBubble = OverlayStatusBubble(service, windowManager, retryHandler)
    private val settingsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key in overlaySettingKeys) {
            applyIconSettings()
            updateScreenshotButtonVisibility()
        }
    }
    private val recording = OverlayRecordingCoordinator(
        service = service,
        config = config,
        handler = retryHandler,
        onLongPress = { longPressTriggered = true },
        hideForScreenshot = ::hideForScreenshot,
        restoreAfterScreenshot = ::restoreAfterScreenshot
    )
    private val pendingRetry = OverlayPendingRetry(service, retryHandler)

    private var button: AirButtonView? = null
    private var screenshotButton: ScreenshotButtonView? = null
    private var cancelButton: CancelButtonView? = null
    private var params: WindowManager.LayoutParams? = null
    private var screenshotParams: WindowManager.LayoutParams? = null
    private var cancelParams: WindowManager.LayoutParams? = null
    private var isShown = false
    private var screenshotShown = false
    private var cancelShown = false
    private var inputButtonRequested = false
    private var downRawX = 0f
    private var downRawY = 0f
    private var downX = 0
    private var downY = 0
    private var dragButtonX = 0
    private var dragButtonY = 0
    private var dragging = false
    private var longPressTriggered = false

    private val busListener: (RecorderState) -> Unit = { state ->
        if (state is RecorderState.InsertText) {
            pendingRetry.cancel()
            service.insertTextIntoFocusedField(state.text)
            Haptics.transcriptionReady(service)
        } else if (state is RecorderState.TranscriptReady) {
            val autoInsertFile = state.autoInsertTranscriptFile
            if (autoInsertFile != null) {
                if (service.insertPendingTranscriptIntoFocusedField(autoInsertFile, showToast = false)) {
                    pendingRetry.cancel()
                    Haptics.transcriptionReady(service)
                    if (state.fallbackUsed) showFallbackBubble(state)
                } else {
                    Toast.makeText(service, "Текст скопирован в буфер. Откройте нужное поле и зажмите кнопку, чтобы вставить снова.", Toast.LENGTH_LONG).show()
                }
            } else if (state.transcripts > 0) {
                if (state.fallbackUsed) showFallbackBubble(state)
                Toast.makeText(service, "Сохраненных текстов: ${state.transcripts}. Зажмите кнопку, чтобы вставить следующий.", Toast.LENGTH_LONG).show()
            }
        } else if (state is RecorderState.Pending) {
            showStatusBubble(
                title = if (state.recordings > 0) "Запись сохранена" else "Текст сохранен",
                subtitle = when {
                    state.reason == PendingReason.Network -> "Ждет интернет"
                    state.reason == PendingReason.Transcription -> "Ждет модель"
                    state.reason == PendingReason.Server -> "Ждет сервер"
                    state.recordings > 0 -> "Повторю автоматически"
                    state.transcripts > 0 -> "Зажмите, чтобы вставить"
                    else -> "Повторю автоматически"
                }
            )
            val toast = when {
                state.reason == PendingReason.Network -> "Запись сохранена, ждет интернет"
                state.reason == PendingReason.Transcription -> "Запись сохранена, ждет модель"
                state.reason == PendingReason.Server -> "Запись сохранена, ждет сервер"
                state.recordings > 0 -> "Запись сохранена, повторю автоматически"
                else -> "Текст сохранен, зажмите кнопку для вставки"
            }
            Toast.makeText(service, toast, Toast.LENGTH_LONG).show()
            if (state.recordings > 0) pendingRetry.schedule()
        } else if (state is RecorderState.InboxDelivered) {
            pendingRetry.cancel()
            showStatusBubble("Отправлено", "Во входящих")
            Toast.makeText(service, "Команда отправлена во входящие", Toast.LENGTH_SHORT).show()
        } else if (state is RecorderState.Error) {
            showStatusBubble("Ошибка", state.message)
            Toast.makeText(service, state.message, Toast.LENGTH_SHORT).show()
            pendingRetry.schedule()
        } else if (state is RecorderState.Recording || state is RecorderState.Uploading || state is RecorderState.Idle) {
            pendingRetry.cancel()
        }
        updateScreenshotButtonVisibility()
        updateButtonStates(state)
        if (state is RecorderState.Recording) {
            showCancelButton()
        } else {
            hideCancelButton()
        }
    }

    fun start() {
        BraiCmdBus.addListener(busListener)
        config.registerChangeListener(settingsListener)
        pendingRetry.start()
        applyIconSettings()
    }

    fun stop() {
        BraiCmdBus.removeListener(busListener)
        config.unregisterChangeListener(settingsListener)
        pendingRetry.stop()
        recording.cancelLongPress()
        hideCancelButton()
        statusBubble.hide()
        hide()
    }

    fun showScreenshotIfAllowed() {
        updateScreenshotButtonVisibility()
    }

    fun showIfAllowed() {
        inputButtonRequested = true
        if (!Settings.canDrawOverlays(service)) {
            hide()
            return
        }
        if (isShown) {
            applyIconSettings()
            updateScreenshotButtonVisibility()
            return
        }
        val view = button ?: AirButtonView(service).also {
            it.contentDescription = "Микрофон Brai Cmd"
            it.setOnTouchListener { _, event -> handleTouch(event) }
            it.setRecorderState(recording.mainButtonState(BraiCmdBus.latest))
            button = it
        }
        view.alpha = mainIconAlpha()
        val sizePx = mainButtonSizePx()
        val lp = WindowManager.LayoutParams(
            sizePx,
            sizePx,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = config.getButtonX(geometry().defaultButtonX())
            y = config.getButtonY(geometry().defaultButtonY())
        }
        params = lp
        windowManager.addView(view, lp)
        isShown = true
        updateScreenshotButtonVisibility()
        if (BraiCmdBus.latest is RecorderState.Recording) showCancelButton()
    }

    fun hideInputButton() {
        inputButtonRequested = false
        hideInputButtonView()
        updateScreenshotButtonVisibility()
    }

    fun hide() {
        inputButtonRequested = false
        hideInputButtonView()
        hideScreenshotButton()
    }

    private fun hideInputButtonView() {
        if (!isShown) {
            return
        }
        hideCancelButton()
        statusBubble.hide()
        button?.let { runCatching { windowManager.removeView(it) } }
        isShown = false
        params = null
    }

    private fun handleTouch(event: MotionEvent): Boolean {
        val lp = params ?: return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downRawX = event.rawX
                downRawY = event.rawY
                downX = lp.x
                downY = lp.y
                dragging = false
                longPressTriggered = false
                recording.scheduleLongPress()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = (event.rawX - downRawX).toInt()
                val dy = (event.rawY - downRawY).toInt()
                if (!dragging && (abs(dx) > touchSlop || abs(dy) > touchSlop)) dragging = true
                if (dragging) {
                    recording.cancelLongPress()
                    lp.x = downX + dx
                    lp.y = downY + dy
                    windowManager.updateViewLayout(button, lp)
                    updateScreenshotButtonPosition()
                    updateCancelButtonPosition()
                    statusBubble.update(lp)
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                recording.cancelLongPress()
                if (dragging) {
                    config.saveButtonPosition(lp.x, lp.y)
                } else if (longPressTriggered) {
                    Unit
                } else {
                    recording.toggle(useScreenshot = false)
                }
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                recording.cancelLongPress()
                return true
            }
        }
        return true
    }

    private fun handleScreenshotTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downRawX = event.rawX
                downRawY = event.rawY
                downX = currentButtonX()
                downY = currentButtonY()
                dragButtonX = downX
                dragButtonY = downY
                dragging = false
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = (event.rawX - downRawX).toInt()
                val dy = (event.rawY - downRawY).toInt()
                if (!dragging && (abs(dx) > touchSlop || abs(dy) > touchSlop)) dragging = true
                if (dragging) {
                    dragButtonX = downX + dx
                    dragButtonY = downY + dy
                    moveButtonAnchor(dragButtonX, dragButtonY)
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                if (dragging) {
                    config.saveButtonPosition(dragButtonX, dragButtonY)
                } else {
                    handleScreenshotButtonClick()
                }
                return true
            }
            MotionEvent.ACTION_CANCEL -> return true
        }
        return true
    }

    private fun handleScreenshotButtonClick() {
        if (!contextButtonAllowed()) {
            hideScreenshotButton()
            return
        }
        recording.toggle(useScreenshot = true)
    }

    private fun updateScreenshotButtonVisibility() {
        if (!Settings.canDrawOverlays(service) || !contextButtonAllowed()) {
            hideScreenshotButton()
            return
        }
        val buttonX = currentButtonX()
        val buttonY = currentButtonY()
        val view = screenshotButton ?: ScreenshotButtonView(service).also {
            it.contentDescription = "Отправить контекст Brai Cmd"
            it.setOnTouchListener { _, event -> handleScreenshotTouch(event) }
            it.setRecorderState(recording.screenshotButtonState(BraiCmdBus.latest))
            screenshotButton = it
        }
        view.alpha = screenshotIconAlpha()

        if (screenshotShown) {
            applyIconSettings()
            updateScreenshotButtonPosition()
            return
        }

        val screenshotButtonSizePx = screenshotButtonSizePx()
        val geometry = geometry()
        val lp = WindowManager.LayoutParams(
            screenshotButtonSizePx,
            screenshotButtonSizePx,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = geometry.screenshotButtonX(buttonX)
            y = geometry.screenshotButtonY(buttonY)
        }

        screenshotParams = lp
        runCatching { windowManager.addView(view, lp) }
            .onSuccess { screenshotShown = true }
            .onFailure { screenshotParams = null }
    }

    private fun hideScreenshotButton() {
        val view = screenshotButton ?: return
        if (screenshotShown) runCatching { windowManager.removeView(view) }
        screenshotShown = false
        screenshotParams = null
    }

    private fun updateScreenshotButtonPosition() {
        if (!screenshotShown) return
        val view = screenshotButton ?: return
        val lp = screenshotParams ?: return
        val geometry = geometry()
        lp.x = geometry.screenshotButtonX(currentButtonX())
        lp.y = geometry.screenshotButtonY(currentButtonY())
        runCatching { windowManager.updateViewLayout(view, lp) }
    }

    private fun applyIconSettings() {
        button?.alpha = mainIconAlpha()
        screenshotButton?.alpha = screenshotIconAlpha()

        params?.let { lp ->
            val sizePx = mainButtonSizePx()
            if (lp.width != sizePx || lp.height != sizePx) {
                lp.x += (lp.width - sizePx) / 2
                lp.y += (lp.height - sizePx) / 2
                lp.width = sizePx
                lp.height = sizePx
                config.saveButtonPosition(lp.x, lp.y)
                button?.let { if (isShown) runCatching { windowManager.updateViewLayout(it, lp) } }
                statusBubble.update(lp)
            }
        }

        screenshotParams?.let { lp ->
            val sizePx = screenshotButtonSizePx()
            val oldWidth = lp.width
            val oldHeight = lp.height
            lp.width = sizePx
            lp.height = sizePx
            lp.x += (oldWidth - sizePx) / 2
            lp.y += (oldHeight - sizePx) / 2
            screenshotButton?.let { if (screenshotShown) runCatching { windowManager.updateViewLayout(it, lp) } }
        }

        updateCancelButtonPosition()
    }

    private fun updateButtonStates(state: RecorderState) {
        button?.setRecorderState(recording.mainButtonState(state))
        screenshotButton?.setRecorderState(recording.screenshotButtonState(state))
        recording.onStateChanged(state)
    }

    private fun hideForScreenshot() {
        hideInputButtonView()
        hideScreenshotButton()
    }

    private fun restoreAfterScreenshot() {
        if (inputButtonRequested) {
            showIfAllowed()
        } else {
            showScreenshotIfAllowed()
        }
    }

    private fun showCancelButton() {
        val anchor = cancelAnchor()
        val view = cancelButton ?: CancelButtonView(service).also {
            it.contentDescription = "Отменить запись Brai Cmd"
            it.setOnClickListener { recording.cancelActiveRecording() }
            cancelButton = it
        }

        if (cancelShown) {
            updateCancelButtonPosition()
            return
        }

        val lp = WindowManager.LayoutParams(
            cancelSizePx,
            cancelSizePx,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = geometry().cancelX(anchor)
            y = geometry().cancelY(anchor)
        }

        cancelParams = lp
        runCatching { windowManager.addView(view, lp) }
            .onSuccess { cancelShown = true }
            .onFailure { cancelParams = null }
    }

    private fun hideCancelButton() {
        val view = cancelButton ?: return
        if (cancelShown) runCatching { windowManager.removeView(view) }
        cancelShown = false
        cancelParams = null
    }

    private fun updateCancelButtonPosition() {
        if (!cancelShown) return
        val view = cancelButton ?: return
        val lp = cancelParams ?: return
        val anchor = cancelAnchor()
        lp.x = geometry().cancelX(anchor)
        lp.y = geometry().cancelY(anchor)
        runCatching { windowManager.updateViewLayout(view, lp) }
    }

    private fun showFallbackBubble(state: RecorderState.TranscriptReady) {
        val subtitle = when {
            state.provider == "groq" && state.model.contains("turbo", ignoreCase = true) -> "Использован Groq Turbo"
            state.provider == "openai" -> "Использован OpenAI"
            else -> "Использована запасная"
        }
        showStatusBubble("Основная модель не ответила", subtitle)
    }

    private fun showStatusBubble(title: String, subtitle: String) {
        statusAnchorParams()?.let { statusBubble.show(title, subtitle, it) }
    }

    private fun statusAnchorParams(): WindowManager.LayoutParams? =
        if (recording.activeButton == RecordingButton.Screenshot) screenshotParams ?: params else params ?: screenshotParams

    private fun currentButtonX(): Int =
        params?.x ?: config.getButtonX(geometry().defaultButtonX())

    private fun currentButtonY(): Int =
        params?.y ?: config.getButtonY(geometry().defaultButtonY())

    private fun moveButtonAnchor(x: Int, y: Int) {
        params?.let { lp ->
            lp.x = x
            lp.y = y
            button?.let { runCatching { windowManager.updateViewLayout(it, lp) } }
        }
        screenshotParams?.let { lp ->
            val geometry = geometry()
            lp.x = geometry.screenshotButtonX(x)
            lp.y = geometry.screenshotButtonY(y)
            screenshotButton?.let { runCatching { windowManager.updateViewLayout(it, lp) } }
        }
        updateCancelButtonPosition()
        statusBubble.update(params)
    }

    private fun cancelAnchor(): OverlayAnchor =
        when (recording.activeButton) {
            RecordingButton.Screenshot -> screenshotButtonAnchor()
            RecordingButton.Main -> mainButtonAnchor()
            null -> mainButtonAnchor()
        }

    private fun mainButtonAnchor(): OverlayAnchor =
        OverlayAnchor(
            x = params?.x ?: currentButtonX(),
            y = params?.y ?: currentButtonY(),
            size = mainButtonSizePx()
        )

    private fun screenshotButtonAnchor(): OverlayAnchor =
        OverlayAnchor(
            x = screenshotParams?.x ?: geometry().screenshotButtonX(currentButtonX()),
            y = screenshotParams?.y ?: geometry().screenshotButtonY(currentButtonY()),
            size = screenshotButtonSizePx()
        )

    private fun mainIconAlpha(): Float =
        config.mainIconOpacityPercent / 100f

    private fun screenshotIconAlpha(): Float =
        config.screenshotIconOpacityPercent / 100f

    private fun mainButtonSizePx(): Int =
        (service.dp(BASE_MAIN_BUTTON_DP) * config.mainIconSizePercent / 100f).roundToInt()

    private fun screenshotButtonSizePx(): Int =
        (service.dp(BASE_SCREENSHOT_BUTTON_DP) * config.screenshotIconSizePercent / 100f).roundToInt()

    private fun contextButtonAllowed(): Boolean =
        !config.onboardingVoiceOnly && (config.contextDeliveryMode == ContextDeliveryMode.Json ||
            (config.contextDeliveryMode == ContextDeliveryMode.Screenshot && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
        )

    private fun geometry(): OverlayGeometry =
        OverlayGeometry(service, mainButtonSizePx(), screenshotButtonSizePx(), screenshotButtonGapPx, cancelSizePx, cancelGapPx)

    private companion object {
        const val BASE_MAIN_BUTTON_DP = 62
        const val BASE_SCREENSHOT_BUTTON_DP = 46
        val overlaySettingKeys = setOf(
            AppConstants.KEY_MAIN_ICON_OPACITY_PERCENT,
            AppConstants.KEY_MAIN_ICON_SIZE_PERCENT,
            AppConstants.KEY_SCREENSHOT_ICON_OPACITY_PERCENT,
            AppConstants.KEY_SCREENSHOT_ICON_SIZE_PERCENT,
            AppConstants.KEY_HEADER_CONTEXT_ENABLED,
            AppConstants.KEY_SCREENSHOT_CONTEXT_ENABLED
        )
    }
}
