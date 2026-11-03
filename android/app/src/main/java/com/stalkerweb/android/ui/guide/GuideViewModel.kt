package com.stalkerweb.android.ui.guide

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.EpgEvent
import com.stalkerweb.android.data.api.ApiError
import com.stalkerweb.android.data.api.Group
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.GuideRepository
import com.stalkerweb.android.data.repo.LiveRepository
import com.stalkerweb.android.data.repo.RecordingsRepository
import com.stalkerweb.android.data.repo.TimedBooking
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
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
    val channels: List<Channel> = emptyList(),          // the viewer's — those without guide data too (Record a time)
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

/** "Record anyway?" for a guide booking: the server's words, and what to book if so (ms). */
data class GuideRecordAsk(val message: String, val channel: Channel, val title: String, val startAt: Long, val endAt: Long)

/** The guide (the web's EpgGridPage / GuideListView): the viewer's channels and their programmes. */
class GuideViewModel(
    private val guide: GuideRepository,
    private val live: LiveRepository,
    val reminders: RemindersRepository,
    private val viewers: ViewerRepository,
    /** Record on a programme: booked on the server, which records it with every app closed. */
    private val recordings: RecordingsRepository,
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
                val channels = live.getChannels()
                _state.value = _state.value.copy(
                    channels = channels, epg = epg, groups = live.getGroups(), favoriteIds = live.getFavoriteIds(),
                    logoMap = live.getLogoMap(), loading = false,
                )
            }.onFailure { _state.value = _state.value.copy(loading = false, error = it.toApiError().message) }
        }
    }

    fun setFilter(f: String?) { _state.value = _state.value.copy(filter = f) }

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    /**
     * [e] on [ch] booked to record, at the guide's times (the server pads
     * them, as Settings says). Booked times stay as they are if the guide
     * moves the programme later. A clash past the provider's stream limit is
     * refused, with what it clashes with.
     */
    fun record(ch: Channel, e: EpgEvent) = book(ch, e.title, e.startTime * 1000, e.endTime * 1000)

    /** Record a time: a start and end of the viewer's own, where the guide has no programme to book. */
    fun recordTime(ch: Channel, b: TimedBooking) = book(ch, b.title, b.startAt, b.endAt)

    private fun book(ch: Channel, title: String, startAt: Long, endAt: Long, force: Boolean = false) {
        viewModelScope.launch {
            runCatching { recordings.schedule(ch.uniqueId, ch.name, title, startAt, endAt, force) }
                .onSuccess { _messages.tryEmit("\"$title\" will be recorded — see Recordings") }
                .onFailure {
                    val err = it.toApiError()
                    // It starts within 5 minutes and the stream limit is in use: asked first, as Record now is.
                    if (err is ApiError.TakesStream && !force) _recordAsk.value = GuideRecordAsk(err.message ?: "Record anyway?", ch, title, startAt, endAt)
                    else _messages.tryEmit(err.message ?: "Couldn't book the recording")
                }
        }
    }

    private val _recordAsk = MutableStateFlow<GuideRecordAsk?>(null)
    /** "Record anyway?": a booking that would take a stream in use now. */
    val recordAsk: StateFlow<GuideRecordAsk?> = _recordAsk.asStateFlow()

    /** "Record anyway?" answered yes: booked again, with force. */
    fun confirmRecord() {
        val ask = _recordAsk.value ?: return
        _recordAsk.value = null
        book(ask.channel, ask.title, ask.startAt, ask.endAt, force = true)
    }

    fun dismissRecordAsk() { _recordAsk.value = null }
}
