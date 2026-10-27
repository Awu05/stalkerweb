package com.stalkerweb.android.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.NowNextEntry
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV

/**
 * A channel the way the web shows it (components/ChannelCard.jsx): one fixed
 * shape everywhere — logo, "Ch N", a two-line name and a guide strip that's
 * there even without guide data, so a row of tiles lines up. The heart and
 * edit buttons are for touch: they show there (and the heart once favourited),
 * and they never take the remote's focus — long-press, a held OK, opens the
 * tile's actions instead ([onLongClick]), so the remote reaches every one.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChannelTile(
    channel: Channel,
    logoUrl: String?,
    isFavorite: Boolean,
    nowNext: NowNextEntry?,
    errors: Int,
    onClick: () -> Unit,
    onToggleFavorite: (() -> Unit)?,
    onEdit: (() -> Unit)?,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
) {
    val isTv = rememberIsTV()
    var focused by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier
            .onFocusChanged { focused = it.hasFocus }
            .tvFocus(shape)
            .clip(shape)
            .background(if (focused) SwColors.Surface2 else SwColors.Surface)
            .border(1.dp, SwColors.Border, shape)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 12.dp, top = 36.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(Modifier.size(64.dp).clip(RoundedCornerShape(8.dp)).background(SwColors.Surface2), contentAlignment = Alignment.Center) {
                if (!logoUrl.isNullOrBlank()) {
                    AsyncImage(model = logoUrl, contentDescription = channel.name, contentScale = ContentScale.Fit, modifier = Modifier.padding(4.dp))
                } else {
                    Icon(Icons.Default.Tv, null, Modifier.size(28.dp), tint = SwColors.Muted)
                }
            }
            Text(if (channel.number > 0) "Ch ${channel.number}" else "", style = MaterialTheme.typography.labelMedium, color = SwColors.Muted)
            Text(
                channel.name,
                style = MaterialTheme.typography.titleSmall,
                color = SwColors.Text,
                textAlign = TextAlign.Center,
                minLines = 2,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            // The guide strip — always this tall.
            Column(Modifier.fillMaxWidth().height(52.dp)) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(SwColors.Border))
                Spacer(Modifier.height(6.dp))
                val now = nowNext?.now
                if (now != null) {
                    Text(now.title, style = MaterialTheme.typography.labelSmall, color = SwColors.PrimaryLight, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val nowSec = System.currentTimeMillis() / 1000
                    val span = (now.endTime - now.startTime).coerceAtLeast(1)
                    LinearProgressIndicator(
                        progress = { ((nowSec - now.startTime).toFloat() / span).coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).height(3.dp),
                        color = SwColors.Primary,
                        trackColor = SwColors.Surface3,
                    )
                    nowNext.next?.let { Text("Next: ${it.title}", style = MaterialTheme.typography.labelSmall, color = SwColors.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            }
        }
        if (errors > 0) {
            Icon(Icons.Default.Warning, "Recent stream failures", Modifier.align(Alignment.TopStart).padding(8.dp).size(16.dp), tint = SwColors.Warning)
        }
        Row(Modifier.align(Alignment.TopEnd).padding(2.dp)) {
            if (onToggleFavorite != null && (isFavorite || !isTv)) {
                TipIconButton(label = if (isFavorite) "Remove ${channel.name} from favorites" else "Add ${channel.name} to favorites", onClick = onToggleFavorite, modifier = Modifier.size(36.dp).focusProperties { canFocus = false }) {
                    Icon(
                        if (isFavorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                        if (isFavorite) "Remove ${channel.name} from favorites" else "Add ${channel.name} to favorites",
                        Modifier.size(18.dp),
                        tint = if (isFavorite) SwColors.Heart else SwColors.Muted,
                    )
                }
            }
            if (onEdit != null && !isTv) {
                TipIconButton(label = "Edit ${channel.name}", onClick = onEdit, modifier = Modifier.size(36.dp).focusProperties { canFocus = false }) {
                    Icon(Icons.Default.Edit, "Edit ${channel.name}", Modifier.size(18.dp), tint = SwColors.Muted)
                }
            }
        }
    }
}
