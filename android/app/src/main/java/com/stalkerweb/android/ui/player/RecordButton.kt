package com.stalkerweb.android.ui.player

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.data.repo.RecordChoice
import com.stalkerweb.android.ui.components.TipIconButton
import com.stalkerweb.android.ui.theme.SwColors

/**
 * Record, among the live player's controls (the web's RecordButton): the
 * channel playing, from now — until the programme ends, for a while, or until
 * stopped ([choices], recordChoices). The server records it, so it goes on with the
 * player closed. [recording]: this player started one on this channel —
 * pressed again, it stops it. A focusable button like the others, so the
 * remote reaches it along the row; its lengths are a menu the D-pad walks.
 */
@Composable
internal fun RecordButton(recording: Boolean, what: String, choices: List<RecordChoice>, tint: Color, onRecord: (String) -> Unit, onStop: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        if (recording) {
            TipIconButton(label = "Stop recording", onClick = onStop) { Icon(Icons.Default.Stop, "Stop recording", tint = SwColors.Live) }
        } else {
            TipIconButton(label = "Record", onClick = { open = true }) { Icon(Icons.Default.FiberManualRecord, "Record", tint = tint) }
        }
        DropdownMenu(expanded = open && !recording, onDismissRequest = { open = false }) {
            Text("Record $what", style = MaterialTheme.typography.labelMedium, color = SwColors.Muted,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
            choices.forEach { c ->
                DropdownMenuItem(text = { Text(c.label) }, onClick = { open = false; onRecord(c.id) })
            }
        }
    }
}

/** "Record anyway?" — recording now would go past the provider's stream limit (the server's words). */
@Composable
internal fun RecordAskDialog(message: String, onYes: () -> Unit, onNo: () -> Unit) {
    AlertDialog(
        onDismissRequest = onNo,
        title = { Text("Record now?") },
        text = { Text(message) },
        confirmButton = { Button(onClick = onYes) { Text("Record anyway") } },
        dismissButton = { TextButton(onClick = onNo) { Text("Cancel") } },
    )
}
