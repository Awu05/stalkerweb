package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.ApiClient
import com.stalkerweb.android.data.api.ApiError
import com.stalkerweb.android.data.api.AppEvents
import com.stalkerweb.android.data.api.StalkerApi
import com.stalkerweb.android.data.prefs.AppPrefs

/** The client for the saved server — rebuilt when the server changes; the key and viewer are read per request. */
class ApiProvider(private val prefs: AppPrefs, private val events: AppEvents) {
    @Volatile private var api: StalkerApi? = null

    init { rebuild() }

    fun rebuild() {
        val url = prefs.serverUrl
        api = url?.let {
            runCatching { ApiClient.create(it, { prefs.accessKey }, { prefs.viewerId }, events) }.getOrElse {
                // A stored URL that can't be used (data corruption): forget it so
                // the app lands on Setup instead of failing on every launch.
                prefs.serverUrl = null
                null
            }
        }
    }

    fun get(): StalkerApi = api ?: throw ApiError.Failed("No server is set up.")
}
