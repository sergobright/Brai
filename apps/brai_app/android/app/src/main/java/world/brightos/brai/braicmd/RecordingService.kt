package world.brightos.brai.braicmd

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import java.io.File
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean

class RecordingService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    private var conversationContext: VisibleConversationContext? = null
    private var screenshotFile: File? = null
    private var inboxDelivery = false
    private var inboxTextPrefix = ""
    private var audioQueueAction = AudioQueueAction.MainDictation
    private var amplitudeTicker: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopRecordingAndQueueUpload()
            ACTION_CANCEL -> cancelRecording()
            ACTION_RETRY -> uploadPendingRecordings()
            else -> startRecording(
                VisibleConversationContext.fromIntent(intent),
                screenshotFileFromIntent(intent),
                intent?.getBooleanExtra(EXTRA_INBOX_DELIVERY, false) == true,
                intent?.getStringExtra(EXTRA_INBOX_TEXT_PREFIX).orEmpty(),
                audioQueueActionFromIntent(intent)
            )
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        val unfinishedFile = outputFile
        releaseRecorder()
        if (unfinishedFile != null && unfinishedFile.exists() && unfinishedFile.length() >= 512L) {
            val pendingFile = finalizeRecording(unfinishedFile)
            ConversationContextStore.save(pendingFile, conversationContext)
            screenshotFile?.let { ScreenshotContextStore.save(pendingFile, it) }
            if (inboxDelivery) InboxPayloadStore.mark(pendingFile, inboxTextPrefix)
            InboxPayloadStore.saveAction(pendingFile, audioQueueAction)
        }
        outputFile = null
        conversationContext = null
        screenshotFile = null
        inboxDelivery = false
        inboxTextPrefix = ""
        audioQueueAction = AudioQueueAction.MainDictation
        super.onDestroy()
    }

    private fun startRecording(
        context: VisibleConversationContext?,
        screenshot: File?,
        deliverToInbox: Boolean,
        textPrefix: String,
        action: AudioQueueAction
    ) {
        if (recorder != null) {
            screenshot?.delete()
            return
        }
        conversationContext = context
        screenshotFile = screenshot?.takeIf { it.isFile && it.length() > 0L }
        inboxDelivery = deliverToInbox
        inboxTextPrefix = textPrefix.trim()
        audioQueueAction = action
        startRecordingForeground()

        val file = File(recordingsDir().apply { mkdirs() }, "brai-cmd-${System.currentTimeMillis()}.recording.m4a")
        val mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else MediaRecorder()
        try {
            mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            mediaRecorder.setAudioEncodingBitRate(96_000)
            mediaRecorder.setAudioSamplingRate(44_100)
            mediaRecorder.setOutputFile(file.absolutePath)
            mediaRecorder.prepare()
            mediaRecorder.start()
            recorder = mediaRecorder
            outputFile = file
            ScreenshotContextStore.save(file, screenshotFile)
            if (inboxDelivery) InboxPayloadStore.mark(file, inboxTextPrefix)
            InboxPayloadStore.saveAction(file, audioQueueAction)
            screenshotFile = null
            BraiCmdBus.post(RecorderState.Recording(0))
            startAmplitudeTicker()
        } catch (error: Throwable) {
            mediaRecorder.release()
            screenshotFile?.delete()
            screenshotFile = null
            InboxPayloadStore.delete(file)
            file.delete()
            BraiCmdBus.post(RecorderState.Error(error.message ?: "Не удалось начать запись"))
            stopSelf()
        }
    }

    private fun stopRecordingAndQueueUpload() {
        val recordingFile = outputFile
        releaseRecorder()
        if (recordingFile == null || !recordingFile.exists() || recordingFile.length() < 512L) {
            recordingFile?.delete()
            recordingFile?.let { ConversationContextStore.delete(it) }
            recordingFile?.let { ScreenshotContextStore.delete(it) }
            recordingFile?.let { InboxPayloadStore.delete(it) }
            BraiCmdBus.post(RecorderState.Error("Запись слишком короткая"))
            stopRecordingForeground()
            stopSelf()
            return
        }

        val pendingFile = finalizeRecording(recordingFile)
        if (!pendingFile.exists()) {
            BraiCmdBus.post(RecorderState.Error("Не удалось сохранить запись"))
            stopRecordingForeground()
            stopSelf()
            return
        }
        ConversationContextStore.save(pendingFile, conversationContext)
        ScreenshotContextStore.move(recordingFile, pendingFile)
        InboxPayloadStore.saveAction(pendingFile, audioQueueAction)
        if (ConfigStore(this).onboardingQueuePaused) {
            BraiCmdPlugin.notifyOnboardingEvent("queueSaved", null)
            postPendingState(
                message = "Запись сохранена в очереди. Отправка временно остановлена для проверки.",
                reason = PendingReason.Network
            )
            stopRecordingForeground()
            stopSelf()
            return
        }
        uploadFreshRecording(pendingFile)
    }

    private fun cancelRecording() {
        val recordingFile = outputFile
        releaseRecorder()
        outputFile = null
        conversationContext = null
        inboxDelivery = false
        inboxTextPrefix = ""
        audioQueueAction = AudioQueueAction.MainDictation
        screenshotFile?.delete()
        screenshotFile = null
        recordingFile?.let { ConversationContextStore.delete(it) }
        recordingFile?.let { ScreenshotContextStore.delete(it) }
        recordingFile?.let { InboxPayloadStore.delete(it) }
        recordingFile?.delete()
        BraiCmdBus.post(RecorderState.Idle)
        stopRecordingForeground()
        stopSelf()
    }

    private fun uploadPendingRecordings() = uploadQueue(autoInsertAudioFileName = null)

    private fun uploadFreshRecording(file: File) {
        QueueRetryStore(this).allowImmediate()
        uploadQueue(autoInsertAudioFileName = file.name)
    }

    private fun uploadQueue(autoInsertAudioFileName: String?) {
        workerStartRequested.set(false)
        if (!uploadInProgress.compareAndSet(false, true)) return
        startUploadForeground()
        BraiCmdBus.post(RecorderState.Uploading)
        Thread {
            var workerResult: QueueWorkerResult? = null
            try {
                val transport = QueueTransportWorker(this).run(autoInsertAudioFileName)
                val retryStore = QueueRetryStore(this)
                val nextRetryAt = when (transport.status) {
                    QueueTransportStatus.TransientFailure -> {
                        BraiCmdQueue.markTransportFailed(this, transport.failedTransportIds)
                        retryStore.recordTransient(System.currentTimeMillis()).nextRetryAtMillis
                    }
                    QueueTransportStatus.Blocked -> {
                        BraiCmdQueue.markTransportFailed(this, transport.failedTransportIds)
                        retryStore.recordBlocked(System.currentTimeMillis()).nextRetryAtMillis
                    }
                    QueueTransportStatus.Drained -> {
                        retryStore.reset()
                        BraiCmdQueue.clearTransportFailures(this)
                        null
                    }
                }
                val snapshot = queueSnapshot(this)
                workerResult = QueueWorkerResult(
                    status = when (transport.status) {
                        QueueTransportStatus.Drained -> QueueWorkerStatus.Drained
                        QueueTransportStatus.TransientFailure -> QueueWorkerStatus.TransientFailure
                        QueueTransportStatus.Blocked -> QueueWorkerStatus.Blocked
                    },
                    snapshot = snapshot,
                    nextRetryAtMillis = nextRetryAt
                )
                postQueueState(transport, snapshot)
            } catch (error: Throwable) {
                val schedule = QueueRetryStore(this).recordTransient(System.currentTimeMillis())
                val snapshot = queueSnapshot(this)
                workerResult = QueueWorkerResult(
                    status = QueueWorkerStatus.TransientFailure,
                    snapshot = snapshot,
                    nextRetryAtMillis = schedule.nextRetryAtMillis
                )
                val (message, reason) = pendingStatusFor(error)
                postPendingState(snapshot, message, reason)
            } finally {
                uploadInProgress.set(false)
                val result = workerResult ?: QueueWorkerResult(QueueWorkerStatus.TransientFailure, queueSnapshot(this))
                queueWorkerListeners.forEach { listener -> runCatching { listener(result) } }
                stopRecordingForeground()
                stopSelf()
                if (result.status == QueueWorkerStatus.Drained &&
                    result.snapshot.transport.total > 0 &&
                    !ConfigStore(this).onboardingQueuePaused
                ) {
                    retryPending(this, QueueRetryTrigger.Enqueue)
                }
            }
        }.start()
    }

    private fun postQueueState(transport: QueueTransportResult, snapshot: BraiCmdQueueSnapshot) {
        if (transport.status != QueueTransportStatus.Drained) {
            val failure = transport.failure ?: IOException("Не удалось отправить очередь")
            val (message, reason) = pendingStatusFor(failure)
            postPendingState(snapshot, message, reason)
            return
        }
        when {
            transport.autoInsertTranscriptFile != null -> BraiCmdBus.post(
                RecorderState.TranscriptReady(
                    transcripts = snapshot.readyToInsert.total,
                    autoInsertTranscriptFile = transport.autoInsertTranscriptFile,
                    fallbackUsed = transport.fallbackUsed,
                    provider = transport.provider,
                    model = transport.model
                )
            )
            transport.permanentFailureMessage != null -> BraiCmdBus.post(RecorderState.Error(transport.permanentFailureMessage))
            transport.inboxDelivered -> BraiCmdBus.post(RecorderState.InboxDelivered)
            snapshot.readyToInsert.total > 0 -> BraiCmdBus.post(
                RecorderState.TranscriptReady(
                    transcripts = snapshot.readyToInsert.total,
                    fallbackUsed = transport.fallbackUsed,
                    provider = transport.provider,
                    model = transport.model
                )
            )
            snapshot.transport.total > 0 -> postPendingState(
                snapshot,
                "Есть сохраненные данные в очереди",
                PendingReason.Unknown
            )
            else -> BraiCmdBus.post(RecorderState.Idle)
        }
    }

    private fun postPendingState(snapshot: BraiCmdQueueSnapshot, message: String, reason: PendingReason) {
        BraiCmdBus.post(
            RecorderState.Pending(
                message = message,
                recordings = snapshot.transport.total,
                transcripts = snapshot.readyToInsert.total,
                reason = reason
            )
        )
    }

    private fun postPendingState(message: String, reason: PendingReason) =
        postPendingState(queueSnapshot(this), message, reason)

    private fun finalizeRecording(file: File): File {
        if (!file.name.contains(".recording.")) return file
        val pendingName = file.name.replace(".recording.", ".")
        val pendingFile = File(file.parentFile ?: recordingsDir(), pendingName)
        if (file.renameTo(pendingFile)) {
            ConversationContextStore.move(file, pendingFile)
            ScreenshotContextStore.move(file, pendingFile)
            InboxPayloadStore.move(file, pendingFile)
            return pendingFile
        }
        return runCatching {
            file.copyTo(pendingFile, overwrite = true)
            if (pendingFile.exists()) file.delete()
            ConversationContextStore.move(file, pendingFile)
            ScreenshotContextStore.move(file, pendingFile)
            InboxPayloadStore.move(file, pendingFile)
            pendingFile
        }.getOrDefault(file)
    }

    private fun recordingsDir(): File = File(filesDir, RECORDINGS_DIR)

    private fun pendingStatusFor(error: Throwable): Pair<String, PendingReason> =
        when (error) {
            is QueueAuthBlockedException ->
                Pair("Данные сохранены. Обновите доступ и повторите отправку.", PendingReason.Server)
            is QueueEmptyModelException ->
                Pair("Данные сохранены. Модель вернула пустой текст; повторю автоматически.", PendingReason.Transcription)
            is UnknownHostException ->
                Pair("Данные сохранены. Нет интернета; отправлю, когда связь вернется.", PendingReason.Network)
            is SocketTimeoutException ->
                Pair("Данные сохранены. Сервер долго не отвечает; повторю автоматически.", PendingReason.Server)
            is ServerResponseException ->
                if (error.statusCode == 401 || error.statusCode == 403) {
                    Pair("Данные сохранены. Обновите доступ и повторите отправку.", PendingReason.Server)
                } else if (error.code == "upstream_error") {
                    Pair("Данные сохранены. Модель сейчас не отвечает; повторю автоматически.", PendingReason.Transcription)
                } else {
                    Pair("Данные сохранены. Сервер не принял запрос; повторю автоматически.", PendingReason.Server)
                }
            is IOException ->
                Pair("Данные сохранены. Сейчас нет связи с сервером; повторю автоматически.", PendingReason.Network)
            else ->
                Pair("Данные сохранены. Не удалось отправить сейчас; повторю автоматически.", PendingReason.Unknown)
        }

    private fun startRecordingForeground() {
        val notification = recordingNotification("Идет запись голоса")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun startUploadForeground() {
        val notification = recordingNotification("Отправляю сохраненную запись")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun stopRecordingForeground() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun recordingNotification(text: String): Notification {
        createNotificationChannel()
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Brai Cmd")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(NotificationChannel(NOTIFICATION_CHANNEL_ID, "Запись Brai Cmd", NotificationManager.IMPORTANCE_LOW))
    }

    private fun startAmplitudeTicker() {
        amplitudeTicker = object : Runnable {
            override fun run() {
                val amplitude = runCatching { recorder?.maxAmplitude ?: 0 }.getOrDefault(0)
                BraiCmdBus.post(RecorderState.Recording(amplitude))
                handler.postDelayed(this, 120L)
            }
        }.also { handler.post(it) }
    }

    private fun releaseRecorder() {
        amplitudeTicker?.let { handler.removeCallbacks(it) }
        amplitudeTicker = null
        recorder?.let {
            runCatching { it.stop() }
            it.release()
        }
        recorder = null
    }

    companion object {
        private const val RECORDINGS_DIR = "pending-recordings"
        private const val NOTIFICATION_CHANNEL_ID = "brai_cmd_recording"
        private const val NOTIFICATION_ID = 4007
        private const val ACTION_START = "world.brightos.brai.braicmd.START_RECORDING"
        private const val ACTION_STOP = "world.brightos.brai.braicmd.STOP_RECORDING"
        private const val ACTION_CANCEL = "world.brightos.brai.braicmd.CANCEL_RECORDING"
        private const val ACTION_RETRY = "world.brightos.brai.braicmd.RETRY_RECORDINGS"
        private const val EXTRA_SCREENSHOT_PATH = "world.brightos.brai.braicmd.extra.SCREENSHOT_PATH"
        private const val EXTRA_INBOX_DELIVERY = "world.brightos.brai.braicmd.extra.INBOX_DELIVERY"
        private const val EXTRA_INBOX_TEXT_PREFIX = "world.brightos.brai.braicmd.extra.INBOX_TEXT_PREFIX"
        private const val EXTRA_AUDIO_QUEUE_ACTION = "world.brightos.brai.braicmd.extra.AUDIO_QUEUE_ACTION"
        private val uploadInProgress = AtomicBoolean(false)
        private val workerStartRequested = AtomicBoolean(false)
        private val queueWorkerListeners = CopyOnWriteArraySet<(QueueWorkerResult) -> Unit>()

        internal fun start(
            context: Context,
            conversationContext: VisibleConversationContext? = null,
            screenshotFile: File? = null,
            deliverToInbox: Boolean = false,
            inboxTextPrefix: String = "",
            contextAction: ContextButtonAction? = null
        ) {
            val intent = Intent(context, RecordingService::class.java).setAction(ACTION_START)
            VisibleConversationContext.putInto(intent, conversationContext)
            if (screenshotFile != null && screenshotFile.isFile) {
                intent.putExtra(EXTRA_SCREENSHOT_PATH, screenshotFile.absolutePath)
            }
            intent.putExtra(EXTRA_INBOX_DELIVERY, deliverToInbox)
            if (inboxTextPrefix.isNotBlank()) intent.putExtra(EXTRA_INBOX_TEXT_PREFIX, inboxTextPrefix.trim())
            val action = when {
                contextAction != null -> AudioQueueAction.fromContextAction(contextAction)
                !deliverToInbox -> AudioQueueAction.MainDictation
                inboxTextPrefix.trim().equals(AudioQueueStore.IDEA_PREFIX, ignoreCase = true) -> AudioQueueAction.IdeaVoiceInbox
                screenshotFile != null -> AudioQueueAction.ScreenshotVoiceInbox
                inboxTextPrefix.trim().equals(AudioQueueStore.CHAT_PREFIX, ignoreCase = true) -> AudioQueueAction.ChatContextInbox
                conversationContext != null -> AudioQueueAction.SaveContextInbox
                else -> AudioQueueAction.Unknown
            }
            intent.putExtra(EXTRA_AUDIO_QUEUE_ACTION, action.persistedValue)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
            } catch (error: Throwable) {
                screenshotFile?.delete()
                BraiCmdBus.post(RecorderState.Error(error.message ?: "Android заблокировал запуск микрофона"))
            }
        }

        fun stop(context: Context) {
            try {
                context.startService(Intent(context, RecordingService::class.java).setAction(ACTION_STOP))
            } catch (error: Throwable) {
                BraiCmdBus.post(RecorderState.Error(error.message ?: "Не удалось остановить запись"))
            }
        }

        fun cancel(context: Context) {
            try {
                context.startService(Intent(context, RecordingService::class.java).setAction(ACTION_CANCEL))
            } catch (error: Throwable) {
                BraiCmdBus.post(RecorderState.Error(error.message ?: "Не удалось отменить запись"))
            }
        }

        fun retryPending(context: Context): Boolean =
            retryPending(context, QueueRetryTrigger.Manual)

        internal fun retryPending(
            context: Context,
            trigger: QueueRetryTrigger
        ): Boolean {
            val state = BraiCmdBus.latest
            val retryStore = QueueRetryStore(context)
            if (ConfigStore(context).onboardingQueuePaused ||
                uploadInProgress.get() ||
                state is RecorderState.Recording ||
                (state is RecorderState.Uploading && trigger != QueueRetryTrigger.Enqueue) ||
                !hasPendingRecordings(context)
            ) {
                return false
            }
            if (!workerStartRequested.compareAndSet(false, true)) return false
            if (trigger in setOf(QueueRetryTrigger.Manual, QueueRetryTrigger.Network, QueueRetryTrigger.Enqueue)) {
                retryStore.allowImmediate()
            }
            val intent = Intent(context, RecordingService::class.java).setAction(ACTION_RETRY)
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
                true
            } catch (error: Throwable) {
                workerStartRequested.set(false)
                BraiCmdBus.post(RecorderState.Error(error.message ?: "Не удалось повторить отправку сохраненной записи"))
                false
            }
        }

        internal fun enqueueScreenshot(context: Context, screenshotFile: File): Boolean {
            if (ScreenshotInboxStore.enqueue(context, screenshotFile) == null) return false
            val snapshot = queueSnapshot(context)
            if (ConfigStore(context).onboardingQueuePaused) {
                BraiCmdPlugin.notifyOnboardingEvent("queueSaved", null)
                BraiCmdBus.post(
                    RecorderState.Pending(
                        message = "Скриншот сохранен в очереди. Отправка временно остановлена для проверки.",
                        recordings = snapshot.transport.total,
                        transcripts = snapshot.readyToInsert.total,
                        reason = PendingReason.Network
                    )
                )
                return true
            }
            retryPending(context, QueueRetryTrigger.Enqueue)
            return true
        }

        internal fun queueSnapshot(context: Context): BraiCmdQueueSnapshot = BraiCmdQueue.snapshot(context)

        internal fun addQueueWorkerListener(listener: (QueueWorkerResult) -> Unit) {
            queueWorkerListeners.add(listener)
        }

        internal fun removeQueueWorkerListener(listener: (QueueWorkerResult) -> Unit) {
            queueWorkerListeners.remove(listener)
        }

        fun hasPendingRecordings(context: Context): Boolean =
            AudioQueueStore.list(context).isNotEmpty() || ScreenshotInboxStore.list(context).isNotEmpty()

        fun pendingRecordingsCount(context: Context): Int =
            AudioQueueStore.list(context).size + ScreenshotInboxStore.list(context).size

        private fun audioQueueActionFromIntent(intent: Intent?): AudioQueueAction {
            val saved = intent?.getStringExtra(EXTRA_AUDIO_QUEUE_ACTION)
            if (!saved.isNullOrBlank()) return AudioQueueAction.fromPersisted(saved)
            if (intent?.getBooleanExtra(EXTRA_INBOX_DELIVERY, false) != true) return AudioQueueAction.MainDictation
            val prefix = intent.getStringExtra(EXTRA_INBOX_TEXT_PREFIX).orEmpty().trim()
            return when {
                prefix.equals(AudioQueueStore.IDEA_PREFIX, ignoreCase = true) -> AudioQueueAction.IdeaVoiceInbox
                intent.getStringExtra(EXTRA_SCREENSHOT_PATH).orEmpty().isNotBlank() -> AudioQueueAction.ScreenshotVoiceInbox
                prefix.equals(AudioQueueStore.CHAT_PREFIX, ignoreCase = true) -> AudioQueueAction.ChatContextInbox
                VisibleConversationContext.fromIntent(intent) != null -> AudioQueueAction.SaveContextInbox
                else -> AudioQueueAction.Unknown
            }
        }

        private fun screenshotFileFromIntent(intent: Intent?): File? {
            val path = intent?.getStringExtra(EXTRA_SCREENSHOT_PATH).orEmpty()
            if (path.isBlank()) return null
            return File(path).takeIf { it.isFile && it.length() > 0L }
        }
    }
}
