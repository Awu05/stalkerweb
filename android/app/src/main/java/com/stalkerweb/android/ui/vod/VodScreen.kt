package com.stalkerweb.android.ui.vod

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.stalkerweb.android.data.api.HistoryEntry
import com.stalkerweb.android.data.api.ListEntry
import com.stalkerweb.android.data.api.VodCategory
import com.stalkerweb.android.data.api.DownloadItem
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodItem
import com.stalkerweb.android.data.api.VodSeason
import com.stalkerweb.android.data.repo.PlayerParams
import com.stalkerweb.android.data.repo.VodFilterState
import com.stalkerweb.android.data.repo.WatchRepository
import com.stalkerweb.android.data.repo.applyVodFilters
import com.stalkerweb.android.data.repo.filterOptions
import com.stalkerweb.android.data.repo.sortVodItems
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.Pill
import com.stalkerweb.android.ui.components.PosterTile
import com.stalkerweb.android.ui.components.SectionHeader
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV

/**
 * The VOD page, laid out as on the web: Movies / Series; My List and the
 * categories (a column on wide screens and TV, a pill row on phones); search,
 * filters and sort; Recently watched and My List rows above the titles.
 */
@Composable
fun VodScreen(viewModel: VodViewModel, watch: WatchRepository, onPlay: (PlayerParams) -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val watchState by watch.state.collectAsStateWithLifecycle()
    val isTV = rememberIsTV()
    val wide = isTV || LocalConfiguration.current.screenWidthDp >= 600
    val firstCategory = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        // What was watched elsewhere (the phone, the web) since — and resume points with it.
        watch.load()
        if (state.categories.isEmpty()) viewModel.loadCategories()
    }
    val ctx = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(viewModel) { viewModel.messages.collect { android.widget.Toast.makeText(ctx, it, android.widget.Toast.LENGTH_SHORT).show() } }
    LaunchedEffect(state.loadingCategories, isTV) {
        if (isTV && !state.loadingCategories && state.categories.isNotEmpty()) runCatching { firstCategory.requestFocus() }
    }

    val isSeries = state.type == "series"
    val watched = remember(watchState) { watch.watchedIds() }
    val myListIds = remember(watchState) { watchState.list.map { it.id }.toSet() }
    // This tab's My List and history: movies, or shows.
    val tabList = remember(watchState, isSeries) { watchState.list.filter { it.item.isSeries == isSeries } }
    val tabHistory = remember(watchState, isSeries) {
        watchState.history.filter { PlayerParams.parse(it.params).isEpisode == isSeries }
    }

    // The titles shown: the whole listing filtered here, or the portal's page.
    val filtered = remember(state.listing, state.filters, state.search, state.sort, watched, state.filtering) {
        if (!state.filtering) emptyList()
        else sortVodItems(applyVodFilters(state.listing.items, state.filters, watched, state.search), state.sort)
    }
    val shown = if (state.filtering) filtered.take(state.visibleCount) else state.items
    val options = remember(state.isMyList, tabList, state.filtering, state.listing.items, state.items) {
        filterOptions(when {
            state.isMyList -> tabList.map { it.item }
            state.filtering -> state.listing.items
            else -> state.items
        })
    }

    fun open(item: VodItem) {
        if (item.isSeries || item.episodes.isNotEmpty()) viewModel.openSeries(item)
        else onPlay(paramsFor(item))
    }
    fun openHistory(entry: HistoryEntry) {
        val p = PlayerParams.parse(entry.params)
        // A finished show opens its seasons; anything else resumes (or plays again).
        if (entry.finished && p.isEpisode) viewModel.openSeries(itemFrom(p, entry.screenshotUrl)) else onPlay(p)
    }

    Column(Modifier.fillMaxSize()) {
        // Movies / Series
        TabRow(selectedTabIndex = if (isSeries) 1 else 0, containerColor = SwColors.Bg) {
            Tab(selected = !isSeries, onClick = { viewModel.setType("vod") }, text = { Text("Movies") })
            Tab(selected = isSeries, onClick = { viewModel.setType("series") }, text = { Text("Series") })
        }
        // Search · count · sort
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = state.search,
                onValueChange = viewModel::setSearch,
                placeholder = { Text(if (state.isMyList) "Search in My List…" else "Search…") },
                leadingIcon = { Icon(Icons.Default.Search, null, Modifier.size(18.dp)) },
                trailingIcon = if (state.search.isNotEmpty()) ({ IconButton(onClick = { viewModel.setSearch("") }) { Icon(Icons.Default.Close, "Clear") } }) else null,
                singleLine = true,
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.weight(1f),
            )
            Pill("A–Z", state.sort == "name", { viewModel.setSort("name") })
            Pill("Newest", state.sort == "added", { viewModel.setSort("added") })
        }
        if (state.isPortalAll) {
            Text("Pick a category to filter — \"All\" is the whole catalog.", style = MaterialTheme.typography.labelMedium,
                color = SwColors.Muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
        } else {
            FilterBar(state.filters, options.withChosen(state.filters), viewModel::setFilters)
        }

        if (wide) {
            Row(Modifier.fillMaxSize()) {
                CategoryColumn(state, tabList.count { it.completedAt == null }, firstCategory, viewModel::selectCategory)
                Box(Modifier.width(1.dp).fillMaxHeight().background(SwColors.Border))
                Content(state, shown, filtered.size, tabHistory, tabList, myListIds, watchState.progress.associateBy { it.key },
                    viewModel, watch, ::open, ::openHistory, onPlay)
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                LazyRow(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(listOf(MY_LIST) + state.categories, key = { it.id }) { cat ->
                        Pill(cat.title, cat.id == state.selected?.id, { viewModel.selectCategory(cat) },
                            leading = if (cat.id == MY_LIST.id) Icons.Default.Bookmark else null)
                    }
                }
                Content(state, shown, filtered.size, tabHistory, tabList, myListIds, watchState.progress.associateBy { it.key },
                    viewModel, watch, ::open, ::openHistory, onPlay)
            }
        }
    }

    state.seriesItem?.let { show ->
        SeriesDialog(
            show = show,
            seasons = state.seasons,
            selectedSeason = state.selectedSeason,
            episodes = state.episodes,
            loading = state.seriesLoading,
            inMyList = show.id in myListIds,
            onToggleMyList = { viewModel.toggleMyList(show) },
            onOpenSeason = viewModel::openSeason,
            onBackSeasons = viewModel::backToSeasons,
            onClose = viewModel::closeSeries,
            onDownloadEpisode = { season, ep -> downloadItem(show, season, ep).let { viewModel.download(listOf(it), "\"${it.title}\"") } },
            onDownloadSeason = { season, eps -> viewModel.download(eps.map { ep -> downloadItem(show, season, ep) }, "${eps.size} episodes") },
            onPlay = { season, ep ->
                viewModel.closeSeries()
                onPlay(paramsFor(show).copy(
                    series = ep.seriesNumber.ifBlank { "0" }, seasonId = season.id, episodeId = ep.episodeId,
                    episodeTitle = ep.name.ifBlank { "Episode ${ep.seriesNumber}" },
                ))
            },
        )
    }
}

