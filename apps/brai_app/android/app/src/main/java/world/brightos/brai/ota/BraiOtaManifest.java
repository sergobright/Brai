package world.brightos.brai.ota;

import java.net.MalformedURLException;
import java.net.URL;
import java.util.Locale;
import java.util.Map;

final class BraiOtaManifest {
    static final int SUPPORTED_SCHEMA_VERSION = 2;

    final int schemaVersion;
    final String otaVersion;
    final int targetApkVersion;
    final String publishedAt;
    final String archiveUrl;
    final String sha256;
    final long sizeBytes;
    final String entrypoint;
    final boolean mandatory;

    private BraiOtaManifest(
        int schemaVersion,
        String otaVersion,
        int targetApkVersion,
        String publishedAt,
        String archiveUrl,
        String sha256,
        long sizeBytes,
        String entrypoint,
        boolean mandatory
    ) {
        this.schemaVersion = schemaVersion;
        this.otaVersion = otaVersion;
        this.targetApkVersion = targetApkVersion;
        this.publishedAt = publishedAt;
        this.archiveUrl = archiveUrl;
        this.sha256 = sha256;
        this.sizeBytes = sizeBytes;
        this.entrypoint = entrypoint;
        this.mandatory = mandatory;
    }

    static BraiOtaManifest parse(String json) throws BraiOtaException {
        Map<String, Object> object = BraiOtaJson.parseObject(json);
        return new BraiOtaManifest(
            intValue(object, "schemaVersion"),
            requiredString(object, "otaVersion"),
            intValue(object, "targetApkVersion"),
            requiredString(object, "publishedAt"),
            requiredString(object, "archiveUrl"),
            requiredString(object, "sha256").toLowerCase(Locale.ROOT),
            longValue(object, "sizeBytes"),
            requiredString(object, "entrypoint"),
            booleanValue(object, "mandatory")
        );
    }

    void validate(URL manifestUrl, int installedApkVersion) throws BraiOtaException {
        if (schemaVersion != SUPPORTED_SCHEMA_VERSION) {
            throw new BraiOtaException("unsupported_manifest_schema");
        }
        if (!otaVersion.matches("\\d+\\.\\d+\\.\\d+")) {
            throw new BraiOtaException("invalid_ota_version");
        }
        if (targetApkVersion <= 0) {
            throw new BraiOtaException("manifest_invalid_targetApkVersion");
        }
        if (!sha256.matches("[0-9a-f]{64}")) {
            throw new BraiOtaException("invalid_sha256");
        }
        if (sizeBytes <= 0) {
            throw new BraiOtaException("invalid_size");
        }
        if (sizeBytes > BraiOtaArchive.MAX_ARCHIVE_BYTES) {
            throw new BraiOtaException("archive_too_large");
        }
        if (entrypoint.startsWith("/") || entrypoint.contains("..") || entrypoint.contains("\u0000")) {
            throw new BraiOtaException("invalid_entrypoint");
        }
        URL archive = archiveUrl();
        if (!"https".equalsIgnoreCase(archive.getProtocol())) {
            throw new BraiOtaException("archive_url_not_https");
        }
        if (archive.getUserInfo() != null) {
            throw new BraiOtaException("archive_url_has_userinfo");
        }
        if (!archive.getHost().equalsIgnoreCase(manifestUrl.getHost())) {
            throw new BraiOtaException("archive_url_untrusted_host");
        }
        if (!archive.getPath().startsWith("/mobile-update/")) {
            throw new BraiOtaException("archive_url_untrusted_path");
        }
        if (!isCompatibleWith(installedApkVersion)) {
            throw new BraiOtaException("apk_required");
        }
    }

    boolean isCompatibleWith(int installedApkVersion) {
        return installedApkVersion >= targetApkVersion;
    }

    boolean isNewerThan(String activeBundleVersion) {
        return BraiOtaVersion.compare(otaVersion, activeBundleVersion) > 0;
    }

    URL archiveUrl() throws BraiOtaException {
        try {
            return new URL(archiveUrl);
        } catch (MalformedURLException error) {
            throw new BraiOtaException("archive_url_malformed", error);
        }
    }

    private static String requiredString(Map<String, Object> object, String key) throws BraiOtaException {
        Object raw = object.get(key);
        if (!(raw instanceof String)) {
            throw new BraiOtaException("manifest_missing_" + key);
        }
        String value = (String) raw;
        if (value == null || value.trim().isEmpty()) {
            throw new BraiOtaException("manifest_missing_" + key);
        }
        return value;
    }

    private static int intValue(Map<String, Object> object, String key) throws BraiOtaException {
        long value = longValue(object, key);
        if (value < Integer.MIN_VALUE || value > Integer.MAX_VALUE) {
            throw new BraiOtaException("manifest_invalid_" + key);
        }
        return (int) value;
    }

    private static long longValue(Map<String, Object> object, String key) throws BraiOtaException {
        Object raw = object.get(key);
        if (!(raw instanceof Long)) {
            throw new BraiOtaException("manifest_invalid_" + key);
        }
        return (Long) raw;
    }

    private static boolean booleanValue(Map<String, Object> object, String key) throws BraiOtaException {
        Object raw = object.get(key);
        if (!(raw instanceof Boolean)) {
            throw new BraiOtaException("manifest_invalid_" + key);
        }
        return (Boolean) raw;
    }
}
