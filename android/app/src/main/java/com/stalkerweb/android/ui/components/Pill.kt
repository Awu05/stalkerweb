package com.stalkerweb.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.ui.theme.SwColors

/** A rounded choice chip (genres, categories, filters) — white when selected, like the web's pills. */
@Composable
fun Pill(text: String, selected: Boolean, onClick: () -> Unit, leading: ImageVector? = null, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(50)
    Row(
        modifier
            .tvFocus(shape)
            .background(if (selected) SwColors.Primary else SwColors.Surface2, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val fg = if (selected) SwColors.Bg else SwColors.Muted
        if (leading != null) Icon(leading, null, Modifier.size(14.dp), tint = fg)
        Text(text, style = MaterialTheme.typography.labelLarge, color = fg, maxLines = 1)
    }
}