/** A movie or show as the player's link (posters stored relative by the player when it saves). */
private fun paramsFor(item: VodItem) = PlayerParams(
    videoId = item.id, title = item.name, cmd = item.cmd, year = item.year, durationMin = item.durationMin,
    isHD = item.isHD, screenshotUrl = item.screenshotUrl.orEmpty(), description = item.description,
    director = item.director, actors = item.actors,
)

/** A history entry's show, rebuilt from its player link — to open its seasons again. */
private fun itemFrom(p: PlayerParams, screenshotUrl: String) = VodItem(
    id = p.videoId, name = p.title, cmd = p.cmd, year = p.year, durationMin = p.durationMin, isHD = p.isHD,
    screenshotUrl = screenshotUrl.ifEmpty { p.screenshotUrl }, description = p.description, director = p.director,
    actors = p.actors, isSeries = true,
)

@Composable
private fun CategoryColumn(state: VodUiState, myListCount: Int, firstFocus: FocusRequester, onSelect: (VodCategory) -> Unit) {
    LazyColumn(Modifier.width(220.dp).fillMaxHeight().padding(vertical = 4.dp)) {
        val all = listOf(MY_LIST) + state.categories
        items(all, key = { it.id }) { cat ->
            val sel = cat.id == state.selected?.id
            Row(
                Modifier.fillMaxWidth()
                    .then(if (cat.id == MY_LIST.id) Modifier.focusRequester(firstFocus) else Modifier)
                    .tvFocus(RoundedCornerShape(8.dp))
                    .background(if (sel) SwColors.Surface2 else SwColors.Bg)
                    .clickable { onSelect(cat) }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (cat.id == MY_LIST.id) Icon(Icons.Default.Bookmark, null, Modifier.size(14.dp), tint = SwColors.Text)
                Text(cat.title, style = MaterialTheme.typography.bodySmall, color = if (sel) SwColors.PrimaryLight else SwColors.Text,
                    maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (cat.id == MY_LIST.id && myListCount > 0) Text(myListCount.toString(), style = MaterialTheme.typography.labelSmall, color = SwColors.Muted)
            }
        }
        if (state.loadingCategories) item { CircularProgressIndicator(Modifier.padding(16.dp).size(20.dp)) }
    }
}

/** The filter bar: a choice menu per filter the titles allow, and HD / Not watched toggles. */
@Composable
private fun FilterBar(f: VodFilterState, o: com.stalkerweb.android.data.repo.FilterOptions, onChange: (VodFilterState) -> Unit) {
    LazyRow(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (o.years.isNotEmpty()) item { ChoicePill("Any year", f.year, o.years.map { it to it }) { onChange(f.copy(year = it)) } }
        if (o.hasAdded) item {
            ChoicePill("Any time", if (f.addedDays > 0) f.addedDays.toString() else "",
                listOf("7" to "Last 7 days", "30" to "Last 30 days", "90" to "Last 90 days")) { onChange(f.copy(addedDays = it.toIntOrNull() ?: 0)) }
        }
        if (o.genres.isNotEmpty()) item { ChoicePill("Any genre", f.genre, o.genres.map { it to it }) { onChange(f.copy(genre = it)) } }
        if (o.hasRating) item {
            ChoicePill("Any rating", if (f.minRating > 0) f.minRating.toInt().toString() else "",
                listOf("6" to "6+", "7" to "7+", "8" to "8+")) { onChange(f.copy(minRating = it.toDoubleOrNull() ?: 0.0)) }
        }
        if (o.hasHD) item { Pill("HD", f.hd, { onChange(f.copy(hd = !f.hd)) }) }
        item { Pill("Not watched", f.unwatched, { onChange(f.copy(unwatched = !f.unwatched)) }) }
        if (f.isActive) item { Pill("Clear", false, { onChange(VodFilterState()) }, leading = Icons.Default.Close) }
    }
}

/** A pill opening a menu: [any] when nothing is chosen, else the chosen label; "" clears. */
@Composable
private fun ChoicePill(any: String, value: String, choices: List<Pair<String, String>>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Pill(choices.firstOrNull { it.first == value }?.second ?: any, value.isNotEmpty(), { open = true })
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text(any) }, onClick = { open = false; onPick("") })
            choices.forEach { (v, label) -> DropdownMenuItem(text = { Text(label) }, onClick = { open = false; onPick(v) }) }
        }
    }
}

