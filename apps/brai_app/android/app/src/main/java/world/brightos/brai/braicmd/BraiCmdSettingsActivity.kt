package world.brightos.brai.braicmd

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.accessibility.AccessibilityManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import world.brightos.brai.capabilities.BraiAccessibilityService

class BraiCmdSettingsActivity : Activity() {
    private lateinit var ui: MainUi
    private lateinit var config: ConfigStore
    private lateinit var overallStatus: TextView
    private lateinit var accessibilityRow: StatusRow
    private lateinit var overlayRow: StatusRow
    private lateinit var micRow: StatusRow
    private lateinit var notificationRow: StatusRow
    private lateinit var testButton: Button
    private lateinit var testStatus: TextView
    private lateinit var postProcessingSwitch: Switch
    private lateinit var postProcessingPromptInput: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ui = MainUi(this)
        ui.applyDarkSystemBars()
        config = ConfigStore(this)
        buildUi()
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshStatus()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(COLOR_BACKGROUND)
            setPadding(ui.dp(20), ui.dp(24), ui.dp(20), ui.dp(30))
        }

        root.addView(TextView(this).apply {
            text = "Brai Cmd"
            textSize = 28f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_TEXT)
        })
        root.addView(TextView(this).apply {
            text = "Команды поверх приложений"
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_ACCENT_TEXT)
            setPadding(0, ui.dp(3), 0, ui.dp(4))
        })
        root.addView(TextView(this).apply {
            text = "Диктовка, контекст экрана и отправка команд."
            textSize = 14f
            setTextColor(COLOR_MUTED)
            setPadding(0, 0, 0, ui.dp(12))
        })

        overallStatus = ui.statusBlock()
        root.addView(overallStatus, ui.matchWrap().apply { setMargins(0, 0, 0, ui.dp(12)) })

        root.addView(ui.sectionTitle("1. Разрешения"))
        accessibilityRow = ui.permissionRow(
            root = root,
            title = "Специальные возможности",
            subtitle = "Вставка текста и чтение имени чата.",
            actionText = "Открыть"
        ) {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        overlayRow = ui.permissionRow(
            root = root,
            title = "Поверх приложений",
            subtitle = "Плавающая кнопка микрофона.",
            actionText = "Разрешить"
        ) {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }
        micRow = ui.permissionRow(
            root = root,
            title = "Микрофон",
            subtitle = "Запись коротких голосовых фрагментов.",
            actionText = "Разрешить"
        ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
        }
        notificationRow = ui.permissionRow(
            root = root,
            title = "Уведомления",
            subtitle = "Служебный статус записи и отправки.",
            actionText = "Разрешить"
        ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
        }

        root.addView(ui.sectionTitle("2. Сервер"))
        addConnectionCard(root)

        root.addView(ui.sectionTitle("3. Контекст"))
        addContextCard(root)

        root.addView(ui.sectionTitle("4. Настройки"))
        addSettingsCard(root)

        root.addView(ui.sectionTitle("5. Пост-обработка"))
        addPostProcessingCard(root)

        val scrollView = ScrollView(this).apply {
            setBackgroundColor(COLOR_BACKGROUND)
            clipToPadding = false
            isFillViewport = true
            addView(root)
        }
        ui.applyScreenEdgePadding(scrollView)
        setContentView(scrollView)
        refreshStatus()
    }

    private fun addConnectionCard(root: LinearLayout) {
        val card = ui.panel()
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        top.addView(TextView(this).apply {
            text = "Проверка связи"
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_TEXT)
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        testButton = ui.actionButton("Проверить") { testServer() }
        top.addView(testButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, ui.dp(42)))
        card.addView(top)

        testStatus = TextView(this).apply {
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_INFO)
            setLineSpacing(ui.dp(2).toFloat(), 1.0f)
            setPadding(ui.dp(10), ui.dp(9), ui.dp(10), ui.dp(9))
            background = ui.roundedBackground(COLOR_INFO_BADGE)
            text = "Сначала включите все разрешения"
        }
        card.addView(testStatus, ui.matchWrap().apply { setMargins(0, ui.dp(10), 0, 0) })
        root.addView(card, ui.matchWrap())
    }

    private fun addPostProcessingCard(root: LinearLayout) {
        val card = ui.panel()
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val textColumn = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        textColumn.addView(TextView(this).apply {
            text = "Кастомный промт"
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_TEXT)
        })
        textColumn.addView(TextView(this).apply {
            text = "Groq GPT-OSS 20B после расшифровки"
            textSize = 13f
            setTextColor(COLOR_MUTED)
            setPadding(0, ui.dp(2), 0, 0)
        })
        row.addView(textColumn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        postProcessingSwitch = Switch(this).apply {
            isChecked = config.postProcessingEnabled
            setOnCheckedChangeListener { _, checked ->
                config.postProcessingEnabled = checked
                refreshPostProcessingUi()
            }
        }
        row.addView(postProcessingSwitch)
        card.addView(row)

        postProcessingPromptInput = EditText(this).apply {
            setText(config.postProcessingPrompt)
            minLines = 4
            maxLines = 8
            gravity = Gravity.TOP or Gravity.START
            textSize = 14f
            setTextColor(COLOR_TEXT)
            setHintTextColor(COLOR_MUTED)
            setPadding(ui.dp(12), ui.dp(10), ui.dp(12), ui.dp(10))
            background = ui.roundedBackground(COLOR_INPUT, COLOR_BORDER)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            filters = arrayOf(InputFilter.LengthFilter(MAX_POST_PROCESSING_PROMPT_CHARS))
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit

                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    config.postProcessingPrompt = s?.toString().orEmpty()
                }

                override fun afterTextChanged(s: Editable?) = Unit
            })
        }
        card.addView(postProcessingPromptInput, ui.matchWrap().apply { setMargins(0, ui.dp(12), 0, 0) })
        root.addView(card, ui.matchWrap())
        refreshPostProcessingUi()
    }

    private fun addContextCard(root: LinearLayout) {
        val card = ui.panel()
        card.addView(TextView(this).apply {
            text = "Отправлять во входящие"
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_TEXT)
        })
        card.addView(TextView(this).apply {
            text = "Показывать дополнительные кнопки контекста."
            textSize = 13f
            setTextColor(COLOR_MUTED)
            setPadding(0, ui.dp(2), 0, ui.dp(8))
        })
        card.addView(contextSwitchRow(
            title = "Идея голосом",
            subtitle = "Голосовая заметка без снимка экрана.",
            checked = config.contextActionIdeaEnabled
        ) { config.contextActionIdeaEnabled = it })
        card.addView(contextSwitchRow(
            title = "Скриншот",
            subtitle = "Картинка текущего экрана.",
            checked = config.contextActionScreenshotEnabled
        ) { config.contextActionScreenshotEnabled = it })
        card.addView(contextSwitchRow(
            title = "Скриншот + голос",
            subtitle = "Снимок экрана с голосовой командой.",
            checked = config.contextActionScreenshotVoiceEnabled
        ) { config.contextActionScreenshotVoiceEnabled = it })
        card.addView(contextSwitchRow(
            title = "Контекст чата",
            subtitle = "Видимый текст и структура текущего чата.",
            checked = config.contextActionChatEnabled
        ) { config.contextActionChatEnabled = it })
        card.addView(contextSwitchRow(
            title = "Сохранить контекст",
            subtitle = "Отдельная отправка текущего контекста.",
            checked = config.contextActionSaveEnabled
        ) { config.contextActionSaveEnabled = it })
        root.addView(card, ui.matchWrap())
    }

    private fun contextSwitchRow(title: String, subtitle: String, checked: Boolean, onChecked: (Boolean) -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, ui.dp(6), 0, ui.dp(6))

            val textColumn = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
            }
            textColumn.addView(TextView(context).apply {
                text = title
                textSize = 14f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(COLOR_TEXT)
            })
            textColumn.addView(TextView(context).apply {
                text = subtitle
                textSize = 13f
                setTextColor(COLOR_MUTED)
                setPadding(0, ui.dp(2), ui.dp(10), 0)
            })
            addView(textColumn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(Switch(context).apply {
                isChecked = checked
                setOnCheckedChangeListener { _, value -> onChecked(value) }
            })
        }

    private fun addSettingsCard(root: LinearLayout) {
        val card = ui.panel()
        card.addView(ui.settingsSliderRow(
            title = "Основная иконка: непрозрачность",
            subtitle = "Кнопка Brai Cmd у поля ввода.",
            value = config.mainIconOpacityPercent,
            min = AppConstants.MIN_ICON_OPACITY_PERCENT,
            max = AppConstants.MAX_ICON_OPACITY_PERCENT
        ) { value ->
            config.mainIconOpacityPercent = value
        })
        card.addView(ui.settingsSliderRow(
            title = "Основная иконка: размер",
            subtitle = "100% - текущий размер и середина ползунка.",
            value = config.mainIconSizePercent,
            min = AppConstants.MIN_ICON_SIZE_PERCENT,
            max = AppConstants.MAX_ICON_SIZE_PERCENT
        ) { value ->
            config.mainIconSizePercent = value
        }, ui.matchWrap().apply { setMargins(0, ui.dp(12), 0, 0) })
        card.addView(ui.settingsSliderRow(
            title = "Контекст: непрозрачность",
            subtitle = "Кнопка отправки во входящие.",
            value = config.screenshotIconOpacityPercent,
            min = AppConstants.MIN_ICON_OPACITY_PERCENT,
            max = AppConstants.MAX_ICON_OPACITY_PERCENT
        ) { value ->
            config.screenshotIconOpacityPercent = value
        }, ui.matchWrap().apply { setMargins(0, ui.dp(12), 0, 0) })
        card.addView(ui.settingsSliderRow(
            title = "Контекст: размер",
            subtitle = "100% - текущий размер и середина ползунка.",
            value = config.screenshotIconSizePercent,
            min = AppConstants.MIN_ICON_SIZE_PERCENT,
            max = AppConstants.MAX_ICON_SIZE_PERCENT
        ) { value ->
            config.screenshotIconSizePercent = value
        }, ui.matchWrap().apply { setMargins(0, ui.dp(12), 0, 0) })
        root.addView(card, ui.matchWrap())
    }

    private fun refreshPostProcessingUi() {
        if (!this::postProcessingSwitch.isInitialized || !this::postProcessingPromptInput.isInitialized) return
        val enabled = postProcessingSwitch.isChecked
        postProcessingPromptInput.isEnabled = enabled
        postProcessingPromptInput.alpha = if (enabled) 1f else 0.55f
    }

    private fun testServer() {
        testButton.isEnabled = false
        testButton.alpha = 0.65f
        updateConnectionStatus("Проверка подключения...", COLOR_INFO_BADGE, COLOR_INFO)
        Thread {
            val result = runCatching { NetworkClient(this).publicHealthCheck() }
            runOnUiThread {
                result.fold(
                    onSuccess = {
                        updateConnectionStatus(if (it == "ok") "Сервер работает" else "Сервер работает: $it", COLOR_OK_BADGE, COLOR_OK)
                    },
                    onFailure = {
                        updateConnectionStatus("Сервер не отвечает\n${it.message}", COLOR_BAD_BADGE, COLOR_BAD)
                    }
                )
                refreshStatus()
            }
        }.start()
    }

    private fun refreshStatus() {
        val accessibilityOk = isAccessibilityEnabled()
        val overlayOk = Settings.canDrawOverlays(this)
        val micOk = hasPermission(Manifest.permission.RECORD_AUDIO)
        val notificationsOk = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasPermission(Manifest.permission.POST_NOTIFICATIONS)
        val permissionsOk = accessibilityOk && overlayOk && micOk && notificationsOk

        updateRequiredRow(accessibilityRow, accessibilityOk)
        updateRequiredRow(overlayRow, overlayOk)
        updateRequiredRow(micRow, micOk)
        updateRequiredRow(notificationRow, notificationsOk)

        testButton.isEnabled = permissionsOk
        testButton.alpha = if (permissionsOk) 1f else 0.45f
        if (!permissionsOk) updateConnectionStatus("Сначала включите все разрешения", COLOR_INFO_BADGE, COLOR_INFO)

        val ready = permissionsOk
        overallStatus.text = when {
            ready -> "Готово: Brai CMD настроен"
            !permissionsOk -> "Нужно включить все разрешения"
            else -> "Проверьте настройки Brai CMD"
        }
        overallStatus.setTextColor(if (ready) COLOR_OK else COLOR_BAD)
        overallStatus.background = ui.roundedBackground(if (ready) COLOR_OK_BADGE else COLOR_BAD_BADGE, if (ready) COLOR_OK else COLOR_BAD)
    }

    private fun updateRequiredRow(row: StatusRow, ok: Boolean) {
        row.container.background = ui.roundedBackground(if (ok) COLOR_OK_SOFT else COLOR_BAD_SOFT, if (ok) COLOR_OK_BADGE else COLOR_BAD_BADGE)
        row.status.text = if (ok) "OK" else "НУЖНО"
        row.status.setTextColor(if (ok) COLOR_OK else COLOR_BAD)
        row.status.background = ui.roundedBackground(if (ok) COLOR_OK_BADGE else COLOR_BAD_BADGE)
        row.button.isEnabled = !ok && (row !== notificationRow || Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        row.button.alpha = if (row.button.isEnabled) 1f else 0.45f
    }

    private fun updateConnectionStatus(textValue: String, backgroundColor: Int, textColor: Int) {
        testStatus.text = textValue
        testStatus.setTextColor(textColor)
        testStatus.background = ui.roundedBackground(backgroundColor)
    }

    private fun hasPermission(permission: String): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun isAccessibilityEnabled(): Boolean {
        val manager = getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        return manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any { it.resolveInfo.serviceInfo.packageName == packageName && it.resolveInfo.serviceInfo.name == BraiAccessibilityService::class.java.name }
    }

    private fun cleanError(error: Throwable): String {
        val message = error.message.orEmpty()
        return message.removePrefix("HTTP 403: ").removePrefix("HTTP 400: ").ifBlank { "Не удалось получить доступ" }
    }

    companion object {
        private const val REQ_MIC = 10
        private const val REQ_NOTIFICATIONS = 11
        private const val MAX_POST_PROCESSING_PROMPT_CHARS = 4000
    }
}
