package com.stalkerweb.android.data.repo

import android.content.Context
import com.stalkerweb.android.data.api.AppEvents
import com.stalkerweb.android.data.prefs.AppPrefs

/** Builds the app's data layer once (StalkerWebApp); screens take what they need from it. */
class AppContainer(context: Context) {
    val prefs = AppPrefs(context)
    val events = AppEvents()
    val apis = ApiProvider(prefs, events)
    private val links = MediaLinks(prefs, apis)
    val server = ServerRepository(prefs, apis)
    val viewers = ViewerRepository(prefs, apis)
    val live = LiveRepository(prefs, apis, links, viewers)
    val vod = VodRepository(apis, links)
}
