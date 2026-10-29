package com.stalkerweb.android.data.repo

import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import com.stalkerweb.android.data.api.DownloadItem
import com.stalkerweb.android.data.api.DownloadJob
import com.stalkerweb.android.data.api.DownloadRequest
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.solo.SoloServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request

/** Downloads to the server's disk (backend routes/downloads.js). */
class DownloadsRepository(private val apis: ApiProvider, private val prefs: AppPrefs, private val client: OkHttpClient) {
    private val adapter = Moshi.Builder().addLast(KotlinJsonAdapterFactory()).build()
        .adapter<List<DownloadJob>>(Types.newParameterizedType(List::class.java, DownloadJob::class.java))

    suspend fun list(): List<DownloadJob> = apis.get().getDownloads().downloads
    suspend fun enqueue(items: List<DownloadItem>) = apis.get().enqueueDownloads(DownloadRequest(items)).also { watch() }

    // Solo: the server does the downloading, so it's kept up (SoloServer.hold)
    // from the moment one is queued until none is left to finish — wherever it
    // was started from, whatever screen is open. A no-op in the remote apps.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var watcher: Job? = null

    /** Follows the downloads until none is queued or under way, holding the server meanwhile. */
    @Synchronized fun watch() {
        if (watcher?.isActive == true) return
        watcher = scope.launch {
            SoloServer.hold(SoloHold.DOWNLOADING)
            try { followUntilIdle() } finally { SoloServer.release(SoloHold.DOWNLOADING) }
        }
    }

    private suspend fun followUntilIdle() {
        var misses = 0
        while (true) {
            val jobs = runCatching { list() }.getOrNull()
            if (jobs != null && !anyDownloadActive(jobs)) return
            // The server not answering for about a minute: let go, it isn't downloading.
            misses = if (jobs == null) misses + 1 else 0
            if (misses >= 20) return
            // The event stream until nothing is left to finish; when it ends or fails, poll.
            if (jobs != null && runCatching { events().firstOrNull { !anyDownloadActive(it) } != null }.getOrDefault(false)) return
            delay(3_000)
        }
    }
    suspend fun remove(id: String) = apis.get().removeDownload(id)

    /**
     * The downloads as they change — the server's event stream, read line by
     * line on the app's client (it carries the key and goes through the access
     * guard). Completes when the stream ends or fails; the caller falls back
     * to polling.
     */
    fun events(): Flow<List<DownloadJob>> = callbackFlow {
        val base = prefs.serverUrl?.trimEnd('/')
        if (base == null) { close(); return@callbackFlow }
        val call = client.newCall(Request.Builder().url("$base/api/downloads/events").build())
        val reader = launch(Dispatchers.IO) {
            runCatching {
                call.execute().use { resp ->
                    if (resp.isSuccessful) {
                        val source = resp.body.source()
                        while (!source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            parseSseData(line)?.let { json -> runCatching { adapter.fromJson(json) }.getOrNull()?.let { trySend(it) } }
                        }
                    }
                }
            }
            close()
        }
        awaitClose { call.cancel(); reader.cancel() }
    }
}
