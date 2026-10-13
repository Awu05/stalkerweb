package com.stalkerweb.android.ui.portal

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.data.repo.ServerRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import retrofit2.HttpException

data class PortalUiState(
    val loading: Boolean = true,
    val connected: Boolean = false,
    val portalUrl: String = "",
    val mac: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val hasSavedConfig: Boolean = false,
    // Saved portal profiles from the server (shared with the web UI). These are
    // the only way to connect from the app — portal setup itself is a web-UI job.
    val profiles: List<Profile> = emptyList(),
    val connectingProfileId: String? = null,
)

class PortalViewModel(private val server: ServerRepository) : ViewModel() {

    private val _state = MutableStateFlow(PortalUiState())
    val state: StateFlow<PortalUiState> = _state.asStateFlow()

    init { refresh() }

    fun refresh() {
        _state.value = _state.value.copy(loading = true, error = null)
        viewModelScope.launch {
            val status   = runCatching { server.testConnection() }.getOrNull()
            val config   = server.getPortalConfig()
            val profiles = server.getProfiles().profiles
            val connected = status?.connected == true
            _state.value = _state.value.copy(
                loading         = false,
                // Every action here (connectProfile / reconnect / disconnect)
                // hands off to refresh() on success while busy is still true,
                // so this is the only place that can clear it.
                // Without it the screen latches: `enabled = !state.busy`
                // disables every button for good and the tapped profile row
                // keeps spinning, so a second tap does nothing at all.
                busy               = false,
                connectingProfileId = null,
                connected       = connected,
                portalUrl       = (if (connected) status?.portal else config?.portal) ?: config?.portal ?: "",
                mac             = (if (connected) status?.mac    else config?.mac)    ?: config?.mac    ?: "",
                hasSavedConfig  = !config?.portal.isNullOrBlank() && !config?.mac.isNullOrBlank(),
                profiles        = profiles,
            )
        }
    }

    /** Connect using a saved profile — one tap, no retyping portal/MAC. */
    fun connectProfile(profile: Profile) {
        _state.value = _state.value.copy(busy = true, error = null, connectingProfileId = profile.id)
        viewModelScope.launch {
            runCatching { server.connectProfile(profile) }
                .onSuccess { resp ->
                    if (resp.success) refresh()
                    else _state.value = _state.value.copy(
                        busy = false, connectingProfileId = null,
                        error = resp.error ?: "Connect failed",
                    )
                }
                .onFailure { e ->
                    _state.value = _state.value.copy(
                        busy = false, connectingProfileId = null,
                        error = e.backendMessage("Connect failed"),
                    )
                }
        }
    }

    fun reconnect() {
        _state.value = _state.value.copy(busy = true, error = null)
        viewModelScope.launch {
            runCatching { server.reconnectPortal() }
                .onSuccess { resp ->
                    if (resp.success) refresh()
                    else _state.value = _state.value.copy(busy = false, error = resp.error ?: "Reconnect failed")
                }
                .onFailure { e ->
                    _state.value = _state.value.copy(busy = false, error = e.backendMessage("Reconnect failed"))
                }
        }
    }

    fun disconnect() {
        _state.value = _state.value.copy(busy = true, error = null)
        viewModelScope.launch {
            runCatching { server.disconnectPortal() }
                .onSuccess { refresh() }
                .onFailure { e ->
                    _state.value = _state.value.copy(busy = false, error = e.backendMessage("Disconnect failed"))
                }
        }
    }
}

/**
 * The backend reports why a connect failed in the response body
 * (`{"error": "…"}`, see routes/auth.js), but Retrofit's HttpException.message
 * is only "HTTP 401 Unauthorized" — so the actual reason never reached the
 * screen and every failure looked alike. Prefer the body's message.
 */
private fun Throwable.backendMessage(fallback: String): String {
    if (this is HttpException) {
        val body = runCatching { response()?.errorBody()?.string() }.getOrNull()
        val fromBody = body?.let {
            runCatching { JSONObject(it).optString("error").takeIf(String::isNotBlank) }.getOrNull()
        }
        return fromBody ?: "HTTP ${code()}"
    }
    return message ?: fallback
}
