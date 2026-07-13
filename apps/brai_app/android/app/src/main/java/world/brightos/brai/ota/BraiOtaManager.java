package world.brightos.brai.ota;

import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;

import androidx.core.content.pm.PackageInfoCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.ServerPath;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.zip.ZipException;

import javax.net.ssl.SSLException;

import world.brightos.brai.BuildConfig;

public final class BraiOtaManager {
    private static final String PREFS_NAME = "brai_ota_state";
    private static final String KEY_STABLE_VERSION = "stableBundleVersion";
    private static final String KEY_STABLE_PATH = "stableBundlePath";
    private static final String KEY_PREVIOUS_STABLE_VERSION = "previousStableBundleVersion";
    private static final String KEY_PREVIOUS_STABLE_PATH = "previousStableBundlePath";
    private static final String KEY_CANDIDATE_VERSION = "candidateBundleVersion";
    private static final String KEY_CANDIDATE_PATH = "candidateBundlePath";
    private static final String KEY_AVAILABLE_VERSION = "availableBundleVersion";
    private static final String KEY_APK_UPDATE_REQUIRED = "apkUpdateRequired";
    private static final String KEY_FAILED_VERSIONS = "failedBundleVersions";
    private static final String KEY_LAST_STATUS = "lastCheckStatus";
    private static final String KEY_LAST_ERROR = "lastUpdateError";
    private static final String KEY_LAST_READY_VERSION = "lastReadyBundleVersion";
    private static final String KEY_LAST_TARGET_APK_VERSION = "lastTargetApkVersion";
    private static final String KEY_LAST_TARGET_APK_RELEASE_KEY = "lastTargetApkReleaseKey";
    private static final String KEY_LAST_TARGET_APK_BUILD_KIND = "lastTargetApkBuildKind";
    private static final String KEY_LAST_TARGET_APK_PREVIEW_ITERATION = "lastTargetApkPreviewIteration";
    private static final String KEY_LAST_TARGET_APK_VERSION_CODE = "lastTargetApkVersionCode";
    private static final String KEY_APK_DOWNLOAD_ID = "apkDownloadId";
    private static final String KEY_APK_DOWNLOAD_STATUS = "apkDownloadStatus";
    private static final String KEY_APK_DOWNLOAD_ERROR = "apkDownloadError";
    private static final String KEY_APK_DOWNLOAD_TARGET = "apkDownloadTarget";
    private static final int NETWORK_TIMEOUT_MS = 7000;
    private static final int READY_TIMEOUT_MS = 15000;

    private final Context context;
    private final SharedPreferences prefs;
    private final Handler mainHandler;
    private Bridge bridge;
    private String activeBundleVersion;
    private Runnable readinessTimeout;
    private boolean checkInProgress;
    private boolean webDownloadInProgress;
    private String downloadProgressVersion;
    private long downloadProgressBytes;
    private long downloadProgressTotalBytes;

    public BraiOtaManager(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.activeBundleVersion = fallbackBundleVersion();
    }

    public ServerPath startupServerPath() {
        String candidateVersion = prefs.getString(KEY_CANDIDATE_VERSION, null);
        String candidatePath = prefs.getString(KEY_CANDIDATE_PATH, null);
        String lastStatus = prefs.getString(KEY_LAST_STATUS, "unknown");
        if (candidateVersion != null) {
            if (wasCandidateLoading(candidateVersion, lastStatus)) {
                markFailedVersion(candidateVersion);
                clearCandidate("candidate_not_ready_before_restart");
            } else if (candidatePath != null && new File(candidatePath, "index.html").isFile()) {
                activeBundleVersion = candidateVersion;
                recordStatus("candidate_loading", null);
                return new ServerPath(ServerPath.PathType.BASE_PATH, candidatePath);
            } else {
                markFailedVersion(candidateVersion);
                clearCandidate("candidate_missing_entrypoint");
            }
        }

        String stableVersion = prefs.getString(KEY_STABLE_VERSION, null);
        String stablePath = prefs.getString(KEY_STABLE_PATH, null);
        if (stableVersion != null && stablePath != null && new File(stablePath, "index.html").isFile()) {
            if (!shouldPreferFallbackBundle(stableVersion, fallbackBundleVersion())) {
                activeBundleVersion = stableVersion;
                recordStatus("startup_stable", null);
                return new ServerPath(ServerPath.PathType.BASE_PATH, stablePath);
            }
            clearStableIfOlderThanFallback(stableVersion);
        }

        clearStableIfMissing();
        activeBundleVersion = fallbackBundleVersion();
        recordStatus("startup_fallback", null);
        return null;
    }