@Composable
private fun Content(
    state: VodUiState,
    shown: List<VodItem>,
    matchCount: Int,
    history: List<HistoryEntry>,
    tabList: List<ListEntry>,
    myListIds: Set<String>,
    progress: Map<String, com.stalkerweb.android.data.api.ProgressEntry>,
    viewModel: VodViewModel,
    watch: WatchRepository,
    open: (VodItem) -> Unit,
    openHistory: (HistoryEntry) -> Unit,
    onPlay: (PlayerParams) -> Unit,
) {
    val isTV = rememberIsTV()
    val gridState = rememberLazyGridState()
    val nearEnd by remember { derivedStateOf {
        val last = gridState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
        last >= gridState.layoutInfo.totalItemsCount - 6
    } }
    LaunchedEffect(nearEnd, state.page, shown.size) { if (nearEnd && !state.isMyList) viewModel.loadMore(matchCount) }
    val browsing = !state.isMyList && !state.filters.isActive && state.search.isBlank()

    LazyVerticalGrid(
        state = gridState,
        columns = GridCells.Adaptive(if (isTV) 180.dp else 140.dp),
        contentPadding = PaddingValues(12.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        if (browsing && history.isNotEmpty()) {
            full { HistoryRow(history, progress, openHistory, watch) }
        }
        if (browsing) {
            val toWatch = tabList.filter { it.completedAt == null }
            if (toWatch.isNotEmpty()) full { MyListRow(toWatch, myListIds, open, viewModel::toggleMyList) { viewModel.selectCategory(MY_LIST) } }
        }

        when {
            state.isMyList -> myListSection(state, tabList, myListIds, open, viewModel, watch)
            else -> {
                if (state.filtering) full {
                    val l = state.listing
                    Text(
                        when {
                            l.error != null -> l.error
                            !l.complete -> "Reading titles… ${l.loaded}${if (l.total > 0) " of ${l.total}" else ""}"
                            else -> "$matchCount of ${l.loaded} titles"
                        },
                        style = MaterialTheme.typography.labelMedium,
                        color = if (l.error != null) SwColors.Live else SwColors.Muted,
                    )
                }
                items(shown, key = { it.id }) { item ->
                    PosterTile(
                        title = item.name, year = item.year, posterUrl = item.screenshotUrl, isHD = item.isHD,
                        onClick = { open(item) },
                        bookmarked = item.id in myListIds, onBookmark = { viewModel.toggleMyList(item) },
                        onDownload = if (item.isSeries || item.episodes.isNotEmpty()) null
                            else ({ viewModel.download(listOf(DownloadItem(videoId = item.id, cmd = item.cmd, title = item.name)), "\"${item.name}\"") }),
                    )
                }
                if (shown.isEmpty()) full {
                    when {
                        state.error != null -> Text(state.error, color = SwColors.Live)
                        state.loadingItems || (state.filtering && !state.listing.complete) -> Box(Modifier.fillMaxWidth().padding(32.dp), Alignment.Center) { CircularProgressIndicator() }
                        state.selected != null -> EmptyState(Icons.Default.Movie, if (state.filters.isActive || state.search.isNotBlank()) "No titles match." else "No titles in this category.")
                    }
                }
                if (state.loadingItems && shown.isNotEmpty()) full { Box(Modifier.fillMaxWidth().padding(16.dp), Alignment.Center) { CircularProgressIndicator(Modifier.size(22.dp)) } }
            }
        }
    }
}

private fun LazyGridScope.full(content: @Composable () -> Unit) = item(span = { GridItemSpan(maxLineSpan) }) { content() }

@Composable
private fun HistoryRow(entries: List<HistoryEntry>, progress: Map<String, com.stalkerweb.android.data.api.ProgressEntry>,
                       onOpen: (HistoryEntry) -> Unit, watch: WatchRepository) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionHeader(Icons.Default.History, "Recently watched", entries.size)
            TextButton(onClick = { watch.clearHistory() }) { Text("Clear", color = SwColors.Muted) }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp), contentPadding = PaddingValues(vertical = 4.dp, horizontal = 2.dp)) {
            items(entries, key = { it.id }) { e ->
                val p = progress[e.key]
                val frac = if (!e.finished && e.duration > 0) ((p?.position ?: e.position) / e.duration).toFloat() else null
                Column(Modifier.width(150.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    PosterTile(
                        title = e.title, year = e.episodeTitle, posterUrl = e.screenshotUrl.ifEmpty { null }, isHD = false,
                        onClick = { onOpen(e) }, progress = frac, watched = e.finished,
                    )
                    // Below the tile, not on it: the remote's focus search can't reach a button inside a tile.
                    TextButton(onClick = { watch.removeFromHistory(e.id) }, modifier = Modifier.tvFocus(RoundedCornerShape(8.dp))) {
                        Icon(Icons.Default.Close, null, Modifier.size(12.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Remove", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}

@Composable
private fun MyListRow(entries: List<ListEntry>, myListIds: Set<String>, onOpen: (VodItem) -> Unit, onToggle: (VodItem) -> Unit, onSeeAll: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionHeader(Icons.Default.Bookmark, "My List", entries.size)
            TextButton(onClick = onSeeAll) { Text("See all", color = SwColors.Muted) }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp), contentPadding = PaddingValues(vertical = 4.dp, horizontal = 2.dp)) {
            items(entries, key = { it.id }) { e ->
                Box(Modifier.width(150.dp)) {
                    PosterTile(e.item.name, e.item.year, e.item.screenshotUrl, e.item.isHD, { onOpen(e.item) },
                        bookmarked = e.id in myListIds, onBookmark = { onToggle(e.item) })
                }
            }
        }
    }
}

/** My List as a category: To watch, then Completed — searched, filtered and sorted ("Newest" = added last). */
private fun LazyGridScope.myListSection(
    state: VodUiState, tabList: List<ListEntry>, myListIds: Set<String>, open: (VodItem) -> Unit, viewModel: VodViewModel, watch: WatchRepository,
) {
    if (tabList.isEmpty()) {
        full { EmptyState(Icons.Default.BookmarkBorder, "No ${if (state.type == "series") "shows" else "movies"} on My List yet.", "Long-press (or hold OK on) any title to save it for later.") }
        return
    }
    fun section(done: Boolean): List<ListEntry> {
        val entries = tabList.filter { (it.completedAt != null) == done }
        val kept = applyVodFilters(entries.map { it.item }, state.filters, watch.watchedIds(), state.search).map { it.id }.toSet()
        val shown = entries.filter { it.id in kept }
        return if (state.sort == "added") shown else sortVodItems(shown.map { it.item }, "name").mapNotNull { i -> shown.firstOrNull { it.id == i.id } }
    }
    val toWatch = section(false)
    val completed = section(true)
    full { SectionHeader(Icons.Default.Bookmark, "To watch", toWatch.size) }
    if (toWatch.isEmpty()) full { Text(if (completed.isNotEmpty()) "Nothing here — all watched." else "Nothing here.", color = SwColors.Muted) }
    items(toWatch, key = { "w" + it.id }) { e -> ListTile(e, false, myListIds, open, viewModel, watch) }
    if (completed.isNotEmpty()) {
        full { SectionHeader(Icons.Default.Check, "Completed", completed.size) }
        items(completed, key = { "c" + it.id }) { e -> ListTile(e, true, myListIds, open, viewModel, watch) }
    }
}

@Composable
private fun ListTile(e: ListEntry, done: Boolean, myListIds: Set<String>, open: (VodItem) -> Unit, viewModel: VodViewModel, watch: WatchRepository) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        PosterTile(e.item.name, e.item.year, e.item.screenshotUrl, e.item.isHD, { open(e.item) },
            bookmarked = e.id in myListIds, onBookmark = { viewModel.toggleMyList(e.item) })
        TextButton(onClick = { watch.setCompleted(e.id, !done) }, modifier = Modifier.tvFocus(RoundedCornerShape(8.dp))) {
            Icon(if (done) Icons.Default.Replay else Icons.Default.Check, null, Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text(if (done) "Back to To watch" else "Mark completed", style = MaterialTheme.typography.labelSmall)
        }
    }
}

/** A show's seasons and episodes (in order), with My List; a full dialog on TV and phones alike. */
@Composable
private fun SeriesDialog(
    show: VodItem, seasons: List<VodSeason>?, selectedSeason: VodSeason?, episodes: List<VodEpisode>?, loading: Boolean,
    inMyList: Boolean, onToggleMyList: () -> Unit, onOpenSeason: (VodSeason) -> Unit, onBackSeasons: () -> Unit,
    onClose: () -> Unit, onPlay: (VodSeason, VodEpisode) -> Unit,
    onDownloadEpisode: (VodSeason, VodEpisode) -> Unit, onDownloadSeason: (VodSeason, List<VodEpisode>) -> Unit,
) {
    val firstFocus = remember { FocusRequester() }
    Dialog(onDismissRequest = { if (selectedSeason != null) onBackSeasons() else onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(color = SwColors.Surface, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth(0.92f).fillMaxHeight(0.85f)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (selectedSeason != null) IconButton(onClick = onBackSeasons) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Seasons") }
                    Text(selectedSeason?.let { "${show.name} · ${it.name.ifBlank { "Season ${it.seasonNumber}" }}" } ?: show.name,
                        style = MaterialTheme.typography.titleMedium, color = SwColors.Text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (selectedSeason != null && !episodes.isNullOrEmpty()) Pill("Download season", false, { onDownloadSeason(selectedSeason, episodes) }, leading = Icons.Default.Download)
                    Pill(if (inMyList) "On My List" else "My List", inMyList, onToggleMyList, leading = if (inMyList) Icons.Default.Bookmark else Icons.Default.BookmarkBorder)
                    IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close") }
                }
                HorizontalDivider(color = SwColors.Border)
                when {
                    loading -> Box(Modifier.fillMaxWidth().padding(32.dp), Alignment.Center) { CircularProgressIndicator() }
                    selectedSeason == null -> LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        val list = seasons.orEmpty()
                        if (list.isEmpty()) item { Text("No seasons found.", color = SwColors.Muted) }
                        items(list, key = { it.id }) { s ->
                            Row(
                                Modifier.fillMaxWidth()
                                    .then(if (s.id == list.first().id) Modifier.focusRequester(firstFocus) else Modifier)
                                    .tvFocus(RoundedCornerShape(8.dp)).clickable { onOpenSeason(s) }.padding(12.dp),
                            ) { Text(s.name.ifBlank { "Season ${s.seasonNumber}" }, color = SwColors.Text) }
                        }
                    }
                    else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        val list = episodes.orEmpty()
                        if (list.isEmpty()) item { Text("No episodes found.", color = SwColors.Muted) }
                        items(list, key = { it.episodeId }) { ep ->
                            Row(
                                Modifier.fillMaxWidth()
                                    .then(if (ep.episodeId == list.first().episodeId) Modifier.focusRequester(firstFocus) else Modifier)
                                    .tvFocus(RoundedCornerShape(8.dp)).clickable { onPlay(selectedSeason, ep) }.padding(12.dp),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(ep.seriesNumber, color = SwColors.Muted, modifier = Modifier.width(32.dp))
                                Text(ep.name.ifBlank { "Episode ${ep.seriesNumber}" }, color = SwColors.Text, modifier = Modifier.weight(1f))
                                IconButton(onClick = { onDownloadEpisode(selectedSeason, ep) }) { Icon(Icons.Default.Download, "Download") }
                            }
                        }
                    }
                }
            }
        }
    }
    LaunchedEffect(seasons, episodes, selectedSeason) { runCatching { firstFocus.requestFocus() } }
}

/** One episode of [show], to download on the server. */
private fun downloadItem(show: VodItem, season: VodSeason, ep: VodEpisode) = DownloadItem(
    videoId = show.id, cmd = show.cmd, series = ep.seriesNumber.ifBlank { "0" }, seasonId = season.id, episodeId = ep.episodeId,
    title = ep.name.ifBlank { "Episode ${ep.seriesNumber}" }, seriesTitle = show.name,
)
