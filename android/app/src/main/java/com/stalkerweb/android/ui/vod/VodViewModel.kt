package com.stalkerweb.android.ui.vod

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.DownloadItem
import com.stalkerweb.android.data.api.VodCategory
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodItem
import com.stalkerweb.android.data.api.VodSeason
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.data.repo.DownloadsRepository
import com.stalkerweb.android.data.repo.COMBINED_ALL_IDS
import com.stalkerweb.android.data.repo.SHOW_STEP
import com.stalkerweb.android.data.repo.categoryAfterRefresh
import com.stalkerweb.android.data.repo.defaultCategory
import com.stalkerweb.android.data.repo.VodFilterState
import com.stalkerweb.android.data.repo.nextVisibleCount
import com.stalkerweb.android.data.repo.VodRepository
import com.stalkerweb.android.data.repo.ViewerRepository
import com.stalkerweb.android.data.repo.WatchRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

/** My List, shown as the first category (its titles come from the watch state, not the portal). */
val MY_LIST = VodCategory(id = "mylist", title = "My List")


/** A category's whole listing, read a part at a time (/api/vod/listing). */
data class ListingState(
    val items: List<VodItem> = emptyList(),
    val loaded: Int = 0,
    val total: Int = 0,
    val complete: Boolean = false,
    val error: String? = null,
)

data class VodUiState(
    val type: String = "vod",                 // "vod" (Movies) | "series"
    val categories: List<VodCategory> = emptyList(),
    val selected: VodCategory? = null,
    val items: List<VodItem> = emptyList(),   // paged mode
    val page: Int = 1,
    val totalPages: Int = 1,
    val loadingCategories: Boolean = false,
    val loadingItems: Boolean = false,
    val error: String? = null,
    val search: String = "",
    val filters: VodFilterState = VodFilterState(),
    val sort: String = "name",
    val listing: ListingState = ListingState(),
    val visibleCount: Int = SHOW_STEP,
    // The seasons pop-up
    val seriesItem: VodItem? = null,
    val seasons: List<VodSeason>? = null,
    val selectedSeason: VodSeason? = null,
    val episodes: List<VodEpisode>? = null,
    val seriesLoading: Boolean = false,
    /** Every season's episodes loaded so far (Continue looks into the next ones). */
    val seriesEpisodes: Map<String, List<VodEpisode>> = emptyMap(),
    /** The viewer chose a season: Continue doesn't move them. */
    val seriesPicked: Boolean = false,
    /** A season Continue needed didn't load: no Continue; the seasons still work. */
    val seriesContinueFailed: Boolean = false,
) {
    val isMyList: Boolean get() = selected?.id == MY_LIST.id
    val isCombinedAll: Boolean get() = selected?.id in COMBINED_ALL_IDS
    /** The portal's own "All": the whole catalog, so it's never read whole to filter. */
    val isPortalAll: Boolean get() = selected != null && !isCombinedAll &&
        (selected.id == "*" || selected.title.trim().equals("all", ignoreCase = true))
    /** Whole-listing mode: a filter is on (not in the portal's "All"), or an added "All". */
    val filtering: Boolean get() = !isMyList && selected != null &&
        ((filters.isActive && !isPortalAll) || isCombinedAll)
    val hasMore: Boolean get() = page < totalPages
}

/**
 * The VOD page, as on the web (frontend/src/pages/VodPage.jsx): Movies and
 * Series; My List and the categories; paged titles from the portal, or — for a
 * filter or an added "All" — the whole category, filtered and sorted here.
 */