    public void attachBridge(Bridge bridge) {
        this.bridge = bridge;
        synchronized (this) {
            String candidateVersion = prefs.getString(KEY_CANDIDATE_VERSION, null);
            if (isActiveCandidate(candidateVersion, activeBundleVersion)) {
                scheduleReadinessTimeout(candidateVersion);
            }
        }
    }

    public synchronized boolean checkForUpdatesAsync() {
        if (checkInProgress || webDownloadInProgress) return false;
        checkInProgress = true;
        recordStatus("checking", null);
        Thread worker = new Thread(() -> {
            try {
                checkForUpdates();
            } catch (Exception error) {
                recordStatus("check_failed", updateErrorCode(error));
            } finally {
                synchronized (BraiOtaManager.this) {
                    checkInProgress = false;
                }
            }
        }, "BraiOtaUpdateCheck");
        worker.setDaemon(true);
        worker.start();
        return true;
    }

    public synchronized boolean downloadUpdateAsync() {
        if (checkInProgress || webDownloadInProgress) return false;
        webDownloadInProgress = true;
        Thread worker = new Thread(() -> {
            try {
                BraiOtaManifest manifest = discoverUpdate();
                if (manifest != null) stageUpdate(manifest);
            } catch (Exception error) {
                recordStatus("download_failed", updateErrorCode(error));
            } finally {
                synchronized (BraiOtaManager.this) {
                    webDownloadInProgress = false;
                }
            }
        }, "BraiOtaUpdateDownload");
        worker.setDaemon(true);
        worker.start();
        return true;
    }

