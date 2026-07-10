package world.brightos.brai.braicmd

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.content.SharedPreferences
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.WindowManager
import android.widget.Toast
import world.brightos.brai.capabilities.BraiAccessibilityService
import kotlin.math.abs
import kotlin.math.roundToInt

class OverlayController(private val service: BraiAccessibilityService) {
    private enum class ContextMenuAction(
        val glyph: ContextButtonGlyph,
        val label: String,
        val action: ContextButtonAction
    ) {
        IdeaVoice(ContextButtonGlyph.Idea, "Идея голосом во входящие", ContextButtonAction.IdeaVoiceInbox),
        ScreenshotOnly(ContextButtonGlyph.Image, "Скриншот во входящие", ContextButtonAction.ScreenshotInbox),
        ScreenshotVoice(ContextButtonGlyph.ImageMic, "Скриншот и голос во входящие", ContextButtonAction.ScreenshotVoiceInbox),
        ChatJsonVoice(ContextButtonGlyph.Chat, "JSON чата и голос во входящие", ContextButtonAction.ChatContextInbox),
        SaveJsonVoice(ContextButtonGlyph.Save, "Сохранить JSON и голос во входящие", ContextButtonAction.SaveContextInbox)
    }

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
            if (key in contextActionSettingKeys) closeContextMenu(animated = false)
            if (key == AppConstants.KEY_OVERLAY_ENABLED && !config.overlayEnabled) {
                hideInputButtonView()
                hideScreenshotButton()
                return@OnSharedPreferenceChangeListener
            }
            if (key == AppConstants.KEY_AUTH_TOKEN && config.authToken.isBlank()) {
                hideScreenshotButton()
                return@OnSharedPreferenceChangeListener
            }
            applyIconSettings()
            if (key == AppConstants.KEY_OVERLAY_ENABLED && inputButtonRequested) showIfAllowed()
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
    private val contextMenuActions = ContextMenuAction.values().toList()
    private val contextActionButtons = mutableMapOf<ContextMenuAction, ScreenshotButtonView>()
    private val contextActionParams = mutableMapOf<ContextMenuAction, WindowManager.LayoutParams>()
    private val contextActionAnimators = mutableMapOf<ContextMenuAction, ValueAnimator>()

