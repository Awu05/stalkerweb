package com.stalkerweb.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.ui.theme.SwColors

/** A quiet centred message for an empty or not-yet-available section. */
@Composable
fun EmptyState(icon: ImageVector, title: String, message: String? = null, action: (@Composable () -> Unit)? = null) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, null, Modifier.size(40.dp), tint = SwColors.Muted.copy(alpha = 0.5f))
        Text(title, style = MaterialTheme.typography.titleMedium, color = SwColors.Text, textAlign = TextAlign.Center)
        if (message != null) Text(message, style = MaterialTheme.typography.bodyMedium, color = SwColors.Muted, textAlign = TextAlign.Center)
        action?.invoke()
    }
}
