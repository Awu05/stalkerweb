package com.stalkerweb.android.ui.channels

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
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
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.Group
import com.stalkerweb.android.data.api.NowNextEntry
import com.stalkerweb.android.data.prefs.WatchedChannel
import com.stalkerweb.android.ui.utils.rememberIsTV

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelScreen(
    viewModel: ChannelViewModel,
    onSelectChannel: (Channel) -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val isTV  = rememberIsTV()
    // ChannelUiState.displayed filters the full channel list on every access and
    // caches nothing, so reading it per row cost O(rows x channels) per frame on
    // large portals. Evaluate it once per state change instead.
    val displayed = remember(state) { state.displayed }
    val firstItemFocusRequester = remember { FocusRequester() }

    // On TV, push initial focus into the channel list so the remote is immediately useful
    LaunchedEffect(state.loading, isTV, displayed.isNotEmpty()) {
        if (isTV && !state.loading && displayed.isNotEmpty()) {
            try { firstItemFocusRequester.requestFocus() } catch (_: Exception) {}
        }
    }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            Column {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                    title = {
                        Text(
                            "Channels",
                            style = MaterialTheme.typography.titleLarge,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    },
                    actions = {
                        IconButton(onClick = viewModel::load) {
                            Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                        }
                    },
                )
                // Search bar
                OutlinedTextField(
                    value = state.query,
                    onValueChange = viewModel::setQuery,
                    placeholder = { Text("Search channels…") },
                    leadingIcon = {
                        Icon(Icons.Default.Search, null, Modifier.size(18.dp))
                    },
                    trailingIcon = {
                        if (state.query.isNotEmpty()) {
                            IconButton(onClick = { viewModel.setQuery("") }) {
                                Icon(Icons.Default.Close, "Clear", Modifier.size(18.dp))
                            }
                        }
                    },
                    singleLine = true,
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                )
                // All / Favorites tabs
                val tabTitles = listOf("All", "Favorites")
                TabRow(
                    selectedTabIndex = state.tab.ordinal,
                    indicator = { positions ->
                        TabRowDefaults.PrimaryIndicator(
                            Modifier.tabIndicatorOffset(positions[state.tab.ordinal])
                        )
                    },
                ) {
                    tabTitles.forEachIndexed { index, title ->
                        Tab(
                            selected = state.tab.ordinal == index,
                            onClick  = { viewModel.setTab(ChannelTab.entries[index]) },
                            text     = { Text(title) },
                        )
                    }
                }

                // Genre selection chips
                if (state.tab == ChannelTab.ALL && state.groups.isNotEmpty()) {
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)
                    ) {
                        item {
                            FilterChip(
                                selected = state.selectedGroupId == null,
                                onClick  = { viewModel.setSelectedGroup(null) },
                                label    = { Text("All") },
                                shape    = RoundedCornerShape(16.dp),
                            )
                        }
                        items(state.groups) { group ->
                            FilterChip(
                                selected = state.selectedGroupId == group.id,
                                onClick  = { viewModel.setSelectedGroup(group.id) },
                                label    = { Text(group.name) },
                                shape    = RoundedCornerShape(16.dp),
                            )
                        }
                    }
                }
            }
        }
    ) { innerPadding ->
        Box(Modifier.fillMaxSize().padding(innerPadding)) {
            when {
                state.loading -> {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                }
                state.portalNotConnected && state.channels.isEmpty() -> {
                    Column(
                        Modifier.align(Alignment.Center).padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(
                            Icons.Default.Router, null,
                            Modifier.size(40.dp),
                            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "No portal connected",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "Connect a portal to load channels.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                        )
                        Spacer(Modifier.height(16.dp))
                        Button(onClick = onOpenPortal) { Text("Connect Portal") }
                    }
                }
                state.error != null -> {
                    Column(
                        Modifier.align(Alignment.Center),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(
                            Icons.Default.Warning, null,
                            Modifier.size(40.dp),
                            tint = MaterialTheme.colorScheme.error,
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            state.error!!,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                        Spacer(Modifier.height(12.dp))
                        Button(onClick = viewModel::load) { Text("Retry") }
                    }
                }
                displayed.isEmpty() -> {
                    Column(
                        Modifier.align(Alignment.Center),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(
                            Icons.Default.Tv, null, Modifier.size(40.dp),
                            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.3f),
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            if (state.query.isNotEmpty()) "No channels match \"${state.query}\""
                            else "No channels",
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                        )
                    }
                }
                else -> {
                    Column {
                        // The list below is a cached snapshot from before the portal
                        // dropped — say so, rather than letting it pass for live data.
                        if (state.portalNotConnected) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(MaterialTheme.colorScheme.errorContainer)
                                    .padding(horizontal = 12.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Icon(
                                    Icons.Default.Router, null,
                                    Modifier.size(18.dp),
                                    tint = MaterialTheme.colorScheme.onErrorContainer,
                                )
                                Text(
                                    "Portal not connected — showing cached channels.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onErrorContainer,
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(onClick = onOpenPortal) { Text("Connect") }
                            }
                        }
                        LazyColumn {
                            // Continue watching row
                            if (state.showRecent) {
                                item(key = "recent_header") {
                                    Text(
                                        "Continue watching",
                                        style    = MaterialTheme.typography.labelMedium,
                                        color    = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                                        modifier = Modifier.padding(start = 12.dp, top = 12.dp, bottom = 4.dp),
                                    )
                                }
                                item(key = "recent_row") {
                                    LazyRow(
                                        contentPadding       = PaddingValues(horizontal = 12.dp),
                                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                                        modifier             = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                                    ) {
                                        items(state.recentChannels, key = { "r_${it.uniqueId}" }) { recent ->
                                            RecentChannelChip(
                                                recent    = recent,
                                                logoUrl   = state.logoMap[recent.uniqueId] ?: recent.logoUrl,
                                                onClick   = {
                                                    val ch = state.channels.find { it.uniqueId == recent.uniqueId }
                                                    if (ch != null) onSelectChannel(ch)
                                                },
                                            )
                                        }
                                    }
                                }
                                item(key = "recent_divider") {
                                    HorizontalDivider(
                                        thickness = 0.5.dp,
                                        color     = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                                    )
                                }
                            }

                            items(displayed, key = { it.uniqueId }) { channel ->
                                val isFirst = channel == displayed.firstOrNull()
                                ChannelRow(
                                    channel          = channel,
                                    logoUrl          = state.logoMap[channel.uniqueId],
                                    isFavorite       = channel.uniqueId in state.favoriteIds,
                                    nowNext          = state.nowNext[channel.uniqueId],
                                    onClick          = { onSelectChannel(channel) },
                                    onToggleFavorite = { viewModel.toggleFavorite(channel) },
                                    isTV             = isTV,
                                    focusRequester   = if (isFirst) firstItemFocusRequester else null,
                                )
                                HorizontalDivider(
                                    thickness = 0.5.dp,
                                    color     = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RecentChannelChip(
    recent: WatchedChannel,
    logoUrl: String?,
    onClick: () -> Unit,
) {
    Surface(
        onClick   = onClick,
        shape     = RoundedCornerShape(8.dp),
        color     = MaterialTheme.colorScheme.surfaceVariant,
        tonalElevation = 2.dp,
        modifier  = Modifier.width(100.dp),
    ) {
        Column(
            modifier            = Modifier.padding(8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(MaterialTheme.colorScheme.surface),
                contentAlignment = Alignment.Center,
            ) {
                if (!logoUrl.isNullOrBlank()) {
                    AsyncImage(
                        model              = logoUrl,
                        contentDescription = recent.name,
                        contentScale       = ContentScale.Fit,
                        modifier           = Modifier.fillMaxSize().padding(4.dp),
                    )
                } else {
                    Icon(
                        Icons.Default.Tv, null, Modifier.size(20.dp),
                        tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.3f),
                    )
                }
            }
            Text(
                text     = recent.name,
                style    = MaterialTheme.typography.labelSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun ChannelRow(
    channel: Channel,
    logoUrl: String?,
    isFavorite: Boolean,
    nowNext: NowNextEntry? = null,
    onClick: () -> Unit,
    onToggleFavorite: () -> Unit,
    isTV: Boolean = false,
    focusRequester: FocusRequester? = null,
) {
    var focused by remember { mutableStateOf(false) }
    val primary = MaterialTheme.colorScheme.primary

    // TV doesn't need bigger touch targets (there's no touch) — legibility at
    // a distance comes from the larger text style below, not from bloating
    // row height/logo size, which just wastes vertical space and shows fewer
    // channels per screen.
    val vertPad  = 10.dp
    val logoSize = if (isTV) 40.dp else 38.dp
    val numWidth = if (isTV) 30.dp else 28.dp

    val modifier = Modifier
        .fillMaxWidth()
        .onFocusChanged { focused = it.isFocused }
        .then(
            if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier
        )
        // Visible D-pad focus border — TV users have no other focus cue
        .border(
            width = if (focused) 2.dp else 0.dp,
            color = if (focused) primary else Color.Transparent,
            shape = RoundedCornerShape(4.dp),
        )
        .background(
            if (focused) primary.copy(alpha = 0.10f) else Color.Transparent,
            shape = RoundedCornerShape(4.dp),
        )
        .clickable(onClick = onClick)
        .padding(horizontal = 12.dp, vertical = vertPad)

    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        // Channel number
        Text(
            text  = channel.number.toString(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f),
            modifier = Modifier.width(numWidth),
        )

        // Logo box
        Box(
            modifier = Modifier
                .size(logoSize)
                .clip(RoundedCornerShape(4.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            if (!logoUrl.isNullOrBlank()) {
                AsyncImage(
                    model            = logoUrl,
                    contentDescription = channel.name,
                    contentScale     = ContentScale.Fit,
                    modifier         = Modifier.fillMaxSize().padding(3.dp),
                )
            } else {
                Icon(
                    Icons.Default.Tv, null, Modifier.size(if (isTV) 22.dp else 18.dp),
                    tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.25f),
                )
            }
        }

        Spacer(Modifier.width(12.dp))

        // Name + Now & Next
        Column(Modifier.weight(1f)) {
            Text(
                text     = channel.name,
                style    = if (isTV) MaterialTheme.typography.bodyLarge else MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (nowNext != null) {
                val nowSecs  = remember { System.currentTimeMillis() / 1000L }
                val duration = nowNext.now.endTime - nowNext.now.startTime
                val progress = if (duration > 0)
                    ((nowSecs - nowNext.now.startTime).toFloat() / duration).coerceIn(0f, 1f)
                else 0f
                Spacer(Modifier.height(2.dp))
                Text(
                    text     = nowNext.now.title,
                    style    = MaterialTheme.typography.labelSmall,
                    color    = MaterialTheme.colorScheme.primary.copy(alpha = 0.85f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(3.dp))
                LinearProgressIndicator(
                    progress        = { progress },
                    modifier        = Modifier.fillMaxWidth().height(2.dp),
                    color           = MaterialTheme.colorScheme.primary,
                    trackColor      = MaterialTheme.colorScheme.surfaceVariant,
                )
                if (nowNext.next != null) {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text     = "Next: ${nowNext.next.title}",
                        style    = MaterialTheme.typography.labelSmall,
                        color    = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        // Favorite toggle
        IconButton(onClick = onToggleFavorite, modifier = Modifier.size(if (isTV) 44.dp else 36.dp)) {
            Icon(
                imageVector = if (isFavorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                contentDescription = if (isFavorite) "Remove favourite" else "Add favourite",
                tint = if (isFavorite) MaterialTheme.colorScheme.error
                       else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.25f),
                modifier = Modifier.size(if (isTV) 22.dp else 18.dp),
            )
        }
    }
}
