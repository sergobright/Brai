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
    public void newerEmbeddedBundleWinsOverStaleStoredOta() {
        assertTrue(BraiOtaManager.shouldPreferFallbackBundle("0.0.10", "0.0.73"));
        assertFalse(BraiOtaManager.shouldPreferFallbackBundle("0.0.73", "0.0.73"));
        assertFalse(BraiOtaManager.shouldPreferFallbackBundle("0.0.74", "0.0.73"));
    }

    @Test
    public void updateIndicatorFollowsAvailableVersionOrApkRequirement() {
        assertFalse(BraiOtaManager.isUpdateAvailable(null, "0.0.73", null, false));
        assertFalse(BraiOtaManager.isUpdateAvailable("0.0.73", "0.0.73", null, false));
        assertTrue(BraiOtaManager.isUpdateAvailable("0.0.74", "0.0.73", null, false));
        assertTrue(BraiOtaManager.isUpdateAvailable("0.0.73", "0.0.73", null, true));
    }

    @Test
    public void installedTargetApkClearsStoredApkUpdateRequirement() {
        assertFalse(BraiOtaManager.isApkUpdateRequired(true, 60004, "60004"));
        assertTrue(BraiOtaManager.isApkUpdateRequired(true, 60003, "60004"));
        assertTrue(BraiOtaManager.isApkUpdateRequired(true, 60004, null));
    }

    @Test
    public void roundsDownloadProgressPercent() {
        assertEquals(67, BraiOtaManager.downloadProgressPercent(2, 3));
        assertEquals(100, BraiOtaManager.downloadProgressPercent(5, 3));
        assertEquals(0, BraiOtaManager.downloadProgressPercent(1, 0));
    }

    @Test
    public void buildsInstalledChannelDownloadUrlAndFileName() {
        assertEquals("https://api.b.test.brai.one/releases/download/b", BraiOtaManager.apkDownloadUrl("https://api.b.test.brai.one/", "b"));
        assertEquals("brai-b-update-60004.apk", BraiOtaManager.apkDownloadFileName("b", "60004"));
    }

    @Test
    public void preventsDuplicateApkDownloadsForTheSameTarget() {
        assertFalse(BraiOtaManager.shouldStartApkDownload("downloading", "60004", "60005"));
        assertFalse(BraiOtaManager.shouldStartApkDownload("downloaded", "60004", "60004"));
        assertTrue(BraiOtaManager.shouldStartApkDownload("downloaded", "60004", "60005"));
        assertTrue(BraiOtaManager.shouldStartApkDownload("failed", "60004", "60004"));
    }

    @Test
    public void cleansStoredApkOnlyAfterTheTargetWasInstalled() {
        assertFalse(BraiOtaManager.isInstalledApkTarget(90001, "90002"));
        assertTrue(BraiOtaManager.isInstalledApkTarget(90002, "90002"));
        assertFalse(BraiOtaManager.isInstalledApkTarget(90002, "unknown"));
    }

    @Test
    public void requiresExactApkLengthAndChecksum() {
        BraiOtaArchive.DownloadResult result = new BraiOtaArchive.DownloadResult("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 12);
        assertTrue(BraiOtaManager.isValidApkDownload(12, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", result));
        assertFalse(BraiOtaManager.isValidApkDownload(11, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", result));
        assertFalse(BraiOtaManager.isValidApkDownload(12, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", result));
    }

    @Test
    public void classifiesUpdateFailuresWithoutLeakingRawMessages() {
        assertEquals("network_connection_lost", BraiOtaManager.updateErrorCode(new SocketException("Software caused connection abort")));
        assertEquals("local_archive_missing", BraiOtaManager.updateErrorCode(new FileNotFoundException("open failed: ENOENT")));
        assertEquals("network_timeout", BraiOtaManager.updateErrorCode(new SocketTimeoutException("timeout")));
        assertEquals("network_unavailable", BraiOtaManager.updateErrorCode(new UnknownHostException("app.brai.one")));
        assertEquals("archive_invalid_zip", BraiOtaManager.updateErrorCode(new ZipException("bad zip")));
        assertEquals("archive_checksum_mismatch", BraiOtaManager.updateErrorCode(new BraiOtaException("archive_checksum_mismatch")));
    }
}
