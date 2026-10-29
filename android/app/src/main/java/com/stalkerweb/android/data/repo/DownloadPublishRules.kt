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
fun publicName(job: DownloadJob): String = publicFileName(fileNameOf(job.filePath.orEmpty()))

/**
 * [name] as it can be in the Downloads folder: without what MediaStore
 * refuses, nor dots or spaces at its end (Windows, where it may be copied,
 * drops them) — and a name of only dots ("..") is no name at all.
 */
fun publicFileName(name: String): String =
    refused.replace(name, "_").trim().trimEnd('.', ' ').ifEmpty { "download" }

/**
 * Whether a download's file, once opened, is one to copy out: a regular file
 * whose real path ([realPath], what the open descriptor points at) is inside
 * the download folder ([dir], canonical). Checked on the opened file, so it
 * can't be swapped for a link between the check and the copy.
 */
fun openedInside(dir: String, realPath: String, isRegular: Boolean): Boolean =
    isRegular && realPath.length > dir.length && realPath.startsWith(dir) && realPath[dir.length] == File.separatorChar

private fun fileNameOf(path: String): String = path.substringAfterLast('/').substringAfterLast('\\')

/** A file in Solo's private download folder, as it was when the folder was looked over. */
data class FolderFile(val name: String, val isFile: Boolean, val isLink: Boolean, val modifiedMs: Long)

/** A file written to this recently may still be in use (a download just finished, not yet in the job list read). */
const val IN_USE_MS = 2 * 60_000L

/** A `.part` file left this long, with nothing downloading, was cut short (the app was stopped mid-download). */
const val STALE_PART_MS = 24 * 60 * 60_000L

/**
 * The finished files in the download folder that no job lists — left from
 * before the server was started again, which forgets its jobs — to be saved
 * to the Downloads folder too. Not a `.part` (one still being written, or cut
 * short), not a link, not one written to just now.
 */
fun orphansToPublish(files: List<FolderFile>, jobs: List<DownloadJob>, nowMs: Long): List<FolderFile> {
    val listed = jobs.mapNotNull { it.filePath?.let(::fileNameOf) }.toSet()
    return files.filter {
        it.isFile && !it.isLink && !it.name.endsWith(".part") && it.name !in listed && nowMs - it.modifiedMs >= IN_USE_MS
    }
}

/** The `.part` files older than a day, to be deleted — none while a download is going. */
fun stalePartsToDelete(files: List<FolderFile>, jobs: List<DownloadJob>, nowMs: Long): List<FolderFile> =
    if (anyDownloadActive(jobs)) emptyList()
    else files.filter { it.isFile && !it.isLink && it.name.endsWith(".part") && nowMs - it.modifiedMs > STALE_PART_MS }

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
