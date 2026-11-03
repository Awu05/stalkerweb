package com.stalkerweb.android.ui.guide

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.repo.RECORD_LENGTHS
import com.stalkerweb.android.data.repo.TimedBooking
import com.stalkerweb.android.data.repo.timedBooking
import com.stalkerweb.android.data.repo.timedLabel
import com.stalkerweb.android.ui.components.Pill
import com.stalkerweb.android.ui.components.TipIconButton
import com.stalkerweb.android.ui.components.TvTextField
import com.stalkerweb.android.ui.theme.SwColors

private const val MIN = 60_000L

/**
 * Record a time (the web's RecordTimeDialog): where the guide has no programme
 * to book — a start and an end, moved with − and + (the remote's OK works them),
 * a length that sets the end, and a title (the channel's name unless typed).
 */
@Composable
fun RecordTimeDialog(channel: Channel, defaultStart: Long, onRecord: (TimedBooking) -> Unit, onDismiss: () -> Unit) {
    var startAt by remember { mutableLongStateOf(defaultStart) }
    var endAt by remember { mutableLongStateOf(defaultStart + 60 * MIN) }
    var title by remember { mutableStateOf("") }
    val now = System.currentTimeMillis()
    val booking = timedBooking(startAt, endAt, title, channel.name, now)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Record a time") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("${channel.name} · no programme in the guide to book", color = SwColors.Muted, style = MaterialTheme.typography.bodySmall)
                // Moving the start keeps the length.
                Stepper("Starts", timedLabel(startAt, now), "30 minutes", { startAt -= 30 * MIN; endAt -= 30 * MIN }, { startAt += 30 * MIN; endAt += 30 * MIN })
                Stepper("Ends", timedLabel(endAt, now), "15 minutes", { endAt -= 15 * MIN }, { endAt += 15 * MIN })
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(RECORD_LENGTHS) { m ->
                        Pill(if (m < 60) "$m min" else "${m / 60} h", endAt - startAt == m * MIN, { endAt = startAt + m * MIN })
                    }
                }
                TvTextField(value = title, onValueChange = { title = it.take(120) }, label = { Text("Title") }, placeholder = { Text(channel.name) })
                Text(booking.error ?: "Plus your padding (Settings)", color = if (booking.error != null) SwColors.Live else SwColors.Muted, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = {
            OutlinedButton(onClick = { onRecord(booking) }, enabled = booking.error == null) {
                Icon(Icons.Default.FiberManualRecord, null, tint = SwColors.Live)
                Text("  Record")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun Stepper(label: String, value: String, step: String, onLess: () -> Unit, onMore: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = SwColors.Muted, modifier = Modifier.width(56.dp))
        TipIconButton(label = "$label $step earlier", onClick = onLess) { Icon(Icons.Default.Remove, "$label $step earlier") }
        Text(value, color = SwColors.Text, textAlign = TextAlign.Center, modifier = Modifier.width(132.dp))
        TipIconButton(label = "$label $step later", onClick = onMore) { Icon(Icons.Default.Add, "$label $step later") }
    }
}
