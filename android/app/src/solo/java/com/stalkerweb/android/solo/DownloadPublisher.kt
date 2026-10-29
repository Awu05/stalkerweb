package com.stalkerweb.android.solo

import android.Manifest
import android.app.Application
import android.content.ContentValues
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.stalkerweb.android.data.api.DownloadJob
import com.stalkerweb.android.data.repo.AppContainer
import com.stalkerweb.android.data.repo.FolderFile
import com.stalkerweb.android.data.repo.goneKey
import com.stalkerweb.android.data.repo.isInside
import com.stalkerweb.android.data.repo.mimeOf
import com.stalkerweb.android.data.repo.orphansToPublish
import com.stalkerweb.android.data.repo.publicFileName
import com.stalkerweb.android.data.repo.publicName
import com.stalkerweb.android.data.repo.stalePartsToDelete
import com.stalkerweb.android.data.repo.toPublish
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.nio.file.Files

/**
 * The server downloads into the app's private folder, where no other app (nor
 * the person) can reach it. Each finished download is copied to the Downloads
 * folder (Download/StalkerWeb) — through MediaStore on Android 10+ — and then
 * the private copy is deleted. A copy that fails leaves the private file as
 * it was, to be tried again the next time the jobs are seen.
 *
 * It rides on the job lists the app reads anyway (DownloadsRepository.onJobs),
 * and looks once at start-up for jobs that finished while the app was closed —
 * and for files no job lists any more (the server forgets its jobs when it's
 * started again), which are saved too, and `.part` files a day old, left by a
 * download cut short, which are deleted.
 */
object DownloadPublisher {
    private const val TAG = "DownloadPublisher"
    private const val FOLDER = "StalkerWeb"
    private const val PERMISSION = Manifest.permission.WRITE_EXTERNAL_STORAGE

    private val lock = Mutex()
    @Volatile private var lastJobs: List<DownloadJob> = emptyList()
    @Volatile private var app: Application? = null
    @Volatile private var container: AppContainer? = null
    @Volatile private var scope: CoroutineScope? = null
    // Android 8-9: a download is waiting for the permission to the Downloads folder.
    private val needsPermission = MutableStateFlow(false)
    private var asked = false

    fun start(scope: CoroutineScope, app: Application, container: AppContainer) {
        this.scope = scope
        this.app = app
        this.container = container
        container.downloads.onJobs = { jobs -> publish(jobs) }
        // Finished while the app was closed: look once the server answers.
        scope.launch {
            if (!SoloServer.awaitReady(container.httpClient)) return@launch
            val jobs = runCatching { container.downloads.list() }.getOrNull() ?: return@launch
            sweep(jobs)
        }
    }

    /** Android 8-9: asks for access to the Downloads folder, once, when a download is waiting for it. */
    fun attach(activity: ComponentActivity) {
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P) return
        val launcher = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) { publish(lastJobs); scope?.launch { sweep(lastJobs) } }
        }
        activity.lifecycleScope.launch {
            needsPermission.first { it }
            if (!asked) { asked = true; launcher.launch(PERMISSION) }
        }
    }

    private fun publish(jobs: List<DownloadJob>) {
        lastJobs = jobs
        val scope = scope ?: return
        val c = container ?: return
        if (toPublish(jobs, c.prefs.publishedDownloads).isEmpty()) return
        scope.launch {
            lock.withLock {
                // Read again inside the lock: an earlier run may have saved some.
                for (job in toPublish(lastJobs, c.prefs.publishedDownloads)) {
                    val saved = runCatching { copyOut(job) }
                        .onFailure { Log.w(TAG, "saving a download failed (${it.javaClass.simpleName})") }
                        .getOrDefault(false)
                    if (saved) c.downloads.markPublished(job.id)
                    else if (!usable(job)) c.downloads.markPublished(goneKey(job.id))
                }
            }
        }
    }

    /**
     * The download folder's files no job lists, saved to the Downloads folder;
     * `.part` files a day old deleted (orphansToPublish, stalePartsToDelete).
     * Each kept to the folder as the jobs' files are ([confined]).
     */
    private suspend fun sweep(jobs: List<DownloadJob>) {
        val context = app ?: return
        lock.withLock {
            val dir = SoloEnv.downloadDir(context.filesDir)
            val now = System.currentTimeMillis()
            val files = dir.listFiles().orEmpty().map {
                FolderFile(it.name, it.isFile, Files.isSymbolicLink(it.toPath()), it.lastModified())
            }
            for (f in orphansToPublish(files, jobs, now)) {
                val file = File(dir, f.name)
                if (!confined(file)) continue
                runCatching { copyOut(file, publicFileName(f.name)) }
                    .onFailure { Log.w(TAG, "saving a download left from before failed (${it.javaClass.simpleName})") }
            }
            for (f in stalePartsToDelete(files, jobs, now)) {
                val file = File(dir, f.name)
                if (confined(file) && !file.delete()) Log.w(TAG, "couldn't delete a download cut short")
            }
        }
    }

    /**
     * Whether the job's file is still there to save: the file is the server's
     * word, so it must be a plain file in the download folder (not a link, not
     * somewhere else in the app's storage). One that isn't is let go, not retried.
     */
    private fun usable(job: DownloadJob): Boolean {
        if (app == null) return true
        val file = File(job.filePath ?: return false)
        if (!file.exists() && !Files.isSymbolicLink(file.toPath())) return false
        return confined(file)
    }

    /** [file] is a plain file in the download folder: not a link, not somewhere else in the app's storage. */
    private fun confined(file: File): Boolean {
        val context = app ?: return false
        if (Files.isSymbolicLink(file.toPath()) || !isInside(SoloEnv.downloadDir(context.filesDir), file)) {
            Log.w(TAG, "a download's file is outside the download folder; not saved")
            return false
        }
        return file.isFile
    }

    /** Copies the job's file to the Downloads folder, then deletes it here. False if it couldn't (yet). */
    private fun copyOut(job: DownloadJob): Boolean {
        if (!usable(job)) return false
        return copyOut(File(job.filePath ?: return false), publicName(job))
    }

    /** Copies [source] to the Downloads folder as [name], then deletes it here. False if it couldn't (yet). */
    private fun copyOut(source: File, name: String): Boolean {
        val context = app ?: return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mimeOf(name))
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            // A name taken is not overwritten: MediaStore picks another.
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
            try {
                val out = resolver.openOutputStream(uri) ?: error("no output")
                out.use { o -> source.inputStream().use { it.copyTo(o) } }
                resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            } catch (e: Exception) {
                runCatching { resolver.delete(uri, null, null) }
                throw e
            }
        } else {
            if (ContextCompat.checkSelfPermission(context, PERMISSION) != PackageManager.PERMISSION_GRANTED) {
                needsPermission.value = true
                return false
            }
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), FOLDER)
            if (!dir.isDirectory && !dir.mkdirs()) return false
            val target = freeName(dir, name)
            try {
                source.inputStream().use { i -> target.outputStream().use { i.copyTo(it) } }
            } catch (e: Exception) {
                target.delete()
                throw e
            }
        }
        source.delete()
        return true
    }

    /** [name] in [dir], or "name (2).ext" and on, if it's taken. */
    private fun freeName(dir: File, name: String): File {
        var file = File(dir, name)
        var n = 2
        val base = name.substringBeforeLast('.', name)
        val ext = name.substringAfterLast('.', "").let { if (it.isEmpty()) "" else ".$it" }
        while (file.exists()) file = File(dir, "$base ($n)$ext").also { n++ }
        return file
    }
}
