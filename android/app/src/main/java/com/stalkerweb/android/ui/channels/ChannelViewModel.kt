package com.stalkerweb.android.ui.channels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.ChannelHealth
import com.stalkerweb.android.data.api.FavoriteGroup
import com.stalkerweb.android.data.api.Group
import com.stalkerweb.android.data.api.NowNextEntry
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.data.prefs.WatchedChannel
import com.stalkerweb.android.data.repo.LiveRepository
import com.stalkerweb.android.data.repo.ServerRepository
import com.stalkerweb.android.data.repo.ViewerRepository
import com.stalkerweb.android.data.repo.filterChannels
import com.stalkerweb.android.data.repo.flakyCount
import com.stalkerweb.android.data.repo.moveItem
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import retrofit2.HttpException

data class ChannelUiState(
    val channels: List<Channel> = emptyList(),
    val logoMap: Map<String, String> = emptyMap(),
    val groups: List<Group> = emptyList(),
    val nowNext: Map<String, NowNextEntry> = emptyMap(),
    val health: Map<String, ChannelHealth> = emptyMap(),
    val favoriteIds: Set<String> = emptySet(),
    val favoriteChannels: List<Channel> = emptyList(),   // in the viewer's order
    val favoriteGroups: List<FavoriteGroup> = emptyList(),
    val recentChannels: List<WatchedChannel> = emptyList(),
    val selectedGroupId: String? = null,
    val query: String = "",
    val hideFlaky: Boolean = false,
    val favoritesOpen: Boolean = true,
    val loading: Boolean = true,
    val error: String? = null,
    // The backend answered 503 "not connected to a portal": point at the Portal screen.
    val portalNotConnected: Boolean = false,
) {
    val displayed: List<Channel> get() = filterChannels(channels, selectedGroupId, query, hideFlaky, health)
    val flaky: Int get() = flakyCount(channels, health)
    /** Favorites and Recently Watched show on All with no search (as on the web). */
    val browsing: Boolean get() = selectedGroupId == null && query.isBlank()
}

/**
 * The Channels page, as on the web (frontend/src/pages/ChannelsPage.jsx):
 * the viewer's channels (filtered for them), favorites with groups, recently
 * watched on this device, now/next and stream health.
 */
