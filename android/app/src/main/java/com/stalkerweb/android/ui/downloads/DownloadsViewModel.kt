package com.stalkerweb.android.ui.downloads

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.DownloadJob
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.DownloadsRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class DownloadsState(val jobs: List<DownloadJob> = emptyList(), val loading: Boolean = true, val error: String? = null)

/** The server's downloads, live while the screen is in front (the event stream; polling when it drops). */
class DownloadsViewModel(private val downloads: DownloadsRepository) : ViewModel() {
    private val _state = MutableStateFlow(DownloadsState())
    val state: StateFlow<DownloadsState> = _state.asStateFlow()
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    /** Runs while the screen is started (cancelled when it isn't). */
    suspend fun follow() {
        while (true) {
            refresh()
            downloads.events().collect { _state.value = DownloadsState(jobs = it.sortedByDescending { j -> j.createdAt }, loading = false) }
            // The stream ended or failed: poll for a while, then try the stream again.
            repeat(10) { delay(3_000); refresh() }
        }
    }

    private suspend fun refresh() {
        runCatching { downloads.list() }
            .onSuccess { _state.value = DownloadsState(jobs = it.sortedByDescending { j -> j.createdAt }, loading = false) }
            .onFailure { _state.value = _state.value.copy(loading = false, error = it.toApiError().message) }
    }

    fun remove(job: DownloadJob) {
        viewModelScope.launch {
            runCatching { downloads.remove(job.id) }
                .onSuccess { refresh() }
                .onFailure { _messages.tryEmit(it.toApiError().message ?: "Couldn't remove it") }
        }
    }
}
