package com.stalkerweb.android.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.LogosInfo
import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.data.api.ProfilesResponse
import com.stalkerweb.android.data.api.SettingsResponse
import com.stalkerweb.android.data.api.SettingsUpdate
import com.stalkerweb.android.data.api.StatusResponse
import com.stalkerweb.android.data.api.ViewerFiltersRequest
import com.stalkerweb.android.data.api.ViewerSummary
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.data.repo.FiltersToSave
import com.stalkerweb.android.data.repo.ServerRepository
import com.stalkerweb.android.data.repo.SettingsRepository
import com.stalkerweb.android.data.repo.ViewerRepository
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

val SETTINGS_TABS = listOf("viewers" to "Viewers", "connection" to "Connection", "links" to "Links", "playback" to "Playback", "logos" to "Logos")

data class SettingsState(
    val tab: String = "viewers",
    val settings: SettingsResponse? = null,
    val viewers: List<ViewerSummary> = emptyList(),
    val genres: List<String> = emptyList(),          // every channel genre
    val movieCategories: List<String> = emptyList(),
    val seriesCategories: List<String> = emptyList(),
    val profiles: ProfilesResponse = ProfilesResponse(),
    val status: StatusResponse? = null,
    val logos: LogosInfo? = null,
    val stripWords: List<String> = emptyList(),
    val busy: Boolean = false,
)

/** The Settings tabs, as on the web (pages/SetupPage.jsx). */
class SettingsViewModel(
    private val settings: SettingsRepository,
    private val server: ServerRepository,
    val viewers: ViewerRepository,
    private val prefs: AppPrefs,
) : ViewModel() {
    private val _state = MutableStateFlow(SettingsState(tab = prefs.settingsTab))
    val state: StateFlow<SettingsState> = _state.asStateFlow()
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    init { load() }

    fun setTab(tab: String) { prefs.settingsTab = tab; _state.value = _state.value.copy(tab = tab); load() }

    /** What the open tab needs. */
    fun load() {
        viewModelScope.launch {
            val s = _state.value
            runCatching {
                when (s.tab) {
                    // Each list on its own: with no portal connected the checklists fail, the viewers don't.
                    "viewers" -> {
                        _state.value = _state.value.copy(viewers = viewers.list())
                        if (viewers.current.value == null) viewers.refresh()
                        runCatching { settings.allGenres().map { it.name }.distinct() }.onSuccess { _state.value = _state.value.copy(genres = it) }
                        runCatching { settings.portalCategories("vod") }.onSuccess { _state.value = _state.value.copy(movieCategories = it) }
                        runCatching { settings.portalCategories("series") }.onSuccess { _state.value = _state.value.copy(seriesCategories = it) }
                    }
                    "connection" -> _state.value = _state.value.copy(profiles = server.getProfiles(), status = server.testConnection(), settings = settings.settings())
                    "links", "playback" -> _state.value = _state.value.copy(settings = settings.settings())
                    "logos" -> _state.value = _state.value.copy(logos = settings.logos(), stripWords = settings.stripWords())
                }
            }.onFailure { say(it) }
        }
    }

    private fun say(e: Throwable) { _messages.tryEmit(e.toApiError().message ?: "Something went wrong") }

    private fun act(done: String? = null, call: suspend () -> Unit) {
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true)
            runCatching { call() }.onSuccess { done?.let(_messages::tryEmit); load() }.onFailure(::say)
            _state.value = _state.value.copy(busy = false)
        }
    }

    // Viewers
    fun rename(v: ViewerSummary, name: String) = act { settings.renameViewer(v.id, name); viewers.refresh() }
    fun recolor(v: ViewerSummary, color: String) = act { settings.recolorViewer(v.id, color); viewers.refresh() }
    fun addViewer(name: String) = act("Added $name") { settings.createViewer(name) }
    /** Deletes a viewer; [onOwnDeleted] when it was this device's (the picker asks again). */
    fun deleteViewer(v: ViewerSummary, onOwnDeleted: () -> Unit) = act("Deleted ${v.name}") {
        settings.deleteViewer(v.id)
        if (v.id == viewers.savedViewerId()) { viewers.forget(); onOwnDeleted() }
    }
    fun saveFilters(f: FiltersToSave, showAdult: Boolean) = act("Saved") {
        settings.saveFilters(ViewerFiltersRequest(f.genres, f.vodCategories, showAdult, f.languages))
        viewers.filtersSaved()
    }

    // Connection
    // A portal change reloads Channels, VOD and the Guide (as the Portal screen does on Back).
    fun connect(p: Profile) = act { val r = server.connectProfile(p); viewers.sectionsChanged(); if (!r.success) throw IllegalStateException(r.error ?: "Couldn't connect") }
    fun disconnect() = act("Disconnected") { server.disconnectPortal(); viewers.sectionsChanged() }
    fun reconnect() = act { val r = server.reconnectPortal(); viewers.sectionsChanged(); if (!r.success) throw IllegalStateException(r.error ?: "Couldn't reconnect") }
    fun saveProfile(p: Profile) = act("Saved") { if (p.id.isBlank()) settings.createProfile(p) else settings.updateProfile(p) }
    fun deleteProfile(p: Profile) = act("Deleted") { settings.deleteProfile(p.id) }

    // Playback
    fun savePlayback(update: SettingsUpdate) = act("Saved") {
        val before = _state.value.settings
        settings.save(update)
        // VOD or the Guide switched: the shell shows or hides its section.
        if (update.vodEnabled != before?.vodEnabled || update.epgEnabled != before?.epgEnabled) viewers.sectionsChanged()
    }

    // Logos
    fun refreshLogos() = act("Logo database refreshed") { settings.refreshLogos() }
    fun addOverride(name: String, url: String) = act { settings.addOverride(name, url) }
    fun removeOverride(name: String) = act { settings.removeOverride(name) }
    fun addStripWord(w: String) = act { settings.addStripWord(w) }
    fun removeStripWord(w: String) = act { settings.removeStripWord(w) }
}
