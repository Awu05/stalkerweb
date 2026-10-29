package com.stalkerweb.android.solo

import android.content.Context
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.zip.ZipInputStream

/** Where the app's bundled files are read from — the APK's assets, or a test's own. */
fun interface AssetSource {
    fun open(name: String): InputStream
}

/**
 * Unpacks the server the app carries (assets/server.zip, from
 * android/scripts/pack-solo-server.sh) into [root]/<version>/ — once per
 * version, since Node runs it from files, not from inside the APK. Older
 * versions' folders are removed.
 */
object ServerInstaller {
    private const val ZIP = "server.zip"
    // Written last: a folder without it was cut short (the app stopped mid-way), and is redone.
    private const val DONE = ".installed"

    /** Returns `root/<versionTag>/backend/server.js`. */
    fun ensureInstalled(context: Context, assets: AssetSource, versionTag: String, root: File): File =
        ensureInstalled(assets, versionTag, root)

    fun ensureInstalled(assets: AssetSource, versionTag: String, root: File): File {
        require(versionTag.isNotBlank() && versionTag.none { it == '/' || it == '\' } && versionTag != "." && versionTag != "..") {
            "bad server version tag"
        }
        val dir = File(root, versionTag)
        val done = File(dir, DONE)
        if (!done.isFile) {
            dir.deleteRecursively()
            if (!dir.mkdirs()) throw IOException("can't create ${dir.path}")
            assets.open(ZIP).use { unzip(it, dir) }
            done.writeText(versionTag)
        }
        root.listFiles()?.filter { it.name != versionTag }?.forEach { it.deleteRecursively() }
        return File(dir, "backend/server.js")
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
                    target.outputStream().use { zip.copyTo(it) }
                }
            }
        }
    }
}
