package com.stalkerweb.android.solo

import android.app.Application
import android.content.Intent
import android.os.Binder
import android.os.Bundle
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.stalkerweb.android.data.repo.AppContainer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The server inside Solo, seen from the app's main process: it picks the ports
 * and the access key on first launch (SoloConfig), points the app at
 * 127.0.0.1, and starts SoloServerService, which runs Node in a process of
 * its own — and may move to other ports if the saved ones are taken, which
 * the app picks up here ([refresh]): on each return to the foreground, and
 * when a request finds nothing on the old port ([onConnectionFailed]).
 *
 * While the app needs the server — playing, casting, downloading — it asks
 * for it to be kept up ([hold], [release]): the service then runs in the
 * foreground, so Android doesn't stop it to free memory.
 */
object SoloServer {
    private const val TAG = "SoloServer"
    private const val RESTART_GRACE_MS = 1_500L

    @Volatile private var configFile: File? = null
    @Volatile private var container: AppContainer? = null
    @Volatile private var app: Application? = null

    // Why the app needs the server up (SoloHold), sent whole with each start of the service.
    private val holds = mutableSetOf<String>()
    // Sent with them: the service sees this process end through it, and lets go of its holds.
    private val life = Binder()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val recovering = AtomicBoolean(false)
    // When restart was asked for: the old Node may still answer for a moment.
    @Volatile private var restartedAt = 0L

    fun boot(app: Application, container: AppContainer) {
        val file = SoloConfig.file(app.filesDir)
        if (SoloConfig.read(file) == null) {
            val (port, castPort) = SoloPorts.choose(null, { true }, SoloPorts::freePort)
            SoloConfig.write(file, SoloConfig(port, castPort, newKey()))
        }
        configFile = file
        this.container = container
        this.app = app
        refresh()

        start()
        CastNetwork.start(app, container)
        // And each time the app comes to the foreground: while it was in the
        // background Android may have stopped the service, or its process.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                refresh()
                start()
                CastNetwork.resend()
            }
        })
    }

    /** Keep the server up for [reason] (SoloHold), until [release]. */
    fun hold(reason: String) {
        if (synchronized(holds) { holds.add(reason) }) start()
    }

    /** [reason] no longer needs the server up; releasing one not held does nothing. */
    fun release(reason: String) {
        if (synchronized(holds) { holds.remove(reason) }) start()
    }

    /**
     * A request found nothing listening on the server's port: it may have
     * moved (another app took the port while it was down) or stopped. Points
     * the app at where it is now, starts it if it isn't running, and once it
     * answers tells it the Wi-Fi address again. One at a time, however many
     * requests fail together.
     */
    fun onConnectionFailed() {
        if (container == null || !recovering.compareAndSet(false, true)) return
        scope.launch {
            try {
                refresh()
                start()
                val c = container ?: return@launch
                awaitReady(c.httpClient, 10_000)
            } finally {
                recovering.set(false)
            }
        }
    }

    /**
     * Starts the server again (a new Node, the key and ports read afresh): the
     * key was refused — or this address locked out — which the app's own key
     * can only be through a fault. The app waits for it with [awaitReady].
     */
    fun restart() {
        restartedAt = System.currentTimeMillis()
        refresh()
        start(SoloServerService.ACTION_RESTART)
    }

    /** Points the app at the server's current port and key (the server may have moved). */
    private fun refresh(): String? {
        val config = configFile?.let { SoloConfig.read(it) } ?: return null
        val c = container ?: return null
        val url = "http://127.0.0.1:${config.port}"
        if (c.prefs.serverUrl != url || c.prefs.accessKey != config.key) {
            c.prefs.serverUrl = url
            c.prefs.accessKey = config.key
            c.apis.rebuild()
        }
        return url
    }

    /** Waits for the server to answer its health check: false if it hasn't within [timeoutMs]. */
    suspend fun awaitReady(client: OkHttpClient, timeoutMs: Long = 20_000): Boolean {
        // Without the app's own interceptors: the health check is open (no key
        // needed), its failures aren't the server moving (onConnectionFailed),
        // and a key refused earlier mustn't keep it from being asked.
        val quick = client.newBuilder().apply { interceptors().clear(); networkInterceptors().clear() }
            .callTimeout(2, TimeUnit.SECONDS).build()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val ok = withContext(Dispatchers.IO) {
                // Read each time: the server may be moving to other ports as it starts.
                val url = refresh() ?: return@withContext false
                val request = Request.Builder().url("$url/api/health").build()
                runCatching { quick.newCall(request).execute().use { it.isSuccessful } }.getOrDefault(false)
            }
            if (ok && System.currentTimeMillis() - restartedAt > RESTART_GRACE_MS) {
                // Up: tell it the Wi-Fi again, and give a restarted service the holds back.
                CastNetwork.resend()
                start()
                return true
            }
            if (System.currentTimeMillis() >= deadline) return false
            delay(200)
        }
    }

    // Android refuses to start a service while the app is in the background (the
    // process woken for a reminder, or at boot); the app's next start does it then.
    // Each start carries the holds as they are now, so a service started again
    // (its process stopped by Android) has them back at the app's next start.
    private fun start(action: String? = null) {
        val context = app ?: return
        val now = synchronized(holds) { holds.toTypedArray() }
        val intent = Intent(context, SoloServerService::class.java)
            .setAction(action)
            .putExtra(SoloServerService.EXTRA_HOLDS, now)
            .putExtras(Bundle().apply { putBinder(SoloServerService.EXTRA_LIFE, life) })
        runCatching { context.startService(intent) }
            .onFailure { Log.i(TAG, "the server starts with the app (${it.javaClass.simpleName})") }
    }

    /** 32 random bytes, Base64url: the server's ACCESS_KEY. */
    private fun newKey(): String {
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
