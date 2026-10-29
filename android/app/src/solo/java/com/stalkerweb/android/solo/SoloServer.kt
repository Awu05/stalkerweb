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
import java.io.File
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * The server inside Solo, seen from the app's main process: it picks the ports
 * and the access key on first launch (SoloConfig), points the app at
 * 127.0.0.1, and starts SoloServerService, which runs Node in a process of
 * its own — and may move to other ports if the saved ones are taken, which
 * the app picks up here ([refresh]).
 */
object SoloServer {
    private const val TAG = "SoloServer"

    @Volatile private var configFile: File? = null
    @Volatile private var container: AppContainer? = null

    fun boot(app: Application, container: AppContainer) {
        val file = SoloConfig.file(app.filesDir)
        if (SoloConfig.read(file) == null) {
            val (port, castPort) = SoloPorts.choose(null, { true }, SoloPorts::freePort)
            SoloConfig.write(file, SoloConfig(port, castPort, newKey()))
        }
        configFile = file
        this.container = container
        refresh()

        val intent = Intent(app, SoloServerService::class.java)
        start(app, intent)
        // And each time the app comes to the foreground: while it was in the
        // background Android may have stopped the service, or its process.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                refresh()
                start(app, intent)
            }
        })
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
        val quick = client.newBuilder().callTimeout(2, TimeUnit.SECONDS).build()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val ok = withContext(Dispatchers.IO) {
                // Read each time: the server may be moving to other ports as it starts.
                val url = refresh() ?: return@withContext false
                val request = Request.Builder().url("$url/api/health").build()
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
}
