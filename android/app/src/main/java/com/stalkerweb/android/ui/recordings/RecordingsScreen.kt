package com.stalkerweb.android.ui.recordings

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.stalkerweb.android.BuildConfig
import com.stalkerweb.android.data.api.Recording
import com.stalkerweb.android.data.repo.groupRecordings
import com.stalkerweb.android.data.repo.recordingLabel
import com.stalkerweb.android.data.repo.recordingsHint
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.TipIconButton
import com.stalkerweb.android.ui.theme.SwColors

/**
 * Live TV recordings (the web's RecordingsPage): recording now, booked, done.
 * The server makes them (data/repo/RecordingRules.kt for the lines); a
 * finished one plays in the VOD player ([onPlay]).
 */
@Composable
fun RecordingsScreen(viewModel: RecordingsViewModel, onPlay: (Recording) -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val published by viewModel.published.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { viewModel.follow() } }
    LaunchedEffect(viewModel) { viewModel.messages.collect { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() } }
    var deleting by remember { mutableStateOf<Recording?>(null) }

    val g = groupRecordings(state.list)
    Column(Modifier.fillMaxSize()) {
        Text("Recordings", style = MaterialTheme.typography.titleMedium, color = SwColors.Text, modifier = Modifier.padding(start = 16.dp, top = 16.dp, end = 16.dp))
        Text(recordingsHint(BuildConfig.IS_SOLO), style = MaterialTheme.typography.labelMedium, color = SwColors.Muted,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        state.error?.takeIf { state.list.isNotEmpty() }?.let {
            Text(it, style = MaterialTheme.typography.labelMedium, color = SwColors.Live, modifier = Modifier.padding(horizontal = 16.dp))
        }
        when {
            state.loading -> CircularProgressIndicator(Modifier.padding(32.dp))
            g.isEmpty -> EmptyState(Icons.Default.FiberManualRecord, "No recordings yet",
                state.error ?: "Press Record in the live player, or pick Record on a programme in the guide.")
            else -> LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                section("Recording now", g.recording, published, onPlay, viewModel::stop) { deleting = it }
                section("Scheduled", g.scheduled, published, onPlay, viewModel::stop) { deleting = it }
                section("Recorded", g.done, published, onPlay, viewModel::stop) { deleting = it }
            }
        }
    }

    deleting?.let { r ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete \"${r.title.ifBlank { r.channelName }}\"?") },
            text = {
                Text(if (BuildConfig.IS_SOLO && r.id in published) "The copy in Downloads/StalkerWeb stays." else "Its file is deleted too.",
                    color = SwColors.Muted)
            },
            confirmButton = { Button(onClick = { viewModel.delete(r); deleting = null }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.section(
    title: String, list: List<Recording>, published: Set<String>,
    onPlay: (Recording) -> Unit, onStop: (Recording) -> Unit, onDelete: (Recording) -> Unit,
) {
    if (list.isEmpty()) return
    item(key = "h-$title") {
        Text("$title  ${list.size}", style = MaterialTheme.typography.labelLarge, color = SwColors.Text, modifier = Modifier.padding(top = 8.dp))
    }
    items(list, key = { it.id }) { r -> RecordingRow(r, published, onPlay, onStop, onDelete) }
}

@Composable
private fun RecordingRow(r: Recording, published: Set<String>, onPlay: (Recording) -> Unit, onStop: (Recording) -> Unit, onDelete: (Recording) -> Unit) {
    val failed = r.status == "failed" || r.status == "missed"
    Surface(color = SwColors.Surface, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            when (r.status) {
                "recording" -> Icon(Icons.Default.FiberManualRecord, null, Modifier.size(18.dp), tint = SwColors.Live)
                "scheduled" -> Icon(Icons.Default.Schedule, null, Modifier.size(18.dp), tint = SwColors.Muted)
                "done" -> Icon(Icons.Default.CheckCircle, null, Modifier.size(18.dp), tint = SwColors.Success)
                else -> Icon(Icons.Default.ErrorOutline, null, Modifier.size(18.dp), tint = SwColors.Live)
            }
            Column(Modifier.weight(1f)) {
                Text(r.title.ifBlank { r.channelName }, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val line = buildString {
                    if (r.channelName.isNotBlank()) append(r.channelName).append(" · ")
                    append(recordingLabel(r))
                    if (r.status == "done" && !r.error.isNullOrBlank()) append(" · ").append(r.error)
                    if (BuildConfig.IS_SOLO && r.status == "done" && r.id in published) append(" · saved to Downloads/StalkerWeb")
                }
                Text(line, style = MaterialTheme.typography.labelMedium, color = if (failed) SwColors.Live else SwColors.Muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            when (r.status) {
                "done" -> TipIconButton(label = "Play", onClick = { onPlay(r) }) { Icon(Icons.Default.PlayArrow, "Play") }
                "recording" -> TipIconButton(label = "Stop recording", onClick = { onStop(r) }) { Icon(Icons.Default.Stop, "Stop recording", tint = SwColors.Live) }
                "scheduled" -> TipIconButton(label = "Cancel", onClick = { onStop(r) }) { Icon(Icons.Default.Close, "Cancel") }
            }
            if (r.status != "scheduled" && r.status != "recording") {
                TipIconButton(label = "Delete", onClick = { onDelete(r) }) { Icon(Icons.Default.Delete, "Delete", tint = SwColors.Live) }
            }
        }
    }
}
