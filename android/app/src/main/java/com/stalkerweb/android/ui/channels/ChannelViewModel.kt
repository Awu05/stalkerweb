package com.stalkerweb.android.ui.channels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.Group
import com.stalkerweb.android.data.api.NowNextEntry
import com.stalkerweb.android.data.prefs.WatchedChannel
import com.stalkerweb.android.data.repo.LiveRepository
import com.stalkerweb.android.data.repo.ServerRepository
import com.stalkerweb.android.data.repo.ViewerRepository
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import retrofit2.HttpException

enum class ChannelTab { ALL, FAVORITES }

data class ChannelUiState(
    val channels: List<Channel>      = emptyList(),
    val logoMap: Map<String, String> = emptyMap(),
    val favoriteIds: Set<String>     = emptySet(),
    val groups: List<Group>          = emptyList(),
    val nowNext: Map<String, NowNextEntry> = emptyMap(),
    val recentChannels: List<WatchedChannel> = emptyList(),
    val selectedGroupId: String?     = null,
    val query: String                = "",
    val tab: ChannelTab              = ChannelTab.ALL,
    val loading: Boolean             = true,
    val error: String?               = null,
    // Backend returned 503 "not connected to a portal" — distinct from a
    // network/server error so the UI can point the user at the Portal
    // screen instead of just offering a dead-end "Retry".
    val portalNotConnected: Boolean  = false,
) {
    val displayed: List<Channel>
        get() {
            var base = if (tab == ChannelTab.FAVORITES)
                channels.filter { it.uniqueId in favoriteIds }
            else
                channels

            if (selectedGroupId != null && tab == ChannelTab.ALL) {
                base = base.filter { it.genreId == selectedGroupId }
            }

            return if (query.isBlank()) base
            else base.filter { it.name.contains(query, ignoreCase = true) }
        }

    /** Show recent row only when on the All tab with no search/group filter active. */
    val showRecent: Boolean
        get() = tab == ChannelTab.ALL && query.isBlank() && selectedGroupId == null && recentChannels.isNotEmpty()
}

class ChannelViewModel(
    private val live: LiveRepository,
    private val server: ServerRepository,
    private val viewers: ViewerRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ChannelUiState())
    val state: StateFlow<ChannelUiState> = _state.asStateFlow()

    init {
        if (server.getServerUrl() != null) load()
        // Another viewer: their favorites and filters — read the lists again.
        viewModelScope.launch { viewers.changes.drop(1).collect { load(reset = true) } }
    }

    /**
     * @param reset clears in-memory + cached state first — used after switching
     *   servers so the previous server's channels don't linger during the refresh.
     */
    fun load(reset: Boolean = false) {
        if (reset) {
            _state.value = _state.value.copy(
                channels        = emptyList(),
                logoMap         = emptyMap(),
                groups          = emptyList(),
                favoriteIds     = emptySet(),
                nowNext         = emptyMap(),
                selectedGroupId = null,
            )
        }
        // Render the on-disk cache immediately (channels, logos, watch history) so
        // the list appears instantly on cold start and survives a briefly-
        // unreachable backend; the network refresh below replaces it silently.
        val cached      = live.getCachedChannels()
        val cachedLogos = live.getCachedLogoMap()
        val haveData    = cached.isNotEmpty() || _state.value.channels.isNotEmpty()
        _state.value = _state.value.copy(
            loading            = !haveData,
            error              = null,
            portalNotConnected = false,
            recentChannels     = live.getWatched(),
            channels       = if (_state.value.channels.isEmpty()) cached else _state.value.channels,
            logoMap        = if (_state.value.logoMap.isEmpty()) cachedLogos else _state.value.logoMap,
        )
        viewModelScope.launch {
            runCatching {
                // coroutineScope is load-bearing: a failing `async` propagates to
                // its parent job immediately, so catching only at `await()` still
                // cancels this launch and hands the exception to viewModelScope's
                // (default, crashing) handler. Inside coroutineScope the failure is
                // rethrown here instead, where runCatching can actually catch it —
                // which is what turns a portal-not-connected 503 into the empty
                // state below rather than a crash on launch.
                coroutineScope {
                    val channels = async { live.getChannels() }
                    val logos    = async { live.getLogoMap() }
                    val favs     = async { live.getFavoriteIds() }
                    val groups   = async { live.getGroups() }
                    val data = Triple(channels.await(), logos.await(), favs.await())
                    val grps = groups.await()
                    data to grps
                }
            }.onSuccess { (triple, groups) ->
                val (channels, logos, favs) = triple
                _state.value = _state.value.copy(
                    channels           = channels,
                    logoMap            = logos,
                    favoriteIds        = favs,
                    groups             = groups,
                    loading            = false,
                    portalNotConnected = false,
                )
            }.onFailure { e ->
                // Backend returns 503 when no portal is connected — point the user
                // at the Portal screen instead of a dead-end "Retry" error.
                val notConnected = e is HttpException && e.code() == 503
                // Keep showing cached channels if we have them; only surface a hard
                // error when there's nothing to display.
                // Report the disconnect even when a cached list is on screen.
                // Gating this on an empty list meant returning users saw a
                // perfectly normal channel list backed by a dead portal, where
                // every channel failed at playback with a generic error and
                // nothing pointed at the cause. The screen keeps showing the
                // cache and puts a banner over it instead.
                _state.value = _state.value.copy(
                    loading            = false,
                    portalNotConnected = notConnected,
                    error              = if (!notConnected && _state.value.channels.isEmpty()) e.message else null,
                )
            }
        }
        // EPG fetch is best-effort — don't block or fail the channel list
        viewModelScope.launch {
            val nowNext = live.getNowNext()
            if (nowNext.isNotEmpty()) _state.value = _state.value.copy(nowNext = nowNext)
        }
    }

    /** Re-read history from prefs — called from MainActivity.onResume so the row
     *  stays fresh after the user returns from the player. */
    fun refreshHistory() {
        _state.value = _state.value.copy(recentChannels = live.getWatched())
    }

    fun setQuery(q: String) { _state.value = _state.value.copy(query = q) }
    fun setTab(tab: ChannelTab) { _state.value = _state.value.copy(tab = tab) }
    fun setSelectedGroup(id: String?) { _state.value = _state.value.copy(selectedGroupId = id) }

    fun toggleFavorite(channel: Channel) {
        val id    = channel.uniqueId
        val isFav = id in _state.value.favoriteIds
        // Optimistic update
        _state.value = _state.value.copy(
            favoriteIds = if (isFav) _state.value.favoriteIds - id
                          else _state.value.favoriteIds + id,
        )
        viewModelScope.launch {
            runCatching {
                if (isFav) live.removeFavorite(id) else live.addFavorite(id)
            }.onFailure {
                // Roll back on network failure
                _state.value = _state.value.copy(
                    favoriteIds = if (isFav) _state.value.favoriteIds + id
                                  else _state.value.favoriteIds - id,
                )
            }
        }
    }
}
