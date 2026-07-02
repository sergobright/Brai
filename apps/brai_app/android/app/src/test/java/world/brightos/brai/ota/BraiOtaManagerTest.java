package world.brightos.brai.ota;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.FileNotFoundException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.zip.ZipException;

import org.junit.Test;

public class BraiOtaManagerTest {
    @Test
    public void pendingCandidateIsNotTheActiveVisibleBundle() {
        assertFalse(BraiOtaManager.isActiveCandidate("0.0.2", "0.0.1"));
        assertTrue(BraiOtaManager.isActiveCandidate("0.0.2", "0.0.2"));
    }

    @Test
    public void onlyLoadingCandidateIsFailedOnNextStartup() {
        assertFalse(BraiOtaManager.wasCandidateLoading("0.0.2", "candidate_ready_for_next_start"));
        assertTrue(BraiOtaManager.wasCandidateLoading("0.0.2", "candidate_loading"));
        assertFalse(BraiOtaManager.wasCandidateLoading(null, "candidate_loading"));
    }

    @Test
    public void roundsDownloadProgressPercent() {
        assertEquals(67, BraiOtaManager.downloadProgressPercent(2, 3));
        assertEquals(100, BraiOtaManager.downloadProgressPercent(5, 3));
        assertEquals(0, BraiOtaManager.downloadProgressPercent(1, 0));
    }

    @Test
    public void classifiesUpdateFailuresWithoutLeakingRawMessages() {
        assertEquals("network_connection_lost", BraiOtaManager.updateErrorCode(new SocketException("Software caused connection abort")));
        assertEquals("local_archive_missing", BraiOtaManager.updateErrorCode(new FileNotFoundException("open failed: ENOENT")));
        assertEquals("network_timeout", BraiOtaManager.updateErrorCode(new SocketTimeoutException("timeout")));
        assertEquals("network_unavailable", BraiOtaManager.updateErrorCode(new UnknownHostException("app.brightos.world")));
        assertEquals("archive_invalid_zip", BraiOtaManager.updateErrorCode(new ZipException("bad zip")));
        assertEquals("archive_checksum_mismatch", BraiOtaManager.updateErrorCode(new BraiOtaException("archive_checksum_mismatch")));
    }
}
