package com.stalkerweb.android.ui.recordings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.Recording
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.BuildConfig
import com.stalkerweb.android.data.repo.RecordingsRepository
import com.stalkerweb.android.data.repo.keepRecordingsResult
import com.stalkerweb.android.data.repo.showsEveryoneSwitch
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
    // Solo has one viewer: no switch, only its own.
    private val _state = MutableStateFlow(RecordingsState(everyone = showsEveryoneSwitch(BuildConfig.IS_SOLO) && prefs.recordingsEveryone))
    val state: StateFlow<RecordingsState> = _state.asStateFlow()
    val published: StateFlow<Set<String>> = recordings.published

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    /** Runs while the screen is started (cancelled when it isn't). */
    suspend fun follow() {
        // The first look is opening the screen; the refresh after it is a timer's (ApiClient.kt Background).
        var again = false
        while (true) { refresh(background = again); again = true; delay(REFRESH_MS) }
    }

    /** Everyone's recordings, or just this viewer's — remembered on this device. */
    fun setEveryone(on: Boolean) {
        prefs.recordingsEveryone = on
        _state.value = _state.value.copy(everyone = on, loading = true)
        viewModelScope.launch { refresh() }
    }

    private suspend fun refresh(background: Boolean = false) {
        val everyone = _state.value.everyone
        val result = runCatching { recordings.list(everyone, background) }
        // The switch changed while this was asked: its answer is the other mode's — dropped.
        if (!keepRecordingsResult(everyone, _state.value.everyone)) return
        result
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
