package com.stalkerweb.android.solo

import java.io.File
import java.io.IOException
import java.util.Properties

/**
 * The Solo server's ports and access key, kept in the app's private storage.
 * Both of the app's processes use it: the main one makes it on first launch
 * (SoloServer), and the server's own (":node", SoloServerService) reads it,
 * and saves new ports if the saved ones are taken. It's a file, not AppPrefs:
 * SharedPreferences doesn't see what another process wrote.
 */
data class SoloConfig(val port: Int, val castPort: Int, val key: String) {
    // Never the key: this may end up in a log.
    override fun toString() = "SoloConfig(port=$port, castPort=$castPort)"

    companion object {
        fun file(filesDir: File) = File(filesDir, "solo-server.properties")

        /** What's saved, or null when there's nothing (yet) or it's unreadable. */
        fun read(file: File): SoloConfig? = runCatching {
            val p = Properties().apply { file.inputStream().use { load(it) } }
            SoloConfig(p.getProperty("port").toInt(), p.getProperty("castPort").toInt(), p.getProperty("key"))
        }.getOrNull()?.takeIf { it.port > 0 && it.castPort > 0 && it.key.isNotBlank() }

        /** Saves [config] whole: written aside, then moved over the old file. */
        fun write(file: File, config: SoloConfig) {
            val p = Properties().apply {
                setProperty("port", config.port.toString())
                setProperty("castPort", config.castPort.toString())
                setProperty("key", config.key)
            }
            val tmp = File(file.parentFile, "${file.name}.tmp")
            tmp.outputStream().use { p.store(it, null) }
            if (!tmp.renameTo(file)) throw IOException("can't save ${file.path}")
        }
    }
}
