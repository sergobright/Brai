package world.brightos.brai.ota;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

final class BraiOtaArchive {
    private static final int BUFFER_SIZE = 64 * 1024;
    static final long MAX_ARCHIVE_BYTES = 25L * 1024L * 1024L;
    static final long MAX_UNPACKED_BYTES = 80L * 1024L * 1024L;
    static final int MAX_ENTRY_COUNT = 5000;

    private BraiOtaArchive() {}

    static DownloadResult sha256(File file) throws IOException {
        MessageDigest digest = sha256Digest();
        long size = 0;
        byte[] buffer = new byte[BUFFER_SIZE];
        try (InputStream input = new BufferedInputStream(new FileInputStream(file));
            DigestInputStream digestInput = new DigestInputStream(input, digest)) {
            int read;
            while ((read = digestInput.read(buffer)) != -1) {
                size += read;
            }
        }
        return new DownloadResult(hex(digest.digest()), size);
    }

    static void extractZip(File archive, File targetDir, String entrypoint) throws IOException, BraiOtaException {
        if (targetDir.exists()) {
            deleteRecursively(targetDir);
        }
        if (!targetDir.mkdirs() && !targetDir.isDirectory()) {
            throw new IOException("Unable to create bundle directory: " + targetDir);
        }

        String targetRoot = targetDir.getCanonicalPath();
        byte[] buffer = new byte[BUFFER_SIZE];
        long unpackedBytes = 0;
        int entryCount = 0;
        Set<String> seenPaths = new HashSet<>();
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(new FileInputStream(archive)))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                entryCount += 1;
                if (entryCount > MAX_ENTRY_COUNT) {
                    throw new BraiOtaException("archive_too_many_entries");
                }
                String name = entry.getName();
                if (
                    name == null ||
                    name.isEmpty() ||
                    name.startsWith("/") ||
                    name.contains("\\") ||
                    name.matches("^[A-Za-z]:.*") ||
                    name.contains("\u0000")
                ) {
                    throw new BraiOtaException("unsafe_archive_entry");
                }

                File destination = new File(targetDir, name);
                String destinationPath = destination.getCanonicalPath();
                if (!destinationPath.equals(targetRoot) && !destinationPath.startsWith(targetRoot + File.separator)) {
                    throw new BraiOtaException("archive_path_traversal");
                }
                if (!seenPaths.add(destinationPath)) {
                    throw new BraiOtaException("duplicate_archive_entry");
                }

                if (entry.isDirectory()) {
                    if (!destination.mkdirs() && !destination.isDirectory()) {
                        throw new IOException("Unable to create directory: " + destination);
                    }
                    continue;
                }

                File parent = destination.getParentFile();
                if (parent != null && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new IOException("Unable to create parent directory: " + parent);
                }
                try (BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(destination))) {
                    int read;
                    while ((read = zip.read(buffer)) != -1) {
                        unpackedBytes += read;
                        if (unpackedBytes > MAX_UNPACKED_BYTES) {
                            throw new BraiOtaException("archive_unpacked_size_exceeded");
                        }
                        output.write(buffer, 0, read);
                    }
                }
            }
        } catch (IOException | BraiOtaException error) {
            deleteRecursively(targetDir);
            throw error;
        }

        File entrypointFile = new File(targetDir, entrypoint);
        String entrypointPath = entrypointFile.getCanonicalPath();
        if (!entrypointPath.startsWith(targetRoot + File.separator) || !entrypointFile.isFile()) {
            deleteRecursively(targetDir);
            throw new BraiOtaException("missing_entrypoint");
        }
    }

    static void deleteRecursively(File file) throws IOException {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursively(child);
            }
        }
        if (!file.delete() && file.exists()) {
            throw new IOException("Unable to delete " + file);
        }
    }

    static MessageDigest sha256Digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    static String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            builder.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return builder.toString();
    }

    static final class DownloadResult {
        final String sha256;
        final long sizeBytes;

        DownloadResult(String sha256, long sizeBytes) {
            this.sha256 = sha256;
            this.sizeBytes = sizeBytes;
        }
    }
}
