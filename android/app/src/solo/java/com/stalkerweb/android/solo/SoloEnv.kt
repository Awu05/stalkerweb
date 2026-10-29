package com.stalkerweb.android.solo

import java.io.File

/** The environment the server inside Solo runs with (its Solo mode, backend/config.js). */
object SoloEnv {
    /** Where the server saves downloads, in the app's private storage. */
    fun downloadDir(filesDir: File): File = File(filesDir, "downloads")

    fun build(
        port: Int,
        accessKey: String,
        dataDir: File,
        downloadDir: File,
        version: String,
    ): Map<String, String> = mapOf(
        // This device only: the app talks to it on 127.0.0.1, and just the cast
        // stream is offered on the Wi-Fi, for a Chromecast, on a port the server
        // picks each time it starts casting.
        "SOLO" to "1",
        "HOST" to "127.0.0.1",
        "PORT" to port.toString(),
        "ACCESS_KEY" to accessKey,
        // The app's private storage.
        "DATA_DIR" to dataDir.path,
        "DOWNLOAD_DIR" to downloadDir.path,
        "APP_VERSION" to version,
        "NODE_ENV" to "production",
    )
}
