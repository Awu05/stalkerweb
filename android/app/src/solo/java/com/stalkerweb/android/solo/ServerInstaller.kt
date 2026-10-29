package com.stalkerweb.android.solo

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
import java.util.zip.ZipInputStream

/** Where the app's bundled files are read from — the APK's assets, or a test's own. */
fun interface AssetSource {
    fun open(name: String): InputStream
}

/**
 * Unpacks the server the app carries (assets/server.zip, from
 * android/scripts/pack-solo-server.sh) into [root]/<version>/ — once per
 * version, since Node runs it from files, not from inside the APK. Older
 * versions' folders are removed. Every file (and folder) is synced to the disk
 * before the done-marker is written, so a power cut can't leave a marker over
 * files that never landed; and the marker counts only with a server.js that
 * isn't empty.
 */
object ServerInstaller {
    /** The asset naming the server version the app carries. */
    const val VERSION_ASSET = "server.version"
    private const val ZIP = "server.zip"
    // Written last: a folder without it was cut short (the app stopped mid-way), and is redone.
    private const val DONE = ".installed"

    /** Returns `root/<versionTag>/backend/server.js`. */
    fun ensureInstalled(context: Context, assets: AssetSource, versionTag: String, root: File): File =
        ensureInstalled(assets, versionTag, root)

    /** Whether [versionTag] is unpacked in [root] already: a start without it unpacks first, and takes longer. */
    fun isInstalled(versionTag: String, root: File): Boolean {
        val dir = File(root, versionTag)
        return File(dir, DONE).isFile && File(dir, SERVER_JS).let { it.isFile && it.length() > 0 }
    }
    private const val SERVER_JS = "backend/server.js"

    fun ensureInstalled(assets: AssetSource, versionTag: String, root: File): File {
        require(versionTag.isNotBlank() && versionTag.none { it == '/' || it == '\\' } && versionTag != "." && versionTag != "..") {
            "bad server version tag"
        }
        val dir = File(root, versionTag)
        if (!isInstalled(versionTag, root)) {
            dir.deleteRecursively()
            if (!dir.mkdirs()) throw IOException("can't create ${dir.path}")
            assets.open(ZIP).use { unzip(it, dir) }
            val server = File(dir, SERVER_JS)
            if (!server.isFile || server.length() == 0L) throw IOException("the server package has no server.js")
            syncFolders(dir)
            FileOutputStream(File(dir, DONE)).use { it.write(versionTag.toByteArray()); it.fd.sync() }
            syncFolder(dir)
        }
        root.listFiles()?.filter { it.name != versionTag }?.forEach { it.deleteRecursively() }
        return File(dir, SERVER_JS)
    }

    /** Syncs a folder's entries (its list of names) to the disk; best effort where a folder can't be opened. */
    private fun syncFolder(dir: File) {
        runCatching { FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) } }
    }

    private fun syncFolders(dir: File) {
        dir.walkBottomUp().filter { it.isDirectory }.forEach { syncFolder(it) }
    }

    private fun unzip(input: InputStream, into: File) {
        val base = into.canonicalPath + File.separator
        ZipInputStream(input.buffered()).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                val target = File(into, entry.name)
                // A name like "../x" would write outside the folder: refused.
                if (!target.canonicalPath.startsWith(base)) throw IOException("zip entry outside the install folder: ${entry.name}")
                if (entry.isDirectory) {
                    target.mkdirs()
                } else {
                    target.parentFile?.mkdirs()
                    FileOutputStream(target).use { zip.copyTo(it); it.fd.sync() }
                }
            }
        }
    }
}
