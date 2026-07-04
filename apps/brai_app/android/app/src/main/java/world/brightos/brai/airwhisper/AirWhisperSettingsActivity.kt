package world.brightos.brai.airwhisper

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

class AirWhisperSettingsActivity : Activity() {
    private lateinit var ui: MainUi
    private lateinit var config: ConfigStore
    private lateinit var overallStatus: TextView
    private lateinit var accessibilityRow: StatusRow
    private lateinit var overlayRow: StatusRow
    private lateinit var micRow: StatusRow
    private lateinit var notificationRow: StatusRow
    private lateinit var testButton: Button
    private lateinit var testStatus: TextView
    private lateinit var accessCard: LinearLayout
    private lateinit var nameInput: EditText
    private lateinit var accessButton: Button
    private lateinit var accessStatus: TextView
    private lateinit var postProcessingSwitch: Switch
    private lateinit var postProcessingPromptInput: EditText
    private lateinit var receiverTokenButton: Button
    private lateinit var receiverUrlInput: EditText
    private lateinit var receiverTestButton: Button
    private lateinit var receiverStatusIcon: TextView
    private lateinit var receiverLogText: TextView

    private var serverOk = false
    private var screen = Screen.Main

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ui = MainUi(this)
        ui.applyDarkSystemBars()
        config = ConfigStore(this)
        buildUi()
    }

    override fun onResume() {
        super.onResume()
        if (screen == Screen.Main) refreshStatus() else refreshReceiverUi()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshStatus()
    }

    override fun onBackPressed() {
        when (screen) {
            Screen.ReceiverToken -> buildReceiverUi()
            Screen.Receiver -> buildUi()
            Screen.Main -> super.onBackPressed()
        }
    }

    private fun buildUi() {
        screen = Screen.Main
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(COLOR_BACKGROUND)
            setPadding(ui.dp(20), ui.dp(24), ui.dp(20), ui.dp(30))
        }

        root.addView(TextView(this).apply {
            text = "AirWhisper"
            textSize = 28f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_TEXT)
        })
        root.addView(TextView(this).apply {
            text = "Bright OS - операционная система жизни"
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_ACCENT_TEXT)
            setPadding(0, ui.dp(3), 0, ui.dp(4))
        })
        root.addView(TextView(this).apply {
            text = "Командный центр поверх приложений"
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

        root.addView(ui.sectionTitle("3. Доступ"))
        addAccessCard(root)

        root.addView(ui.sectionTitle("4. Контекст"))
        addContextCard(root)

        root.addView(ui.sectionTitle("5. Настройки"))
        addSettingsCard(root)

        root.addView(ui.sectionTitle("6. Пост-обработка"))
        addPostProcessingCard(root)

        root.addView(ui.actionButton("Подключить") { buildReceiverUi() }, ui.matchHeight(ui.dp(46)).apply {
            setMargins(0, ui.dp(16), 0, 0)
        })

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

    private fun addAccessCard(root: LinearLayout) {
        accessCard = ui.panel()
        accessCard.addView(TextView(this).apply {
            text = "Имя для статистики"
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_TEXT)
        })
        nameInput = EditText(this).apply {
            hint = "Ваше имя"
            setSingleLine(true)
            textSize = 16f
            setTextColor(COLOR_TEXT)
            setHintTextColor(COLOR_MUTED)
            setPadding(ui.dp(12), 0, ui.dp(12), 0)
            background = ui.roundedBackground(COLOR_INPUT, COLOR_BORDER)
            setText(config.displayName)
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = refreshStatus()
                override fun afterTextChanged(s: Editable?) = Unit
            })
        }
        accessCard.addView(nameInput, ui.matchHeight(ui.dp(46)).apply { setMargins(0, ui.dp(10), 0, ui.dp(10)) })

        accessButton = ui.actionButton("Получить доступ") { requestAccess() }
        accessCard.addView(accessButton, ui.matchHeight(ui.dp(44)))

        accessStatus = TextView(this).apply {
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(ui.dp(10), ui.dp(9), ui.dp(10), ui.dp(9))
            setLineSpacing(ui.dp(2).toFloat(), 1.0f)
            background = ui.roundedBackground(COLOR_INFO_BADGE)
            setTextColor(COLOR_INFO)
        }
        accessCard.addView(accessStatus, ui.matchWrap().apply { setMargins(0, ui.dp(10), 0, 0) })
        root.addView(accessCard, ui.matchWrap())
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
        val headerRow = ui.settingsSwitchRow(
            title = "JSON страницы",
            subtitle = "Использовать видимый текст страницы как контекст для ответа.",
            checked = config.headerContextEnabled
        ) { checked ->
            config.headerContextEnabled = checked
        }
        val screenshotRow = ui.settingsSwitchRow(
            title = "Кнопка со скриншотом",
            subtitle = "Показывать кнопку отправки данных получателю.",
            checked = config.screenshotContextEnabled
        ) { checked ->
            config.screenshotContextEnabled = checked
        }
        card.addView(headerRow)
        card.addView(screenshotRow, ui.matchWrap().apply { setMargins(0, ui.dp(10), 0, 0) })
        root.addView(card, ui.matchWrap())
    }

    private fun addSettingsCard(root: LinearLayout) {
        val card = ui.panel()
        card.addView(ui.settingsSliderRow(
            title = "Основная иконка: непрозрачность",
            subtitle = "Кнопка AirWhisper у поля ввода.",
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
            title = "Скриншот: непрозрачность",
            subtitle = "Кнопка отправки данных получателю.",
            value = config.screenshotIconOpacityPercent,
            min = AppConstants.MIN_ICON_OPACITY_PERCENT,
            max = AppConstants.MAX_ICON_OPACITY_PERCENT
        ) { value ->
            config.screenshotIconOpacityPercent = value
        }, ui.matchWrap().apply { setMargins(0, ui.dp(12), 0, 0) })
        card.addView(ui.settingsSliderRow(
            title = "Скриншот: размер",
            subtitle = "100% - текущий размер и середина ползунка.",
            value = config.screenshotIconSizePercent,
            min = AppConstants.MIN_ICON_SIZE_PERCENT,
            max = AppConstants.MAX_ICON_SIZE_PERCENT
        ) { value ->
            config.screenshotIconSizePercent = value
        }, ui.matchWrap().apply { setMargins(0, ui.dp(12), 0, 0) })
        root.addView(card, ui.matchWrap())
    }

    private fun buildReceiverUi() {
        screen = Screen.Receiver
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(COLOR_BACKGROUND)
            setPadding(ui.dp(20), ui.dp(24), ui.dp(20), ui.dp(30))
        }

        root.addView(TextView(this).apply {
            text = "Подключите сервер получатель команд"
            textSize = 24f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_TEXT)
            setPadding(0, 0, 0, ui.dp(16))
        })

        receiverTokenButton = ui.actionButton(if (config.receiverToken.isBlank()) "Указать токен" else "Изменить токен") {
            buildReceiverTokenUi()
        }
        root.addView(receiverTokenButton, ui.matchHeight(ui.dp(46)))

        root.addView(TextView(this).apply {
            text = "URL для получения данных"
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_TEXT)
            setPadding(0, ui.dp(18), 0, ui.dp(8))
        })

        val urlRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        receiverUrlInput = EditText(this).apply {
            hint = "https://example.com/commands"
            setSingleLine(true)
            textSize = 16f
            setTextColor(COLOR_TEXT)
            setHintTextColor(COLOR_MUTED)
            setPadding(ui.dp(12), 0, ui.dp(12), 0)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            background = ui.roundedBackground(COLOR_INPUT, COLOR_BORDER)
            setText(config.receiverUrl)
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    config.receiverUrl = s?.toString().orEmpty()
                    refreshReceiverUi()
                }
                override fun afterTextChanged(s: Editable?) = Unit
            })
        }
        urlRow.addView(receiverUrlInput, LinearLayout.LayoutParams(0, ui.dp(46), 1f))
        receiverStatusIcon = TextView(this).apply {
            textSize = 26f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        }
        urlRow.addView(receiverStatusIcon, LinearLayout.LayoutParams(ui.dp(38), ui.dp(46)).apply {
            setMargins(ui.dp(8), 0, 0, 0)
        })
        root.addView(urlRow, ui.matchWrap())

        receiverTestButton = ui.actionButton("Тест") { testReceiver() }
        root.addView(receiverTestButton, ui.matchHeight(ui.dp(44)).apply { setMargins(0, ui.dp(12), 0, 0) })

        root.addView(TextView(this).apply {
            text = "Логи подключения"
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_TEXT)
            setPadding(0, ui.dp(18), 0, ui.dp(8))
        })
        receiverLogText = TextView(this).apply {
            textSize = 12f
            setTextColor(COLOR_MUTED)
            setPadding(ui.dp(10), ui.dp(9), ui.dp(10), ui.dp(9))
            background = ui.roundedBackground(COLOR_INPUT, COLOR_BORDER)
        }
        root.addView(receiverLogText, ui.matchWrap())

        val scrollView = ScrollView(this).apply {
            setBackgroundColor(COLOR_BACKGROUND)
            clipToPadding = false
            isFillViewport = true
            addView(root)
        }
        ui.applyScreenEdgePadding(scrollView)
        setContentView(scrollView)
        refreshReceiverUi()
    }

    private fun buildReceiverTokenUi() {
        screen = Screen.ReceiverToken
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(COLOR_BACKGROUND)
            setPadding(ui.dp(20), ui.dp(24), ui.dp(20), ui.dp(30))
        }

        root.addView(TextView(this).apply {
            text = "Токен получателя"
            textSize = 24f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_TEXT)
            setPadding(0, 0, 0, ui.dp(16))
        })

        val savedToken = config.receiverToken
        if (savedToken.isNotBlank()) {
            root.addView(TextView(this).apply {
                text = maskToken(savedToken)
                textSize = 18f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(COLOR_OK)
                setPadding(ui.dp(12), ui.dp(10), ui.dp(12), ui.dp(10))
                background = ui.roundedBackground(COLOR_OK_BADGE)
            }, ui.matchWrap().apply { setMargins(0, 0, 0, ui.dp(12)) })
        }

        val tokenInput = EditText(this).apply {
            hint = "Введите токен"
            setSingleLine(true)
            textSize = 16f
            setTextColor(COLOR_TEXT)
            setHintTextColor(COLOR_MUTED)
            setPadding(ui.dp(12), 0, ui.dp(12), 0)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            background = ui.roundedBackground(COLOR_INPUT, COLOR_BORDER)
        }
        root.addView(tokenInput, ui.matchHeight(ui.dp(46)))

        root.addView(ui.actionButton("Сохранить") {
            val token = tokenInput.text?.toString().orEmpty().trim()
            if (token.isNotBlank()) {
                config.receiverToken = token
                buildReceiverUi()
            }
        }, ui.matchHeight(ui.dp(44)).apply { setMargins(0, ui.dp(12), 0, 0) })

        if (savedToken.isNotBlank()) {
            root.addView(ui.actionButton("Сбросить") {
                config.receiverToken = ""
                config.receiverConnectionOk = false
                buildReceiverUi()
            }, ui.matchHeight(ui.dp(44)).apply { setMargins(0, ui.dp(12), 0, 0) })
        }

        val scrollView = ScrollView(this).apply {
            setBackgroundColor(COLOR_BACKGROUND)
            clipToPadding = false
            isFillViewport = true
            addView(root)
        }
        ui.applyScreenEdgePadding(scrollView)
        setContentView(scrollView)
    }

    private fun refreshReceiverUi() {
        if (!this::receiverTestButton.isInitialized || !this::receiverStatusIcon.isInitialized) return
        val hasUrl = this::receiverUrlInput.isInitialized && receiverUrlInput.text?.toString()?.trim()?.isNotBlank() == true
        val hasToken = config.receiverToken.isNotBlank()
        if (this::receiverTokenButton.isInitialized) {
            receiverTokenButton.text = if (hasToken) "Изменить токен" else "Указать токен"
        }
        receiverTestButton.isEnabled = hasUrl && hasToken
        receiverTestButton.alpha = if (receiverTestButton.isEnabled) 1f else 0.45f
        receiverStatusIcon.text = when {
            !hasUrl || !hasToken -> ""
            config.receiverConnectionOk -> "✓"
            else -> "✕"
        }
        receiverStatusIcon.setTextColor(if (config.receiverConnectionOk) COLOR_OK else COLOR_BAD)
        if (this::receiverLogText.isInitialized) {
            receiverLogText.text = config.receiverLog.ifBlank { "Логов пока нет" }
        }
    }

    private fun testReceiver() {
        config.receiverUrl = receiverUrlInput.text?.toString().orEmpty()
        config.appendReceiverLog("Тест: GET ${config.receiverUrl}")
        refreshReceiverUi()
        receiverTestButton.isEnabled = false
        receiverTestButton.alpha = 0.65f
        receiverStatusIcon.text = "..."
        receiverStatusIcon.setTextColor(COLOR_INFO)
        Thread {
            val result = runCatching { NetworkClient(this).receiverHandshake() }
            runOnUiThread {
                config.receiverConnectionOk = result.isSuccess
                result.fold(
                    onSuccess = {
                        config.appendReceiverLog("Тест: OK HTTP $it")
                        RecordingService.retryPending(this)
                    },
                    onFailure = {
                        config.appendReceiverLog("Тест: ошибка ${it.message.orEmpty().take(180)}")
                    }
                )
                refreshReceiverUi()
            }
        }.start()
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
        serverOk = false
        updateConnectionStatus("Проверка подключения...", COLOR_INFO_BADGE, COLOR_INFO)
        Thread {
            val result = runCatching { NetworkClient(this).publicHealthCheck() }
            runOnUiThread {
                result.fold(
                    onSuccess = {
                        serverOk = true
                        updateConnectionStatus(if (it == "ok") "Сервер работает" else "Сервер работает: $it", COLOR_OK_BADGE, COLOR_OK)
                    },
                    onFailure = {
                        serverOk = false
                        updateConnectionStatus("Сервер не отвечает\n${it.message}", COLOR_BAD_BADGE, COLOR_BAD)
                    }
                )
                refreshStatus()
            }
        }.start()
    }

    private fun requestAccess() {
        val name = nameInput.text?.toString().orEmpty().trim()
        if (name.isBlank()) return
        accessButton.isEnabled = false
        accessButton.alpha = 0.65f
        updateAccessStatus("Запрашиваю доступ...", COLOR_INFO_BADGE, COLOR_INFO)
        Thread {
            val result = runCatching {
                val client = NetworkClient(this)
                val access = client.requestAccess(name)
                require(access.token.isNotBlank()) { "Сервер не вернул токен" }
                config.authToken = access.token
                config.displayName = access.displayName.ifBlank { name }
                client.healthCheck()
                access
            }
            runOnUiThread {
                result.fold(
                    onSuccess = {
                        updateAccessStatus("Доступ активен для ${config.displayName}", COLOR_OK_BADGE, COLOR_OK)
                    },
                    onFailure = {
                        config.authToken = ""
                        updateAccessStatus(cleanError(it), COLOR_BAD_BADGE, COLOR_BAD)
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
        val hasToken = config.authToken.isNotBlank()
        val hasName = this::nameInput.isInitialized && nameInput.text?.toString()?.trim()?.isNotBlank() == true

        updateRequiredRow(accessibilityRow, accessibilityOk)
        updateRequiredRow(overlayRow, overlayOk)
        updateRequiredRow(micRow, micOk)
        updateRequiredRow(notificationRow, notificationsOk)

        if (!permissionsOk) serverOk = false
        testButton.isEnabled = permissionsOk
        testButton.alpha = if (permissionsOk) 1f else 0.45f
        if (!permissionsOk) updateConnectionStatus("Сначала включите все разрешения", COLOR_INFO_BADGE, COLOR_INFO)

        accessCard.visibility = if ((permissionsOk && serverOk) || hasToken) View.VISIBLE else View.GONE
        nameInput.isEnabled = !hasToken
        accessButton.visibility = if (hasToken) View.GONE else View.VISIBLE
        accessButton.isEnabled = permissionsOk && serverOk && hasName
        accessButton.alpha = if (accessButton.isEnabled) 1f else 0.45f

        if (hasToken) {
            updateAccessStatus("Доступ активен для ${config.displayName.ifBlank { "пользователя" }}", COLOR_OK_BADGE, COLOR_OK)
        } else if (permissionsOk && serverOk) {
            updateAccessStatus("Введите имя и получите персональный доступ", COLOR_INFO_BADGE, COLOR_INFO)
        } else {
            updateAccessStatus("Появится после проверки сервера", COLOR_INFO_BADGE, COLOR_INFO)
        }

        val ready = permissionsOk && hasToken
        overallStatus.text = when {
            ready -> "Готово: можно отправлять команды"
            !permissionsOk -> "Нужно включить все разрешения"
            !serverOk -> "Проверьте подключение к серверу"
            else -> "Получите доступ для этого устройства"
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

    private fun updateAccessStatus(textValue: String, backgroundColor: Int, textColor: Int) {
        accessStatus.text = textValue
        accessStatus.setTextColor(textColor)
        accessStatus.background = ui.roundedBackground(backgroundColor)
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

    private fun maskToken(token: String): String =
        token.take(3) + "******" + token.takeLast(3)

    private enum class Screen {
        Main,
        Receiver,
        ReceiverToken
    }

    companion object {
        private const val REQ_MIC = 10
        private const val REQ_NOTIFICATIONS = 11
        private const val MAX_POST_PROCESSING_PROMPT_CHARS = 4000
    }
}