    private var button: AirButtonView? = null
    private var screenshotButton: ScreenshotButtonView? = null
    private var cancelButton: CancelButtonView? = null
    private var params: WindowManager.LayoutParams? = null
    private var screenshotParams: WindowManager.LayoutParams? = null
    private var cancelParams: WindowManager.LayoutParams? = null
    private var isShown = false
    private var screenshotShown = false
    private var cancelShown = false
    private var contextMenuOpen = false
    private var contextMenuClosing = false
    private var selectedContextAction: ContextMenuAction? = null
    private var contextActionFinishRunnable: Runnable? = null
    private var hiddenForScreenshot = false
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
            if (state.recordings > 0 && !config.onboardingQueuePaused) pendingRetry.schedule()
        } else if (state is RecorderState.InboxDelivered) {
            pendingRetry.cancel()
            showStatusBubble("Отправлено", "Во входящие")
            Toast.makeText(service, "Отправлено во входящие", Toast.LENGTH_SHORT).show()
        } else if (state is RecorderState.Error) {
            showStatusBubble("Ошибка", state.message)
            Toast.makeText(service, state.message, Toast.LENGTH_SHORT).show()
            pendingRetry.schedule()
        } else if (state is RecorderState.Recording || state is RecorderState.Uploading || state is RecorderState.Idle) {
            pendingRetry.cancel()
        }
        updateScreenshotButtonVisibility()
        updateButtonStates(state)
        if (shouldShowStandaloneCancel(state, recording.activeButton)) {
            showCancelButton()
        } else {
            hideCancelButton()
        }
        when {
            selectedContextAction == null -> Unit
            state is RecorderState.InboxDelivered -> scheduleContextActionFinish(CONTEXT_ACTION_SUCCESS_MS)
            state is RecorderState.Pending || state is RecorderState.Error -> scheduleContextActionFinish(CONTEXT_ACTION_TERMINAL_MS)
            state is RecorderState.Idle -> finishContextAction(animated = true, resetRecording = false)
        }
        recording.onStateChanged(state)
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
        if (!config.overlayEnabled || !Settings.canDrawOverlays(service)) {
            hideInputButtonView()
            hideScreenshotButton()
            return
        }
        if (isShown) {
            button?.visibility = if (mainButtonShouldBeVisible()) View.VISIBLE else View.INVISIBLE
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
        view.visibility = if (mainButtonShouldBeVisible()) View.VISIBLE else View.INVISIBLE
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
                    closeContextMenu(animated = false)
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
                    closeContextMenu(animated = false)
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
        if (mainRecordingBusy()) return
        if (selectedContextAction != null) {
            if (recording.isStartingContextAction || BraiCmdBus.latest is RecorderState.Recording) {
                recording.cancelActiveContextAction()
            } else if (BraiCmdBus.latest !is RecorderState.Uploading) {
                finishContextAction(animated = true, resetRecording = true)
            }
            return
        }
        if (contextMenuOpen) {
            closeContextMenu(animated = true)
        } else {
            showContextMenu()
        }
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
            it.setRecorderState(RecorderState.Idle)
            it.setGlyph(if (contextMenuOpen) ContextButtonGlyph.Close else ContextButtonGlyph.Logo)
            screenshotButton = it
        }
        view.alpha = contextHubAlpha()

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
        closeContextMenu(animated = false)
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
        updateContextMenuPosition()
    }

    private fun showContextMenu() {
        if (!screenshotShown || !contextButtonAllowed()) return
        contextActionFinishRunnable?.let(retryHandler::removeCallbacks)
        contextActionFinishRunnable = null
        selectedContextAction = null
        contextActionAnimators.values.toList().forEach { it.cancel() }
        contextActionAnimators.clear()
        contextActionButtons.values.forEach { runCatching { windowManager.removeView(it) } }
        contextActionParams.clear()

        val actions = enabledContextMenuActions()
        if (actions.isEmpty()) {
            hideScreenshotButton()
            return
        }
        contextMenuOpen = true
        contextMenuClosing = false
        button?.visibility = View.INVISIBLE
        screenshotButton?.setGlyph(ContextButtonGlyph.Close)
        screenshotButton?.alpha = contextHubAlpha()

        val actionSize = contextActionButtonSizePx()
        val hub = screenshotButtonAnchor()
        val start = contextMenuHubPoint(hub, actionSize)
        val positions = geometry().radialActionPositions(
            hub = hub,
            actionSize = actionSize,
            count = actions.size
        )
        if (positions.size != actions.size) {
            contextMenuOpen = false
            finishClosingContextMenu()
            return
        }
        actions.forEachIndexed { index, action ->
            val view = contextActionButtons[action] ?: ScreenshotButtonView(service).also {
                it.contentDescription = action.label
                it.setGlyph(action.glyph)
                it.setRecorderState(RecorderState.Idle)
                it.setOnClickListener { handleContextAction(action) }
                contextActionButtons[action] = it
            }
            view.setRecorderState(RecorderState.Idle)
            view.isEnabled = true
            view.visibility = View.VISIBLE
            val lp = WindowManager.LayoutParams(
                actionSize,
                actionSize,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.TOP or Gravity.START
                x = start.x
                y = start.y
            }
            view.alpha = 0f
            view.scaleX = 0.82f
            view.scaleY = 0.82f
            runCatching { windowManager.addView(view, lp) }
                .onSuccess {
                    contextActionParams[action] = lp
                    animateContextAction(action, view, lp, start, positions[index], opening = true)
                }
        }
    }

    private fun closeContextMenu(animated: Boolean) {
        if (!contextMenuOpen && contextActionParams.isEmpty()) return
        contextActionFinishRunnable?.let(retryHandler::removeCallbacks)
        contextActionFinishRunnable = null
        selectedContextAction = null
        contextMenuOpen = false
        contextMenuClosing = animated && contextActionParams.isNotEmpty()

        val actionSize = contextActionButtonSizePx()
        val end = contextMenuHubPoint(screenshotButtonAnchor(), actionSize)
        val closing = contextActionParams.toMap()
        contextActionParams.clear()
        closing.forEach { (action, lp) ->
            val view = contextActionButtons[action] ?: return@forEach
            contextActionAnimators.remove(action)?.cancel()
            if (animated) {
                animateContextAction(action, view, lp, OverlayPoint(lp.x, lp.y), end, opening = false)
            } else {
                runCatching { windowManager.removeView(view) }
            }
        }
        if (!contextMenuClosing) finishClosingContextMenu()
    }

    private fun updateContextMenuPosition() {
        if (!contextMenuOpen) return
        val actionSize = contextActionButtonSizePx()
        val positions = geometry().radialActionPositions(
            hub = screenshotButtonAnchor(),
            actionSize = actionSize,
            count = enabledContextMenuActions().size
        )
        if (positions.size != enabledContextMenuActions().size) return
        enabledContextMenuActions().forEachIndexed { index, action ->
            val view = contextActionButtons[action] ?: return@forEachIndexed
            val lp = contextActionParams[action] ?: return@forEachIndexed
            contextActionAnimators.remove(action)?.cancel()
            lp.width = actionSize
            lp.height = actionSize
            lp.x = positions[index].x
            lp.y = positions[index].y
            runCatching { windowManager.updateViewLayout(view, lp) }
        }
    }

    private fun animateContextAction(
        action: ContextMenuAction,
        view: ScreenshotButtonView,
        lp: WindowManager.LayoutParams,
        from: OverlayPoint,
        to: OverlayPoint,
        opening: Boolean
    ) {
        contextActionAnimators.remove(action)?.cancel()
        val animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 160L
            interpolator = AccelerateDecelerateInterpolator()
            addUpdateListener { animation ->
                val progress = animation.animatedValue as Float
                lp.x = (from.x + (to.x - from.x) * progress).roundToInt()
                lp.y = (from.y + (to.y - from.y) * progress).roundToInt()
                view.alpha = if (opening) progress else 1f - progress
                val scale = if (opening) 0.82f + progress * 0.18f else 1f - progress * 0.18f
                view.scaleX = scale
                view.scaleY = scale
                runCatching { windowManager.updateViewLayout(view, lp) }
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    contextActionAnimators.remove(action)
                    if (!opening) {
                        runCatching { windowManager.removeView(view) }
                        if (!contextMenuOpen && contextActionAnimators.isEmpty()) finishClosingContextMenu()
                    }
                }
            })
        }
        contextActionAnimators[action] = animator
        animator.start()
    }

    private fun contextMenuHubPoint(hub: OverlayAnchor, actionSize: Int): OverlayPoint =
        OverlayPoint(
            x = hub.x + (hub.size - actionSize) / 2,
            y = hub.y + (hub.size - actionSize) / 2
        )

    private fun finishClosingContextMenu() {
        contextMenuClosing = false
        screenshotButton?.setGlyph(ContextButtonGlyph.Logo)
        screenshotButton?.alpha = contextHubAlpha()
        if (isShown && !hiddenForScreenshot) button?.visibility = View.VISIBLE
    }

    private fun handleContextAction(action: ContextMenuAction) {
        if (mainRecordingBusy()) return
        val selected = selectedContextAction
        if (selected != null && selected != action) return
        if (selected == null) {
            selectedContextAction = action
            collapseContextMenuTo(action)
        }
        recording.toggleContextAction(action.action)
    }

    private fun collapseContextMenuTo(selected: ContextMenuAction) {
        button?.visibility = View.INVISIBLE
        hideCancelButton()
        val actionSize = contextActionButtonSizePx()
        val end = contextMenuHubPoint(screenshotButtonAnchor(), actionSize)
        contextActionParams.toMap().forEach { (action, lp) ->
            if (action == selected) return@forEach
            val view = contextActionButtons[action] ?: return@forEach
            contextActionParams.remove(action)
            contextActionAnimators.remove(action)?.cancel()
            animateContextAction(action, view, lp, OverlayPoint(lp.x, lp.y), end, opening = false)
        }
    }

    private fun scheduleContextActionFinish(delayMs: Long) {
        contextActionFinishRunnable?.let(retryHandler::removeCallbacks)
        contextActionFinishRunnable = Runnable {
            contextActionFinishRunnable = null
            finishContextAction(animated = true, resetRecording = true)
        }.also { retryHandler.postDelayed(it, delayMs) }
    }

    private fun finishContextAction(animated: Boolean, resetRecording: Boolean) {
        contextActionFinishRunnable?.let(retryHandler::removeCallbacks)
        contextActionFinishRunnable = null
        selectedContextAction = null
        closeContextMenu(animated)
        if (resetRecording) recording.completeContextAction()
    }

    private fun applyIconSettings() {
        button?.alpha = mainIconAlpha()
        screenshotButton?.alpha = contextHubAlpha()

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

        updateContextMenuPosition()
        updateCancelButtonPosition()
    }

    private fun updateButtonStates(state: RecorderState) {
        button?.setRecorderState(recording.mainButtonState(state))
        screenshotButton?.setRecorderState(RecorderState.Idle)
        screenshotButton?.setGlyph(if (contextMenuOpen || contextMenuClosing) ContextButtonGlyph.Close else ContextButtonGlyph.Logo)
        screenshotButton?.alpha = contextHubAlpha()
        contextActionButtons.forEach { (menuAction, view) ->
            view.setRecorderState(recording.contextButtonState(menuAction.action, state))
            view.isEnabled = !(state is RecorderState.Uploading && recording.activeContextAction == menuAction.action)
        }
    }

    private fun hideForScreenshot() {
        hiddenForScreenshot = true
        statusBubble.hide()
        button?.visibility = View.INVISIBLE
        screenshotButton?.visibility = View.INVISIBLE
        cancelButton?.visibility = View.INVISIBLE
        contextActionButtons.values.forEach { it.visibility = View.INVISIBLE }
    }

    private fun restoreAfterScreenshot() {
        if (!hiddenForScreenshot) return
        hiddenForScreenshot = false
        button?.visibility = if (isShown && mainButtonShouldBeVisible()) View.VISIBLE else View.INVISIBLE
        screenshotButton?.visibility = if (screenshotShown) View.VISIBLE else View.INVISIBLE
        cancelButton?.visibility = if (cancelShown) View.VISIBLE else View.INVISIBLE
        contextActionButtons.forEach { (action, view) ->
            view.visibility = if (contextActionParams.containsKey(action)) View.VISIBLE else View.INVISIBLE
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
        if (recording.activeButton == RecordingButton.Context) screenshotParams ?: params else params ?: screenshotParams

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
        updateContextMenuPosition()
        updateCancelButtonPosition()
        statusBubble.update(params)
    }

    private fun cancelAnchor(): OverlayAnchor =
        when (recording.activeButton) {
            RecordingButton.Context -> screenshotButtonAnchor()
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

    private fun contextHubAlpha(): Float =
        if (contextMenuOpen || contextMenuClosing) CONTEXT_MENU_HUB_ALPHA else screenshotIconAlpha()

    private fun mainButtonShouldBeVisible(): Boolean =
        !contextMenuOpen && !contextMenuClosing && !hiddenForScreenshot

    private fun mainRecordingBusy(): Boolean =
        recording.activeButton == RecordingButton.Main &&
            (BraiCmdBus.latest is RecorderState.Recording || BraiCmdBus.latest is RecorderState.Uploading)

    private fun mainButtonSizePx(): Int =
        (service.dp(BASE_MAIN_BUTTON_DP) * config.mainIconSizePercent / 100f).roundToInt()

    private fun screenshotButtonSizePx(): Int =
        (service.dp(BASE_SCREENSHOT_BUTTON_DP) * config.screenshotIconSizePercent / 100f).roundToInt()

    private fun contextActionButtonSizePx(): Int =
        (screenshotButtonSizePx() * CONTEXT_ACTION_BUTTON_SCALE).roundToInt().coerceAtLeast(service.dp(28))

    private fun contextButtonAllowed(): Boolean =
        config.overlayEnabled && config.authToken.isNotBlank() && !config.onboardingVoiceOnly && enabledContextMenuActions().isNotEmpty()

    private fun enabledContextMenuActions(): List<ContextMenuAction> =
        contextMenuActions.filter { action ->
            when (action.action) {
                ContextButtonAction.IdeaVoiceInbox -> config.contextActionIdeaEnabled
                ContextButtonAction.ScreenshotInbox -> config.contextActionScreenshotEnabled
                ContextButtonAction.ScreenshotVoiceInbox -> config.contextActionScreenshotVoiceEnabled
                ContextButtonAction.ChatContextInbox -> config.contextActionChatEnabled
                ContextButtonAction.SaveContextInbox -> config.contextActionSaveEnabled
            }
        }

    private fun geometry(): OverlayGeometry =
        OverlayGeometry(service, mainButtonSizePx(), screenshotButtonSizePx(), screenshotButtonGapPx, cancelSizePx, cancelGapPx)

    private companion object {
        const val BASE_MAIN_BUTTON_DP = 62
        const val BASE_SCREENSHOT_BUTTON_DP = 46
        const val CONTEXT_MENU_HUB_ALPHA = 0.30f
        const val CONTEXT_ACTION_BUTTON_SCALE = 0.80f
        const val CONTEXT_ACTION_SUCCESS_MS = 760L
        const val CONTEXT_ACTION_TERMINAL_MS = 1_100L
        val contextActionSettingKeys = setOf(
            AppConstants.KEY_CONTEXT_ACTION_IDEA_ENABLED,
            AppConstants.KEY_CONTEXT_ACTION_SCREENSHOT_ENABLED,
            AppConstants.KEY_CONTEXT_ACTION_SCREENSHOT_VOICE_ENABLED,
            AppConstants.KEY_CONTEXT_ACTION_CHAT_ENABLED,
            AppConstants.KEY_CONTEXT_ACTION_SAVE_ENABLED
        )
        val overlaySettingKeys = setOf(
            AppConstants.KEY_MAIN_ICON_OPACITY_PERCENT,
            AppConstants.KEY_MAIN_ICON_SIZE_PERCENT,
            AppConstants.KEY_SCREENSHOT_ICON_OPACITY_PERCENT,
            AppConstants.KEY_SCREENSHOT_ICON_SIZE_PERCENT,
            AppConstants.KEY_AUTH_TOKEN,
            AppConstants.KEY_OVERLAY_ENABLED,
            AppConstants.KEY_ONBOARDING_VOICE_ONLY
        ) + contextActionSettingKeys
    }
}
