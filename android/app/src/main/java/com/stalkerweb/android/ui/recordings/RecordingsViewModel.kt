package com.stalkerweb.android.ui.recordings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.Recording
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.RecordingsRepository
import com.stalkerweb.android.data.prefs.AppPrefs
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class RecordingsState(val list: List<Recording> = emptyList(), val loading: Boolean = true, val error: String? = null, val everyone: Boolean = false)

// As often as the web's Recordings page reads them: a recording's length and size move.
private const val REFRESH_MS = 5_000L

/** This viewer's recordings, or everyone's (the web's RecordingsPage): booked, recording now, done. */
class RecordingsViewModel(private val recordings: RecordingsRepository, private val prefs: AppPrefs) : ViewModel() {
    private val _state = MutableStateFlow(RecordingsState(everyone = prefs.recordingsEveryone))
    val state: StateFlow<RecordingsState> = _state.asStateFlow()
    val published: StateFlow<Set<String>> = recordings.published

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    /** Runs while the screen is started (cancelled when it isn't). */
    suspend fun follow() {
        while (true) { refresh(); delay(REFRESH_MS) }
    }

    /** The viewer this device is — whose recordings it may delete (canDelete). */
    val viewerId: String? get() = prefs.viewerId

    /** Everyone's recordings, or just this viewer's — remembered on this device. */
    fun setEveryone(on: Boolean) {
        prefs.recordingsEveryone = on
        _state.value = _state.value.copy(everyone = on, loading = true)
        viewModelScope.launch { refresh() }
    }

    private suspend fun refresh() {
        val everyone = _state.value.everyone
        runCatching { recordings.list(everyone) }
            .onSuccess { _state.value = RecordingsState(list = it, loading = false, everyone = everyone) }
            .onFailure { _state.value = _state.value.copy(loading = false, error = it.toApiError().message) }
    }

    /** Stop one recording now (what it has is kept), or cancel one booked. */
    fun stop(r: Recording) = act({ recordings.stop(r.id) },
        if (r.status == "recording") "Recording stopped — what it has is kept" else "Recording cancelled")

    fun delete(r: Recording) = act({ recordings.delete(r.id) }, "Recording deleted")

    private fun act(call: suspend () -> Unit, done: String) {
        viewModelScope.launch {
            runCatching { call() }
                .onSuccess { _messages.tryEmit(done) }
                .onFailure { _messages.tryEmit(it.toApiError().message ?: "Something went wrong") }
            refresh()
        }
    }
}
