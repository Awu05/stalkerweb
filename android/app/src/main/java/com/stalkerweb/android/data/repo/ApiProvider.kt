package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.ApiClient
import com.stalkerweb.android.data.api.ApiError
import com.stalkerweb.android.data.api.StalkerApi
import com.stalkerweb.android.data.prefs.AppPrefs
import okhttp3.OkHttpClient

/**
 * The API for the saved server, on the app's one [client] (ApiClient.httpClient)
 * — rebuilt when the server changes; the key and viewer are read per request.
 */
class ApiProvider(private val prefs: AppPrefs, private val client: OkHttpClient) {
    @Volatile private var api: StalkerApi? = null

    init { rebuild() }

    fun rebuild() {
        val url = prefs.serverUrl
        api = url?.let {
            runCatching { ApiClient.create(it, client) }.getOrElse {
                // A stored URL that can't be used (data corruption): forget it so
                // the app lands on Setup instead of failing on every launch.
                prefs.serverUrl = null
                null
            }
        }
    }

    fun get(): StalkerApi = api ?: throw ApiError.Failed("No server is set up.")
}
