package com.stalkerweb.android.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cast
import androidx.compose.material.icons.filled.CastConnected
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.stalkerweb.android.cast.CastManager

/** The player's Cast button: a picker of TVs, or — while casting — which one, and Stop casting. */
@Composable
fun CastButton(cast: CastManager, tint: Color = Color.White) {
    if (!cast.available) return
    val casting by cast.isCasting.collectAsStateWithLifecycle()
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }) {
        Icon(if (casting) Icons.Default.CastConnected else Icons.Default.Cast, if (casting) "Casting — choose" else "Cast", tint = tint)
    }
    if (open) CastDialog(cast, casting) { open = false }
}

@Composable
private fun CastDialog(cast: CastManager, casting: Boolean, onDismiss: () -> Unit) {
    val devices by cast.devices.collectAsStateWithLifecycle()
    val deviceName by cast.deviceName.collectAsStateWithLifecycle()
    DisposableEffect(Unit) {
        cast.startDiscovery()
        onDispose { cast.stopDiscovery() }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (casting) "Casting to ${deviceName ?: "TV"}" else "Cast to") },
        text = {
            if (casting) {
                Text("It plays on the TV; the controls here drive it.")
            } else if (devices.isEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Text("Looking for TVs on this network…")
                }
            } else {
                LazyColumn(Modifier.heightIn(max = 320.dp)) {
                    items(devices, key = { it.id }) { d ->
                        Row(
                            Modifier.fillMaxWidth().clickable { cast.select(d); onDismiss() }.padding(vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Icon(Icons.Default.Tv, null)
                            Column {
                                Text(d.name)
                                d.description?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (casting) Button(onClick = { cast.stopCasting(); onDismiss() }) { Text("Stop casting") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(if (casting) "Close" else "Cancel") } },
    )
}
