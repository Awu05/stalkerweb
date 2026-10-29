package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.DownloadJob
import java.io.File

/**
 * Solo's downloads land in the server's private folder; each finished one is
 * copied to Downloads/StalkerWeb, where the person can find it (DownloadPublisher).
 * These are the rules for what, and under which name.
 */

/** The finished downloads with a file, not yet copied to the Downloads folder. */
fun toPublish(jobs: List<DownloadJob>, published: Set<String>): List<DownloadJob> =
    jobs.filter { it.status == "done" && !it.filePath.isNullOrBlank() && it.id !in published && goneKey(it.id) !in published }

/** Recorded with the published ones for a download whose file is gone (or refused), so it isn't looked at again. */
fun goneKey(id: String): String = "gone:$id"

/**
 * Whether [file] is a file within [dir] (not the folder itself), once `..` and
 * links are resolved: the server's word for where a download is isn't taken
 * for a place outside its download folder.
 */
fun isInside(dir: File, file: File): Boolean {
    val root = dir.canonicalFile.path
    val path = file.canonicalFile.path
    return path.length > root.length && path.startsWith(root) && path[root.length] == File.separatorChar
}

private val refused = Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]")

/** The file's name in the Downloads folder: the server's own, without what MediaStore refuses. */
fun publicName(job: DownloadJob): String {
    val name = job.filePath.orEmpty().substringAfterLast('/').substringAfterLast('\\')
    return refused.replace(name, "_").trim().ifEmpty { "download" }
}

fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "ts" -> "video/mp2t"
    "mp4" -> "video/mp4"
    "mkv" -> "video/x-matroska"
    else -> "application/octet-stream"
}

/** What a finished download says on the Downloads screen. */
fun doneLabel(job: DownloadJob, isSolo: Boolean, published: Set<String>, size: String): String = when {
    !isSolo -> "Done · $size"
    job.id in published -> "Saved to Downloads/StalkerWeb · $size"
    goneKey(job.id) in published -> "Done · $size"
    else -> "Done · $size · not saved to Downloads yet"
}
