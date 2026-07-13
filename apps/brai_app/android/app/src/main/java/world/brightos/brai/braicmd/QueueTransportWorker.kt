package world.brightos.brai.braicmd

import android.content.Context
import android.media.MediaMetadataRetriever
import java.io.File
import java.io.IOException

internal enum class QueueTransportStatus {
    Drained,
    TransientFailure,
    Blocked,
    Superseded
}

internal data class QueueTransportResult(
    val status: QueueTransportStatus,
    val ownerId: String,
    val failure: Throwable? = null,
    val failedTransportIds: Set<String> = emptySet(),
    val autoInsertTranscriptFile: String? = null,
    val fallbackUsed: Boolean = false,
    val provider: String = "",
    val model: String = "",
    val inboxDelivered: Boolean = false,
    val serverNotice: BraiCmdNotice? = null,
    val permanentFailureMessage: String? = null
)

internal data class QueueExecutionContext(
    val owner: QueueOwnerScope,
    val accessToken: String,
    val transcriptionMode: String,
    val transcriptionProviderId: String,
    val transcriptionModel: String,
    val transcriptionApiKey: String,
    val postProcessingEnabled: Boolean,
    val postProcessingMode: String,
    val postProcessingProviderId: String,
    val postProcessingModel: String,
    val postProcessingBaseUrl: String,
    val postProcessingApiKey: String,
    val postProcessingPrompt: String
)

internal fun captureQueueExecutionContext(
    context: Context,
    config: ConfigStore = ConfigStore(context.applicationContext),
    secure: SecureStringStore = SecureStringStore(context.applicationContext)
): QueueExecutionContext {
    val access = config.queueAccessSnapshot()
    val settings = config.queueProviderSettingsSnapshot()
    if (access.owner.accountUserId == null) secure.migrateLegacyProviderKey(settings.postProcessingProviderId)
    fun ownerKey(providerId: String): String = access.owner.accountUserId?.let { userId ->
        if (providerId in ConfigStore.ACCOUNT_PROVIDER_IDS) secure.accountProviderKey(userId, providerId) else ""
    } ?: secure.localProviderKey(providerId)
    return QueueExecutionContext(
        owner = access.owner,
        accessToken = access.accessToken,
        transcriptionMode = settings.transcriptionMode,
        transcriptionProviderId = settings.transcriptionProviderId,
        transcriptionModel = settings.transcriptionModel,
        transcriptionApiKey = ownerKey(settings.transcriptionProviderId),
        postProcessingEnabled = settings.postProcessingEnabled,
        postProcessingMode = settings.postProcessingMode,
        postProcessingProviderId = settings.postProcessingProviderId,
        postProcessingModel = settings.postProcessingModel,
        postProcessingBaseUrl = settings.postProcessingBaseUrl,
        postProcessingApiKey = ownerKey(settings.postProcessingProviderId),
        postProcessingPrompt = settings.postProcessingPrompt
    )
}

