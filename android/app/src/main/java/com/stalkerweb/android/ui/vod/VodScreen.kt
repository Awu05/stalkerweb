package com.stalkerweb.android.ui.vod

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.stalkerweb.android.data.api.VodItem
import com.stalkerweb.android.ui.components.PosterTile
import com.stalkerweb.android.data.api.VodSeason
import com.stalkerweb.android.ui.utils.rememberIsTV

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VodScreen(
    viewModel: VodViewModel,
    onPlayMovie: (VodItem) -> Unit,
    onPlayEpisode: (show: VodItem, season: VodSeason, episodeId: String, seriesNumber: String, title: String) -> Unit,
    onBack: (() -> Unit)? = null,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val isTV = rememberIsTV()
    val firstCategoryFocusRequester = remember { FocusRequester() }

    LaunchedEffect(Unit) { if (state.categories.isEmpty()) viewModel.loadCategories() }

    // On TV, push initial focus into the category list so the remote is
    // immediately useful — Compose gives nothing focus by default.
    LaunchedEffect(state.loadingCategories, isTV) {
        if (isTV && !state.loadingCategories && state.categories.isNotEmpty()) {
            try { firstCategoryFocusRequester.requestFocus() } catch (_: Exception) {}
        }
    }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    navigationIcon = {
                        if (onBack != null) {
                            IconButton(onClick = onBack) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                            }
                        }
                    },
                    title = { Text("VOD", color = MaterialTheme.colorScheme.primary) },
                )
                // Movies / TV Shows toggle
                TabRow(selectedTabIndex = if (state.type == "vod") 0 else 1) {
                    Tab(
                        selected = state.type == "vod",
                        onClick  = { viewModel.setType("vod") },
                        text     = { Text("Movies") },
                    )
                    Tab(
                        selected = state.type == "series",
                        onClick  = { viewModel.setType("series") },
                        text     = { Text("TV Shows") },
                    )
                }
                OutlinedTextField(
                    value = state.query,
                    onValueChange = viewModel::setQuery,
                    placeholder = { Text("Search…") },
                    leadingIcon = { Icon(Icons.Default.Search, null, Modifier.size(18.dp)) },
                    singleLine = true,
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                )
            }
        },
    ) { padding ->
        Row(Modifier.padding(padding).fillMaxSize()) {

            // Categories sidebar
            Surface(
                color    = MaterialTheme.colorScheme.surface,
                modifier = Modifier.width(132.dp).fillMaxHeight(),
            ) {
                if (state.loadingCategories) {
                    Box(Modifier.fillMaxSize(), Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(22.dp))
                    }
                } else {
                    LazyColumn {
                        itemsIndexed(state.categories, key = { _, c -> c.id }) { index, cat ->
                            val sel = cat.id == state.selectedCategory?.id
                            var focused by remember { mutableStateOf(false) }
                            Text(
                                text     = cat.title,
                                style    = MaterialTheme.typography.bodySmall,
                                color    = if (sel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .then(
                                        if (index == 0) Modifier.focusRequester(firstCategoryFocusRequester)
                                        else Modifier
                                    )
                                    .onFocusChanged { focused = it.isFocused }
                                    .border(
                                        width = if (focused) 2.dp else 0.dp,
                                        color = if (focused) MaterialTheme.colorScheme.primary else Color.Transparent,
                                    )
                                    .background(
                                        when {
                                            sel     -> MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
                                            focused -> MaterialTheme.colorScheme.primary.copy(alpha = 0.06f)
                                            else    -> Color.Transparent
                                        }
                                    )
                                    .clickable { viewModel.selectCategory(cat) }
                                    .padding(horizontal = 10.dp, vertical = 10.dp),
                            )
                        }
                    }
                }
            }

            Box(Modifier.width(0.5.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outlineVariant))

            // Items grid
            Box(Modifier.weight(1f).fillMaxHeight()) {
                if (state.error != null && state.items.isEmpty()) {
                    Text(
                        state.error ?: "",
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.align(Alignment.Center).padding(16.dp),
                    )
                } else if (state.loadingItems && state.items.isEmpty()) {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                } else {
                    val gridState = rememberLazyGridState()
                    // Infinite scroll: load more as the last items come into view.
                    val shouldLoadMore by remember {
                        derivedStateOf {
                            val last = gridState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
                            last >= state.items.size - 4
                        }
                    }
                    // Keyed on page as well as the flag: when a page's items all
                    // fit on screen the flag stays true, and an effect keyed only
                    // on it would never re-fire — with nothing to scroll, paging
                    // would stall there permanently.
                    LaunchedEffect(shouldLoadMore, state.page) {
                        if (shouldLoadMore && state.hasMore && !state.loadingItems) viewModel.loadMore()
                    }
                    LazyVerticalGrid(
                        state    = gridState,
                        columns  = GridCells.Adaptive(minSize = 108.dp),
                        contentPadding = PaddingValues(8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement   = Arrangement.spacedBy(8.dp),
                    ) {
                        gridItems(state.items, key = { it.id }) { item ->
                            VodCard(item) {
                                if (item.isSeries) viewModel.openSeries(item) else onPlayMovie(item)
                            }
                        }
                    }
                }
            }
        }
    }

    // Series drill-down sheet
    state.seriesItem?.let { show ->
        SeriesSheet(
            show          = show,
            seasons       = state.seasons,
            selectedSeason = state.selectedSeason,
            episodes      = state.episodes,
            loading       = state.seriesLoading,
            onOpenSeason  = viewModel::openSeason,
            onBackSeasons = viewModel::backToSeasons,
            onPlayEpisode = { season, ep ->
                viewModel.closeSeries()
                onPlayEpisode(show, season, ep.episodeId, ep.seriesNumber, ep.name.ifBlank { "Episode ${ep.seriesNumber}" })
            },
            onClose = viewModel::closeSeries,
        )
    }
}

