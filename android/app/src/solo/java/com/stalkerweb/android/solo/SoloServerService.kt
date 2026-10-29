package com.stalkerweb.android.solo

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.stalkerweb.android.BuildConfig
import com.stalkerweb.android.data.repo.SOLO_STUCK_START_MS
import com.stalkerweb.android.data.repo.SoloForeground
import com.stalkerweb.android.data.repo.SoloStatus
import com.stalkerweb.android.data.repo.holdsAfterStatus
import com.stalkerweb.android.data.repo.holdsLeftByApp
import com.stalkerweb.android.data.repo.parseSoloStatus
import com.stalkerweb.android.data.repo.restartsNode
import com.stalkerweb.android.data.repo.soloForeground
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Runs the StalkerWeb server (Node) in its own process, ":node". Node can start
 * only once per process, so when it exits this process goes too, and Android
 * starts the service again (START_STICKY). The port and access key are read
 * from SoloConfig, not the Intent, so a restart without one works the same.
 * Node's own output goes to logcat, tag "stalkerweb".
 *
 * While the app holds it (SoloServer.hold: playing, casting, downloading) it
 * runs in the foreground, with a quiet "StalkerWeb Solo is running"
 * notification — shown only if notifications are allowed, it works the same
 * without. Media playback while playing or casting, which Android doesn't
 * time-limit; a data sync while only downloading.
 *
 * When the app's process ends, a download or a cast it held the server for
 * goes on without it: those holds stay, and the server is asked every 30 s
 * (GET /api/solo/status) until it says each is over.
 *
 * The app binds to it too while it's on screen (SoloServer.attach), so Android
 * counts the server as part of what's visible.
 */
class SoloServerService : Service() {
    // Nothing to call on it: the binding only keeps the server up while the app is on screen.
    private val binder = Binder()
    override fun onBind(intent: Intent?): IBinder = binder

