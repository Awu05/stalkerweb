package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.CreateViewerRequest
import com.stalkerweb.android.data.api.ViewerDetails
import com.stalkerweb.android.data.api.ViewerSummary
import com.stalkerweb.android.data.prefs.AppPrefs
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Who is watching on this device: the list, the current viewer and its filters. */
class ViewerRepository(private val prefs: AppPrefs, private val apis: ApiProvider) {
    private val _current = MutableStateFlow<ViewerDetails?>(null)
    /** The current viewer's details, once read from the server. */
    val current: StateFlow<ViewerDetails?> = _current.asStateFlow()

    private val _changes = MutableStateFlow(0)
    /** Goes up on every switch or forget — screens holding a viewer's data reload on it. */
    val changes: StateFlow<Int> = _changes.asStateFlow()

    fun savedViewerId(): String? = prefs.viewerId

    suspend fun list(): List<ViewerSummary> = apis.get().getViewers().viewers

    /**
     * Who to start as. When the list can't be read (an older server without
     * viewers, or a hiccup), don't block the app: carry on as the server's
     * default viewer.
     */
    suspend fun startupChoice(): ViewerChoice =
        runCatching { chooseViewer(list(), prefs.viewerId) }.getOrElse { ViewerChoice(prefs.viewerId, false) }

    suspend fun choose(id: String) {
        prefs.viewerId = id
        _current.value = null
        _changes.value += 1
        refresh()
    }

    /** Makes a viewer (the server checks the name) and switches to it. Throws with the server's message. */
    suspend fun create(name: String): ViewerSummary {
        val viewer = apis.get().createViewer(CreateViewerRequest(name.trim()))
        choose(viewer.id)
        return viewer
    }

    suspend fun refresh(): ViewerDetails? =
        runCatching { apis.get().getMyViewer() }.getOrNull().also { _current.value = it }

    /** The current viewer's live TV filter, reading the viewer first if needed. */
    suspend fun filter(): ViewerFilter = ViewerFilter.from(_current.value ?: refresh())

    /** This device's viewer is no more (deleted elsewhere): forget it. */
    fun forget() {
        prefs.viewerId = null
        _current.value = null
        _changes.value += 1
    }
}
