package com.stalkerweb.android.solo

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.stalkerweb.android.BuildConfig
import com.stalkerweb.android.data.repo.SoloForeground
import com.stalkerweb.android.data.repo.soloForeground
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Runs the StalkerWeb server (Node) in its own process, ":node". Node can start
 * only once per process, so when it exits this process goes too, and Android
 * starts the service again (START_STICKY). The ports and access key are read
 * from SoloConfig, not the Intent, so a restart without one works the same.
 * Node's own output goes to logcat, tag "stalkerweb".
 *
 * While the app holds it (SoloServer.hold: playing, casting, downloading) it
 * runs in the foreground, with a quiet "StalkerWeb Solo is running"
 * notification — shown only if notifications are allowed, it works the same
 * without. Media playback while playing or casting, which Android doesn't
 * time-limit; a data sync while only downloading.
 */
class SoloServerService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    private val main = Handler(Looper.getMainLooper())
    // What the app holds the server for, as it last said (SoloServer sends them whole).
    private var holds: Set<String> = emptySet()
    private var foreground: SoloForeground? = null
    private var life: IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_RESTART && started.get()) {
            // A new Node, with the key and ports read afresh: this process ends, and Android starts it again.
            Log.w(TAG, "restarting the server, as the app asked")
            Process.killProcess(Process.myPid())
            return START_STICKY
        }
        // Started again (the app came back to the foreground) while it runs: just the holds.
        if (started.compareAndSet(false, true)) {
            thread(name = "node") { runServer() }
        }
        intent?.getStringArrayExtra(EXTRA_HOLDS)?.let { holds = it.toSet() }
        intent?.extras?.getBinder(EXTRA_LIFE)?.let(::follow)
        applyHolds()
        return START_STICKY
    }

    // The app's process ended (swiped away, or stopped by Android): nothing it held still needs the server.
    private fun follow(app: IBinder) {
        if (app == life) return
        life = app
        val ok = runCatching {
            app.linkToDeath({ main.post { if (life == app) { holds = emptySet(); applyHolds() } } }, 0)
        }.isSuccess
        if (!ok) { holds = emptySet() }   // already gone
    }

    private fun applyHolds() {
        val want = soloForeground(holds)
        if (want == foreground) return
        if (want == null) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            foreground = null
            return
        }
        val type = when (want) {
            SoloForeground.MediaPlayback -> ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            SoloForeground.DataSync -> ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        }
        // Android may refuse (the app in the background, or the day's data-sync
        // time used up): the server still runs, just without the foreground's protection.
        runCatching { ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type) }
            .onSuccess { foreground = want }
            .onFailure { Log.w(TAG, "can't keep the server in the foreground (${it.javaClass.simpleName})") }
    }

    private fun notification(): android.app.Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Solo server", NotificationManager.IMPORTANCE_LOW)
                .apply { description = "Shown while the server inside the app is kept running" }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
        val open = (packageManager.getLaunchIntentForPackage(packageName) ?: packageManager.getLeanbackLaunchIntentForPackage(packageName))
            ?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE) }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("StalkerWeb Solo is running")
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    // Android 15+: a data sync may run 6 hours a day. Then it's no longer in the
    // foreground (or Android stops the app); playing or casting goes on as media.
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "the day's foreground time is used up")
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foreground = null
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
        private const val CHANNEL_ID = "solo-server"
        private const val NOTIFICATION_ID = 4071

        /** Start Node again (SoloServer.restart). */
        const val ACTION_RESTART = "com.stalkerweb.android.solo.RESTART"
        /** What the app holds the server for, all of it (SoloHold). */
        const val EXTRA_HOLDS = "holds"
        /** A Binder of the app's main process, to see it end. */
        const val EXTRA_LIFE = "life"

        // Once per process: Node can't run twice in one.
        private val started = AtomicBoolean(false)
        private val runtime: NodeRuntime get() = NodejsMobileRuntime
    }
}
