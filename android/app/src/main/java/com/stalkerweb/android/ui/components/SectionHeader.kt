package com.stalkerweb.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.ui.theme.SwColors

/** "♥ FAVORITES 3 ⌃" — an uppercase section title with a count; collapsible when [onToggle] is given. */
@Composable
fun SectionHeader(icon: ImageVector, title: String, count: Int? = null, expanded: Boolean? = null, onToggle: (() -> Unit)? = null) {
    val mod = if (onToggle != null) Modifier.tvFocus(RoundedCornerShape(8.dp)).clickable(onClick = onToggle) else Modifier
    Row(mod.padding(vertical = 4.dp, horizontal = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(14.dp), tint = SwColors.Muted)
        Text(title.uppercase(), style = MaterialTheme.typography.labelMedium, color = SwColors.Muted)
        if (count != null && count > 0) {
            Text(
                count.toString(),
                style = MaterialTheme.typography.labelSmall,
                color = SwColors.Muted,
                modifier = Modifier.background(SwColors.Surface2, RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
        if (expanded != null) Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, Modifier.size(16.dp), tint = SwColors.Muted)
    }
}
