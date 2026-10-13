package com.stalkerweb.android.ui.shell

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.ApiError
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.ConnectionLabel
import com.stalkerweb.android.data.repo.ServerRepository
import com.stalkerweb.android.data.repo.ViewerRepository
import com.stalkerweb.android.data.repo.connectionLabel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

data class ShellState(
    val connection: ConnectionLabel? = null,
    val unreachable: Boolean = false,
    val vodEnabled: Boolean = true,
    val epgEnabled: Boolean = true,
)

/** The shell's status: which connection is in use, whether the server answers, which sections are on. */
class ShellViewModel(private val server: ServerRepository, val viewers: ViewerRepository) : ViewModel() {
    private val _state = MutableStateFlow(ShellState())
    val state: StateFlow<ShellState> = _state.asStateFlow()

    init {
        loadSettings()
        viewModelScope.launch { if (viewers.current.value == null) viewers.refresh() }
        // Settings saved (here or on a section change): show or hide VOD and the Guide.
        viewModelScope.launch { viewers.changes.drop(1).collect { loadSettings() } }
    }

    fun loadSettings() {
        viewModelScope.launch {
            server.getSettings()?.let { _state.value = _state.value.copy(vodEnabled = it.vodEnabled, epgEnabled = it.epgEnabled) }
        }
    }

    /** One status check (the shell runs it every 30 s while the app is in front). */
    suspend fun refreshStatus() {
        runCatching { server.testConnection() }
            .onSuccess { status ->
                val profiles = server.getProfiles().profiles
                _state.value = _state.value.copy(connection = connectionLabel(status, profiles), unreachable = false)
                // The switches may have changed on the web.
                server.getSettings()?.let { _state.value = _state.value.copy(vodEnabled = it.vodEnabled, epgEnabled = it.epgEnabled) }
            }
            .onFailure { e ->
                _state.value = _state.value.copy(unreachable = e.toApiError() is ApiError.Unreachable)
            }
    }
}
