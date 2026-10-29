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
 * starts the service again (START_STICKY). The ports and access key are read
 * from SoloConfig, not the Intent, so a restart without one works the same.
 * Node's own output goes to logcat, tag "stalkerweb".
 */
class SoloServerService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Started again (the app came back to the foreground) while it runs: nothing to do.
        if (started.compareAndSet(false, true)) {
            thread(name = "node") { runServer() }
        }
        return START_STICKY
    }

    private fun runServer() {
        val file = SoloConfig.file(filesDir)
        val saved = SoloConfig.read(file)
        if (saved == null) {
            // The app makes it before starting the service; it starts it again then.
            Log.w(TAG, "no Solo server settings yet, so the server isn't started")
            started.set(false)
            stopSelf()
            return
        }
        val code = runCatching {
            val config = withFreePorts(file, saved)
            val assets = applicationContext.assets
            val version = assets.open(VERSION_FILE).bufferedReader().use { it.readText().trim() }
            val entry = ServerInstaller.ensureInstalled(this, { name -> assets.open(name) }, version, File(filesDir, "server"))
            val dataDir = File(filesDir, "data").apply { mkdirs() }
            val downloadDir = File(filesDir, "downloads").apply { mkdirs() }
            val env = SoloEnv.build(config.port, config.castPort, config.key, dataDir, downloadDir, BuildConfig.VERSION_NAME)
            Log.i(TAG, "starting the server (version $version) on 127.0.0.1:${config.port}")
            runtime.start(entry, emptyList(), env)
        }.getOrElse {
            Log.e(TAG, "the server couldn't start", it)
            1
        }
        // Node can't start again in this process: end it, and Android brings the service back.
        Log.w(TAG, "the server stopped (exit code $code), restarting its process")
        Process.killProcess(Process.myPid())
    }

    /** [saved], or with new ports where one is taken (saved for the app to find: SoloServer). */
    private fun withFreePorts(file: File, saved: SoloConfig): SoloConfig {
        val (port, castPort) = SoloPorts.choose(saved.port to saved.castPort, SoloPorts::isFree, SoloPorts::freePort)
        if (port == saved.port && castPort == saved.castPort) return saved
        Log.w(TAG, "port ${saved.port} or ${saved.castPort} is taken, moving to $port and $castPort")
        return saved.copy(port = port, castPort = castPort).also { SoloConfig.write(file, it) }
    }

    companion object {
        private const val TAG = "SoloServer"
        private const val VERSION_FILE = "server.version"

        // Once per process: Node can't run twice in one.
        private val started = AtomicBoolean(false)
        private val runtime: NodeRuntime get() = NodejsMobileRuntime
    }
}
