package world.brightos.brai.ota;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class BraiOtaArchiveTest {
    @Test
    public void extractsSafeStaticBundle() throws Exception {
        File root = Files.createTempDirectory("brai-ota-safe").toFile();
        File archive = new File(root, "bundle.zip");
        writeZip(archive, new Entry("index.html", "<main>ok</main>"), new Entry("_next/app.js", "console.log('ok')"));

        File target = new File(root, "bundle");
        BraiOtaArchive.extractZip(archive, target, "index.html");

        assertTrue(new File(target, "index.html").isFile());
        assertTrue(new File(target, "_next/app.js").isFile());
    }

    @Test
    public void rejectsPathTraversal() throws Exception {
        File root = Files.createTempDirectory("brai-ota-traversal").toFile();
        File archive = new File(root, "bundle.zip");
        writeZip(archive, new Entry("index.html", "ok"), new Entry("../escape.txt", "bad"));

        BraiOtaException error = assertThrows(
            BraiOtaException.class,
            () -> BraiOtaArchive.extractZip(archive, new File(root, "bundle"), "index.html")
        );
        assertEquals("archive_path_traversal", error.getMessage());
    }

    @Test
    public void rejectsBackslashEntries() throws Exception {
        File root = Files.createTempDirectory("brai-ota-backslash").toFile();
        File archive = new File(root, "bundle.zip");
        writeZip(archive, new Entry("index.html", "ok"), new Entry("..\\escape.txt", "bad"));

        BraiOtaException error = assertThrows(
            BraiOtaException.class,
            () -> BraiOtaArchive.extractZip(archive, new File(root, "bundle"), "index.html")
        );
        assertEquals("unsafe_archive_entry", error.getMessage());
    }

    @Test
    public void rejectsMissingEntrypoint() throws Exception {
        File root = Files.createTempDirectory("brai-ota-entrypoint").toFile();
        File archive = new File(root, "bundle.zip");
        writeZip(archive, new Entry("_next/app.js", "console.log('ok')"));

        BraiOtaException error = assertThrows(
            BraiOtaException.class,
            () -> BraiOtaArchive.extractZip(archive, new File(root, "bundle"), "index.html")
        );
        assertEquals("missing_entrypoint", error.getMessage());
    }

    private static void writeZip(File archive, Entry... entries) throws Exception {
        try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(archive))) {
            for (Entry entry : entries) {
                zip.putNextEntry(new ZipEntry(entry.name));
                zip.write(entry.content.getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
            }
        }
    }

    private static final class Entry {
        final String name;
        final String content;

        Entry(String name, String content) {
            this.name = name;
            this.content = content;
        }
    }
}
