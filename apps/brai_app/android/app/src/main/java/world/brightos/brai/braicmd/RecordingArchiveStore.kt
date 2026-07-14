package world.brightos.brai.braicmd

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

internal object RecordingArchiveStore {
    private const val QUEUE_DIR = "pending-recordings"
    private const val PROCESSED_DIR = "processed-recordings"
    private const val QUARANTINE_DIR = "failed-processed-recordings"
    private const val METADATA_SUFFIX = ".metadata.json"
    private val sidecarSuffixes = listOf(
        ".context.json",
        ".screenshot.png",
        ".screenshot.jpg",
        ".inbox.txt",
        ".receiver.txt",
        ".inbox-prefix.txt",
        ".inbox-action.txt",
        METADATA_SUFFIX,
        QueueOwnerStore.SUFFIX
    )
    private val titleFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

    fun saveNewMetadata(audioFile: File) {
        val zone = ZoneId.systemDefault()
        val now = Instant.now()
        metadataFile(audioFile).writeText(
            JSONObject()
                .put("createdAtEpochMs", now.toEpochMilli())
                .put("zoneId", zone.id)
                .toString(),
            Charsets.UTF_8
        )
    }

    fun moveMetadata(source: File, target: File) {
        val sourceMetadata = metadataFile(source)
        if (!sourceMetadata.exists()) return
        val targetMetadata = metadataFile(target)
        if (!sourceMetadata.renameTo(targetMetadata)) {
            runCatching {
                sourceMetadata.copyTo(targetMetadata, overwrite = true)
                sourceMetadata.delete()
            }
        }
    }

    fun onAudioProcessed(context: Context, audioFile: File): Boolean {
        val config = ConfigStore(context)
        if (!config.processedAudioRetentionEnabled) {
            return deleteAudioWithSidecars(audioFile)
        }
        val ownerId = QueueOwnerStore.readOwnerId(audioFile) ?: return false
        val archiveDir = File(context.filesDir, PROCESSED_DIR).apply { mkdirs() }
        val target = uniqueTarget(archiveDir, audioFile.name)
        val sources = listOf(audioFile) + existingSidecars(audioFile)
        val targets = sources.map { source ->
            if (source == audioFile) target else File("${target.absolutePath}${source.name.removePrefix(audioFile.name)}")
        }
        val copied = runCatching {
            sources.zip(targets).forEach { (source, destination) ->
                source.copyTo(destination, overwrite = false)
            }
        }.isSuccess
        if (!copied) {
            targets.forEach(File::delete)
            return false
        }
        if (QueueOwnerStore.readOwnerId(target) != ownerId) {
            targets.forEach(File::delete)
            return false
        }
        sources.forEach(File::delete)
        pruneProcessed(context, ownerId, config.processedAudioRetentionLimit)
        return !audioFile.exists()
    }

    fun reconcileProcessedRetention(context: Context) {
        val config = ConfigStore(context)
        val ownerId = QueueOwnerStore.current(context).ownerId
        if (!config.processedAudioRetentionEnabled) {
            processedAudioFiles(context, ownerId).forEach(::deleteAudioWithSidecars)
            return
        }
        pruneProcessed(context, ownerId, config.processedAudioRetentionLimit)
    }

    fun listJson(context: Context): JSArray {
        val array = JSArray()
        val ownerId = QueueOwnerStore.current(context).ownerId
        queuedAudioFiles(context, ownerId).forEach { file -> array.put(itemJson("queued", file)) }
        processedAudioFiles(context, ownerId).forEach { file -> array.put(itemJson("processed", file)) }
        return array
    }

    fun delete(context: Context, id: String): Boolean {
        val file = fileForId(context, id) ?: return false
        return deleteAudioWithSidecars(file)
    }

