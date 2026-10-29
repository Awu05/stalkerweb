package com.stalkerweb.android.solo

import android.app.Application
import android.content.Intent
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.stalkerweb.android.data.repo.AppContainer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.ServerSocket
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * The server inside Solo, seen from the app's main process: it picks the ports
 * and the access key on first launch, points the app at 127.0.0.1, and starts
 * SoloServerService, which runs Node in a process of its own.
 */
object SoloServer {
    private const val TAG = "SoloServer"

    @Volatile private var baseUrl: String? = null

    fun boot(app: Application, container: AppContainer) {
        val prefs = container.prefs
        if (prefs.soloKey.isNullOrBlank()) prefs.soloKey = newKey()
        if (prefs.soloPort <= 0 || prefs.soloCastPort <= 0) {
            val (port, castPort) = freePorts()
            prefs.soloPort = port
            prefs.soloCastPort = castPort
        }
        val url = "http://127.0.0.1:${prefs.soloPort}"
        baseUrl = url
        prefs.serverUrl = url
        prefs.accessKey = prefs.soloKey

        val intent = Intent(app, SoloServerService::class.java)
            .putExtra(SoloServerService.EXTRA_PORT, prefs.soloPort)
            .putExtra(SoloServerService.EXTRA_CAST_PORT, prefs.soloCastPort)
            .putExtra(SoloServerService.EXTRA_KEY, prefs.soloKey)
        start(app, intent)
        // And each time the app comes to the foreground: while it was in the
        // background Android may have stopped the service, or its process.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = start(app, intent)
        })
    }

    /** Waits for the server to answer its health check: false if it hasn't within [timeoutMs]. */
    suspend fun awaitReady(client: OkHttpClient, timeoutMs: Long = 20_000): Boolean {
        val url = baseUrl ?: return false
        val quick = client.newBuilder().callTimeout(2, TimeUnit.SECONDS).build()
        val request = Request.Builder().url("$url/api/health").build()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val ok = withContext(Dispatchers.IO) {
                runCatching { quick.newCall(request).execute().use { it.isSuccessful } }.getOrDefault(false)
            }
            if (ok) return true
            if (System.currentTimeMillis() >= deadline) return false
            delay(200)
        }
    }

    // Android refuses to start a service while the app is in the background (the
    // process woken for a reminder, or at boot); the app's next start does it then.
    private fun start(app: Application, intent: Intent) {
        runCatching { app.startService(intent) }
            .onFailure { Log.i(TAG, "the server starts with the app (${it.javaClass.simpleName})") }
    }

    /** 32 random bytes, Base64url: the server's ACCESS_KEY. */
    private fun newKey(): String {
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    /** Two ports free right now, and not the same one (both held open while picking). */
    private fun freePorts(): Pair<Int, Int> =
        ServerSocket(0).use { a -> ServerSocket(0).use { b -> a.localPort to b.localPort } }
}
