package com.stalkerweb.android.solo

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.Process
import android.util.Log
import com.stalkerweb.android.BuildConfig
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Runs the StalkerWeb server (Node) in its own process, ":node". Node can start
 * only once per process, so when it exits this process goes too, and Android
 * starts the service again with the same Intent (START_REDELIVER_INTENT): the
 * ports and the access key come as its extras, from SoloServer in the app's
 * main process. Node's own output goes to logcat, tag "stalkerweb".
 */
class SoloServerService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val port = intent?.getIntExtra(EXTRA_PORT, 0) ?: 0
        val castPort = intent?.getIntExtra(EXTRA_CAST_PORT, 0) ?: 0
        val key = intent?.getStringExtra(EXTRA_KEY)
        if (port <= 0 || key.isNullOrBlank()) {
            Log.w(TAG, "started without its port or key, so the server isn't started")
            stopSelf(startId)
            return START_NOT_STICKY
        }
        // Started again (the app came back to the foreground) while it runs: nothing to do.
        if (started.compareAndSet(false, true)) {
            thread(name = "node") { runServer(port, castPort, key) }
        }
        return START_REDELIVER_INTENT
    }

    private fun runServer(port: Int, castPort: Int, key: String) {
        val code = runCatching {
            val assets = applicationContext.assets
            val version = assets.open(VERSION_FILE).bufferedReader().use { it.readText().trim() }
            val entry = ServerInstaller.ensureInstalled(this, { name -> assets.open(name) }, version, File(filesDir, "server"))
            val dataDir = File(filesDir, "data").apply { mkdirs() }
            val downloadDir = File(filesDir, "downloads").apply { mkdirs() }
            val env = SoloEnv.build(port, castPort, key, dataDir, downloadDir, BuildConfig.VERSION_NAME)
            Log.i(TAG, "starting the server (version $version) on 127.0.0.1:$port")
            runtime.start(entry, emptyList(), env)
        }.getOrElse {
            Log.e(TAG, "the server couldn't start", it)
            1
        }
        // Node can't start again in this process: end it, and Android brings the service back.
        Log.w(TAG, "the server stopped (exit code $code), restarting its process")
        Process.killProcess(Process.myPid())
    }

    companion object {
        const val EXTRA_PORT = "com.stalkerweb.android.solo.PORT"
        const val EXTRA_CAST_PORT = "com.stalkerweb.android.solo.CAST_PORT"
        const val EXTRA_KEY = "com.stalkerweb.android.solo.KEY"
        private const val TAG = "SoloServer"
        private const val VERSION_FILE = "server.version"

        // Once per process: Node can't run twice in one.
        private val started = AtomicBoolean(false)
        private val runtime: NodeRuntime get() = NodejsMobileRuntime
    }
}
