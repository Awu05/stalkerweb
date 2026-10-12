package com.stalkerweb.android.data.repo

import android.content.Context
import com.stalkerweb.android.data.api.AccessGuard
import com.stalkerweb.android.data.api.AccessStore
import com.stalkerweb.android.data.api.ApiClient
import com.stalkerweb.android.data.api.AppEvents
import com.stalkerweb.android.data.prefs.AppPrefs
import okhttp3.OkHttpClient

/** Builds the app's data layer once (StalkerWebApp); screens take what they need from it. */
class AppContainer(context: Context) {
    val prefs = AppPrefs(context)
    val events = AppEvents()

    /** Keeps a refused access key from being tried again (data/api/AccessGuard). */
    val guard = AccessGuard(object : AccessStore {
        override var rejectedMessage: String?
            get() = prefs.accessRejectedMessage
            set(value) {
                prefs.accessRejectedMessage = value
                // The playback token goes with the key: links carrying it would be refused too.
                if (value != null) prefs.shareToken = null
            }
    })

    /** The one HTTP client for the server — API calls and images (Coil, StalkerWebApp) alike. */
    val httpClient: OkHttpClient = ApiClient.httpClient(
        serverUrl = { prefs.serverUrl },
        accessKey = { prefs.accessKey },
        viewerId = { prefs.viewerId },
        guard = guard,
        events = events,
    )

    val apis = ApiProvider(prefs, httpClient)
    private val links = MediaLinks(prefs, apis)
    val server = ServerRepository(prefs, apis, guard)
    val viewers = ViewerRepository(prefs, apis)
    val live = LiveRepository(prefs, apis, links, viewers)
    val vod = VodRepository(apis, links)
}