internal class QueueTransportWorker(
    context: Context,
    private val directTranscriber: ((File) -> SpeechProviderResult)? = null,
    private val directPostProcessor: ((String, String) -> LlmProviderResult)? = null,
    private val cloudPostProcessor: ((String, String) -> CloudPostProcessingResponse)? = null
) {
    private val appContext = context.applicationContext
    private val client = NetworkClient(appContext)
    private var autoInsertTranscriptFile: String? = null
    private var fallbackUsed = false
    private var provider = ""
    private var model = ""
    private var inboxDelivered = false
    private var serverNotice: BraiCmdNotice? = null
    private var permanentFailureMessage: String? = null
    private lateinit var execution: QueueExecutionContext

    fun run(autoInsertAudioFileName: String?): QueueTransportResult {
        execution = captureQueueExecutionContext(appContext)
        val items = (
            AudioQueueStore.list(appContext).map { PendingItem.Audio(it) } +
                ScreenshotInboxStore.list(appContext).map { PendingItem.Screenshot(it) }
            ).sortedBy { it.file.lastModified() }

        for (item in items) {
            if (!item.file.exists()) continue
            try {
                val ownerId = QueueOwnerStore.readOwnerId(item.file) ?: throw QueueLegacyOwnerException()
                if (ownerId != execution.owner.ownerId) {
                    continue
                }
                ensureExecutionOwnerCurrent()
                when (item) {
                    is PendingItem.Audio -> processAudio(item.file, autoInsertAudioFileName)
                    is PendingItem.Screenshot -> processScreenshot(item.file)
                }
            } catch (error: Throwable) {
                if (error is QueueOwnerBlockedException) {
                    return result(QueueTransportStatus.Superseded, error)
                }
                if (error is ServerResponseException && error.statusCode == 401 &&
                    ConfigStore(appContext).clearAuthTokenIfMatches(execution.accessToken)
                ) {
                    BraiCmdPlugin.notifyCredentialRefreshRequired()
                }
                when (classifyQueueFailure(error)) {
                    QueueFailureDisposition.Transient ->
                        return result(QueueTransportStatus.TransientFailure, error, setOf(item.transportId))
                    QueueFailureDisposition.Blocked ->
                        return result(QueueTransportStatus.Blocked, error, setOf(item.transportId))
                    QueueFailureDisposition.Permanent -> {
                        val quarantined = when (item) {
                            is PendingItem.Audio -> AudioQueueStore.quarantine(appContext, item.file)
                            is PendingItem.Screenshot -> ScreenshotInboxStore.quarantine(appContext, item.file)
                        }
                        if (!quarantined) {
                            return result(
                                QueueTransportStatus.TransientFailure,
                                IOException("Не удалось переместить поврежденный элемент очереди"),
                                setOf(item.transportId)
                            )
                        }
                        permanentFailureMessage = permanentFailureMessage(error)
                    }
                }
            }
        }
        return result(QueueTransportStatus.Drained)
    }

    private fun processAudio(file: File, autoInsertAudioFileName: String?) {
        when {
            file.length() < MIN_AUDIO_BYTES ->
                throw QueueCorruptItemException("Данные повреждены")
            file.length() > NetworkClient.MAX_AUDIO_BYTES ->
                throw QueueCorruptItemException("Файл слишком большой")
        }

        val action = AudioQueueStore.action(file)
        val serverBound = InboxPayloadStore.isInboxPayload(file) || action.contextAction != null
        if (serverBound) {
            processInboxAudio(file, action)
        } else {
            processMainDictation(file, autoInsertAudioFileName)
        }
    }

    private fun processMainDictation(file: File, autoInsertAudioFileName: String?) {
        val response = transcribeAudio(
            file,
            ConversationContextStore.read(file),
            ScreenshotContextStore.read(file),
            AudioQueueAction.MainDictation.functionKey
        )
        ensureExecutionOwnerCurrent()
        val text = response.text.trim()
        if (text.isBlank()) throw QueueEmptyModelException()
        val transcriptFile = PendingTranscriptStore.addForAudio(
            appContext,
            file,
            text,
            PendingTranscriptKind.MainDictation
        )
        recordStatsOnce(file, response)
        if (file.name == autoInsertAudioFileName) autoInsertTranscriptFile = transcriptFile.name
        if (response.fallbackUsed) {
            fallbackUsed = true
            provider = response.provider
            model = response.model
        }
        completeAudio(file)
    }

    private fun processInboxAudio(file: File, action: AudioQueueAction) {
        var transcript = InboxPayloadStore.readTranscript(file)
        if (transcript == null) {
            val response = transcribeAudio(file, null, null, action.functionKey)
            transcript = response.text.trim()
            if (transcript.isBlank()) throw QueueEmptyModelException()
            recordStatsOnce(file, response)
            // Persist before Inbox delivery so retries never retranscribe a completed upload.
            InboxPayloadStore.saveTranscript(file, transcript)
        }
        ensureExecutionOwnerCurrent()
        serverNotice = client.uploadInboxCommand(
            transcript = inboxDeliveryText(action, InboxPayloadStore.readTextPrefix(file), transcript),
            conversationContext = ConversationContextStore.read(file),
            screenshotFile = ScreenshotContextStore.read(file),
            idempotencyKey = file.name,
            braiCmdFunction = action.functionKey,
            accessToken = execution.accessToken
        )
        completeAudio(file)
        inboxDelivered = true
    }

    private fun processScreenshot(file: File) {
        if (file.length() <= 0L) throw QueueCorruptItemException("Данные повреждены")
        ensureExecutionOwnerCurrent()
        serverNotice = client.uploadInboxCommand(
            transcript = SCREENSHOT_INBOX_TEXT,
            conversationContext = null,
            screenshotFile = file,
            idempotencyKey = file.name,
            braiCmdFunction = BRAI_CMD_FUNCTION_SCREENSHOT_INBOX,
            accessToken = execution.accessToken
        )
        if (!ScreenshotInboxStore.delete(file)) throw IOException("Не удалось удалить отправленный скриншот")
        inboxDelivered = true
    }

    private fun completeAudio(file: File) {
        if (!AudioQueueStore.complete(appContext, file)) {
            throw IOException("Не удалось исключить отправленную запись из очереди")
        }
    }

    private fun transcribeAudio(
        file: File,
        conversationContext: VisibleConversationContext?,
        screenshotFile: File?,
        braiCmdFunction: String
    ): DictationResponse {
        val checkpoint = TranscriptionCheckpointStore.read(file)
        val raw = checkpoint?.response ?: if (execution.transcriptionMode == "key") {
            ensureExecutionOwnerCurrent()
            val speech = directTranscriber?.invoke(file) ?: SpeechProviderClient(appContext).transcribe(
                file,
                execution.transcriptionProviderId,
                execution.transcriptionApiKey,
                execution.transcriptionModel
            )
            DictationResponse(
                text = speech.text,
                provider = speech.provider,
                model = speech.model,
                fallbackUsed = false,
                notice = null,
                audioDurationMs = audioDurationMs(file),
                postProcessed = false,
                postProcessingProvider = "",
                postProcessingModel = "",
                postProcessingInputChars = 0,
                postProcessingOutputChars = 0
            )
        } else {
            ensureExecutionOwnerCurrent()
            client.uploadAudio(
                file,
                conversationContext,
                screenshotFile,
                braiCmdFunction,
                cloudPostProcessingEnabled = execution.postProcessingEnabled && execution.postProcessingMode != "key",
                cloudPostProcessingPrompt = execution.postProcessingPrompt,
                accessToken = execution.accessToken
            )
        }
        if (checkpoint == null && raw.text.isNotBlank()) TranscriptionCheckpointStore.save(file, raw)
        if (!execution.postProcessingEnabled || raw.postProcessed || raw.text.isBlank()) return raw

        ensureExecutionOwnerCurrent()
        return if (execution.postProcessingMode == "key") {
            val result = directPostProcessor?.invoke(raw.text, execution.postProcessingPrompt)
                ?: LlmProviderClient(appContext).postProcess(
                    raw.text,
                    execution.postProcessingPrompt,
                    execution.postProcessingProviderId,
                    execution.postProcessingApiKey,
                    execution.postProcessingModel,
                    execution.postProcessingBaseUrl
                )
            raw.copy(
                text = result.text,
                postProcessed = true,
                postProcessingProvider = result.provider,
                postProcessingModel = result.model,
                postProcessingInputChars = result.inputChars,
                postProcessingOutputChars = result.outputChars
            )
        } else {
            val result = cloudPostProcessor?.invoke(raw.text, execution.postProcessingPrompt)
                ?: client.postProcessText(raw.text, execution.postProcessingPrompt, execution.accessToken)
            raw.copy(
                text = result.text,
                postProcessed = true,
                postProcessingProvider = result.provider,
                postProcessingModel = result.model,
                postProcessingInputChars = result.inputChars,
                postProcessingOutputChars = result.outputChars
            )
        }
    }

    private fun audioDurationMs(file: File): Long = runCatching {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        } finally {
            retriever.release()
        }
    }.getOrDefault(0L)

    private fun recordStats(file: File, response: DictationResponse) {
        BraiCmdStatsStore(appContext).recordSuccess(
            BraiCmdStatsInput(
                audioBytes = file.length(),
                audioDurationMs = response.audioDurationMs,
                transcriptChars = response.text.length,
                cloudInputChars = response.postProcessingInputChars,
                cloudOutputChars = response.postProcessingOutputChars,
                cloudRequest = response.postProcessed && response.postProcessingProvider == "brai-cloud"
            )
        )
    }

    private fun ensureExecutionOwnerCurrent() {
        if (QueueOwnerStore.current(appContext).ownerId != execution.owner.ownerId) {
            throw QueueOwnerBlockedException()
        }
    }

    private fun recordStatsOnce(file: File, response: DictationResponse) {
        if (TranscriptionCheckpointStore.read(file)?.statsRecorded == true) return
        recordStats(file, response)
        TranscriptionCheckpointStore.markStatsRecorded(file, response)
    }

    private fun result(
        status: QueueTransportStatus,
        failure: Throwable? = null,
        failedTransportIds: Set<String> = emptySet()
    ) =
        QueueTransportResult(
            status = status,
            ownerId = execution.owner.ownerId,
            failure = failure,
            failedTransportIds = failedTransportIds,
            autoInsertTranscriptFile = autoInsertTranscriptFile,
            fallbackUsed = fallbackUsed,
            provider = provider,
            model = model,
            inboxDelivered = inboxDelivered,
            serverNotice = serverNotice,
            permanentFailureMessage = permanentFailureMessage
        )

    private fun permanentFailureMessage(error: Throwable): String =
        when (error) {
            is QueueCorruptItemException -> error.message.orEmpty()
            is QueueLegacyOwnerException -> "Старая запись изолирована: владелец не подтверждён"
            is ServerResponseException -> when (error.statusCode) {
                413 -> "Файл слишком большой"
                415 -> "Формат не поддержан"
                422 -> "Данные повреждены"
                else -> "Запрос отклонён"
            }
            else -> "Данные повреждены"
        }

    private sealed class PendingItem(open val file: File) {
        abstract val transportId: String

        data class Audio(override val file: File) : PendingItem(file) {
            override val transportId: String = BraiCmdQueue.audioTransportId(file)
        }

        data class Screenshot(override val file: File) : PendingItem(file) {
            override val transportId: String = BraiCmdQueue.screenshotTransportId(file)
        }
    }

    private companion object {
        const val MIN_AUDIO_BYTES = 512L
        const val SCREENSHOT_INBOX_TEXT = "Скриншот"
    }
}
