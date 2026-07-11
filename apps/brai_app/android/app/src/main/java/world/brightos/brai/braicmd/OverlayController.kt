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
import android.view.animation.PathInterpolator
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
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

    private sealed interface ContextMenuState {
        data object Closed : ContextMenuState
        data class Opening(val generation: Int) : ContextMenuState
        data object OpenIdle : ContextMenuState
        data class Active(val action: ContextMenuAction) : ContextMenuState
        data class Closing(val generation: Int) : ContextMenuState
    }

    private data class ContextLayerBounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        val width: Int get() = right - left
        val height: Int get() = bottom - top
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
    private val pendingRetry = OverlayPendingRetry(service, retryHandler, ::updateQueueIndicators)
    private val contextMenuActions = ContextMenuAction.values().toList()
    private val contextActionButtons = mutableMapOf<ContextMenuAction, ScreenshotButtonView>()
    private val contextActionPoints = mutableMapOf<ContextMenuAction, OverlayPoint>()

    private var button: AirButtonView? = null
    private var screenshotButton: ScreenshotButtonView? = null
    private var cancelButton: CancelButtonView? = null
    private var params: WindowManager.LayoutParams? = null
    private var screenshotParams: WindowManager.LayoutParams? = null
    private var cancelParams: WindowManager.LayoutParams? = null
    private var isShown = false
    private var screenshotShown = false
    private var cancelShown = false
    private var contextMenuState: ContextMenuState = ContextMenuState.Closed
    private var contextMenuGeneration = 0
    private var contextMenuAnimator: ValueAnimator? = null
    private var contextActionLayer: ContextActionLayerView? = null
    private var contextActionLayerParams: WindowManager.LayoutParams? = null
    private var contextMenuLayout: RadialMenuLayout? = null
    private var contextOriginalHub: OverlayAnchor? = null
    private var contextMenuProgress = 0f
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
    private var hubTouchHandledOnDown = false

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
                val ready = BraiCmdQueue.snapshot(service).readyToInsert
                val message = when {
                    ready.mainDictation > 0 && ready.chatReply > 0 ->
                        "Готово к вставке: диктовка — ${ready.mainDictation}, чат — ${ready.chatReply}."
                    ready.chatReply > 0 ->
                        "Готовых ответов чата: ${ready.chatReply}. Зажмите кнопку чата для вставки."
                    else ->
                        "Сохраненных текстов: ${ready.mainDictation}. Зажмите кнопку диктовки для вставки."
                }
                Toast.makeText(service, message, Toast.LENGTH_LONG).show()
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
        if (state !is RecorderState.Recording) updateQueueIndicators()
        if (shouldShowStandaloneCancel(state, recording.activeButton)) {
            showCancelButton()
        } else {
            hideCancelButton()
        }
        when {
            activeContextMenuAction() == null -> Unit
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
        updateQueueIndicators()
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
            updateQueueIndicators()
            updateScreenshotButtonVisibility()
            return
        }
        val view = button ?: AirButtonView(service).also {
            it.contentDescription = "Микрофон Brai Cmd"
            it.setOnTouchListener { _, event -> handleTouch(event) }
            it.setRecorderState(recording.mainButtonState(BraiCmdBus.latest))
            button = it
        }
        updateQueueIndicators()
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
                hubTouchHandledOnDown = when (contextMenuState) {
                    is ContextMenuState.Opening,
                    ContextMenuState.OpenIdle -> {
                        closeContextMenu(animated = true)
                        true
                    }
                    is ContextMenuState.Active -> {
                        when {
                            recording.isStartingContextAction || BraiCmdBus.latest is RecorderState.Recording -> {
                                recording.cancelActiveContextAction()
                                finishContextAction(animated = true, resetRecording = false)
                            }
                            BraiCmdBus.latest !is RecorderState.Uploading ->
                                finishContextAction(animated = true, resetRecording = true)
                        }
                        true
                    }
                    is ContextMenuState.Closing -> true
                    ContextMenuState.Closed -> false
                }
                if (hubTouchHandledOnDown) return true
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
                if (hubTouchHandledOnDown) return true
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
                if (hubTouchHandledOnDown) {
                    hubTouchHandledOnDown = false
                    return true
                }
                if (dragging) {
                    config.saveButtonPosition(dragButtonX, dragButtonY)
                } else {
                    handleScreenshotButtonClick()
                }
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                hubTouchHandledOnDown = false
                return true
            }
            MotionEvent.ACTION_OUTSIDE -> {
                closeIdleContextMenu()
                return true
            }
        }
        return true
    }

    private fun handleScreenshotButtonClick() {
        if (!contextButtonAllowed()) {
            hideScreenshotButton()
            return
        }
        if (mainRecordingBusy()) return
        if (contextMenuState == ContextMenuState.Closed) showContextMenu()
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
            it.setGlyph(ContextButtonGlyph.Logo)
            it.setMenuExpansionProgress(if (contextMenuState == ContextMenuState.Closed) 0f else 1f)
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
        if (contextMenuState != ContextMenuState.Closed) return
        val view = screenshotButton ?: return
        val lp = screenshotParams ?: return
        val geometry = geometry()
        lp.x = geometry.screenshotButtonX(currentButtonX())
        lp.y = geometry.screenshotButtonY(currentButtonY())
        runCatching { windowManager.updateViewLayout(view, lp) }
    }

    private fun showContextMenu() {
        if (!screenshotShown || !contextButtonAllowed() || contextMenuState != ContextMenuState.Closed) return
        contextActionFinishRunnable?.let(retryHandler::removeCallbacks)
        contextActionFinishRunnable = null

        val actions = enabledContextMenuActions()
        if (actions.isEmpty()) {
            hideScreenshotButton()
            return
        }
        val actionSize = contextActionButtonSizePx()
        val originalHub = screenshotButtonAnchor()
        val layout = geometry().radialMenuLayout(originalHub, actionSize, actions.size, visibleMainButtonAnchor())
        if (layout == null || layout.actions.size != actions.size) {
            Toast.makeText(service, "Недостаточно места для кнопок Brai Cmd", Toast.LENGTH_SHORT).show()
            return
        }
        val originalPoint = contextMenuHubPoint(originalHub, actionSize)
        val layerBounds = contextLayerBounds(originalHub, layout.actions, actionSize)
        val layer = ContextActionLayerView(service).apply {
            onOutsideTouch = ::closeIdleContextMenu
            onHubTouch = ::handleScreenshotTouch
            setHubBounds(
                (originalHub.x - layerBounds.left).toFloat(),
                (originalHub.y - layerBounds.top).toFloat(),
                originalHub.size.toFloat()
            )
        }

        contextActionButtons.clear()
        contextActionPoints.clear()
        actions.forEachIndexed { index, action ->
            val point = layout.actions[index]
            val view = ScreenshotButtonView(service).also {
                it.contentDescription = action.label
                it.setGlyph(action.glyph)
                it.setRecorderState(RecorderState.Idle)
                it.setOnClickListener { handleContextAction(action) }
                if (action.action == ContextButtonAction.ChatContextInbox) {
                    it.setOnLongClickListener { insertNextChatReply() }
                }
                it.isEnabled = false
                it.alpha = 0f
                it.translationX = (originalPoint.x - point.x).toFloat()
                it.translationY = (originalPoint.y - point.y).toFloat()
            }
            layer.addView(
                view,
                FrameLayout.LayoutParams(actionSize, actionSize).apply {
                    leftMargin = point.x - layerBounds.left
                    topMargin = point.y - layerBounds.top
                }
            ).apply {
                contextActionButtons[action] = view
                contextActionPoints[action] = point
            }
        }
        val layerParams = WindowManager.LayoutParams(
            layerBounds.width,
            layerBounds.height,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = layerBounds.left
            y = layerBounds.top
        }
        val generation = ++contextMenuGeneration
        val added = runCatching { windowManager.addView(layer, layerParams) }.isSuccess
        if (!added) {
            layer.removeAllViews()
            contextActionButtons.clear()
            contextActionPoints.clear()
            return
        }
        contextActionLayer = layer
        contextActionLayerParams = layerParams
        contextMenuLayout = layout
        contextOriginalHub = originalHub
        contextMenuProgress = 0f
        contextMenuState = ContextMenuState.Opening(generation)
        button?.visibility = View.INVISIBLE
        updateQueueIndicators()
        animateContextMenu(opening = true, generation = generation)
    }

    private fun closeContextMenu(animated: Boolean) {
        if (contextMenuState == ContextMenuState.Closed) return
        if (contextMenuState is ContextMenuState.Closing) {
            if (animated) return
            val generation = ++contextMenuGeneration
            contextMenuState = ContextMenuState.Closing(generation)
            contextMenuAnimator?.cancel()
            finishClosingContextMenu(generation)
            return
        }
        contextActionFinishRunnable?.let(retryHandler::removeCallbacks)
        contextActionFinishRunnable = null
        val generation = ++contextMenuGeneration
        contextMenuState = ContextMenuState.Closing(generation)
        contextActionLayer?.let { layer ->
            contextActionButtons.values.forEach { view ->
                view.isEnabled = false
                layer.setTouchable(view, false)
            }
        }
        contextMenuAnimator?.cancel()
        if (animated && contextActionLayer != null) {
            animateContextMenu(opening = false, generation = generation)
        } else {
            finishClosingContextMenu(generation)
        }
    }

    private fun animateContextMenu(opening: Boolean, generation: Int) {
        val layer = contextActionLayer ?: return finishClosingContextMenu(generation)
        val layout = contextMenuLayout ?: return finishClosingContextMenu(generation)
        val originalHub = contextOriginalHub ?: return finishClosingContextMenu(generation)
        val hubView = screenshotButton ?: return finishClosingContextMenu(generation)
        val layerParams = contextActionLayerParams ?: return finishClosingContextMenu(generation)
        val actionSize = contextActionButtonSizePx()
        val closingPoint = contextMenuHubPoint(originalHub, actionSize)
        val startProgress = contextMenuProgress
        val endHub = if (opening) layout.hub else originalHub
        val startHubTranslationX = hubView.translationX
        val startHubTranslationY = hubView.translationY
        val endHubTranslationX = (endHub.x - originalHub.x).toFloat()
        val endHubTranslationY = (endHub.y - originalHub.y).toFloat()
        val starts = contextActionButtons.mapValues { (_, view) ->
            floatArrayOf(view.translationX, view.translationY, view.alpha)
        }
        contextMenuAnimator?.cancel()
        val animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = if (opening) CONTEXT_MENU_OPEN_MS else CONTEXT_MENU_CLOSE_MS
            interpolator = CONTEXT_MOTION_INTERPOLATOR
            addUpdateListener { animation ->
                val progress = animation.animatedValue as Float
                contextMenuProgress = startProgress + ((if (opening) 1f else 0f) - startProgress) * progress
                hubView.setMenuExpansionProgress(contextMenuProgress)
                hubView.alpha = contextHubAlpha()
                hubView.translationX = startHubTranslationX + (endHubTranslationX - startHubTranslationX) * progress
                hubView.translationY = startHubTranslationY + (endHubTranslationY - startHubTranslationY) * progress
                layer.setHubBounds(
                    originalHub.x - layerParams.x + hubView.translationX,
                    originalHub.y - layerParams.y + hubView.translationY,
                    originalHub.size.toFloat()
                )
                contextActionButtons.forEach { (action, view) ->
                    val point = contextActionPoints[action] ?: return@forEach
                    val start = starts.getValue(action)
                    val endTranslationX = if (opening) 0f else (closingPoint.x - point.x).toFloat()
                    val endTranslationY = if (opening) 0f else (closingPoint.y - point.y).toFloat()
                    view.translationX = start[0] + (endTranslationX - start[0]) * progress
                    view.translationY = start[1] + (endTranslationY - start[1]) * progress
                    view.alpha = if (opening) start[2] + (1f - start[2]) * progress else start[2] * secondaryCloseAlpha(progress)
                }
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    if (generation != contextMenuGeneration) return
                    contextMenuAnimator = null
                    if (opening && contextMenuState == ContextMenuState.Opening(generation)) {
                        contextMenuState = ContextMenuState.OpenIdle
                        contextActionButtons.values.forEach { view ->
                            view.isEnabled = true
                            layer.setTouchable(view, true)
                        }
                    } else if (!opening && contextMenuState == ContextMenuState.Closing(generation)) {
                        finishClosingContextMenu(generation)
                    }
                }
            })
        }
        contextMenuAnimator = animator
        animator.start()
    }

    private fun contextLayerBounds(
        originalHub: OverlayAnchor,
        actions: List<OverlayPoint>,
        actionSize: Int
    ): ContextLayerBounds = ContextLayerBounds(
        left = minOf(actions.minOf { it.x }, originalHub.x),
        top = minOf(actions.minOf { it.y }, originalHub.y),
        right = maxOf(actions.maxOf { it.x + actionSize }, originalHub.x + originalHub.size),
        bottom = maxOf(actions.maxOf { it.y + actionSize }, originalHub.y + originalHub.size)
    )

    private fun contextMenuHubPoint(hub: OverlayAnchor, actionSize: Int): OverlayPoint =
        OverlayPoint(
            x = hub.x + (hub.size - actionSize) / 2,
            y = hub.y + (hub.size - actionSize) / 2
        )

    private fun finishClosingContextMenu(generation: Int = contextMenuGeneration) {
        if (generation != contextMenuGeneration) return
        contextMenuAnimator?.cancel()
        contextMenuAnimator = null
        contextOriginalHub?.let { original ->
            screenshotParams?.let { params ->
                params.x = original.x
                params.y = original.y
                screenshotButton?.let { view ->
                    view.translationX = 0f
                    view.translationY = 0f
                    runCatching { windowManager.updateViewLayout(view, params) }
                }
            }
        }
        contextMenuProgress = 0f
        screenshotButton?.setGlyph(ContextButtonGlyph.Logo)
        screenshotButton?.setMenuExpansionProgress(0f)
        screenshotButton?.alpha = contextHubAlpha()
        screenshotButton?.visibility = if (screenshotShown && !hiddenForScreenshot) View.VISIBLE else View.INVISIBLE
        contextActionLayer?.let { runCatching { windowManager.removeView(it) } }
        contextActionLayer?.removeAllViews()
        contextActionLayer = null
        contextActionLayerParams = null
        contextActionButtons.clear()
        contextActionPoints.clear()
        contextMenuLayout = null
        contextOriginalHub = null
        contextMenuState = ContextMenuState.Closed
        if (isShown && mainButtonShouldBeVisible()) button?.visibility = View.VISIBLE
    }

    private fun handleContextAction(action: ContextMenuAction) {
        if (mainRecordingBusy()) return
        if (contextMenuState == ContextMenuState.OpenIdle && BraiCmdBus.latest is RecorderState.Uploading) return
        when (val state = contextMenuState) {
            ContextMenuState.OpenIdle -> collapseContextMenuTo(action)
            is ContextMenuState.Active -> if (state.action != action) return
            else -> return
        }
        recording.toggleContextAction(action.action)
        if (recording.isStartingContextAction) {
            contextRecordingStartingState(action.action)?.let { startingState ->
                contextActionButtons[action]?.setRecorderState(startingState)
            }
        }
    }

    private fun collapseContextMenuTo(selected: ContextMenuAction) {
        if (contextMenuState != ContextMenuState.OpenIdle) return
        val layer = contextActionLayer ?: return
        val layout = contextMenuLayout ?: return
        val generation = ++contextMenuGeneration
        contextMenuState = ContextMenuState.Active(selected)
        button?.visibility = View.INVISIBLE
        hideCancelButton()
        val actionSize = contextActionButtonSizePx()
        val end = contextMenuHubPoint(layout.hub, actionSize)
        val collapsing = contextActionButtons.filterKeys { it != selected }
        collapsing.values.forEach { view ->
            view.isEnabled = false
            layer.setTouchable(view, false)
        }
        contextActionButtons[selected]?.let { selectedView ->
            selectedView.isEnabled = true
            layer.setTouchable(selectedView, true)
        }
        val starts = collapsing.mapValues { (_, view) ->
            floatArrayOf(view.translationX, view.translationY, view.alpha)
        }
        contextMenuAnimator?.cancel()
        contextMenuAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = CONTEXT_ACTION_COLLAPSE_MS
            interpolator = CONTEXT_MOTION_INTERPOLATOR
            addUpdateListener { animation ->
                val progress = animation.animatedValue as Float
                collapsing.forEach { (action, view) ->
                    val point = contextActionPoints[action] ?: return@forEach
                    val start = starts.getValue(action)
                    val endX = (end.x - point.x).toFloat()
                    val endY = (end.y - point.y).toFloat()
                    view.translationX = start[0] + (endX - start[0]) * progress
                    view.translationY = start[1] + (endY - start[1]) * progress
                    view.alpha = start[2] * secondaryCloseAlpha(progress)
                }
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    if (generation != contextMenuGeneration || contextMenuState != ContextMenuState.Active(selected)) return
                    contextMenuAnimator = null
                    collapsing.values.forEach { it.visibility = View.GONE }
                }
            })
        }.also { it.start() }
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
        closeContextMenu(animated)
        if (resetRecording) recording.completeContextAction()
    }

    private fun insertNextChatReply(): Boolean {
        if (contextMenuState != ContextMenuState.OpenIdle) return false
        val inserted = service.insertNextPendingTranscriptIntoFocusedField(
            showToast = true,
            kind = PendingTranscriptKind.ChatReply
        )
        if (inserted) {
            Haptics.transcriptionReady(service)
        } else {
            Toast.makeText(service, "Нет готового ответа чата для вставки", Toast.LENGTH_SHORT).show()
        }
        updateQueueIndicators()
        return true
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

        screenshotParams?.takeIf { contextMenuState == ContextMenuState.Closed }?.let { lp ->
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
        screenshotButton?.setRecorderState(RecorderState.Idle)
        screenshotButton?.setGlyph(ContextButtonGlyph.Logo)
        screenshotButton?.setMenuExpansionProgress(contextMenuProgress)
        screenshotButton?.alpha = contextHubAlpha()
        contextActionButtons.forEach { (menuAction, view) ->
            view.setRecorderState(recording.contextButtonState(menuAction.action, state))
            view.isEnabled = !(state is RecorderState.Uploading && recording.activeContextAction == menuAction.action)
        }
    }

    private fun updateQueueIndicators(snapshot: BraiCmdQueueSnapshot = BraiCmdQueue.snapshot(service)) {
        val mainReady = snapshot.readyToInsert.mainDictation
        button?.setQueueState(
            failedCount = snapshot.failedTransport.main + snapshot.failedTransport.unknown,
            readyCount = mainReady
        )
        contextActionButtons.forEach { (menuAction, view) ->
            val chatReady = if (menuAction.action == ContextButtonAction.ChatContextInbox) {
                snapshot.readyToInsert.chatReply
            } else {
                0
            }
            view.setQueueState(
                failedCount = snapshot.failedTransport[menuAction.action],
                readyCount = chatReady
            )
        }
    }

    private fun hideForScreenshot() {
        hiddenForScreenshot = true
        statusBubble.hide()
        button?.visibility = View.INVISIBLE
        screenshotButton?.visibility = View.INVISIBLE
        cancelButton?.visibility = View.INVISIBLE
        contextActionLayer?.visibility = View.INVISIBLE
    }

    private fun restoreAfterScreenshot() {
        if (!hiddenForScreenshot) return
        hiddenForScreenshot = false
        button?.visibility = if (isShown && mainButtonShouldBeVisible()) View.VISIBLE else View.INVISIBLE
        screenshotButton?.visibility = if (screenshotShown) View.VISIBLE else View.INVISIBLE
        cancelButton?.visibility = if (cancelShown) View.VISIBLE else View.INVISIBLE
        contextActionLayer?.visibility = if (screenshotShown) View.VISIBLE else View.INVISIBLE
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

    private fun visibleMainButtonAnchor(): OverlayAnchor? =
        mainButtonAnchor().takeIf { isShown && button?.visibility == View.VISIBLE }

    private fun screenshotButtonAnchor(): OverlayAnchor =
        contextMenuLayout?.hub ?: OverlayAnchor(
            x = screenshotParams?.x ?: geometry().screenshotButtonX(currentButtonX()),
            y = screenshotParams?.y ?: geometry().screenshotButtonY(currentButtonY()),
            size = screenshotButtonSizePx()
        )

    private fun mainIconAlpha(): Float =
        config.mainIconOpacityPercent / 100f

    private fun screenshotIconAlpha(): Float =
        config.screenshotIconOpacityPercent / 100f

    private fun contextHubAlpha(): Float =
        screenshotIconAlpha() + (CONTEXT_MENU_HUB_ALPHA - screenshotIconAlpha()) * contextMenuProgress

    private fun mainButtonShouldBeVisible(): Boolean =
        contextMenuState == ContextMenuState.Closed && !hiddenForScreenshot

    fun onExternalInteraction(packageName: String?) {
        if (packageName == service.packageName) return
        closeIdleContextMenu()
    }

    private fun closeIdleContextMenu() {
        if (contextMenuState is ContextMenuState.Opening || contextMenuState == ContextMenuState.OpenIdle) {
            closeContextMenu(animated = true)
        }
    }

    private fun activeContextMenuAction(): ContextMenuAction? =
        (contextMenuState as? ContextMenuState.Active)?.action

    private fun mainRecordingBusy(): Boolean =
        recording.activeButton == RecordingButton.Main &&
            (recording.isStartingRecording ||
                BraiCmdBus.latest is RecorderState.Recording ||
                BraiCmdBus.latest is RecorderState.Uploading)

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
        val CONTEXT_MOTION_INTERPOLATOR = PathInterpolator(0.2f, 0f, 0f, 1f)
        const val CONTEXT_MENU_OPEN_MS = 240L
        const val CONTEXT_MENU_CLOSE_MS = 220L
        const val CONTEXT_ACTION_COLLAPSE_MS = 220L
        const val CONTEXT_ACTION_SUCCESS_MS = 1000L
        const val CONTEXT_ACTION_TERMINAL_MS = 800L
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

internal fun secondaryCloseAlpha(progress: Float): Float =
    1f - progress.coerceIn(0f, 1f)
