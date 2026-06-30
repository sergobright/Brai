package world.brightos.bright_os_client.ota;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.FileNotFoundException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.zip.ZipException;

import org.junit.Test;

public class BrightOtaManagerTest {
    @Test
    public void pendingCandidateIsNotTheActiveVisibleBundle() {
        assertFalse(BrightOtaManager.isActiveCandidate("0.0.1.2", "0.0.1.1"));
        assertTrue(BrightOtaManager.isActiveCandidate("0.0.1.2", "0.0.1.2"));
    }

    @Test
    public void onlyLoadingCandidateIsFailedOnNextStartup() {
        assertFalse(BrightOtaManager.wasCandidateLoading("0.0.1.2", "candidate_ready_for_next_start"));
        assertTrue(BrightOtaManager.wasCandidateLoading("0.0.1.2", "candidate_loading"));
        assertFalse(BrightOtaManager.wasCandidateLoading(null, "candidate_loading"));
    }

    @Test
    public void roundsDownloadProgressPercent() {
        assertEquals(67, BrightOtaManager.downloadProgressPercent(2, 3));
        assertEquals(100, BrightOtaManager.downloadProgressPercent(5, 3));
        assertEquals(0, BrightOtaManager.downloadProgressPercent(1, 0));
    }

    @Test
    public void classifiesUpdateFailuresWithoutLeakingRawMessages() {
        assertEquals("network_connection_lost", BrightOtaManager.updateErrorCode(new SocketException("Software caused connection abort")));
        assertEquals("local_archive_missing", BrightOtaManager.updateErrorCode(new FileNotFoundException("open failed: ENOENT")));
        assertEquals("network_timeout", BrightOtaManager.updateErrorCode(new SocketTimeoutException("timeout")));
        assertEquals("network_unavailable", BrightOtaManager.updateErrorCode(new UnknownHostException("app.brightos.world")));
        assertEquals("archive_invalid_zip", BrightOtaManager.updateErrorCode(new ZipException("bad zip")));
        assertEquals("archive_checksum_mismatch", BrightOtaManager.updateErrorCode(new BrightOtaException("archive_checksum_mismatch")));
    }
}
