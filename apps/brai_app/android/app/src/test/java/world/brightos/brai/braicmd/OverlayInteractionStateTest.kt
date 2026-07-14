package world.brightos.brai.braicmd

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OverlayInteractionStateTest {
    @Test
    fun separateCancelIsReservedForMainDictation() {
        val recording = RecorderState.Recording(amplitude = 1)

        assertTrue(shouldShowStandaloneCancel(recording, RecordingButton.Main))
        assertFalse(shouldShowStandaloneCancel(recording, RecordingButton.Context))
        assertFalse(shouldShowStandaloneCancel(RecorderState.Uploading, RecordingButton.Main))
    }

    @Test
    fun secondaryButtonsFadeContinuouslyUntilTheyReachTheHub() {
        assertEquals(1f, secondaryCloseAlpha(0f), 0.001f)
        assertEquals(0.75f, secondaryCloseAlpha(0.25f), 0.001f)
        assertEquals(0.48f, secondaryCloseAlpha(0.52f), 0.001f)
        assertEquals(0f, secondaryCloseAlpha(1f), 0.001f)
    }

    @Test
    fun tapContextFirstVisibleStateIsRecordingNeverUploading() {
        val action = ContextButtonAction.ScreenshotVoiceInbox
        val states = listOf(
            contextRecordingStartingState(action),
            visibleContextButtonState(
                activeButton = RecordingButton.Context,
                activeAction = action,
                startingRecording = true,
                action = action,
                state = RecorderState.Uploading
            )
        )

        assertTrue(states.all { it is RecorderState.Recording })
        assertFalse(states.any { it is RecorderState.Uploading })
    }

    @Test
    fun screenshotOnlyKeepsItsProcessingSpinnerState() {
        val action = ContextButtonAction.ScreenshotInbox

        assertEquals(null, contextRecordingStartingState(action))
        assertTrue(
            visibleContextButtonState(
                activeButton = RecordingButton.Context,
                activeAction = action,
                startingRecording = true,
                action = action,
                state = RecorderState.Uploading
            ) is RecorderState.Uploading
        )
    }

    @Test
    fun contextRecordingStartDoesNotHideAnError() {
        val error = RecorderState.Error("Не удалось начать запись")

        assertEquals(
            error,
            visibleContextButtonState(
                activeButton = RecordingButton.Context,
                activeAction = ContextButtonAction.ScreenshotVoiceInbox,
                startingRecording = true,
                action = ContextButtonAction.ScreenshotVoiceInbox,
                state = error
            )
        )
    }

    @Test
    fun noticeTextDropsFinalDots() {
        assertEquals("Ждёт интернет", braiCmdNoticeText("  Ждёт интернет. "))
        assertEquals("Доступно обновление", braiCmdNoticeText("Доступно обновление。"))
    }

    @Test
    fun updateNoticeChainsOnlyAfterServerSuccess() {
        assertTrue(shouldShowUpdateNoticeAfter(BraiCmdNotice("Отправлено", BraiCmdNoticeTone.ServerSuccess)))
        assertFalse(shouldShowUpdateNoticeAfter(BraiCmdNotice("Текст скопирован", BraiCmdNoticeTone.LocalSuccess)))
        assertFalse(shouldShowUpdateNoticeAfter(BraiCmdNotice("Ждёт интернет", BraiCmdNoticeTone.LocalError)))
        assertFalse(shouldShowUpdateNoticeAfter(null))
    }

    @Test
    fun updateDotUsesOnlyAvailableOrApkRequiredFlags() {
        assertFalse(shouldShowUpdateDot(updateAvailable = false, apkUpdateRequired = false))
        assertTrue(shouldShowUpdateDot(updateAvailable = true, apkUpdateRequired = false))
        assertTrue(shouldShowUpdateDot(updateAvailable = false, apkUpdateRequired = true))
        assertFalse(shouldShowUpdateDot(updateAvailable = true, apkUpdateRequired = true, checkInProgress = true))
    }

    @Test
    fun queueIndicatorCountsOnlyFailedAudio() {
        val snapshot = BraiCmdQueueSnapshot(
            transport = QueueTransportCounts(
                main = 1,
                contextActions = mapOf(ContextButtonAction.ChatContextInbox to 1),
                unknown = 1
            ),
            failedTransport = QueueTransportCounts(
                main = 0,
                contextActions = mapOf(
                    ContextButtonAction.ChatContextInbox to 1,
                    ContextButtonAction.ScreenshotInbox to 1
                ),
                unknown = 1
            ),
            readyToInsert = QueueReadyToInsertCounts(mainDictation = 3, chatReply = 2)
        )

        assertEquals(1, failedAudioCount(snapshot))
        assertEquals(1, failedAudioCount(snapshot, ContextButtonAction.ChatContextInbox))
        assertEquals(0, failedAudioCount(snapshot, ContextButtonAction.ScreenshotInbox))
    }

    @Test
    fun contextButtonDependsOnModeAndActionsNotTransportCredential() {
        assertTrue(contextButtonAvailable(overlayEnabled = true, voiceOnly = false, enabledActions = 1))
        assertFalse(contextButtonAvailable(overlayEnabled = true, voiceOnly = true, enabledActions = 1))
        assertFalse(contextButtonAvailable(overlayEnabled = false, voiceOnly = false, enabledActions = 1))
        assertFalse(contextButtonAvailable(overlayEnabled = true, voiceOnly = false, enabledActions = 0))
    }
}
