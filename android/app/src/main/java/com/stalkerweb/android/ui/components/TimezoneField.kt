package com.stalkerweb.android.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.data.repo.ZoneEntry
import com.stalkerweb.android.data.repo.filterZones
import com.stalkerweb.android.data.repo.isZone
import com.stalkerweb.android.data.repo.utcOffset
import com.stalkerweb.android.data.repo.zoneEntries
import com.stalkerweb.android.ui.theme.SwColors

/**
 * A connection's time zone, picked from all of them (the web's
 * TimezonePicker — the same list, shared/timezones.json): the field shows
 * the zone and its UTC offset; pressing it opens the list, which a search
 * narrows (a city, a country, an offset like "UTC+1"). A real zone typed in
 * full that isn't listed can be used too.
 */
@Composable
fun TimezoneField(value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier, label: String = "Timezone") {
    var open by remember { mutableStateOf(false) }
    val offset = remember(value) { utcOffset(value) }
    Surface(
        color = SwColors.Surface2,
        shape = RoundedCornerShape(4.dp),
        border = BorderStroke(1.dp, SwColors.BorderStrong),
        modifier = modifier.tvFocus(RoundedCornerShape(4.dp)).clickable { open = true },
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(label, color = SwColors.Muted, style = MaterialTheme.typography.labelSmall)
                Text(
                    value.ifBlank { "Choose a time zone" }.replace('_', ' ') + if (offset.isNotEmpty()) "  ($offset)" else "",
                    color = if (value.isBlank()) SwColors.Muted else SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(Icons.Default.ArrowDropDown, null, tint = SwColors.Muted)
        }
    }
    if (open) TimezoneDialog(value, onPick = { onChange(it); open = false }, onDismiss = { open = false })
}

@Composable
private fun TimezoneDialog(value: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    var query by remember { mutableStateOf("") }
    // Worked out once a dialog: every zone's country and offset now.
    val entries = remember(value) { zoneEntries(value) }
    val typed = query.trim()
    val matches = remember(query, entries) {
        val found = filterZones(entries, query)
        // A real zone typed in full that the list hasn't: offered first, to use as it is.
        if (typed.isNotEmpty() && isZone(typed) && entries.none { it.id.equals(typed, ignoreCase = true) }) {
            listOf(ZoneEntry(typed, "", null, utcOffset(typed), "", "", "")) + found
        } else found
    }
    val listState = rememberLazyListState()
    val currentFocus = remember { FocusRequester() }
    // Opened at the zone there is, with the remote's focus on it.
    LaunchedEffect(Unit) {
        val at = entries.indexOfFirst { it.id == value }
        if (at > 0) listState.scrollToItem(at)
        withFrameNanos { }   // the row laid out, so it can take the focus
        runCatching { currentFocus.requestFocus() }
    }
    LaunchedEffect(query) { if (query.isNotEmpty()) listState.scrollToItem(0) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Timezone") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SearchField(query, { query = it }, "Search: a city, a country, UTC+1…", Modifier.fillMaxWidth())
                if (matches.isEmpty()) Text("No time zone matches \"$query\".", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall)
                LazyColumn(state = listState, modifier = Modifier.heightIn(max = 360.dp)) {
                    itemsIndexed(matches, key = { i, z -> if (i == 0 && z.words.isEmpty()) "custom:${z.id}" else z.id }) { i, z ->
                        val custom = i == 0 && z.words.isEmpty()
                        Row(
                            Modifier.fillMaxWidth()
                                .then(if (z.id == value && query.isEmpty()) Modifier.focusRequester(currentFocus) else Modifier)
                                .tvFocus(RoundedCornerShape(8.dp)).clickable { onPick(z.id) }.padding(horizontal = 8.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Box(Modifier.size(16.dp)) { if (z.id == value) Icon(Icons.Default.Check, "Chosen", tint = SwColors.PrimaryLight, modifier = Modifier.size(16.dp)) }
                            Column(Modifier.weight(1f)) {
                                Text(if (custom) "Use \"${z.id}\"" else z.id.replace('_', ' '), color = if (z.id == value) SwColors.PrimaryLight else SwColors.Text,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (z.country.isNotEmpty()) Text(z.country, color = SwColors.Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                            }
                            Text(z.label, color = SwColors.Muted, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
