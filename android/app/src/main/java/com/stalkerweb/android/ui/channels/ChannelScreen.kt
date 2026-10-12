package com.stalkerweb.android.ui.channels

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Router
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.FavoriteGroup
import com.stalkerweb.android.data.repo.jumpTarget
import com.stalkerweb.android.ui.components.ChannelTile
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.Pill
import com.stalkerweb.android.ui.components.SectionHeader
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val GENRE_COLLAPSE_THRESHOLD = 12

/**
 * The Channels page, as on the web: search, count, "Hide flaky" and genre
 * pills; then, on All, Favorites (collapsible, with groups) and Recently
 * Watched; then the channel tiles. Long-press a tile (a held OK on the remote)
 * for its actions; type a channel number on the remote to jump to it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChannelScreen(viewModel: ChannelViewModel, onSelectChannel: (Channel) -> Unit, onOpenPortal: () -> Unit = {}) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val isTV = rememberIsTV()
    val context = LocalContext.current
    val displayed = remember(state.channels, state.selectedGroupId, state.query, state.hideFlaky, state.health) { state.displayed }
    val byId = remember(state.channels) { state.channels.associateBy { it.uniqueId } }
    var menuFor by remember { mutableStateOf<Channel?>(null) }
    var logoFor by remember { mutableStateOf<Channel?>(null) }
    var groupPickFor by remember { mutableStateOf<Channel?>(null) }
    var editGroup by remember { mutableStateOf<FavoriteGroup?>(null) }
    var newGroup by remember { mutableStateOf(false) }
    var genresExpanded by remember { mutableStateOf(false) }
    var searchFocused by remember { mutableStateOf(false) }
    var digits by remember { mutableStateOf("") }

    // Toasts for failed saves.
    LaunchedEffect(viewModel) { viewModel.messages.collect { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() } }
    // Now/next every 5 minutes and health every minute, while this screen is in front.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            launch { while (true) { delay(5 * 60_000L); viewModel.refreshNowNext() } }
            while (true) { delay(60_000L); viewModel.refreshHealth() }
        }
    }
    // Number jump: the digits typed, then the channel 1.2 s after the last one.
    LaunchedEffect(digits) {
        if (digits.isEmpty()) return@LaunchedEffect
        delay(1_200)
        jumpTarget(state.channels, digits)?.let(onSelectChannel)
        digits = ""
    }

    Column(
        Modifier.fillMaxSize().onPreviewKeyEvent { e ->
            if (e.type != KeyEventType.KeyDown || searchFocused) return@onPreviewKeyEvent false
            val c = e.utf16CodePoint.toChar()
            if (c.isDigit()) { digits = (digits + c).takeLast(4); true } else false
        },
    ) {
        // Search · count · hide flaky · refresh
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = state.query, onValueChange = viewModel::setQuery,
                placeholder = { Text("Search channels…") },
                leadingIcon = { Icon(Icons.Default.Search, null, Modifier.size(18.dp)) },
                trailingIcon = if (state.query.isNotEmpty()) ({ IconButton(onClick = { viewModel.setQuery("") }) { Icon(Icons.Default.Close, "Clear") } }) else null,
                singleLine = true, shape = RoundedCornerShape(10.dp),
                modifier = Modifier.weight(1f).onFocusChanged { searchFocused = it.isFocused },
            )
            if (state.flaky > 0) {
                Pill(if (state.hideFlaky) "Flaky hidden" else "Hide flaky (${state.flaky})", state.hideFlaky,
                    { viewModel.setHideFlaky(!state.hideFlaky) }, leading = Icons.Default.Warning)
            }
            Text("${displayed.size} ${if (displayed.size == 1) "channel" else "channels"}", style = MaterialTheme.typography.labelMedium, color = SwColors.Muted)
            IconButton(onClick = { viewModel.load() }) { Icon(Icons.Default.Refresh, "Refresh") }
        }
        // Genre pills: collapsed to one line when there are many.
        if (state.groups.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.Top) {
                val pills: @Composable () -> Unit = {
                    Pill("All", state.selectedGroupId == null, { viewModel.setSelectedGroup(null) })
                    state.groups.forEach { g -> Pill(g.name, state.selectedGroupId == g.id, { viewModel.setSelectedGroup(g.id) }) }
                }
                if (genresExpanded || state.groups.size <= GENRE_COLLAPSE_THRESHOLD) {
                    FlowRow(Modifier.weight(1f).heightIn(max = 240.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { pills() }
                } else {
                    LazyRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        item { Pill("All", state.selectedGroupId == null, { viewModel.setSelectedGroup(null) }) }
                        items(state.groups, key = { it.id }) { g -> Pill(g.name, state.selectedGroupId == g.id, { viewModel.setSelectedGroup(g.id) }) }
                    }
                }
                if (state.groups.size > GENRE_COLLAPSE_THRESHOLD) {
                    Pill(if (genresExpanded) "Less" else "More", false, { genresExpanded = !genresExpanded },
                        leading = if (genresExpanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
        if (state.portalNotConnected) {
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Default.Router, null, tint = SwColors.Warning)
                Text("Portal not connected — showing cached channels.", color = SwColors.Text, modifier = Modifier.weight(1f))
                TextButton(onClick = onOpenPortal) { Text("Connect") }
            }
        }

        val tile: @Composable (Channel, Boolean) -> Unit = { ch, inFavorites ->
            ChannelTile(
                channel = ch, logoUrl = state.logoMap[ch.uniqueId], isFavorite = ch.uniqueId in state.favoriteIds,
                nowNext = state.nowNext[ch.uniqueId], errors = state.health[ch.uniqueId]?.errors ?: 0,
                onClick = { onSelectChannel(ch) },
                onToggleFavorite = { viewModel.toggleFavorite(ch) },
                onEdit = { logoFor = ch },
                onLongClick = { menuFor = ch },
            )
        }

        LazyVerticalGrid(
            columns = GridCells.Adaptive(if (isTV) 180.dp else 150.dp),
            contentPadding = PaddingValues(12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            if (state.browsing) {
                full {
                    SectionHeader(Icons.Default.Favorite, "Favorites", state.favoriteChannels.size, state.favoritesOpen, viewModel::toggleFavoritesOpen)
                }
                if (state.favoritesOpen) {
                    if (state.favoriteChannels.isEmpty() && state.favoriteGroups.isEmpty()) {
                        full { Text("No favorites yet — long-press a channel (or hold OK) to add it.", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall) }
                    }
                    items(state.favoriteChannels, key = { "fav-" + it.uniqueId }) { ch -> tile(byId[ch.uniqueId] ?: ch, true) }
                    full { GroupsSection(state.favoriteGroups, state.logoMap, byId, onSelectChannel, onNew = { newGroup = true }, onEdit = { editGroup = it },
                        onDelete = viewModel::deleteGroup, onMove = viewModel::moveGroup) }
                }
                if (state.recentChannels.isNotEmpty()) {
                    full {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            SectionHeader(Icons.Default.History, "Recently Watched", state.recentChannels.size)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 4.dp, horizontal = 2.dp)) {
                                items(state.recentChannels.take(10), key = { "rec-" + it.uniqueId }) { r ->
                                    val ch = byId[r.uniqueId] ?: Channel(uniqueId = r.uniqueId, name = r.name)
                                    Column(Modifier.width(if (isTV) 180.dp else 150.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        ChannelTile(
                                            channel = ch, logoUrl = state.logoMap[ch.uniqueId] ?: r.logoUrl, isFavorite = ch.uniqueId in state.favoriteIds,
                                            nowNext = state.nowNext[ch.uniqueId], errors = state.health[ch.uniqueId]?.errors ?: 0,
                                            onClick = { onSelectChannel(ch) }, onToggleFavorite = { viewModel.toggleFavorite(ch) },
                                            onEdit = { logoFor = ch }, onLongClick = { menuFor = ch },
                                        )
                                        TextButton(onClick = { viewModel.removeRecent(r.uniqueId) }) {
                                            Icon(Icons.Default.Close, null, Modifier.size(12.dp)); Spacer(Modifier.width(4.dp))
                                            Text("Remove", style = MaterialTheme.typography.labelSmall)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                full { SectionHeader(Icons.Default.Tv, "All channels", displayed.size) }
            }
            when {
                state.loading && state.channels.isEmpty() -> full { Box(Modifier.fillMaxWidth().padding(48.dp), Alignment.Center) { CircularProgressIndicator() } }
                state.error != null && state.channels.isEmpty() -> full {
                    EmptyState(Icons.Default.Tv, "Couldn't load channels", state.error) { Button(onClick = { viewModel.load() }) { Text("Retry") } }
                }
                state.portalNotConnected && state.channels.isEmpty() -> full {
                    EmptyState(Icons.Default.Router, "No portal connected", "Connect a portal to load channels.") { Button(onClick = onOpenPortal) { Text("Connect Portal") } }
                }
                displayed.isEmpty() -> full { EmptyState(Icons.Default.Search, "No channels found.") }
                else -> items(displayed, key = { it.uniqueId }) { ch -> tile(ch, false) }
            }
        }
    }

    if (digits.isNotEmpty()) NumberJumpOverlay(digits)

    menuFor?.let { ch ->
        val favIndex = state.favoriteChannels.indexOfFirst { it.uniqueId == ch.uniqueId }
        ChannelActionsDialog(
            channel = ch, isFavorite = ch.uniqueId in state.favoriteIds, canMoveLeft = favIndex > 0,
            canMoveRight = favIndex >= 0 && favIndex < state.favoriteChannels.size - 1, hasGroups = state.favoriteGroups.isNotEmpty(),
            onDismiss = { menuFor = null },
            onToggleFavorite = { viewModel.toggleFavorite(ch) },
            onAddToGroup = { groupPickFor = ch },
            onEditLogo = { logoFor = ch },
            onMove = { delta -> viewModel.moveFavorite(ch, delta) },
        )
    }
    groupPickFor?.let { ch ->
        GroupPickerDialog(state.favoriteGroups, onPick = { g -> viewModel.addToGroup(g, ch) }, onDismiss = { groupPickFor = null })
    }
    logoFor?.let { ch ->
        LogoDialog(ch, onCheck = viewModel::checkLogo, onSave = { url -> viewModel.saveLogo(ch, url) }, onDismiss = { logoFor = null })
    }
    if (newGroup) NameDialog("New group", "", onSave = viewModel::createGroup, onDismiss = { newGroup = false })
    editGroup?.let { g ->
        GroupEditDialog(
            group = g, allChannels = state.channels, logoMap = state.logoMap,
            onRename = { viewModel.renameGroup(g, it) },
            onAdd = { viewModel.addToGroup(g, it) },
            onRemove = { viewModel.removeFromGroup(g, it) },
            onDismiss = { editGroup = null },
        )
    }
}

private fun LazyGridScope.full(content: @Composable () -> Unit) = item(span = { GridItemSpan(maxLineSpan) }) { content() }

/** The Favorites groups: a row each with a logo preview, count and actions; New group. */
@Composable
private fun GroupsSection(
    groups: List<FavoriteGroup>, logoMap: Map<String, String>, byId: Map<String, Channel>, onOpen: (Channel) -> Unit,
    onNew: () -> Unit, onEdit: (FavoriteGroup) -> Unit, onDelete: (FavoriteGroup) -> Unit, onMove: (FavoriteGroup, Int) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionHeader(Icons.Default.Layers, "Groups", groups.size)
            Spacer(Modifier.weight(1f))
            Pill("New group", false, onNew, leading = Icons.Default.Add)
        }
        groups.forEachIndexed { i, g ->
            GroupRow(g, logoMap, byId, onOpen, canUp = i > 0, canDown = i < groups.size - 1,
                onEdit = { onEdit(g) }, onDelete = { onDelete(g) }, onMove = { d -> onMove(g, d) })
        }
    }
}
