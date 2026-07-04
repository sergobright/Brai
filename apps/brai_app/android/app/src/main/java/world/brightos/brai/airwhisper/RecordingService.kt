package world.brightos.brai.airwhisper

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
import java.util.concurrent.atomic.AtomicBoolean

private class InboxDeliveryException(message: String) : IOException(message)

class RecordingService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    private var conversationContext: VisibleConversationContext? = null
    private var screenshotFile: File? = null
    private var inboxDelivery = false
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
                intent?.getBooleanExtra(EXTRA_INBOX_DELIVERY, false) == true
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
            if (inboxDelivery) InboxPayloadStore.mark(pendingFile)
        }
        outputFile = null
        conversationContext = null
        screenshotFile = null
        inboxDelivery = false
        super.onDestroy()
    }

    private fun startRecording(context: VisibleConversationContext?, screenshot: File?, deliverToInbox: Boolean) {
        if (recorder != null) {
            screenshot?.delete()
            return
        }
        conversationContext = context
        screenshotFile = screenshot?.takeIf { it.isFile && it.length() > 0L }
        inboxDelivery = deliverToInbox
        startRecordingForeground()

        val file = File(recordingsDir().apply { mkdirs() }, "airwhisper-${System.currentTimeMillis()}.recording.m4a")
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
            if (inboxDelivery) InboxPayloadStore.mark(file)
            screenshotFile = null
            AirWhisperBus.post(RecorderState.Recording(0))
            startAmplitudeTicker()
        } catch (error: Throwable) {
            mediaRecorder.release()
            screenshotFile?.delete()
            screenshotFile = null
            InboxPayloadStore.delete(file)
            file.delete()
            AirWhisperBus.post(RecorderState.Error(error.message ?: "Не удалось начать запись"))
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
            AirWhisperBus.post(RecorderState.Error("Запись слишком короткая"))
            stopRecordingForeground()
            stopSelf()
            return
        }

        val pendingFile = finalizeRecording(recordingFile)
        if (!pendingFile.exists()) {
            AirWhisperBus.post(RecorderState.Error("Не удалось сохранить запись"))
            stopRecordingForeground()
            stopSelf()
            return
        }
        ConversationContextStore.save(pendingFile, conversationContext)
        ScreenshotContextStore.move(recordingFile, pendingFile)
        uploadFreshRecording(pendingFile)
    }

    private fun cancelRecording() {
        val recordingFile = outputFile
        releaseRecorder()
        outputFile = null
        conversationContext = null
        inboxDelivery = false
        screenshotFile?.delete()
        screenshotFile = null
        recordingFile?.let { ConversationContextStore.delete(it) }
        recordingFile?.let { ScreenshotContextStore.delete(it) }
        recordingFile?.let { InboxPayloadStore.delete(it) }
        recordingFile?.delete()
        AirWhisperBus.post(RecorderState.Idle)
        stopRecordingForeground()
        stopSelf()
    }

    private fun uploadPendingRecordings() {
        uploadRecordings(pendingAudioFiles(this), autoInsertAudioFileName = null)
    }

    private fun uploadFreshRecording(file: File) {
        uploadRecordings(listOf(file), autoInsertAudioFileName = file.name)
    }

    private fun uploadRecordings(files: List<File>, autoInsertAudioFileName: String?) {
        if (!uploadInProgress.compareAndSet(false, true)) return
        val firstBatch = files.filter { it.exists() && it.length() >= 512L }
        if (firstBatch.isEmpty()) {
            uploadInProgress.set(false)
            val transcripts = PendingTranscriptStore.list(this).size
            if (transcripts > 0) {
                AirWhisperBus.post(RecorderState.TranscriptReady(transcripts))
            }
            stopRecordingForeground()
            stopSelf()
            return
        }

        startUploadForeground()
        AirWhisperBus.post(RecorderState.Uploading)
        Thread {
            try {
                val client = NetworkClient(this)
                var autoInsertTranscriptFile: String? = null
                var fallbackUsed = false
                var fallbackProvider = ""
                var fallbackModel = ""
                var permanentFailureMessage: String? = null
                var inboxDelivered = false
                for (file in firstBatch) {
                    if (!file.exists()) continue
                    val inboxPayload = InboxPayloadStore.isInboxPayload(file)
                    if (isTooLargeForUpload(file)) {
                        permanentFailureMessage = tooLargeMessage(file)
                        markAudioUnretryable(file)
                        continue
                    }
                    if (inboxPayload) {
                        var text = InboxPayloadStore.readTranscript(file)
                        if (text == null) {
                            val response = try {
                                client.uploadAudio(file, null, null)
                            } catch (error: ServerResponseException) {
                                if (isPermanentServerReject(error)) {
                                    markAudioUnretryable(file)
                                    permanentFailureMessage = permanentRejectMessage(error)
                                    continue
                                }
                                throw error
                            }
                            text = response.text.trim()
                            if (text.isNotBlank()) {
                                InboxPayloadStore.saveTranscript(file, text)
                            }
                        }
                        val finalText = text.orEmpty()
                        if (finalText.isBlank()) {
                            postPendingState(
                                message = "Данные сохранены. Модель вернула пустой текст; повторю автоматически.",
                                reason = PendingReason.Transcription
                            )
                            return@Thread
                        }
                        deliverToInbox(client, file, finalText)
                        markAudioComplete(file)
                        inboxDelivered = true
                    } else {
                        val storedContext = ConversationContextStore.read(file)
                        val response = try {
                            client.uploadAudio(file, storedContext, ScreenshotContextStore.read(file))
                        } catch (error: ServerResponseException) {
                            if (isPermanentServerReject(error)) {
                                markAudioUnretryable(file)
                                permanentFailureMessage = permanentRejectMessage(error)
                                continue
                            }
                            throw error
                        }
                        val text = response.text.trim()
                        if (text.isBlank()) {
                            postPendingState(
                                message = "Запись сохранена. Модель вернула пустой текст; повторю автоматически.",
                                reason = PendingReason.Transcription
                            )
                            return@Thread
                        }
                        val transcriptFile = PendingTranscriptStore.add(this, text)
                        if (file.name == autoInsertAudioFileName) {
                            autoInsertTranscriptFile = transcriptFile.name
                        }
                        if (response.fallbackUsed) {
                            fallbackUsed = true
                            fallbackProvider = response.provider
                            fallbackModel = response.model
                        }
                        markAudioComplete(file)
                    }
                }
                val pendingRecordings = pendingAudioFiles(this).size
                val pendingTranscripts = PendingTranscriptStore.list(this).size
                if (pendingTranscripts > 0) {
                    AirWhisperBus.post(
                        RecorderState.TranscriptReady(
                            transcripts = pendingTranscripts,
                            autoInsertTranscriptFile = autoInsertTranscriptFile,
                            fallbackUsed = fallbackUsed,
                            provider = fallbackProvider,
                            model = fallbackModel
                        )
                    )
                } else if (pendingRecordings > 0) {
                    AirWhisperBus.post(
                        RecorderState.Pending(
                            message = "Есть сохраненные записи в очереди",
                            recordings = pendingRecordings,
                            transcripts = 0,
                            reason = PendingReason.Unknown
                        )
                    )
                } else if (permanentFailureMessage != null) {
                    AirWhisperBus.post(RecorderState.Error(permanentFailureMessage))
                } else if (inboxDelivered) {
                    AirWhisperBus.post(RecorderState.InboxDelivered)
                } else {
                    AirWhisperBus.post(RecorderState.Idle)
                }
            } catch (error: Throwable) {
                val (message, reason) = pendingStatusFor(error)
                postPendingState(message, reason)
            } finally {
                uploadInProgress.set(false)
                stopRecordingForeground()
                stopSelf()
            }
        }.start()
    }

    private fun deliverToInbox(client: NetworkClient, file: File, text: String) {
        val context = ConversationContextStore.read(file)
        val screenshot = ScreenshotContextStore.read(file)
        try {
            client.uploadInboxCommand(
                transcript = text,
                conversationContext = context,
                screenshotFile = screenshot,
                idempotencyKey = file.name
            )
        } catch (error: Throwable) {
            throw InboxDeliveryException(error.message ?: "Входящие не отвечают")
        }
    }

    private fun postPendingState(message: String, reason: PendingReason) {
        AirWhisperBus.post(
            RecorderState.Pending(
                message = message,
                recordings = pendingAudioFiles(this).size,
                transcripts = PendingTranscriptStore.list(this).size,
                reason = reason
            )
        )
    }

    private fun markAudioComplete(file: File) {
        ConversationContextStore.delete(file)
        ScreenshotContextStore.delete(file)
        InboxPayloadStore.delete(file)
        if (file.delete()) return
        file.renameTo(File(file.parentFile ?: recordingsDir(), "${file.name}.done"))
    }

    private fun markAudioUnretryable(file: File) {
        ConversationContextStore.delete(file)
        ScreenshotContextStore.delete(file)
        InboxPayloadStore.delete(file)
        val failedFile = File(file.parentFile ?: recordingsDir(), "${file.name}.failed")
        if (file.renameTo(failedFile)) return
        file.delete()
    }

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
            is InboxDeliveryException ->
                Pair("Команда сохранена. Входящие сейчас не отвечают; повторю автоматически.", PendingReason.Server)
            is UnknownHostException ->
                Pair("Запись сохранена. Нет интернета; когда связь вернется, Brai Cmd расшифрует ее сам.", PendingReason.Network)
            is SocketTimeoutException ->
                Pair("Запись сохранена. Сервер долго не отвечает; повторю отправку автоматически.", PendingReason.Server)
            is ServerResponseException ->
                if (error.code == "upstream_error") {
                    Pair("Запись сохранена. Модель расшифровки сейчас не отвечает; повторю автоматически.", PendingReason.Transcription)
                } else {
                    Pair("Запись сохранена. Сервер не принял запрос; повторю автоматически.", PendingReason.Server)
                }
            is IOException ->
                Pair("Запись сохранена. Сейчас нет связи с сервером; повторю отправку автоматически.", PendingReason.Network)
            else ->
                Pair("Запись сохранена. Не удалось отправить сейчас; повторю автоматически.", PendingReason.Unknown)
        }

    private fun isTooLargeForUpload(file: File): Boolean =
        file.length() > NetworkClient.MAX_AUDIO_BYTES

    private fun tooLargeMessage(file: File): String {
        val megabytes = ((file.length() + BYTES_PER_MEGABYTE - 1) / BYTES_PER_MEGABYTE).coerceAtLeast(1)
        return "Запись ${megabytes} МБ слишком большая для отправки и убрана из очереди."
    }

    private fun isPermanentServerReject(error: ServerResponseException): Boolean =
        error.statusCode == 413 ||
            error.code == "request_too_large" ||
            error.code == "audio_too_large" ||
            error.code == "unsupported_audio" ||
            error.code == "unsupported_media_type" ||
            error.code == "missing_audio"

    private fun permanentRejectMessage(error: ServerResponseException): String =
        when (error.code) {
            "request_too_large", "audio_too_large" ->
                "Запись слишком большая для отправки и убрана из очереди."
            "unsupported_audio", "unsupported_media_type", "missing_audio" ->
                "Запись повреждена или не поддерживается и убрана из очереди."
            else ->
                "Сервер не принял запись, она убрана из очереди."
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
                AirWhisperBus.post(RecorderState.Recording(amplitude))
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
        private const val BYTES_PER_MEGABYTE = 1024L * 1024L
        private const val NOTIFICATION_CHANNEL_ID = "airwhisper_recording"
        private const val NOTIFICATION_ID = 4007
        private const val ACTION_START = "world.brightos.brai.airwhisper.START_RECORDING"
        private const val ACTION_STOP = "world.brightos.brai.airwhisper.STOP_RECORDING"
        private const val ACTION_CANCEL = "world.brightos.brai.airwhisper.CANCEL_RECORDING"
        private const val ACTION_RETRY = "world.brightos.brai.airwhisper.RETRY_RECORDINGS"
        private const val EXTRA_SCREENSHOT_PATH = "world.brightos.brai.airwhisper.extra.SCREENSHOT_PATH"
        private const val EXTRA_INBOX_DELIVERY = "world.brightos.brai.airwhisper.extra.INBOX_DELIVERY"
        private val uploadInProgress = AtomicBoolean(false)

        fun start(
            context: Context,
            conversationContext: VisibleConversationContext? = null,
            screenshotFile: File? = null,
            deliverToInbox: Boolean = false
        ) {
            val intent = Intent(context, RecordingService::class.java).setAction(ACTION_START)
            VisibleConversationContext.putInto(intent, conversationContext)
            if (screenshotFile != null && screenshotFile.isFile) {
                intent.putExtra(EXTRA_SCREENSHOT_PATH, screenshotFile.absolutePath)
            }
            intent.putExtra(EXTRA_INBOX_DELIVERY, deliverToInbox)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
            } catch (error: Throwable) {
                screenshotFile?.delete()
                AirWhisperBus.post(RecorderState.Error(error.message ?: "Android заблокировал запуск микрофона"))
            }
        }

        fun stop(context: Context) {
            try {
                context.startService(Intent(context, RecordingService::class.java).setAction(ACTION_STOP))
            } catch (error: Throwable) {
                AirWhisperBus.post(RecorderState.Error(error.message ?: "Не удалось остановить запись"))
            }
        }

        fun cancel(context: Context) {
            try {
                context.startService(Intent(context, RecordingService::class.java).setAction(ACTION_CANCEL))
            } catch (error: Throwable) {
                AirWhisperBus.post(RecorderState.Error(error.message ?: "Не удалось отменить запись"))
            }
        }

        fun retryPending(context: Context) {
            val state = AirWhisperBus.latest
            if (uploadInProgress.get() ||
                state is RecorderState.Recording ||
                state is RecorderState.Uploading ||
                !hasPendingRecordings(context)
            ) {
                return
            }
            val intent = Intent(context, RecordingService::class.java).setAction(ACTION_RETRY)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
            } catch (error: Throwable) {
                AirWhisperBus.post(RecorderState.Error(error.message ?: "Не удалось повторить отправку сохраненной записи"))
            }
        }

        fun hasPendingRecordings(context: Context): Boolean = pendingAudioFiles(context).isNotEmpty()

        fun pendingRecordingsCount(context: Context): Int = pendingAudioFiles(context).size

        private fun pendingAudioFiles(context: Context): List<File> =
            File(context.filesDir, RECORDINGS_DIR)
                .listFiles { file ->
                    file.isFile &&
                        file.name.endsWith(".m4a", ignoreCase = true) &&
                        !file.name.contains(".recording.")
                }
                ?.sortedBy { it.lastModified() }
                .orEmpty()

        private fun screenshotFileFromIntent(intent: Intent?): File? {
            val path = intent?.getStringExtra(EXTRA_SCREENSHOT_PATH).orEmpty()
            if (path.isBlank()) return null
            return File(path).takeIf { it.isFile && it.length() > 0L }
        }
    }
}