class ChannelViewModel(
    private val live: LiveRepository,
    private val server: ServerRepository,
    private val viewers: ViewerRepository,
    private val prefs: AppPrefs,
) : ViewModel() {

    private val _state = MutableStateFlow(ChannelUiState(favoritesOpen = prefs.favoritesOpen))
    val state: StateFlow<ChannelUiState> = _state.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    /** Short messages for a toast (a save that failed). */
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    private var loadJob: Job? = null
    private var favoritesJob: Job? = null

    init {
        if (server.getServerUrl() != null) load()
        // Another viewer: their favorites and filters — read the lists again.
        viewModelScope.launch { viewers.changes.drop(1).collect { load(reset = true) } }
    }

    /** @param reset clears what's shown first (another server or viewer). */
    fun load(reset: Boolean = false) {
        if (reset) {
            // The last viewer's (or server's) answers still on the way mustn't land on this one.
            loadJob?.cancel(); favoritesJob?.cancel()
            _state.value = _state.value.copy(
                channels = emptyList(), logoMap = emptyMap(), groups = emptyList(), favoriteIds = emptySet(),
                favoriteChannels = emptyList(), favoriteGroups = emptyList(), nowNext = emptyMap(), selectedGroupId = null,
            )
        }
        // The on-disk cache first (this viewer's), so the grid appears at once; the network replaces it.
        val cached = live.getCachedChannels()
        val cachedLogos = live.getCachedLogoMap()
        val haveData = cached.isNotEmpty() || _state.value.channels.isNotEmpty()
        _state.value = _state.value.copy(
            loading = !haveData, error = null, portalNotConnected = false, recentChannels = live.getWatched(),
            channels = _state.value.channels.ifEmpty { cached },
            logoMap = _state.value.logoMap.ifEmpty { cachedLogos },
        )
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            runCatching {
                // coroutineScope: a failing async is rethrown here, where runCatching catches it
                // (a portal-not-connected 503 becomes the banner, not a crash).
                coroutineScope {
                    val channels = async { live.getChannels() }
                    val logos = async { live.getLogoMap() }
                    val groups = async { live.getGroups() }
                    Triple(channels.await(), logos.await(), groups.await())
                }
            }.onSuccess { (channels, logos, groups) ->
                _state.value = _state.value.copy(channels = channels, logoMap = logos, groups = groups, loading = false)
            }.onFailure { e ->
                if (e is kotlinx.coroutines.CancellationException) throw e
                val notConnected = e is HttpException && e.code() == 503
                _state.value = _state.value.copy(
                    loading = false, portalNotConnected = notConnected,
                    error = if (!notConnected && _state.value.channels.isEmpty()) e.toApiError().message else null,
                )
            }
        }
        loadFavorites()
        refreshNowNext()
        refreshHealth()
    }

    /** The viewer's favorites from the server; only the latest read counts. */
    fun loadFavorites() {
        favoritesJob?.cancel()
        favoritesJob = viewModelScope.launch {
            runCatching { live.getFavorites() }.onSuccess { f ->
                _state.value = _state.value.copy(
                    favoriteChannels = f.channels.distinctBy { it.uniqueId },
                    favoriteGroups = f.groups,
                    favoriteIds = f.channels.map { it.uniqueId }.toSet(),
                )
            }
        }
    }

    fun refreshNowNext() {
        viewModelScope.launch {
            val nowNext = live.getNowNext()
            if (nowNext.isNotEmpty()) _state.value = _state.value.copy(nowNext = nowNext)
        }
    }

    fun refreshHealth() {
        viewModelScope.launch { _state.value = _state.value.copy(health = live.getHealth()) }
    }

    /** Re-read this device's history — after returning from the player (MainActivity.onResume). */
    fun refreshHistory() { _state.value = _state.value.copy(recentChannels = live.getWatched()) }

    fun removeRecent(uniqueId: String) {
        live.removeWatched(uniqueId)
        refreshHistory()
    }

    fun setQuery(q: String) { _state.value = _state.value.copy(query = q) }
    fun setSelectedGroup(id: String?) { _state.value = _state.value.copy(selectedGroupId = id) }
    fun setHideFlaky(on: Boolean) { _state.value = _state.value.copy(hideFlaky = on) }
    fun toggleFavoritesOpen() {
        val open = !_state.value.favoritesOpen
        prefs.favoritesOpen = open
        _state.value = _state.value.copy(favoritesOpen = open)
    }

    // ── Favorites ─────────────────────────────────────────────────────────────

    fun toggleFavorite(channel: Channel) {
        val id = channel.uniqueId
        val isFav = id in _state.value.favoriteIds
        val before = _state.value
        // At once: the heart, and the Favorites section.
        _state.value = _state.value.copy(
            favoriteIds = if (isFav) _state.value.favoriteIds - id else _state.value.favoriteIds + id,
            favoriteChannels = if (isFav) _state.value.favoriteChannels.filter { it.uniqueId != id }
                               else _state.value.favoriteChannels + channel,
        )
        save(before = before) { if (isFav) live.removeFavorite(id) else live.addFavorite(id) }
    }

    /** A favorite moved one place left or right (the remote can't drag). */
    fun moveFavorite(channel: Channel, delta: Int) {
        val list = _state.value.favoriteChannels
        val moved = moveItem(list, list.indexOfFirst { it.uniqueId == channel.uniqueId }, delta)
        if (moved == list) return
        val before = _state.value
        _state.value = _state.value.copy(favoriteChannels = moved)
        save(reload = false, before = before) { live.reorderFavorites(moved.map { it.uniqueId }) }
    }

    fun moveGroup(group: FavoriteGroup, delta: Int) {
        val list = _state.value.favoriteGroups
        val moved = moveItem(list, list.indexOfFirst { it.id == group.id }, delta)
        if (moved == list) return
        val before = _state.value
        _state.value = _state.value.copy(favoriteGroups = moved)
        save(reload = false, before = before) { live.reorderGroups(moved.map { it.id }) }
    }

    fun createGroup(name: String) { if (name.isNotBlank()) save { live.createGroup(name) } }
    fun renameGroup(group: FavoriteGroup, name: String) { if (name.isNotBlank()) save { live.renameGroup(group.id, name) } }
    fun deleteGroup(group: FavoriteGroup) {
        val before = _state.value
        _state.value = _state.value.copy(favoriteGroups = _state.value.favoriteGroups.filter { it.id != group.id })
        save(before = before) { live.deleteGroup(group.id) }
    }
    fun addToGroup(group: FavoriteGroup, channel: Channel) = save { live.addToGroup(group.id, channel.uniqueId) }
    fun removeFromGroup(group: FavoriteGroup, channel: Channel) = save { live.removeFromGroup(group.id, channel.uniqueId) }

    // A favorites change on the server. On failure: say so, put back what was
    // shown before the change ([before] — the reload may fail too, offline),
    // and read the truth back.
    private fun save(reload: Boolean = true, before: ChannelUiState? = null, call: suspend () -> Unit) {
        viewModelScope.launch {
            runCatching { call() }
                .onSuccess { if (reload) loadFavorites() }
                .onFailure {
                    _messages.tryEmit("Couldn't save — try again")
                    before?.let {
                        _state.value = _state.value.copy(favoriteIds = it.favoriteIds, favoriteChannels = it.favoriteChannels, favoriteGroups = it.favoriteGroups)
                    }
                    loadFavorites()
                }
        }
    }

    // ── Logos ─────────────────────────────────────────────────────────────────

    suspend fun checkLogo(name: String): String? = live.checkLogo(name)

    fun saveLogo(channel: Channel, url: String) {
        viewModelScope.launch {
            runCatching { live.setLogoOverride(channel.name, url) }
                .onSuccess { _state.value = _state.value.copy(logoMap = live.getLogoMap()) }
                .onFailure { _messages.tryEmit("Couldn't save the logo") }
        }
    }
}
