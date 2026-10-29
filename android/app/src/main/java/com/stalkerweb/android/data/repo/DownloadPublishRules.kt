package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.DownloadJob

/**
 * Solo's downloads land in the server's private folder; each finished one is
 * copied to Downloads/StalkerWeb, where the person can find it (DownloadPublisher).
 * These are the rules for what, and under which name.
 */

/** The finished downloads with a file, not yet copied to the Downloads folder. */
fun toPublish(jobs: List<DownloadJob>, published: Set<String>): List<DownloadJob> =
    jobs.filter { it.status == "done" && !it.filePath.isNullOrBlank() && it.id !in published }

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
    else -> "video/*"
}

/** What a finished download says on the Downloads screen. */
fun doneLabel(job: DownloadJob, isSolo: Boolean, published: Set<String>, size: String): String = when {
    !isSolo -> "Done · $size"
    job.id in published -> "Saved to Downloads/StalkerWeb · $size"
    else -> "Done · $size · not saved to Downloads yet"
}