    fun download(context: Context, id: String): String {
        val file = fileForId(context, id) ?: throw IllegalArgumentException("audio_not_found")
        val targetName = file.name.removeSuffix(".recording")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, targetName)
                put(MediaStore.Downloads.MIME_TYPE, "audio/mp4")
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Brai CMD")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("download_insert_failed")
            resolver.openOutputStream(uri)?.use { output -> file.inputStream().use { input -> input.copyTo(output) } }
                ?: throw IllegalStateException("download_open_failed")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return "Downloads/Brai CMD/$targetName"
        }
        val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Brai CMD").apply { mkdirs() }
        val target = uniqueTarget(directory, targetName)
        file.copyTo(target, overwrite = false)
        return target.absolutePath
    }

    private fun itemJson(status: String, file: File): JSObject {
        val metadata = readMetadata(file)
        val createdAt = metadata.optLong("createdAtEpochMs", file.lastModified())
        val zoneId = runCatching { ZoneId.of(metadata.optString("zoneId", ZoneId.systemDefault().id)) }.getOrDefault(ZoneId.systemDefault())
        return JSObject()
            .put("id", "$status:${file.name}")
            .put("status", status)
            .put("title", titleFormatter.format(Instant.ofEpochMilli(createdAt).atZone(zoneId)))
            .put("bytes", file.length())
            .put("megabytes", file.length() / 1_000_000.0)
    }

    private fun queuedAudioFiles(context: Context, ownerId: String): List<File> =
        File(context.filesDir, QUEUE_DIR)
            .listFiles { file -> file.isFile && file.name.endsWith(".m4a", ignoreCase = true) && !file.name.contains(".recording.") }
            ?.filter { QueueOwnerStore.readOwnerId(it) == ownerId }
            ?.sortedBy { readMetadata(it).optLong("createdAtEpochMs", it.lastModified()) }
            .orEmpty()

    private fun allProcessedAudioFiles(context: Context): List<File> =
        File(context.filesDir, PROCESSED_DIR)
            .listFiles { file -> file.isFile && file.name.endsWith(".m4a", ignoreCase = true) }
            .orEmpty()
            .toList()

    private fun processedAudioFiles(context: Context, ownerId: String): List<File> {
        quarantineUnownedProcessed(context)
        return allProcessedAudioFiles(context)
            .filter { QueueOwnerStore.readOwnerId(it) == ownerId }
            .sortedByDescending { readMetadata(it).optLong("createdAtEpochMs", it.lastModified()) }
    }

    private fun pruneProcessed(context: Context, ownerId: String, limit: Int) {
        val files = processedAudioFiles(context, ownerId)
            .sortedBy { readMetadata(it).optLong("createdAtEpochMs", it.lastModified()) }
        val overflow = files.size - limit.coerceAtLeast(1)
        if (overflow <= 0) return
        files.take(overflow).forEach(::deleteAudioWithSidecars)
    }

    private fun fileForId(context: Context, id: String): File? {
        val parts = id.split(":", limit = 2)
        if (parts.size != 2) return null
        val directory = when (parts[0]) {
            "queued" -> File(context.filesDir, QUEUE_DIR)
            "processed" -> File(context.filesDir, PROCESSED_DIR)
            else -> return null
        }
        val name = parts[1]
        if (name.contains('/') || name.contains('\\')) return null
        return File(directory, name).takeIf {
            it.isFile && QueueOwnerStore.readOwnerId(it) == QueueOwnerStore.current(context).ownerId
        }
    }

    private fun readMetadata(audioFile: File): JSONObject =
        runCatching { JSONObject(metadataFile(audioFile).readText(Charsets.UTF_8)) }.getOrDefault(JSONObject())

    private fun metadataFile(audioFile: File): File = File("${audioFile.absolutePath}$METADATA_SUFFIX")

    private fun existingSidecars(audioFile: File): List<File> =
        sidecarSuffixes.map { File("${audioFile.absolutePath}$it") }.filter(File::exists)

    internal fun deleteAudioWithSidecars(audioFile: File): Boolean {
        existingSidecars(audioFile).forEach(File::delete)
        return audioFile.delete() || !audioFile.exists()
    }

    private fun quarantineUnownedProcessed(context: Context) {
        val directory = File(context.filesDir, QUARANTINE_DIR).apply { mkdirs() }
        allProcessedAudioFiles(context)
            .filter { QueueOwnerStore.readOwnerId(it) == null }
            .forEach { audioFile ->
                val target = uniqueTarget(directory, audioFile.name)
                val sources = listOf(audioFile) + existingSidecars(audioFile)
                val targets = sources.map { source ->
                    if (source == audioFile) target
                    else File("${target.absolutePath}${source.name.removePrefix(audioFile.name)}")
                }
                val copied = runCatching {
                    sources.zip(targets).forEach { (source, destination) ->
                        source.copyTo(destination, overwrite = false)
                    }
                }.isSuccess
                if (copied) sources.forEach(File::delete) else targets.forEach(File::delete)
            }
    }

    private fun uniqueTarget(directory: File, name: String): File {
        val direct = File(directory, name)
        return if (!direct.exists()) direct else File(directory, "${UUID.randomUUID()}-$name")
    }
}
