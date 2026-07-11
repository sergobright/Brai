package world.brightos.brai.ota;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public class BraiOtaManifestTest {
    @Test
    public void validatesTrustedCompatibleManifest() throws Exception {
        BraiOtaManifest manifest = BraiOtaManifest.parse(validManifest());

        manifest.validate(new URL("https://app.brai.one/mobile-update/manifest.json"), 1);

        assertEquals("0.0.1", manifest.otaVersion);
        assertEquals(1, manifest.targetApkVersion);
        assertTrue(manifest.isCompatibleWith(1));
        assertTrue(manifest.isNewerThan("0.0.0"));
    }

    @Test
    public void acceptsNewerInstalledApkVersion() throws Exception {
        BraiOtaManifest manifest = BraiOtaManifest.parse(validManifest().replace("\"targetApkVersion\":1", "\"targetApkVersion\":2"));

        manifest.validate(new URL("https://app.brai.one/mobile-update/manifest.json"), 3);

        assertTrue(manifest.isCompatibleWith(3));
    }

    @Test
    public void rejectsNewerApkRequirement() throws Exception {
        BraiOtaManifest manifest = BraiOtaManifest.parse(validManifest().replace("\"targetApkVersion\":1", "\"targetApkVersion\":2"));

        assertFalse(manifest.isCompatibleWith(1));
        BraiOtaException error = assertThrows(
            BraiOtaException.class,
            () -> manifest.validate(new URL("https://app.brai.one/mobile-update/manifest.json"), 1)
        );
        assertTrue(error.getMessage().contains("apk_required"));
    }

    @Test
    public void checksStableTargetIdentity() throws Exception {
        BraiOtaManifest manifest = BraiOtaManifest.parse(manifestWithApkTarget("2", "a", "stable", 0, 2));

        manifest.validate(new URL("https://app.brai.one/mobile-update/manifest.json"), 2, "a", "stable", 0);

        assertTrue(manifest.isCompatibleWith(3, "a", "stable", 0));
        assertFalse(manifest.isCompatibleWith(2, "b", "stable", 0));
        assertFalse(manifest.isCompatibleWith(2, "a", "preview", 4));
    }

    @Test
    public void checksPreviewTargetIdentity() throws Exception {
        BraiOtaManifest manifest = BraiOtaManifest.parse(manifestWithApkTarget("2", "a", "preview", 6, 20006));

        manifest.validate(new URL("https://app.brai.one/mobile-update/manifest.json"), 2, "a", "preview", 6);

        assertTrue(manifest.isCompatibleWith(2, "a", "preview", 7));
        assertFalse(manifest.isCompatibleWith(2, "a", "preview", 5));
        assertFalse(manifest.isCompatibleWith(3, "a", "preview", 7));
        assertFalse(manifest.isCompatibleWith(2, "a", "stable", 0));
        assertFalse(manifest.isCompatibleWith(2, "b", "preview", 7));
    }

    @Test
    public void rejectsInvalidTargetApkVersion() {
        assertThrows(
            BraiOtaException.class,
            () -> BraiOtaManifest.parse(validManifest().replace("\"targetApkVersion\":1", "\"targetApkVersion\":\"bad\""))
        );
    }

    @Test
    public void rejectsLegacyManifestSchema() {
        assertThrows(
            BraiOtaException.class,
            () -> BraiOtaManifest.parse(validManifest().replace("\"schemaVersion\":2", "\"schemaVersion\":1"))
                .validate(new URL("https://app.brai.one/mobile-update/manifest.json"), 1)
        );
    }

    @Test
    public void rejectsCrossOriginArchiveUrl() throws Exception {
        BraiOtaManifest manifest = BraiOtaManifest.parse(
            validManifest().replace(
                "https://app.brai.one/mobile-update/bundles/0.0.1/bundle.zip",
                "https://evil.example.test/mobile-update/bundles/0.0.1/bundle.zip"
            )
        );

        BraiOtaException error = assertThrows(
            BraiOtaException.class,
            () -> manifest.validate(new URL("https://app.brai.one/mobile-update/manifest.json"), 1)
        );
        assertTrue(error.getMessage().contains("archive_url_untrusted_host"));
    }

    @Test
    public void rejectsInvalidChecksumShape() {
        assertThrows(
            BraiOtaException.class,
            () -> BraiOtaManifest.parse(validManifest().replace("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "not-a-hash"))
                .validate(new URL("https://app.brai.one/mobile-update/manifest.json"), 1)
        );
    }

    @Test
    public void rejectsArchiveChecksumMismatch() throws Exception {
        File archive = Files.createTempFile("brai-ota-checksum", ".zip").toFile();
        Files.write(archive.toPath(), "not the expected archive".getBytes(StandardCharsets.UTF_8));
        BraiOtaManifest manifest = BraiOtaManifest.parse(
            validManifest()
                .replace("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
                .replace("\"sizeBytes\":1234", "\"sizeBytes\":" + archive.length())
        );

        BraiOtaException error = assertThrows(
            BraiOtaException.class,
            () -> BraiOtaManager.verifyArchive(manifest, archive)
        );
        assertTrue(error.getMessage().contains("archive_checksum_mismatch"));
    }

    private static String validManifest() {
        return "{"
            + "\"schemaVersion\":2,"
            + "\"otaVersion\":\"0.0.1\","
            + "\"targetApkVersion\":1,"
            + "\"publishedAt\":\"2026-06-15T00:00:00Z\","
            + "\"archiveUrl\":\"https://app.brai.one/mobile-update/bundles/0.0.1/bundle.zip\","
            + "\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
            + "\"sizeBytes\":1234,"
            + "\"entrypoint\":\"index.html\","
            + "\"mandatory\":false"
            + "}";
    }

    private static String manifestWithApkTarget(String version, String releaseKey, String buildKind, int previewIteration, int versionCode) {
        return validManifest().replace(
            "\"targetApkVersion\":1,",
            "\"targetApkVersion\":" + version + ","
                + "\"targetApkReleaseKey\":\"" + releaseKey + "\","
                + "\"targetApkBuildKind\":\"" + buildKind + "\","
                + "\"targetApkPreviewIteration\":" + previewIteration + ","
                + "\"targetApkVersionCode\":" + versionCode + ","
        );
    }
}