class VodViewModel(
    private val vod: VodRepository,
    private val watch: WatchRepository,
    private val viewers: ViewerRepository,
    private val prefs: AppPrefs,
    private val downloads: DownloadsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(VodUiState(sort = prefs.vodSort))
    val state: StateFlow<VodUiState> = _state.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    /** Short messages for a toast ("Queued …"). */
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    /** Queues titles to download on the server (as the web's VOD page does). */
    fun download(items: List<DownloadItem>, what: String) {
        viewModelScope.launch {
            runCatching { downloads.enqueue(items) }
                .onSuccess { _messages.tryEmit("Queued $what for download") }
                .onFailure { _messages.tryEmit(it.toApiError().message ?: "Could not queue download") }
        }
    }

    private var itemsJob: Job? = null
    private var categoriesJob: Job? = null
    private var searchJob: Job? = null
    private var listingJob: Job? = null

    init {
        // Another viewer: start again (their hidden categories differ).
        viewModelScope.launch {
            viewers.changes.drop(1).collect {
                _state.value = VodUiState(type = _state.value.type, sort = _state.value.sort)
                loadCategories()
            }
        }
    }

    fun setType(type: String) {
        if (type == _state.value.type) return
        // The other tab's loads are stale now.
        itemsJob?.cancel(); listingJob?.cancel(); searchJob?.cancel()
        _state.value = VodUiState(type = type, sort = _state.value.sort, search = _state.value.search)
        loadCategories()
    }

    fun loadCategories() {
        _state.value = _state.value.copy(loadingCategories = true, error = null)
        categoriesJob?.cancel()   // a quick Movies → Series → Movies: only the last tab's list
        val type = _state.value.type
        categoriesJob = viewModelScope.launch {
            val cats = runCatching { vod.getVodCategories(type) }.getOrDefault(emptyList())
            if (_state.value.type != type) return@launch
            _state.value = _state.value.copy(categories = cats, loadingCategories = false)
            defaultCategory(cats)?.let(::selectCategory)
        }
    }

    /**
     * The categories read again each time VOD opens (as the web does): the
     * view model lives as long as the app, and the server's list changes —
     * an update (a new "All"), categories hidden, another portal. What's
     * open stays open while it's still listed.
     */
    fun refreshCategories() {
        val type = _state.value.type
        categoriesJob?.cancel()
        categoriesJob = viewModelScope.launch {
            val cats = runCatching { vod.getVodCategories(type) }.getOrDefault(emptyList())
            if (_state.value.type != type || cats.isEmpty()) return@launch   // unreadable just now: keep what's shown
            _state.value = _state.value.copy(categories = cats)
            categoryAfterRefresh(_state.value.selected, cats, keep = setOf(MY_LIST.id))?.let(::selectCategory)
        }
    }

    fun selectCategory(cat: VodCategory) {
        _state.value = _state.value.copy(selected = cat, items = emptyList(), page = 1, totalPages = 1,
            listing = ListingState(), visibleCount = SHOW_STEP, error = null)
        refresh()
    }

    /** The search is kept across categories; paged mode asks the portal after a pause, a listing filters at once. */
    fun setSearch(q: String) {
        _state.value = _state.value.copy(search = q, visibleCount = SHOW_STEP)
        searchJob?.cancel()
        if (_state.value.filtering || _state.value.isMyList) return
        searchJob = viewModelScope.launch {
            delay(400)
            loadItems(page = 1)
        }
    }

    fun setFilters(f: VodFilterState) {
        val wasFiltering = _state.value.filtering
        _state.value = _state.value.copy(filters = f, visibleCount = SHOW_STEP)
        if (wasFiltering != _state.value.filtering) refresh()
    }

    fun setSort(sort: String) {
        if (sort == _state.value.sort) return
        prefs.vodSort = sort
        _state.value = _state.value.copy(sort = sort, visibleCount = SHOW_STEP)
        if (!_state.value.filtering && !_state.value.isMyList) loadItems(page = 1)
    }

    /** Another step of the filtered titles — none past the [total] there are, or the grid would ask forever. */
    fun showMore(total: Int) {
        val next = nextVisibleCount(_state.value.visibleCount, total)
        if (next != _state.value.visibleCount) _state.value = _state.value.copy(visibleCount = next)
    }

    /** The end of the grid came into view: [total] filtered titles in whole-listing mode, else the next portal page. */
    fun loadMore(total: Int) {
        val s = _state.value
        if (s.isMyList) return
        if (s.filtering) { showMore(total); return }
        if (s.hasMore && !s.loadingItems) loadItems(page = s.page + 1)
    }

    // Paged titles, or the whole listing, for what's selected now.
    private fun refresh() {
        itemsJob?.cancel(); listingJob?.cancel()
        val s = _state.value
        when {
            s.isMyList || s.selected == null -> Unit
            s.filtering -> startListing()
            else -> loadItems(page = 1)
        }
    }

    private fun loadItems(page: Int) {
        val s = _state.value
        val cat = s.selected ?: return
        if (s.isMyList || s.isCombinedAll) return
        itemsJob?.cancel()
        _state.value = s.copy(loadingItems = true, error = null, items = if (page == 1) emptyList() else s.items)
        itemsJob = viewModelScope.launch {
            runCatching { vod.getVodItems(s.type, cat.id, page, s.search.trim(), s.sort) }
                .onSuccess { r ->
                    val cur = _state.value
                    _state.value = cur.copy(
                        // Ids once: the grid keys by id, and a title added mid-read can come twice.
                        items = (if (page == 1) r.items else cur.items + r.items).distinctBy { it.id },
                        page = page, totalPages = r.totalPages, loadingItems = false,
                    )
                }
                .onFailure { e ->
                    if (e is CancellationException) throw e
                    _state.value = _state.value.copy(loadingItems = false, error = e.toApiError().message)
                }
        }
    }

    // Reads the whole category a part at a time until it's complete (web useCategoryListing).
    private fun startListing() {
        val s = _state.value
        val cat = s.selected ?: return
        listingJob?.cancel()
        _state.value = s.copy(listing = ListingState())
        listingJob = viewModelScope.launch {
            while (true) {
                val have = _state.value.listing.items
                // From the server's count, not ours: ours drops repeats.
                val r = runCatching { vod.getListing(s.type, cat.id, _state.value.listing.loaded) }.getOrElse { e ->
                    if (e is CancellationException) throw e
                    _state.value = _state.value.copy(listing = _state.value.listing.copy(error = e.toApiError().message, complete = true))
                    return@launch
                }
                _state.value = _state.value.copy(listing = ListingState((have + r.items).distinctBy { it.id }, r.loaded, r.total, r.complete, r.error))
                if (r.complete || r.error != null) return@launch
                delay(1200)
            }
        }
    }

    // ── The seasons pop-up ────────────────────────────────────────────────────

    // One seasons/episodes load at a time: a slow answer for another show or season mustn't land on this one.
    private var seriesJob: Job? = null

    fun openSeries(item: VodItem) {
        _state.value = _state.value.copy(seriesItem = item, seasons = null, selectedSeason = null, episodes = null, seriesLoading = true,
            seriesEpisodes = emptyMap(), seriesPicked = false, seriesContinueFailed = false)
        seriesJob?.cancel()
        seriesJob = viewModelScope.launch {
            val seasons = vod.getVodSeasons(item.id)
            _state.value = _state.value.copy(seasons = seasons, seriesLoading = false)
        }
    }

    fun openSeason(season: VodSeason) {
        val show = _state.value.seriesItem ?: return
        val cached = _state.value.seriesEpisodes[season.id]
        _state.value = _state.value.copy(selectedSeason = season, episodes = cached, seriesLoading = cached == null, seriesPicked = true)
        if (cached != null) return
        seriesJob?.cancel()
        seriesJob = viewModelScope.launch {
            val eps = vod.getVodEpisodesOrNull(show.id, season.id)
            // Failed: "No episodes found" for now, but not kept as the season's list (Continue mustn't skip it; opening it again retries).
            _state.value = _state.value.copy(episodes = eps.orEmpty(), seriesLoading = false,
                seriesEpisodes = if (eps != null) _state.value.seriesEpisodes + (season.id to eps) else _state.value.seriesEpisodes)
        }
    }

    fun backToSeasons() { seriesJob?.cancel(); _state.value = _state.value.copy(selectedSeason = null, episodes = null, seriesLoading = false, seriesPicked = true) }

    // Continue's seasons: loaded beside the one shown, never cancelling it.
    private val continueLoads = mutableSetOf<String>()

    /** A season Continue has to look into. */
    fun loadSeasonEpisodes(seasonId: String) {
        val show = _state.value.seriesItem ?: return
        if (!continueLoads.add("${show.id}:$seasonId")) return
        viewModelScope.launch {
            val eps = vod.getVodEpisodesOrNull(show.id, seasonId)
            if (_state.value.seriesItem?.id != show.id) return@launch
            if (eps != null) _state.value = _state.value.copy(seriesEpisodes = _state.value.seriesEpisodes + (seasonId to eps))
            else {
                continueLoads.remove("${show.id}:$seasonId")
                _state.value = _state.value.copy(seriesContinueFailed = true)
            }
        }
    }

    /** Open at Continue's season, its episodes already loaded (not the viewer's choice). */
    fun showContinueSeason(season: VodSeason) {
        val s = _state.value
        if (s.seriesPicked) return
        _state.value = s.copy(selectedSeason = season, episodes = s.seriesEpisodes[season.id], seriesLoading = s.seriesEpisodes[season.id] == null)
    }

    /** The viewer acted on a season (a tick): Continue doesn't move them elsewhere. */
    fun markSeriesPicked() { _state.value = _state.value.copy(seriesPicked = true) }


    fun closeSeries() { seriesJob?.cancel(); continueLoads.clear(); _state.value = _state.value.copy(seriesLoading = false, seriesEpisodes = emptyMap(), seriesPicked = false, seriesItem = null, seasons = null, selectedSeason = null, episodes = null) }

    fun toggleMyList(item: VodItem) = watch.toggleMyList(item)
}
