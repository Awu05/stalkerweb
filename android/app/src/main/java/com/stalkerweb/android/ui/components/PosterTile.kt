package com.stalkerweb.android.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material3.Icon
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV

/**
 * A movie or show the way the web shows it: a 2:3 poster (fitted, not cropped),
 * an HD badge at the bottom right, the title and year below. Long-press — the
 * remote's held OK — toggles My List, so the remote reaches it; the corner
 * bookmark (shown on focus, once bookmarked, and always on touch) is for touch.
 * [progress] (0–1) draws a resume bar; [watched] a "Watched" badge.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PosterTile(
    title: String,
    year: String,
    posterUrl: String?,
    isHD: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    bookmarked: Boolean? = null,
    onBookmark: (() -> Unit)? = null,
    onDownload: (() -> Unit)? = null,
    progress: Float? = null,
    watched: Boolean = false,
) {
    val isTv = rememberIsTV()
    var focused by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(8.dp)
    Column(
        modifier
            .onFocusChanged { focused = it.hasFocus }
            .tvFocus(shape)
            .combinedClickable(onClick = onClick, onLongClick = onBookmark),
    ) {
        Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).clip(shape).background(SwColors.Surface2)) {
            if (!posterUrl.isNullOrBlank()) {
                AsyncImage(model = posterUrl, contentDescription = title, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
            } else {
                Icon(Icons.Default.Movie, null, Modifier.align(Alignment.Center).size(28.dp), tint = SwColors.Muted.copy(alpha = 0.4f))
            }
            if (isHD) {
                Text(
                    "HD",
                    style = MaterialTheme.typography.labelSmall,
                    color = Color.White,
                    modifier = Modifier.align(Alignment.BottomEnd).padding(4.dp)
                        .background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(4.dp)).padding(horizontal = 4.dp, vertical = 1.dp),
                )
            }
            if (watched) {
                Row(
                    Modifier.align(Alignment.TopStart).padding(4.dp)
                        .background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Icon(Icons.Default.Check, null, Modifier.size(10.dp), tint = Color.White)
                    Text("Watched", style = MaterialTheme.typography.labelSmall, color = Color.White)
                }
            } else if (progress != null && progress > 0f) {
                Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(4.dp).background(Color.Black.copy(alpha = 0.5f))) {
                    Box(Modifier.fillMaxWidth(progress.coerceIn(0f, 1f)).fillMaxHeight().background(SwColors.PrimaryLight))
                }
            }
            val showButtons = focused || !isTv
            if (onBookmark != null && (showButtons || bookmarked == true) && !watched) {
                TipIconButton(label = if (bookmarked == true) "Remove from My List" else "Add to My List", onClick = onBookmark, modifier = Modifier.align(Alignment.TopStart).padding(4.dp).size(36.dp).background(Color.Black.copy(alpha = 0.6f), CircleShape)) {
                    Icon(if (bookmarked == true) Icons.Default.Bookmark else Icons.Default.BookmarkBorder, if (bookmarked == true) "Remove from My List" else "Add to My List", Modifier.size(18.dp), tint = Color.White)
                }
            }
            if (onDownload != null && showButtons) {
                TipIconButton(label = "Download to server", onClick = onDownload, modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).size(36.dp).background(Color.Black.copy(alpha = 0.6f), CircleShape)) {
                    Icon(Icons.Default.Download, "Download to server", Modifier.size(18.dp), tint = Color.White)
                }
            }
        }
        Text(title, style = MaterialTheme.typography.bodySmall, color = SwColors.Text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        if (year.isNotBlank()) Text(year, style = MaterialTheme.typography.labelSmall, color = SwColors.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