    public synchronized boolean downloadApk() {
        reconcileApkDownload();
        String status = prefs.getString(KEY_APK_DOWNLOAD_STATUS, "idle");
        String target = prefs.getString(KEY_LAST_TARGET_APK_VERSION_CODE, "unknown");
        if (!shouldStartApkDownload(status, prefs.getString(KEY_APK_DOWNLOAD_TARGET, null), target)) return false;
        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            recordApkDownload("failed", "download_manager_unavailable", -1, target);
            return false;
        }
        String releaseKey = BuildConfig.BRAI_APK_RELEASE_KEY;
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(apkDownloadUrl(BuildConfig.BRAI_ANDROID_API, releaseKey)))
            .setTitle("Brai — обновление приложения")
            .setDescription("Скачивается APK " + BuildConfig.BRAI_APP_LABEL)
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, apkDownloadFileName(releaseKey, target));
        try {
            long downloadId = manager.enqueue(request);
            recordApkDownload("downloading", null, downloadId, target);
            return true;
        } catch (RuntimeException error) {
            recordApkDownload("failed", updateErrorCode(error), -1, target);
            return false;
        }
    }

    public synchronized JSObject stateJson() {
        reconcileApkDownload();
        JSObject state = new JSObject();
        state.put("fallbackBundleVersion", fallbackBundleVersion());
        state.put("activeBundleVersion", activeBundleVersion);
        state.put("nativeVersionName", BuildConfig.VERSION_NAME);
        state.put("nativeApkVersion", nativeApkVersion());
        state.put("nativeBuild", BuildConfig.BRAI_APP_BUILD);
        state.put("nativeVersionCode", installedVersionCodeOrZero());
        state.put("nativeEnvironment", BuildConfig.BRAI_ENVIRONMENT);
        state.put("nativePreviewSlot", BuildConfig.BRAI_PREVIEW_SLOT);
        state.put("nativeApkReleaseKey", BuildConfig.BRAI_APK_RELEASE_KEY);
        state.put("nativeApkBuildKind", BuildConfig.BRAI_APK_BUILD_KIND);
        state.put("nativeApkPreviewIteration", BuildConfig.BRAI_APK_PREVIEW_ITERATION);
        state.put("nativeOtaChannel", BuildConfig.BRAI_OTA_CHANNEL);
        state.put("nativeAppLabel", BuildConfig.BRAI_APP_LABEL);
        state.put("stableBundleVersion", prefs.getString(KEY_STABLE_VERSION, null));
        state.put("previousStableBundleVersion", prefs.getString(KEY_PREVIOUS_STABLE_VERSION, null));
        state.put("candidateBundleVersion", prefs.getString(KEY_CANDIDATE_VERSION, null));
        String availableVersion = prefs.getString(KEY_AVAILABLE_VERSION, null);
        boolean apkRequired = isApkUpdateRequired(
            prefs.getBoolean(KEY_APK_UPDATE_REQUIRED, false),
            installedVersionCodeOrZero(),
            prefs.getString(KEY_LAST_TARGET_APK_VERSION_CODE, null)
        );
        state.put("availableBundleVersion", availableVersion);
        state.put("updateAvailable", isUpdateAvailable(
            availableVersion,
            activeBundleVersion,
            prefs.getString(KEY_CANDIDATE_VERSION, null),
            apkRequired
        ));
        state.put("apkUpdateRequired", apkRequired);
        state.put("lastCheckStatus", prefs.getString(KEY_LAST_STATUS, "unknown"));
        state.put("lastUpdateError", prefs.getString(KEY_LAST_ERROR, null));
        state.put("targetApkVersion", prefs.getString(KEY_LAST_TARGET_APK_VERSION, null));
        state.put("targetApkReleaseKey", prefs.getString(KEY_LAST_TARGET_APK_RELEASE_KEY, null));
        state.put("targetApkBuildKind", prefs.getString(KEY_LAST_TARGET_APK_BUILD_KIND, null));
        state.put("targetApkPreviewIteration", prefs.getString(KEY_LAST_TARGET_APK_PREVIEW_ITERATION, null));
        state.put("targetApkVersionCode", prefs.getString(KEY_LAST_TARGET_APK_VERSION_CODE, null));
        state.put("targetApkReleaseUrl", apkDownloadUrl(BuildConfig.BRAI_ANDROID_API, BuildConfig.BRAI_APK_RELEASE_KEY));
        state.put("failedBundleVersions", prefs.getString(KEY_FAILED_VERSIONS, ""));
        state.put("checkInProgress", checkInProgress);
        String apkDownloadStatus = currentApkDownloadStatus();
        state.put("activeOperation", checkInProgress ? "checking" : webDownloadInProgress ? "web_download" : "downloading".equals(apkDownloadStatus) ? "apk_download" : null);
        state.put("apkDownloadStatus", apkDownloadStatus);
        state.put("apkDownloadError", prefs.getString(KEY_APK_DOWNLOAD_ERROR, null));
        state.put("downloadProgressVersion", downloadProgressVersion);
        state.put("downloadProgressBytes", downloadProgressBytes);
        state.put("downloadProgressTotalBytes", downloadProgressTotalBytes);
        state.put("downloadProgressPercent", downloadProgressTotalBytes > 0 ? downloadProgressPercent(downloadProgressBytes, downloadProgressTotalBytes) : null);
        return state;
    }

    public synchronized boolean markReady(String bundleVersion) {
        String readyVersion = normalizeReadyVersion(bundleVersion);
        prefs.edit().putString(KEY_LAST_READY_VERSION, readyVersion).apply();

        String candidateVersion = prefs.getString(KEY_CANDIDATE_VERSION, null);
        if (candidateVersion == null) {
            if (readyVersion.equals(activeBundleVersion)) {
                recordStatus("ready", null);
                return false;
            }
            recordStatus("ready_version_mismatch", "ready=" + readyVersion + " active=" + activeBundleVersion);
            return false;
        }

        if (!isActiveCandidate(candidateVersion, activeBundleVersion)) {
            if (readyVersion.equals(activeBundleVersion)) {
                recordStatus("ready_candidate_pending", candidateVersion);
                return false;
            }
            recordStatus("ready_version_mismatch", "ready=" + readyVersion + " active=" + activeBundleVersion);
            return false;
        }

        if (!candidateVersion.equals(readyVersion)) {
            failCandidate("readiness_version_mismatch");
            return false;
        }

        if (readinessTimeout != null) {
            mainHandler.removeCallbacks(readinessTimeout);
            readinessTimeout = null;
        }

        String currentStableVersion = prefs.getString(KEY_STABLE_VERSION, null);
        String currentStablePath = prefs.getString(KEY_STABLE_PATH, null);
        String candidatePath = prefs.getString(KEY_CANDIDATE_PATH, null);
        prefs.edit()
            .putString(KEY_PREVIOUS_STABLE_VERSION, currentStableVersion)
            .putString(KEY_PREVIOUS_STABLE_PATH, currentStablePath)
            .putString(KEY_STABLE_VERSION, candidateVersion)
            .putString(KEY_STABLE_PATH, candidatePath)
            .remove(KEY_CANDIDATE_VERSION)
            .remove(KEY_CANDIDATE_PATH)
            .remove(KEY_AVAILABLE_VERSION)
            .remove(KEY_APK_UPDATE_REQUIRED)
            .putString(KEY_LAST_STATUS, "candidate_promoted")
            .remove(KEY_LAST_ERROR)
            .apply();
        activeBundleVersion = candidateVersion;
        return true;
    }

    public synchronized void handleCandidateLoadFailure(String reason) {
        String candidateVersion = prefs.getString(KEY_CANDIDATE_VERSION, null);
        if (candidateVersion != null && candidateVersion.equals(activeBundleVersion)) {
            failCandidate(reason);
        }
    }

    private void checkForUpdates() throws Exception {
        BraiOtaManifest manifest = discoverUpdate();
        if (manifest != null) recordStatus("update_available", null);
    }

    private BraiOtaManifest discoverUpdate() throws Exception {
        recordStatus("checking", null);
        URL manifestUrl = new URL(BuildConfig.BRAI_OTA_MANIFEST_URL);
        BraiOtaManifest manifest = BraiOtaManifest.parse(readText(manifestUrl));
        recordManifestApkVersions(manifest);
        try {
            manifest.validate(
                manifestUrl,
                nativeApkVersionNumber(),
                BuildConfig.BRAI_APK_RELEASE_KEY,
                BuildConfig.BRAI_APK_BUILD_KIND,
                BuildConfig.BRAI_APK_PREVIEW_ITERATION
            );
        } catch (BraiOtaException error) {
            if ("apk_required".equals(error.getMessage())) {
                recordAvailableUpdate(manifest, true);
                recordStatus("apk_required", error.getMessage());
                return null;
            }
            throw error;
        }

        synchronized (this) {
            if (!manifest.isNewerThan(activeBundleVersion)) {
                clearAvailableUpdate();
                recordStatus("up_to_date", null);
                return null;
            }
            recordAvailableUpdate(manifest, false);
            if (failedVersions().contains(manifest.otaVersion)) {
                recordStatus("skipped_failed_bundle", manifest.otaVersion);
                return null;
            }
            if (manifest.otaVersion.equals(prefs.getString(KEY_CANDIDATE_VERSION, null))) {
                recordStatus("candidate_already_pending", manifest.otaVersion);
                return null;
            }
        }

        return manifest;
    }

    private void stageUpdate(BraiOtaManifest manifest) throws Exception {
        File archive = null;
        try {
            recordStatus("downloading", null);
            recordDownloadProgress(manifest.otaVersion, 0, manifest.sizeBytes);
            archive = downloadArchive(manifest);
            verifyArchive(manifest, archive);

            File bundleDir = new File(bundlesDir(), safeVersion(manifest.otaVersion));
            BraiOtaArchive.extractZip(archive, bundleDir, manifest.entrypoint);
            if (!archive.delete() && archive.exists()) {
                recordStatus("archive_cleanup_failed", archive.getAbsolutePath());
            }

            synchronized (this) {
                prefs.edit()
                    .putString(KEY_CANDIDATE_VERSION, manifest.otaVersion)
                    .putString(KEY_CANDIDATE_PATH, bundleDir.getAbsolutePath())
                    .putString(KEY_AVAILABLE_VERSION, manifest.otaVersion)
                    .putBoolean(KEY_APK_UPDATE_REQUIRED, false)
                    .putString(KEY_LAST_STATUS, "candidate_ready_for_next_start")
                    .remove(KEY_LAST_ERROR)
                    .apply();
            }
        } catch (Exception error) {
            if (archive != null && archive.exists() && !archive.delete()) {
                recordStatus("archive_cleanup_failed", archive.getAbsolutePath());
            }
            throw error;
        }
    }

    private synchronized void reconcileApkDownload() {
        long downloadId = prefs.getLong(KEY_APK_DOWNLOAD_ID, -1);
        if (downloadId < 0 || !"downloading".equals(prefs.getString(KEY_APK_DOWNLOAD_STATUS, "idle"))) return;
        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) return;
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
            if (cursor == null || !cursor.moveToFirst()) {
                recordApkDownload("failed", "download_not_found", -1, null);
                return;
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                recordApkDownload("downloaded", null, downloadId, null);
            } else if (status == DownloadManager.STATUS_FAILED) {
                int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                recordApkDownload("failed", "download_manager_" + reason, downloadId, null);
            }
        } catch (RuntimeException error) {
            recordApkDownload("failed", updateErrorCode(error), downloadId, null);
        }
    }

    private String currentApkDownloadStatus() {
        String status = prefs.getString(KEY_APK_DOWNLOAD_STATUS, "idle");
        if ("downloading".equals(status)) return status;
        String currentTarget = prefs.getString(KEY_LAST_TARGET_APK_VERSION_CODE, "unknown");
        return currentTarget.equals(prefs.getString(KEY_APK_DOWNLOAD_TARGET, null)) ? status : "idle";
    }

    private void recordApkDownload(String status, String error, long downloadId, String target) {
        SharedPreferences.Editor editor = prefs.edit().putString(KEY_APK_DOWNLOAD_STATUS, status);
        if (downloadId < 0) editor.remove(KEY_APK_DOWNLOAD_ID); else editor.putLong(KEY_APK_DOWNLOAD_ID, downloadId);
        if (error == null) editor.remove(KEY_APK_DOWNLOAD_ERROR); else editor.putString(KEY_APK_DOWNLOAD_ERROR, error);
        if (target != null) editor.putString(KEY_APK_DOWNLOAD_TARGET, target);
        editor.apply();
    }

    private synchronized void scheduleReadinessTimeout(String version) {
        if (readinessTimeout != null) {
            mainHandler.removeCallbacks(readinessTimeout);
        }
        readinessTimeout = () -> {
            synchronized (BraiOtaManager.this) {
                if (version.equals(prefs.getString(KEY_CANDIDATE_VERSION, null))) {
                    failCandidate("readiness_timeout");
                }
            }
        };
        mainHandler.postDelayed(readinessTimeout, READY_TIMEOUT_MS);
    }

    private synchronized void failCandidate(String reason) {
        String candidateVersion = prefs.getString(KEY_CANDIDATE_VERSION, null);
        String candidatePath = prefs.getString(KEY_CANDIDATE_PATH, null);
        if (candidateVersion != null) {
            markFailedVersion(candidateVersion);
        }
        clearCandidate(reason);
        if (candidatePath != null) {
            try {
                BraiOtaArchive.deleteRecursively(new File(candidatePath));
            } catch (IOException ignored) {
                // Diagnostics already record the failed bundle; deletion is best effort.
            }
        }
        rollbackToKnownGood();
    }

    private void rollbackToKnownGood() {
        String stableVersion = prefs.getString(KEY_STABLE_VERSION, null);
        String stablePath = prefs.getString(KEY_STABLE_PATH, null);
        if (stableVersion != null && stablePath != null && new File(stablePath, "index.html").isFile()) {
            activeBundleVersion = stableVersion;
            if (bridge != null) bridge.setServerBasePath(stablePath);
            return;
        }

        activeBundleVersion = fallbackBundleVersion();
        if (bridge != null) bridge.setServerAssetPath("public");
    }

    private File downloadArchive(BraiOtaManifest manifest) throws Exception {
        URL archiveUrl = manifest.archiveUrl();
        File downloadDir = new File(context.getFilesDir(), "brai-ota-downloads");
        if (!downloadDir.mkdirs() && !downloadDir.isDirectory()) {
            throw new IOException("Unable to create download directory");
        }
        String filename = safeVersion(manifest.otaVersion) + ".zip";
        File archive = new File(downloadDir, filename);
        File partial = new File(downloadDir, filename + ".part");
        if (partial.exists() && !partial.delete()) {
            throw new IOException("Unable to remove previous partial download");
        }
        if (archive.exists() && !archive.delete()) {
            throw new IOException("Unable to replace previous downloaded archive");
        }
        HttpURLConnection connection = (HttpURLConnection) archiveUrl.openConnection();
        try {
            connection.setConnectTimeout(NETWORK_TIMEOUT_MS);
            connection.setReadTimeout(NETWORK_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/zip, application/octet-stream");
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new BraiOtaException("archive_download_http_" + status);
            }
            byte[] buffer = new byte[64 * 1024];
            long downloadedBytes = 0;
            try (InputStream input = new BufferedInputStream(connection.getInputStream());
                BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(partial))) {
                int read;
                while ((read = input.read(buffer)) != -1) {
                    downloadedBytes += read;
                    if (downloadedBytes > manifest.sizeBytes || downloadedBytes > BraiOtaArchive.MAX_ARCHIVE_BYTES) {
                        throw new BraiOtaException("archive_download_size_exceeded");
                    }
                    recordDownloadProgress(manifest.otaVersion, downloadedBytes, manifest.sizeBytes);
                    output.write(buffer, 0, read);
                }
            } catch (Exception error) {
                if (partial.exists() && !partial.delete()) {
                    recordStatus("archive_cleanup_failed", partial.getAbsolutePath());
                }
                throw error;
            }
        } finally {
            connection.disconnect();
        }
        if (!partial.renameTo(archive)) {
            if (partial.exists() && !partial.delete()) {
                recordStatus("archive_cleanup_failed", partial.getAbsolutePath());
            }
            throw new IOException("Unable to store downloaded archive");
        }
        return archive;
    }

    private String readText(URL url) throws IOException, BraiOtaException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setConnectTimeout(NETWORK_TIMEOUT_MS);
            connection.setReadTimeout(NETWORK_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new BraiOtaException("manifest_http_" + status);
            }
            StringBuilder builder = new StringBuilder();
            byte[] buffer = new byte[16 * 1024];
            try (InputStream input = new BufferedInputStream(connection.getInputStream())) {
                int read;
                while ((read = input.read(buffer)) != -1) {
                    builder.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
                }
            }
            return builder.toString();
        } finally {
            connection.disconnect();
        }
    }

    private int installedVersionCode() throws Exception {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        return (int) PackageInfoCompat.getLongVersionCode(info);
    }

    private int installedVersionCodeOrZero() {
        try {
            return installedVersionCode();
        } catch (Exception ignored) {
            return 0;
        }
    }

    private void clearStableIfMissing() {
        prefs.edit()
            .remove(KEY_STABLE_VERSION)
            .remove(KEY_STABLE_PATH)
            .apply();
    }

    private void clearStableIfOlderThanFallback(String stableVersion) {
        prefs.edit()
            .putString(KEY_PREVIOUS_STABLE_VERSION, stableVersion)
            .remove(KEY_STABLE_VERSION)
            .remove(KEY_STABLE_PATH)
            .apply();
    }

    private void clearCandidate(String reason) {
        prefs.edit()
            .remove(KEY_CANDIDATE_VERSION)
            .remove(KEY_CANDIDATE_PATH)
            .putString(KEY_LAST_STATUS, "candidate_failed")
            .putString(KEY_LAST_ERROR, reason)
            .apply();
    }

    private synchronized void recordStatus(String status, String error) {
        if (!"downloading".equals(status)) {
            recordDownloadProgress(null, 0, 0);
        }
        SharedPreferences.Editor editor = prefs.edit().putString(KEY_LAST_STATUS, status);
        if (error == null) {
            editor.remove(KEY_LAST_ERROR);
        } else {
            editor.putString(KEY_LAST_ERROR, error);
        }
        editor.apply();
    }

    private synchronized void recordDownloadProgress(String version, long bytes, long totalBytes) {
        downloadProgressVersion = version;
        downloadProgressBytes = Math.max(0, bytes);
        downloadProgressTotalBytes = Math.max(0, totalBytes);
    }

    private Set<String> failedVersions() {
        Set<String> failed = new LinkedHashSet<>();
        String raw = prefs.getString(KEY_FAILED_VERSIONS, "");
        if (raw == null || raw.trim().isEmpty()) return failed;
        for (String value : raw.split(",")) {
            String trimmed = value.trim();
            if (!trimmed.isEmpty()) failed.add(trimmed);
        }
        return failed;
    }

    private void markFailedVersion(String version) {
        Set<String> failed = failedVersions();
        failed.add(version);
        prefs.edit().putString(KEY_FAILED_VERSIONS, String.join(",", failed)).apply();
    }

    private File bundlesDir() {
        return new File(context.getFilesDir(), "brai-ota-bundles");
    }

    private static String fallbackBundleVersion() {
        return BuildConfig.BRAI_FALLBACK_BUNDLE_VERSION;
    }

    private static String nativeApkVersion() {
        return BuildConfig.BRAI_APK_VERSION;
    }

    private synchronized void recordManifestApkVersions(BraiOtaManifest manifest) {
        SharedPreferences.Editor editor = prefs.edit()
            .putString(KEY_LAST_TARGET_APK_VERSION, String.valueOf(manifest.targetApkVersion))
            .putString(KEY_LAST_TARGET_APK_BUILD_KIND, manifest.targetApkBuildKind)
            .putString(KEY_LAST_TARGET_APK_PREVIEW_ITERATION, String.valueOf(manifest.targetApkPreviewIteration))
            .putString(KEY_LAST_TARGET_APK_VERSION_CODE, String.valueOf(manifest.targetApkVersionCode));
        if (manifest.targetApkReleaseKey == null) {
            editor.remove(KEY_LAST_TARGET_APK_RELEASE_KEY);
        } else {
            editor.putString(KEY_LAST_TARGET_APK_RELEASE_KEY, manifest.targetApkReleaseKey);
        }
        editor.apply();
    }

    private synchronized void recordAvailableUpdate(BraiOtaManifest manifest, boolean apkRequired) {
        prefs.edit()
            .putString(KEY_AVAILABLE_VERSION, manifest.otaVersion)
            .putBoolean(KEY_APK_UPDATE_REQUIRED, apkRequired)
            .apply();
    }

    private synchronized void clearAvailableUpdate() {
        prefs.edit()
            .remove(KEY_AVAILABLE_VERSION)
            .remove(KEY_APK_UPDATE_REQUIRED)
            .apply();
    }

    private static int nativeApkVersionNumber() throws BraiOtaException {
        try {
            int version = Integer.parseInt(nativeApkVersion());
            if (version > 0) return version;
        } catch (NumberFormatException ignored) {
            // Handled below with a stable OTA error code.
        }
        throw new BraiOtaException("invalid_native_apk_version");
    }

    static String apkDownloadUrl(String apiBase, String releaseKey) {
        String base = apiBase == null ? "" : apiBase.trim().replaceAll("/+$", "");
        return base + "/releases/download/" + releaseKey;
    }

    static String apkDownloadFileName(String releaseKey, String targetVersionCode) {
        return "brai-" + releaseKey + "-update-" + targetVersionCode + ".apk";
    }

    static boolean shouldStartApkDownload(String status, String storedTarget, String target) {
        return !"downloading".equals(status) && !("downloaded".equals(status) && target.equals(storedTarget));
    }

    static boolean wasCandidateLoading(String candidateVersion, String lastStatus) {
        return candidateVersion != null && "candidate_loading".equals(lastStatus);
    }

    static boolean isActiveCandidate(String candidateVersion, String activeBundleVersion) {
        return candidateVersion != null && candidateVersion.equals(activeBundleVersion);
    }

    static boolean shouldPreferFallbackBundle(String stableVersion, String fallbackVersion) {
        return stableVersion != null && fallbackVersion != null && BraiOtaVersion.compare(fallbackVersion, stableVersion) > 0;
    }

    static boolean isUpdateAvailable(String availableVersion, String activeVersion, String candidateVersion, boolean apkRequired) {
        if (apkRequired) return true;
        if (availableVersion == null || availableVersion.trim().isEmpty()) return false;
        if (activeVersion != null && BraiOtaVersion.compare(availableVersion, activeVersion) <= 0) return false;
        return candidateVersion == null || !availableVersion.equals(activeVersion);
    }

    static boolean isApkUpdateRequired(boolean storedRequired, int installedVersionCode, String targetVersionCode) {
        if (!storedRequired) return false;
        try {
            return installedVersionCode < Integer.parseInt(targetVersionCode);
        } catch (NumberFormatException | NullPointerException ignored) {
            return true;
        }
    }

    static int downloadProgressPercent(long bytes, long totalBytes) {
        if (totalBytes <= 0) return 0;
        long safeBytes = Math.max(0, Math.min(bytes, totalBytes));
        return (int) Math.min(100, Math.round((safeBytes * 100.0) / totalBytes));
    }

    static String updateErrorCode(Throwable error) {
        boolean sawIoError = false;
        Throwable current = error;
        for (int depth = 0; current != null && depth < 8; depth += 1) {
            if (current instanceof BraiOtaException) {
                String message = current.getMessage();
                return message == null || message.trim().isEmpty() ? "update_failed" : message;
            }
            if (current instanceof FileNotFoundException) return "local_archive_missing";
            if (current instanceof SocketTimeoutException) return "network_timeout";
            if (current instanceof UnknownHostException) return "network_unavailable";
            if (current instanceof SSLException) return "network_tls_failed";
            if (current instanceof ZipException) return "archive_invalid_zip";
            if (current instanceof SocketException) {
                String message = lowerMessage(current);
                if (
                    message.contains("software caused connection abort") ||
                    message.contains("connection reset") ||
                    message.contains("broken pipe")
                ) {
                    return "network_connection_lost";
                }
                return "network_connection_failed";
            }
            if (current instanceof IOException) sawIoError = true;

            String message = lowerMessage(current);
            if (message.contains("enoent") || message.contains("no such file")) return "local_archive_missing";
            if (
                message.contains("software caused connection abort") ||
                message.contains("connection reset") ||
                message.contains("broken pipe")
            ) {
                return "network_connection_lost";
            }
            if (message.contains("timeout")) return "network_timeout";
            current = current.getCause();
        }
        return sawIoError ? "network_or_storage_error" : "unexpected_update_error";
    }

    private String normalizeReadyVersion(String bundleVersion) {
        if (bundleVersion == null || bundleVersion.trim().isEmpty()) {
            return activeBundleVersion;
        }
        return bundleVersion.trim();
    }

    private static String lowerMessage(Throwable error) {
        String message = error.getMessage();
        return message == null ? "" : message.toLowerCase(Locale.ROOT);
    }

    private static String safeVersion(String version) throws BraiOtaException {
        if (!version.matches("[A-Za-z0-9._+\\-]+")) {
            throw new BraiOtaException("invalid_bundle_version");
        }
        return version.replace('+', '_');
    }

    static void verifyArchive(BraiOtaManifest manifest, File archive) throws IOException, BraiOtaException {
        BraiOtaArchive.DownloadResult result = BraiOtaArchive.sha256(archive);
        if (result.sizeBytes != manifest.sizeBytes) {
            throw new BraiOtaException("archive_size_mismatch");
        }
        if (!result.sha256.equals(manifest.sha256)) {
            throw new BraiOtaException("archive_checksum_mismatch");
        }
    }
}
