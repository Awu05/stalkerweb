package com.stalkerweb.android.ui.channels

import com.stalkerweb.android.ui.components.TvTextField
import com.stalkerweb.android.ui.utils.isOkKey

import com.stalkerweb.android.ui.components.TipIconButton

import com.stalkerweb.android.ui.components.tvKeyboardOptions
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.FavoriteGroup
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** "Jump to channel 101" — the digits typed on the remote. */
@Composable
fun NumberJumpOverlay(digits: String) {
    Box(Modifier.fillMaxSize().padding(bottom = 48.dp), contentAlignment = Alignment.BottomCenter) {
        Surface(color = SwColors.Bg.copy(alpha = 0.9f), shape = RoundedCornerShape(12.dp)) {
            Column(Modifier.padding(horizontal = 24.dp, vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Jump to channel", style = MaterialTheme.typography.labelSmall, color = SwColors.Muted)
                Text(digits, style = MaterialTheme.typography.headlineMedium, color = SwColors.PrimaryLight)
            }
        }
    }
}

@Composable
private fun ActionRow(icon: ImageVector, label: String, focus: FocusRequester? = null, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .tvFocus(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, null, Modifier.size(18.dp), tint = SwColors.Muted)
        Text(label, color = SwColors.Text)
    }
}

/** A tile's actions — long-press (a held OK) opens it, so the remote reaches every one. */
@Composable
fun ChannelActionsDialog(
    channel: Channel, isFavorite: Boolean, canMoveLeft: Boolean, canMoveRight: Boolean, hasGroups: Boolean,
    onDismiss: () -> Unit, onToggleFavorite: () -> Unit, onAddToGroup: () -> Unit, onEditLogo: () -> Unit, onMove: (Int) -> Unit,
) {
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    // The OK held to open this menu is still down: its repeats and release mustn't
    // press the focused row. Only a fresh press (repeatCount 0) counts.
    var armed by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(channel.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(Modifier.onPreviewKeyEvent { e ->
                val ok = isOkKey(e.key)
                if (!ok || armed) return@onPreviewKeyEvent false
                if (e.type == KeyEventType.KeyDown && e.nativeKeyEvent.repeatCount == 0) { armed = true; false } else true
            }) {
                ActionRow(if (isFavorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                    if (isFavorite) "Remove from favorites" else "Add to favorites", first) { onToggleFavorite(); onDismiss() }
                if (hasGroups) ActionRow(Icons.Default.Layers, "Add to group…") { onAddToGroup(); onDismiss() }
                ActionRow(Icons.Default.Edit, "Edit logo") { onEditLogo(); onDismiss() }
                if (canMoveLeft) ActionRow(Icons.AutoMirrored.Filled.ArrowBack, "Move left in Favorites") { onMove(-1); onDismiss() }
                if (canMoveRight) ActionRow(Icons.AutoMirrored.Filled.ArrowForward, "Move right in Favorites") { onMove(1); onDismiss() }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
fun GroupPickerDialog(groups: List<FavoriteGroup>, onPick: (FavoriteGroup) -> Unit, onDismiss: () -> Unit) {
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add to group") },
        text = {
            LazyColumn(Modifier.heightIn(max = 360.dp)) {
                items(groups, key = { it.id }) { g ->
                    ActionRow(Icons.Default.Layers, g.name, if (g.id == groups.first().id) first else null) { onPick(g); onDismiss() }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** A name: a new group, or a group renamed. */
@Composable
fun NameDialog(title: String, initial: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(initial) }
    val field = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { field.requestFocus() } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { TvTextField(name, { name = it }, singleLine = true, label = { Text("Name") }, modifier = Modifier.focusRequester(field)) },
        confirmButton = { Button(onClick = { onSave(name.trim()); onDismiss() }, enabled = name.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Search a name for the logo the server finds, or paste a URL; Save sets it for that channel name. */
@Composable
fun LogoDialog(channel: Channel, onCheck: suspend (String) -> String?, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var search by remember { mutableStateOf(channel.name) }
    var found by remember { mutableStateOf<String?>(null) }
    var notFound by remember { mutableStateOf(false) }
    var url by remember { mutableStateOf("") }
    LaunchedEffect(search) {
        found = null; notFound = false
        if (search.isBlank()) return@LaunchedEffect
        delay(400)
        val logo = onCheck(search.trim())
        found = logo; notFound = logo == null
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Set logo — ${channel.name}", maxLines = 1, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                TvTextField(search, { search = it }, singleLine = true, keyboardOptions = tvKeyboardOptions(), label = { Text("Search by channel name") }, trailingIcon = if (search.isNotEmpty()) ({ TipIconButton(label = "Clear search", onClick = { search = "" }) { Icon(Icons.Default.Close, "Clear search") } }) else null)
                found?.let { logo ->
                    Row(
                        Modifier.fillMaxWidth().tvFocus(RoundedCornerShape(8.dp)).clickable { url = logo }
                            .background(if (url == logo) SwColors.Surface3 else SwColors.Surface2, RoundedCornerShape(8.dp)).padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        AsyncImage(logo, null, Modifier.size(40.dp), contentScale = ContentScale.Fit)
                        Text(if (url == logo) "Selected" else "Use this logo", color = SwColors.Text)
                    }
                }
                if (notFound) Text("No logo found", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall)
                TvTextField(url, { url = it }, singleLine = true, keyboardOptions = tvKeyboardOptions(), label = { Text("Or paste a logo URL") })
            }
        },
        confirmButton = { Button(onClick = { onSave(url); onDismiss() }, enabled = url.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** A favorites group's row: logo preview, name and count; expand to its channels; edit, delete, move. */
@Composable
fun GroupRow(
    group: FavoriteGroup, logoMap: Map<String, String>, byId: Map<String, Channel>, onOpen: (Channel) -> Unit,
    canUp: Boolean, canDown: Boolean, onEdit: () -> Unit, onDelete: () -> Unit, onMove: (Int) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    Surface(color = SwColors.Surface, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(Modifier.size(48.dp).clip(RoundedCornerShape(8.dp)).background(SwColors.Surface2)) {
                    group.channels.take(2).forEach { ch ->
                        AsyncImage(logoMap[ch.uniqueId], null, Modifier.size(24.dp).padding(2.dp), contentScale = ContentScale.Fit)
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(group.name, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${group.channels.size} channel${if (group.channels.size == 1) "" else "s"}", style = MaterialTheme.typography.labelSmall, color = SwColors.Muted)
                }
                TipIconButton(label = if (expanded) "Collapse" else "Expand", onClick = { expanded = !expanded }) { Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, if (expanded) "Collapse" else "Expand") }
                if (canUp) TipIconButton(label = "Move group up", onClick = { onMove(-1) }) { Icon(Icons.Default.KeyboardArrowUp, "Move group up") }
                if (canDown) TipIconButton(label = "Move group down", onClick = { onMove(1) }) { Icon(Icons.Default.KeyboardArrowDown, "Move group down") }
                TipIconButton(label = "Edit group", onClick = onEdit) { Icon(Icons.Default.Edit, "Edit group") }
                TipIconButton(label = "Delete group", onClick = { confirmDelete = true }) { Icon(Icons.Default.Delete, "Delete group", tint = SwColors.Live) }
            }
            if (expanded) {
                if (group.channels.isEmpty()) Text("No channels — edit the group to add some.", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(group.channels, key = { it.uniqueId }) { c ->
                        val ch = byId[c.uniqueId] ?: c
                        Column(
                            Modifier.width(96.dp).tvFocus(RoundedCornerShape(8.dp)).clickable { onOpen(ch) }.padding(6.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Box(Modifier.size(40.dp).clip(RoundedCornerShape(6.dp)).background(SwColors.Surface2), Alignment.Center) {
                                val logo = logoMap[ch.uniqueId]
                                if (logo != null) AsyncImage(logo, ch.name, Modifier.size(36.dp), contentScale = ContentScale.Fit)
                                else Icon(Icons.Default.Tv, null, Modifier.size(18.dp), tint = SwColors.Muted)
                            }
                            Text(ch.name, style = MaterialTheme.typography.labelSmall, color = SwColors.Text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete ${group.name}?") },
            text = { Text("The group goes; its channels stay in your favorites.") },
            confirmButton = { Button(onClick = { confirmDelete = false; onDelete() }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

/** Rename a group, remove its channels, add channels from a search. */
@Composable
fun GroupEditDialog(
    group: FavoriteGroup, allChannels: List<Channel>, logoMap: Map<String, String>,
    onRename: (String) -> Unit, onAdd: (Channel) -> Unit, onRemove: (Channel) -> Unit, onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(group.name) }
    var members by remember { mutableStateOf(group.channels) }
    var query by remember { mutableStateOf("") }
    val ids = members.map { it.uniqueId }.toSet()
    val suggestions = remember(query, ids) {
        val q = query.trim().lowercase()
        if (q.isEmpty()) emptyList() else allChannels.filter { it.uniqueId !in ids && it.name.lowercase().contains(q) }.take(20)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit group") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                TvTextField(name, { name = it }, singleLine = true, keyboardOptions = tvKeyboardOptions(), label = { Text("Name") })
                Text("Channels in group", style = MaterialTheme.typography.labelMedium, color = SwColors.Muted)
                LazyColumn(Modifier.heightIn(max = 160.dp)) {
                    items(members, key = { "m" + it.uniqueId }) { c ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(c.name, color = SwColors.Text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            TipIconButton(label = "Remove ${c.name}", onClick = { onRemove(c); members = members.filter { it.uniqueId != c.uniqueId } }) { Icon(Icons.Default.Close, "Remove ${c.name}") }
                        }
                    }
                }
                TvTextField(query, { query = it }, singleLine = true, keyboardOptions = tvKeyboardOptions(), label = { Text("Search channels to add…") }, trailingIcon = if (query.isNotEmpty()) ({ TipIconButton(label = "Clear search", onClick = { query = "" }) { Icon(Icons.Default.Close, "Clear search") } }) else null)
                LazyColumn(Modifier.heightIn(max = 180.dp)) {
                    items(suggestions, key = { "s" + it.uniqueId }) { c ->
                        Row(
                            Modifier.fillMaxWidth().tvFocus(RoundedCornerShape(8.dp)).clickable { onAdd(c); members = members + c; query = "" }.padding(8.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(Icons.Default.Add, null, Modifier.size(16.dp), tint = SwColors.Muted)
                            Text(c.name, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        },
        confirmButton = { Button(onClick = { if (name.trim() != group.name) onRename(name.trim()); onDismiss() }, enabled = name.isNotBlank()) { Text("Done") } },
    )
}
