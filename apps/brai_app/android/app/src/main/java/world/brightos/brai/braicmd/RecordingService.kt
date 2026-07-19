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

private data class QueueUploadCompletion(
    val result: QueueWorkerResult,
    val snapshot: BraiCmdQueueSnapshot,
    val handoffRequested: Boolean
)

internal class QueueUploadHandoff {
    private val lock = Any()
    private var active = false
    private var deferredOwnerId: String? = null

    fun tryBegin(): Boolean = synchronized(lock) {
        if (active) return@synchronized false
        active = true
        true
    }

    fun deferIfActive(ownerId: String, trigger: QueueRetryTrigger): Boolean = synchronized(lock) {
        if (!active) return@synchronized false
        if (trigger == QueueRetryTrigger.Manual || trigger == QueueRetryTrigger.Enqueue) {
            deferredOwnerId = ownerId
        }
        true
    }

    fun <T> finish(block: (String?) -> T): T = synchronized(lock) {
        try {
            block(deferredOwnerId)
        } finally {
            deferredOwnerId = null
            active = false
        }
    }
}

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
                audioQueueActionFromIntent(intent),
                capturedOwnerIdFromIntent(intent)
            )
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        val unfinishedFile = outputFile
        releaseRecorder()
        val ownerStillCurrent = unfinishedFile?.let {
            QueueOwnerStore.readOwnerId(it) == QueueOwnerStore.current(this).ownerId
        } == true
        if (unfinishedFile != null && ownerStillCurrent && unfinishedFile.exists() && unfinishedFile.length() >= 512L) {
            val pendingFile = finalizeRecording(unfinishedFile)
            ConversationContextStore.save(pendingFile, conversationContext)
            screenshotFile?.let { ScreenshotContextStore.save(pendingFile, it) }
            if (inboxDelivery) InboxPayloadStore.mark(pendingFile, inboxTextPrefix)
            InboxPayloadStore.saveAction(pendingFile, audioQueueAction)
        } else if (unfinishedFile != null && !ownerStillCurrent) {
            screenshotFile?.delete()
            RecordingArchiveStore.deleteAudioWithSidecars(unfinishedFile)
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
        action: AudioQueueAction,
        capturedOwnerId: String?
    ) {
        if (recorder != null) {
            screenshot?.delete()
            return
        }
        if (capturedOwnerId == null || QueueOwnerStore.current(this).ownerId != capturedOwnerId) {
            screenshot?.delete()
            BraiCmdBus.post(RecorderState.Error("Профиль изменился до начала записи"))
            stopSelf()
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
            QueueOwnerStore.claim(file, capturedOwnerId)
            mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            mediaRecorder.setAudioEncodingBitRate(96_000)
            mediaRecorder.setAudioSamplingRate(44_100)
            mediaRecorder.setOutputFile(file.absolutePath)
            mediaRecorder.prepare()
            mediaRecorder.start()
            val accepted = QueueOwnerStore.withinBoundary {
                if (QueueOwnerStore.current(this).ownerId != capturedOwnerId) return@withinBoundary false
                recorder = mediaRecorder
                outputFile = file
                RecordingArchiveStore.saveNewMetadata(file)
                ScreenshotContextStore.save(file, screenshotFile)
                if (inboxDelivery) InboxPayloadStore.mark(file, inboxTextPrefix)
                InboxPayloadStore.saveAction(file, audioQueueAction)
                screenshotFile = null
                BraiCmdBus.post(RecorderState.Recording(0))
                startAmplitudeTicker()
                true
            }
            if (!accepted) {
                discardRecordingStart(mediaRecorder, file, "Профиль изменился до начала записи")
            }
        } catch (error: Throwable) {
            discardRecordingStart(mediaRecorder, file, "Запись не началась")
        }
    }

    private fun discardRecordingStart(mediaRecorder: MediaRecorder, file: File, message: String) {
        recorder = null
        outputFile = null
        runCatching { mediaRecorder.stop() }
        runCatching { mediaRecorder.release() }
        screenshotFile?.delete()
        screenshotFile = null
        conversationContext = null
        inboxDelivery = false
        inboxTextPrefix = ""
        audioQueueAction = AudioQueueAction.MainDictation
        RecordingArchiveStore.deleteAudioWithSidecars(file)
        BraiCmdBus.post(RecorderState.Error(message))
        stopRecordingForeground()
        stopSelf()
    }

    private fun stopRecordingAndQueueUpload() {
        val recordingFile = outputFile
        releaseRecorder()
        if (recordingFile == null || !recordingFile.exists() || recordingFile.length() < 512L) {
            recordingFile?.delete()
            recordingFile?.let { ConversationContextStore.delete(it) }
            recordingFile?.let { ScreenshotContextStore.delete(it) }
            recordingFile?.let { InboxPayloadStore.delete(it) }
            recordingFile?.let { QueueOwnerStore.delete(it) }
            BraiCmdBus.post(RecorderState.Error("Запись слишком короткая"))
            stopRecordingForeground()
            stopSelf()
            return
        }

        val pendingFile = finalizeRecording(recordingFile)
        if (!pendingFile.exists()) {
            BraiCmdBus.post(RecorderState.Error("Запись не сохранена"))
            stopRecordingForeground()
            stopSelf()
            return
        }
        ConversationContextStore.save(pendingFile, conversationContext)
        ScreenshotContextStore.move(recordingFile, pendingFile)
        InboxPayloadStore.saveAction(pendingFile, audioQueueAction)
        BraiCmdPlugin.notifyStateChanged()
        if (ConfigStore(this).onboardingQueuePaused) {
            BraiCmdPlugin.notifyOnboardingEvent("queueSaved", null)
            BraiCmdBus.post(RecorderState.Notice(onboardingQueueSavedNotice()))
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
        recordingFile?.let { QueueOwnerStore.delete(it) }
        recordingFile?.delete()
        BraiCmdBus.post(RecorderState.Idle)
        stopRecordingForeground()
        stopSelf()
        retryPending(this, QueueRetryTrigger.Enqueue)
    }

    private fun uploadPendingRecordings() = uploadQueue(autoInsertAudioFileName = null)

    private fun uploadFreshRecording(file: File) {
        QueueRetryStore(this).allowImmediate()
        uploadQueue(autoInsertAudioFileName = file.name)
    }

    private fun uploadQueue(autoInsertAudioFileName: String?) {
        workerStartRequested.set(false)
        if (!uploadHandoff.tryBegin()) return
        startUploadForeground()
        BraiCmdBus.post(RecorderState.Uploading)
        Thread {
            var workerResult: QueueWorkerResult? = null
            var workerOwnerId: String? = null
            try {
                val rawTransport = QueueTransportWorker(this).run(autoInsertAudioFileName)
                workerOwnerId = rawTransport.ownerId
                val transport = effectiveTransportForCurrentOwner(rawTransport, QueueOwnerStore.current(this).ownerId)
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
                    QueueTransportStatus.Superseded -> {
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
                        QueueTransportStatus.Superseded -> QueueWorkerStatus.Drained
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
                val completion = uploadHandoff.finish { deferredRetryOwnerId ->
                    val currentOwnerId = QueueOwnerStore.current(this).ownerId
                    val currentSnapshot = queueSnapshot(this)
                    val ownerChanged = workerOwnerId?.let { it != currentOwnerId } == true
                    val handoffRequested = ownerChanged || deferredRetryOwnerId != null
                    if (handoffRequested) {
                        QueueRetryStore(this).reset()
                        BraiCmdQueue.clearTransportFailures(this)
                    }
                    val result = (workerResult
                        ?: QueueWorkerResult(QueueWorkerStatus.TransientFailure, currentSnapshot)).copy(
                        status = if (handoffRequested) QueueWorkerStatus.Drained else workerResult?.status
                            ?: QueueWorkerStatus.TransientFailure,
                        snapshot = currentSnapshot,
                        nextRetryAtMillis = if (handoffRequested) null else workerResult?.nextRetryAtMillis
                    )
                    QueueUploadCompletion(result, currentSnapshot, handoffRequested).also { completed ->
                        if (completed.handoffRequested) postQueueState(
                            QueueTransportResult(QueueTransportStatus.Superseded, currentOwnerId),
                            completed.snapshot
                        )
                        queueWorkerListeners.forEach { listener -> runCatching { listener(completed.result) } }
                        BraiCmdPlugin.notifyStateChanged()
                        stopRecordingForeground()
                        stopSelf()
                    }
                }
                val result = completion.result
                if (result.status == QueueWorkerStatus.Drained && !ConfigStore(this).onboardingQueuePaused) {
                    retryPending(this, QueueRetryTrigger.Enqueue)
                }
            }
        }.start()
    }

    private fun postQueueState(transport: QueueTransportResult, snapshot: BraiCmdQueueSnapshot) {
        if (transport.status != QueueTransportStatus.Drained && transport.status != QueueTransportStatus.Superseded) {
            val failure = transport.failure ?: IOException("Не удалось сохранить в очередь")
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
            transport.inboxDelivered -> BraiCmdBus.post(RecorderState.InboxDelivered(transport.serverNotice))
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
                "Не удалось сохранить в очередь",
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
        val ownerPrepared = try {
            QueueOwnerStore.copyOwner(file, pendingFile)
        } catch (_: Throwable) {
            return file
        }
        if (file.renameTo(pendingFile)) {
            if (ownerPrepared) QueueOwnerStore.delete(file)
            ConversationContextStore.move(file, pendingFile)
            ScreenshotContextStore.move(file, pendingFile)
            InboxPayloadStore.move(file, pendingFile)
            RecordingArchiveStore.moveMetadata(file, pendingFile)
            return pendingFile
        }
        return runCatching {
            file.copyTo(pendingFile, overwrite = true)
            if (pendingFile.exists()) file.delete()
            if (ownerPrepared) QueueOwnerStore.delete(file)
            ConversationContextStore.move(file, pendingFile)
            ScreenshotContextStore.move(file, pendingFile)
            InboxPayloadStore.move(file, pendingFile)
            RecordingArchiveStore.moveMetadata(file, pendingFile)
            pendingFile
        }.onFailure {
            if (ownerPrepared) QueueOwnerStore.delete(pendingFile)
        }.getOrDefault(file)
    }

    private fun recordingsDir(): File = File(filesDir, RECORDINGS_DIR)

    internal fun pendingStatusFor(error: Throwable): Pair<String, PendingReason> =
        when (error) {
            is QueueOwnerBlockedException ->
                Pair("Сохранено для другого профиля", PendingReason.Server)
            is QueueAuthBlockedException ->
                Pair("Сохранено, отправлю автоматически", PendingReason.Server)
            is QueueEmptyModelException ->
                Pair("Модель временно недоступна", PendingReason.Transcription)
            is UnknownHostException ->
                Pair("Ждёт интернет", PendingReason.Network)
            is SocketTimeoutException ->
                Pair("Ждёт сервер", PendingReason.Server)
            is ProviderResponseException -> when {
                error.statusCode == 401 || error.statusCode == 403 ->
                    Pair("Данные сохранены. Проверьте API-ключ поставщика в настройках.", PendingReason.Transcription)
                error.statusCode in 400..499 && error.statusCode !in setOf(408, 425, 429) ->
                    Pair("Данные сохранены. Проверьте выбранную модель и настройки поставщика.", PendingReason.Transcription)
                error.statusCode == 429 ->
                    Pair("Данные сохранены. Поставщик временно ограничил запросы; повторю автоматически.", PendingReason.Transcription)
                else ->
                    Pair("Данные сохранены. Поставщик сейчас не отвечает; повторю автоматически.", PendingReason.Transcription)
            }
            is ServerResponseException ->
                if (error.code == "function_disabled") {
                    Pair("Функция временно недоступна", PendingReason.Server)
                } else if (error.statusCode == 401 || error.statusCode == 403) {
                    Pair("Ждёт сервер", PendingReason.Server)
                } else if (error.code == "upstream_error") {
                    Pair("Модель временно недоступна", PendingReason.Transcription)
                } else if (error.statusCode == 413) {
                    Pair("Файл слишком большой", PendingReason.Server)
                } else if (error.statusCode == 415) {
                    Pair("Формат не поддержан", PendingReason.Server)
                } else if (error.statusCode == 422) {
                    Pair("Данные повреждены", PendingReason.Server)
                } else if (error.statusCode == 400) {
                    Pair("Запрос отклонён", PendingReason.Server)
                } else {
                    Pair("Ждёт сервер", PendingReason.Server)
                }
            is IOException ->
                Pair("Ждёт интернет", PendingReason.Network)
            else ->
                Pair("Не удалось сохранить в очередь", PendingReason.Unknown)
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
        private const val EXTRA_QUEUE_OWNER_ID = "world.brightos.brai.braicmd.extra.QUEUE_OWNER_ID"
        private val uploadHandoff = QueueUploadHandoff()
        private val workerStartRequested = AtomicBoolean(false)
        private val queueWorkerListeners = CopyOnWriteArraySet<(QueueWorkerResult) -> Unit>()

        internal fun start(
            context: Context,
            conversationContext: VisibleConversationContext? = null,
            screenshotFile: File? = null,
            deliverToInbox: Boolean = false,
            inboxTextPrefix: String = "",
            contextAction: ContextButtonAction? = null,
            owner: QueueOwnerScope = QueueOwnerStore.current(context)
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
            intent.putExtra(EXTRA_QUEUE_OWNER_ID, owner.ownerId)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
            } catch (error: Throwable) {
                screenshotFile?.delete()
                BraiCmdBus.post(RecorderState.Error("Запись не началась"))
            }
        }

        fun stop(context: Context) {
            try {
                context.startService(Intent(context, RecordingService::class.java).setAction(ACTION_STOP))
            } catch (error: Throwable) {
                BraiCmdBus.post(RecorderState.Error("Запись не остановлена"))
            }
        }

        fun cancel(context: Context) {
            try {
                context.startService(Intent(context, RecordingService::class.java).setAction(ACTION_CANCEL))
            } catch (error: Throwable) {
                BraiCmdBus.post(RecorderState.Error("Запись не остановлена"))
            }
        }

        internal fun cancelActiveForOwnerTransition(context: Context) {
            if (BraiCmdBus.latest is RecorderState.Recording) cancel(context)
        }

        fun retryPending(context: Context): Boolean =
            retryPending(context, QueueRetryTrigger.Manual)

        internal fun retryPending(
            context: Context,
            trigger: QueueRetryTrigger
        ): Boolean {
            if (ConfigStore(context).onboardingQueuePaused ||
                !hasPendingRecordings(context)
            ) {
                return false
            }
            if (uploadHandoff.deferIfActive(QueueOwnerStore.current(context).ownerId, trigger)) return false
            val state = BraiCmdBus.latest
            val retryStore = QueueRetryStore(context)
            if (
                state is RecorderState.Recording ||
                (retryStore.isBlocked && trigger in setOf(
                    QueueRetryTrigger.Resume,
                    QueueRetryTrigger.Scheduled,
                    QueueRetryTrigger.Network
                )) ||
                (state is RecorderState.Uploading && trigger != QueueRetryTrigger.Enqueue)
            ) {
                return false
            }
            if (trigger in setOf(QueueRetryTrigger.Manual, QueueRetryTrigger.Network, QueueRetryTrigger.Enqueue)) {
                retryStore.allowImmediate()
            }
            if (!workerStartRequested.compareAndSet(false, true)) return false
            val intent = Intent(context, RecordingService::class.java).setAction(ACTION_RETRY)
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
                true
            } catch (error: Throwable) {
                workerStartRequested.set(false)
                BraiCmdBus.post(RecorderState.Error("Повтор не запущен"))
                false
            }
        }

        internal fun enqueueScreenshot(
            context: Context,
            screenshotFile: File,
            owner: QueueOwnerScope
        ): Boolean {
            if (QueueOwnerStore.current(context).ownerId != owner.ownerId) {
                screenshotFile.delete()
                return false
            }
            if (ScreenshotInboxStore.enqueue(context, screenshotFile, owner) == null) return false
            if (ConfigStore(context).onboardingQueuePaused) {
                BraiCmdPlugin.notifyOnboardingEvent("queueSaved", null)
                BraiCmdBus.post(RecorderState.Notice(onboardingQueueSavedNotice()))
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
            queueSnapshot(context).transport.total > 0

        fun pendingRecordingsCount(context: Context): Int =
            queueSnapshot(context).transport.total

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

        internal fun capturedOwnerIdFromIntent(intent: Intent?): String? =
            intent?.getStringExtra(EXTRA_QUEUE_OWNER_ID)?.trim()?.takeIf(String::isNotBlank)

    }
}

internal fun effectiveTransportForCurrentOwner(
    transport: QueueTransportResult,
    currentOwnerId: String
): QueueTransportResult = if (transport.ownerId == currentOwnerId) transport else transport.copy(
    status = QueueTransportStatus.Superseded,
    failure = QueueOwnerBlockedException(),
    failedTransportIds = emptySet()
)
