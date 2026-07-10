package world.brightos.brai.braicmd

import org.junit.Assert.assertFalse
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
}
