package com.stalkerweb.android.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Router
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors

/** Settings until the web's tabs arrive (sub-project 4): the server and the IPTV connection. */
@Composable
fun SettingsScreen(onOpenServer: () -> Unit, onOpenConnection: () -> Unit) {
    Column(Modifier.padding(24.dp).widthIn(max = 640.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall, color = SwColors.Text)
        SettingsLink(Icons.Default.Dns, "Server and access key", "The StalkerWeb server this app talks to", onOpenServer)
        SettingsLink(Icons.Default.Router, "IPTV connection", "Connect, switch or disconnect your provider", onOpenConnection)
        Text("More settings are on the web app for now.", style = MaterialTheme.typography.bodySmall, color = SwColors.Muted)
    }
}

@Composable
private fun SettingsLink(icon: ImageVector, title: String, subtitle: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Surface(color = SwColors.Surface, shape = shape, modifier = Modifier.fillMaxWidth().tvFocus(shape).clickable(onClick = onClick)) {
        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, tint = SwColors.Muted)
            Column {
                Text(title, style = MaterialTheme.typography.titleSmall, color = SwColors.Text)
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = SwColors.Muted)
            }
        }
    }
}
