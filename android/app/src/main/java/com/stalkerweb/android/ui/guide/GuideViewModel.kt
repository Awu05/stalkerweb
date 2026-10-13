package com.stalkerweb.android.ui.guide

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.EpgEvent
import com.stalkerweb.android.data.api.Group
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.GuideRepository
import com.stalkerweb.android.data.repo.LiveRepository
import com.stalkerweb.android.data.repo.RemindersRepository
import com.stalkerweb.android.data.repo.ViewerRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

const val FAVORITES_FILTER = "__favorites"

data class GuideState(
    val channels: List<Channel> = emptyList(),          // the viewer's, with guide data
    val epg: Map<String, List<EpgEvent>> = emptyMap(),
    val groups: List<Group> = emptyList(),
    val favoriteIds: Set<String> = emptySet(),
    val logoMap: Map<String, String> = emptyMap(),
    val filter: String? = null,                         // null = All; a genre id; or FAVORITES_FILTER
    val loading: Boolean = true,
    val error: String? = null,
) {
    val shown: List<Channel> get() = when (filter) {
        null -> channels
        FAVORITES_FILTER -> channels.filter { it.uniqueId in favoriteIds }
        else -> channels.filter { it.genreId == filter }
    }
}

/** The guide (the web's EpgGridPage / GuideListView): the viewer's channels that have programmes. */
class GuideViewModel(
    private val guide: GuideRepository,
    private val live: LiveRepository,
    val reminders: RemindersRepository,
    private val viewers: ViewerRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(GuideState())
    val state: StateFlow<GuideState> = _state.asStateFlow()
    private var loadJob: Job? = null

    init {
        load()
        viewModelScope.launch { viewers.changes.drop(1).collect { load(force = true) } }
    }

    fun load(force: Boolean = false) {
        _state.value = _state.value.copy(loading = true, error = null)
        // The newest load wins: an older answer (other filters, another portal) mustn't land after it.
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            runCatching {
                val epg = guide.guide(force, viewers.changes.value)
                val channels = live.getChannels().filter { !epg[it.uniqueId].isNullOrEmpty() }
                _state.value = _state.value.copy(
                    channels = channels, epg = epg, groups = live.getGroups(), favoriteIds = live.getFavoriteIds(),
                    logoMap = live.getLogoMap(), loading = false,
                )
            }.onFailure { _state.value = _state.value.copy(loading = false, error = it.toApiError().message) }
        }
    }

    fun setFilter(f: String?) { _state.value = _state.value.copy(filter = f) }
}