@Composable
private fun VodCard(item: VodItem, onClick: () -> Unit) {
    PosterTile(title = item.name, year = item.year, posterUrl = item.screenshotUrl, isHD = item.isHD, onClick = onClick)
}

@Composable
private fun SeriesSheet(
    show: VodItem,
    seasons: List<VodSeason>?,
    selectedSeason: VodSeason?,
    episodes: List<com.stalkerweb.android.data.api.VodEpisode>?,
    loading: Boolean,
    onOpenSeason: (VodSeason) -> Unit,
    onBackSeasons: () -> Unit,
    onPlayEpisode: (VodSeason, com.stalkerweb.android.data.api.VodEpisode) -> Unit,
    onClose: () -> Unit,
) {
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.6f)).clickable(onClick = onClose)) {
        Surface(
            color    = MaterialTheme.colorScheme.surface,
            shape    = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
            modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.8f),
        ) {
            Column {
                Row(
                    Modifier.fillMaxWidth().padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (selectedSeason != null) {
                        IconButton(onClick = onBackSeasons) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                        }
                    }
                    Column(Modifier.weight(1f)) {
                        Text(show.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            selectedSeason?.name ?: "Select a season",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close") }
                }
                HorizontalDivider()
                Box(Modifier.fillMaxSize()) {
                    when {
                        loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                        selectedSeason == null -> {
                            val list = seasons ?: emptyList()
                            if (list.isEmpty()) {
                                Text("No seasons found.", Modifier.align(Alignment.Center).padding(16.dp),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            } else {
                                LazyColumn {
                                    items(list, key = { it.id }) { season ->
                                        ListRow(season.name, screenshotUrl = season.screenshotUrl) { onOpenSeason(season) }
                                    }
                                }
                            }
                        }
                        else -> {
                            val list = episodes ?: emptyList()
                            if (list.isEmpty()) {
                                Text("No episodes found.", Modifier.align(Alignment.Center).padding(16.dp),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            } else {
                                LazyColumn {
                                    items(list, key = { it.episodeId }) { ep ->
                                        ListRow(
                                            text = ep.name.ifBlank { "Episode ${ep.seriesNumber}" },
                                            screenshotUrl = ep.screenshotUrl,
                                            leadingPlay = true
                                        ) {
                                            onPlayEpisode(selectedSeason, ep)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ListRow(
    text: String,
    screenshotUrl: String? = null,
    leadingPlay: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable { onClick() }.padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(width = 64.dp, height = 36.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center
        ) {
            if (!screenshotUrl.isNullOrBlank()) {
                AsyncImage(
                    model = screenshotUrl,
                    contentDescription = text,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                if (leadingPlay) {
                    Icon(Icons.Default.PlayArrow, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                } else {
                    Icon(Icons.Default.Tv, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Spacer(Modifier.width(12.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f))
        if (!leadingPlay) Icon(Icons.Default.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
