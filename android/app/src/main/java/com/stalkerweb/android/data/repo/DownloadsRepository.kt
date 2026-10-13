package com.stalkerweb.android.data.repo

import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import com.stalkerweb.android.data.api.DownloadItem
import com.stalkerweb.android.data.api.DownloadJob
import com.stalkerweb.android.data.api.DownloadRequest
import com.stalkerweb.android.data.prefs.AppPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request

/** Downloads to the server's disk (backend routes/downloads.js). */
class DownloadsRepository(private val apis: ApiProvider, private val prefs: AppPrefs, private val client: OkHttpClient) {
    private val adapter = Moshi.Builder().addLast(KotlinJsonAdapterFactory()).build()
        .adapter<List<DownloadJob>>(Types.newParameterizedType(List::class.java, DownloadJob::class.java))

    suspend fun list(): List<DownloadJob> = apis.get().getDownloads().downloads
    suspend fun enqueue(items: List<DownloadItem>) = apis.get().enqueueDownloads(DownloadRequest(items))
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