    private val main = Handler(Looper.getMainLooper())
    // What the app holds the server for, as it last said (SoloServer sends them whole).
    private var holds: Set<String> = emptySet()
    // What an app process that has ended left going (holdsLeftByApp), until the server says it's over.
    private var left: Set<String> = emptySet()
    private var foreground: SoloForeground? = null
    private var life: IBinder? = null
    private val poller = Executors.newSingleThreadScheduledExecutor()
    private var polling: ScheduledFuture<*>? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_RESTART && started.get()) {
            if (restartsNode(answered, SystemClock.elapsedRealtime() - startedAt)) {
                // A new Node, with the key and port read afresh: this process ends, and the app starts it again.
                Log.w(TAG, "restarting the server, as the app asked")
                Process.killProcess(Process.myPid())
                return START_STICKY
            }
            // Still unpacking or booting: stopping it would only start that over. It's waited for again.
            Log.i(TAG, "the server is still starting, so it's waited for, not restarted")
        }
        // Started again (the app came back to the foreground) while it runs: just the holds.
        if (started.compareAndSet(false, true)) {
            startedAt = SystemClock.elapsedRealtime()
            // An 8 MB stack: V8 takes it to have about 1 MB, more than Android gives a thread by default.
            Thread(null, { runServer() }, "node", NODE_STACK_BYTES).start()
        }
        intent?.getStringArrayExtra(EXTRA_HOLDS)?.let { holds = it.toSet() }
        intent?.extras?.getBinder(EXTRA_LIFE)?.let(::follow)
        applyHolds()
        return START_STICKY
    }

    // The app's process ended (swiped away, or stopped by Android): appEnded.
    private fun follow(app: IBinder) {
        if (app == life) return
        life = app
        val ok = runCatching {
            app.linkToDeath({ main.post { if (life == app) appEnded() } }, 0)
        }.isSuccess
        if (!ok) appEnded()   // already gone
    }

    // Playing ended with the app; a download or a cast goes on, so it's kept until the server says it's over.
    private fun appEnded() {
        left = left + holdsLeftByApp(holds)
        holds = emptySet()
        applyHolds()
        if (left.isNotEmpty() && polling == null) {
            polling = poller.scheduleWithFixedDelay({ askStatus() }, STATUS_EVERY_S, STATUS_EVERY_S, TimeUnit.SECONDS)
        }
    }

    // On the poller's thread. No answer (the server busy, or still starting): asked again next time.
    private fun askStatus() {
        val status = runCatching { fetchStatus() }.getOrNull() ?: return
        main.post { onStatus(status) }
    }

    private fun onStatus(status: SoloStatus) {
        left = holdsAfterStatus(left, status)
        if (left.isEmpty()) { polling?.cancel(false); polling = null }
        applyHolds()
    }

    /** GET /api/solo/status from the server in this process, with its key; null without an answer. */
    private fun fetchStatus(): SoloStatus? {
        val config = SoloConfig.read(SoloConfig.file(filesDir)) ?: return null
        val (code, body) = get(config.port, "/api/solo/status", config.key) ?: return null
        return if (code == 200) parseSoloStatus(body) else null
    }

    private fun applyHolds() {
        val want = soloForeground(holds + left)
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

    override fun onDestroy() {
        poller.shutdownNow()
        super.onDestroy()
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
            val config = withFreePort(file, saved)
            // Watched from the start: until it first answers, a restart only waits for it (onStartCommand).
            Thread({ watchUntilAnswered(config.port) }, "node-health").apply { isDaemon = true }.start()
            val assets = applicationContext.assets
            val version = assets.open(ServerInstaller.VERSION_ASSET).bufferedReader().use { it.readText().trim() }
            val entry = ServerInstaller.ensureInstalled(this, { name -> assets.open(name) }, version, File(filesDir, "server"))
            val dataDir = File(filesDir, "data").apply { mkdirs() }
            val downloadDir = SoloEnv.downloadDir(filesDir).apply { mkdirs() }
            val env = SoloEnv.build(config.port, config.key, dataDir, downloadDir, BuildConfig.VERSION_NAME)
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

    /** [saved], or with a new port if it's taken (saved for the app to find: SoloServer). */
    private fun withFreePort(file: File, saved: SoloConfig): SoloConfig {
        val port = SoloPorts.choose(saved.port, SoloPorts::isFree, SoloPorts::freePort)
        if (port == saved.port) return saved
        Log.w(TAG, "port ${saved.port} is taken, moving to $port")
        return saved.copy(port = port).also { SoloConfig.write(file, it) }
    }

    // Asks the health check until Node first answers (or it's long past stuck: restartsNode).
    private fun watchUntilAnswered(port: Int) {
        while (!answered && SystemClock.elapsedRealtime() - startedAt < SOLO_STUCK_START_MS) {
            if (get(port, "/api/health", null)?.first == 200) answered = true
            else SystemClock.sleep(500)
        }
    }

    /** A GET to the server in this process: the status code and body, or null if nothing answered. */
    private fun get(port: Int, path: String, key: String?): Pair<Int, String>? {
        val connection = runCatching { URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection }.getOrNull() ?: return null
        return try {
            connection.connectTimeout = 2_000
            connection.readTimeout = 5_000
            connection.useCaches = false
            if (key != null) connection.setRequestProperty("Authorization", "Bearer $key")
            val code = connection.responseCode
            val body = (if (code < 400) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            code to body
        } catch (e: IOException) {
            null
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        private const val TAG = "SoloServer"
        private const val CHANNEL_ID = "solo-server"
        private const val NOTIFICATION_ID = 4071
        private const val NODE_STACK_BYTES = 8L shl 20
        private const val STATUS_EVERY_S = 30L

        /** Start Node again (SoloServer.restart). */
        const val ACTION_RESTART = "com.stalkerweb.android.solo.RESTART"
        /** What the app holds the server for, all of it (SoloHold). */
        const val EXTRA_HOLDS = "holds"
        /** A Binder of the app's main process, to see it end. */
        const val EXTRA_LIFE = "life"

        // Once per process: Node can't run twice in one.
        private val started = AtomicBoolean(false)
        // When Node was started in this process, and whether it has answered since.
        @Volatile private var startedAt = 0L
        @Volatile private var answered = false
        private val runtime: NodeRuntime get() = NodejsMobileRuntime
    }
}
