package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.CompletedRequest
import com.stalkerweb.android.data.api.HistoryEntry
import com.stalkerweb.android.data.api.ListEntry
import com.stalkerweb.android.data.api.ProgressEntry
import com.stalkerweb.android.data.api.SaveWatchRequest
import com.stalkerweb.android.data.api.StalkerApi
import com.stalkerweb.android.data.api.VodItem
import com.stalkerweb.android.data.api.WatchState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * What the current viewer has watched — resume points, Recently watched, the
 * titles finished and My List — kept on the server per viewer and portal
 * (backend viewers/WatchStore.js), so it follows them to the web and other
 * devices. Mirrors the web's lib/vodProgress.js: changes show at once, and an
 * answer is used only while it's still current ([RequestOrder]).
 */
class WatchRepository(private val apis: ApiProvider, private val links: MediaLinks, viewers: ViewerRepository) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val order = RequestOrder()
    private val _state = MutableStateFlow(WatchState())
    val state: StateFlow<WatchState> = _state.asStateFlow()

    init {
        // At start and on every viewer switch: the new viewer's, never the last one's.
        scope.launch {
            viewers.changes.collect {
                order.next(local = true)   // answers for the previous viewer are stale now
                _state.value = WatchState()
                load()
            }
        }
    }

    fun load() = request(local = false) { getWatch() }

    fun saveProgress(entry: SaveWatchRequest) = request(local = false) { saveWatch(entry) }

    fun removeFromHistory(id: String) {
        val s = _state.value
        set(s.copy(history = s.history.filter { it.id != id }, progress = s.progress.filter { it.key.substringBefore(':') != id }))
        request(local = true) { removeWatchTitle(id) }
    }

    fun clearHistory() {
        set(_state.value.copy(history = emptyList()))
        request(local = true) { clearWatchHistory() }
    }

    fun isInMyList(id: String): Boolean = _state.value.list.any { it.id == id }

    /** On My List → off it; off it → on it (as a movie or show the web can show too). */
    fun toggleMyList(item: VodItem) {
        val s = _state.value
        if (isInMyList(item.id)) {
            set(s.copy(list = s.list.filter { it.id != item.id }))
            request(local = true) { removeFromWatchList(item.id) }
        } else {
            set(s.copy(list = listOf(ListEntry(item.id, item, System.currentTimeMillis(), null)) + s.list))
            val stored = item.copy(screenshotUrl = links.relativeImage(item.screenshotUrl))
            request(local = true) { addToWatchList(stored) }
        }
    }

    fun setCompleted(id: String, completed: Boolean) {
        val s = _state.value
        set(s.copy(list = s.list.map { if (it.id == id) it.copy(completedAt = if (completed) System.currentTimeMillis() else null) else it }))
        request(local = true) { setWatchListCompleted(id, CompletedRequest(completed)) }
    }

    /** An episode ticked as watched, or not, by hand. Watched, it has no resume point left. */
    fun setEpisodeWatched(key: String, watched: Boolean) {
        val s = _state.value
        val rest = s.watchedEpisodes.filter { it != key }
        set(s.copy(
            watchedEpisodes = if (watched) listOf(key) + rest else rest,
            progress = if (watched) s.progress.filter { it.key != key } else s.progress,
        ))
        request(local = true) { setEpisodeWatched(key, com.stalkerweb.android.data.api.EpisodeWatchedRequest(watched)) }
    }

    fun progressFor(key: String): ProgressEntry? = _state.value.progress.firstOrNull { it.key == key }

    /** Ids of titles started or finished — for the "Not watched" filter. */
    fun watchedIds(): Set<String> = _state.value.let { s ->
        s.watched.toSet() + s.history.map(HistoryEntry::id) + s.progress.map { it.key.substringBefore(':') }
    }

    private fun set(next: WatchState) { _state.value = next }

    // A request whose answer (the whole state) replaces what's here when still current;
    // a failed change reloads, undoing what was shown.
    private fun request(local: Boolean, call: suspend StalkerApi.() -> WatchState) {
        val n = order.next(local)
        scope.launch {
            runCatching { apis.get().call() }
                .onSuccess { if (order.accept(n)) _state.value = it.withImages() }
                .onFailure { if (local) load() }
        }
    }

    // Images are stored as the server's own paths; shown, they need its address.
    private fun WatchState.withImages() = copy(
        progress = progress.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl).orEmpty()) },
        history = history.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl).orEmpty()) },
        list = list.map { it.copy(item = it.item.copy(screenshotUrl = links.absoluteImage(it.item.screenshotUrl))) },
    )
}
