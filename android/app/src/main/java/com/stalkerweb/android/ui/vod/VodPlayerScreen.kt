package com.stalkerweb.android.ui.vod

import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material.icons.filled.Check
import androidx.compose.foundation.layout.height
import android.app.Activity
import android.view.View
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.stalkerweb.android.data.repo.PlayerParams
import com.stalkerweb.android.ui.components.Pill
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV
import kotlinx.coroutines.delay

private fun clock(secs: Double): String {
    val s = secs.toLong()
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s % 3600 / 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

/**
 * The VOD player (the web's VodPlayerPage): Media3's own controls (seek bar,
 * play/pause; the remote seeks with Left/Right), with a top bar shown alongside
 * them — Back, the title, My List, and for a show Episodes and Previous / Next —
 * a "Resumed from" banner, the episodes panel, and "Up next" after an episode.
 */
@OptIn(UnstableApi::class)
@Composable
fun VodPlayerScreen(params: PlayerParams, viewModel: VodPlayerViewModel, onBack: () -> Unit) {
    val activity = LocalContext.current as? Activity
    val player by viewModel.player.collectAsStateWithLifecycle()
    val state by viewModel.state.collectAsStateWithLifecycle()
    val isTV = rememberIsTV()
    val wide = isTV || LocalConfiguration.current.screenWidthDp >= 600
    var controlsVisible by remember { mutableStateOf(true) }
    var panelOpen by remember { mutableStateOf(false) }
    val p = state.params ?: params
    val watchState by viewModel.watchState.collectAsStateWithLifecycle()
    val inMyList = watchState.list.any { it.id == p.videoId }

    LaunchedEffect(Unit) { viewModel.init(params) }
    val toastContext = LocalContext.current
    LaunchedEffect(viewModel) { viewModel.messages.collect { android.widget.Toast.makeText(toastContext, it, android.widget.Toast.LENGTH_SHORT).show() } }
    // Back closes the episodes panel first (the remote's Back would otherwise leave the player).
    BackHandler(enabled = panelOpen) { panelOpen = false }
    DisposableEffect(activity) {
        activity?.window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { activity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }
    LaunchedEffect(state.resumedFrom) { if (state.resumedFrom > 0) { delay(8_000); viewModel.dismissResumed() } }

    Box(
        Modifier.fillMaxSize().background(Color.Black).onPreviewKeyEvent { e ->
            if (e.type != KeyEventType.KeyDown || !p.isEpisode) return@onPreviewKeyEvent false
            when (e.key) {
                Key.MediaNext, Key.ChannelUp -> { viewModel.playNext(); true }
                Key.MediaPrevious, Key.ChannelDown -> { viewModel.playPrevious(); true }
                else -> false
            }
        },
    ) {
        if (player != null) {
            AndroidView(
                factory = { ctx ->
                    PlayerView(ctx).apply {
                        useController = true
                        resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                        setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { v -> controlsVisible = v == View.VISIBLE })
                    }
                },
                update = { it.player = player },
                modifier = Modifier.fillMaxSize(),
            )
        }

        if (state.loading && state.error == null) CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)

        state.error?.let { msg ->
            Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Default.ErrorOutline, null, tint = SwColors.Live, modifier = Modifier.size(36.dp))
                Text(msg, color = Color.White)
                Button(onClick = viewModel::retry) { Text("Retry") }
            }
        }

        // Top bar, shown with the player's controls.
        if (controlsVisible || state.error != null) {
            Row(
                Modifier.align(Alignment.TopStart).fillMaxWidth().background(Color.Black.copy(alpha = 0.55f)).statusBarsPadding().padding(4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White) }
                Column(Modifier.weight(1f)) {
                    Text(p.title, color = Color.White, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (p.episodeTitle.isNotEmpty()) Text(p.episodeTitle, color = SwColors.Muted, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (p.isEpisode) {
                    IconButton(onClick = viewModel::playPrevious, enabled = state.neighbours.prev != null) { Icon(Icons.Default.SkipPrevious, "Previous episode", tint = Color.White) }
                    IconButton(onClick = viewModel::playNext, enabled = state.neighbours.next != null) { Icon(Icons.Default.SkipNext, "Next episode", tint = Color.White) }
                    IconButton(onClick = { panelOpen = !panelOpen }) { Icon(Icons.AutoMirrored.Filled.List, "Episodes", tint = Color.White) }
                }
                IconButton(onClick = viewModel::download) { Icon(Icons.Default.Download, "Download to server", tint = Color.White) }
                IconButton(onClick = viewModel::toggleMyList) {
                    Icon(if (inMyList) Icons.Default.Bookmark else Icons.Default.BookmarkBorder,
                        if (inMyList) "Remove from My List" else "Add to My List", tint = Color.White)
                }
            }
        }

        // "Resumed from 12:34 · Start over"
        if (state.resumedFrom > 0 && state.error == null) {
            Surface(color = Color.Black.copy(alpha = 0.75f), shape = RoundedCornerShape(50),
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 72.dp)) {
                Row(Modifier.padding(horizontal = 14.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Resumed from ${clock(state.resumedFrom)}", color = Color.White, style = MaterialTheme.typography.labelMedium)
                    TextButton(onClick = viewModel::startOver) { Text("Start over") }
                    IconButton(onClick = viewModel::dismissResumed, modifier = Modifier.size(28.dp)) { Icon(Icons.Default.Close, "Dismiss", tint = Color.White, modifier = Modifier.size(14.dp)) }
                }
            }
        }

        // Episodes: a side panel on wide screens and TV, a bottom panel on phones.
        if (panelOpen && p.isEpisode) {
            EpisodesPanel(
                state = state, current = p, wide = wide,
                watched = watchState.watchedEpisodes.toSet(), progress = watchState.progress.associateBy { it.key },
                onPick = { season, ep -> viewModel.playEpisode(season, ep) },
                onSeason = viewModel::loadSeason,
                onClose = { panelOpen = false },
                modifier = if (wide) Modifier.align(Alignment.CenterEnd).width(340.dp).fillMaxHeight()
                           else Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.6f),
            )
        }

        state.upNext?.let { next ->
            UpNextCard(
                title = com.stalkerweb.android.data.repo.episodeRowLabel(next.episode),
                onPlay = viewModel::playNext,
                onCancel = viewModel::cancelUpNext,
                modifier = Modifier.align(Alignment.BottomEnd).padding(24.dp),
            )
        }
    }
}

@Composable
private fun EpisodesPanel(
    state: VodPlayerState, current: PlayerParams, wide: Boolean,
    watched: Set<String>, progress: Map<String, com.stalkerweb.android.data.api.ProgressEntry>,
    onPick: (com.stalkerweb.android.data.api.VodSeason, com.stalkerweb.android.data.api.VodEpisode) -> Unit,
    onSeason: (String) -> Unit, onClose: () -> Unit, modifier: Modifier,
) {
    var seasonId by remember(current.seasonId) { mutableStateOf(current.seasonId) }
    LaunchedEffect(seasonId) { onSeason(seasonId) }
    val currentFocus = remember { FocusRequester() }
    Surface(color = SwColors.Surface.copy(alpha = 0.96f), shape = RoundedCornerShape(if (wide) 0.dp else 12.dp), modifier = modifier) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Episodes", style = MaterialTheme.typography.titleSmall, color = SwColors.Text, modifier = Modifier.weight(1f))
                IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close episodes") }
            }
            val seasons = state.seasons.orEmpty()
            if (seasons.size > 1) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(seasons, key = { it.id }) { s ->
                        Pill(s.name.ifBlank { "Season ${s.seasonNumber}" }, s.id == seasonId, { seasonId = s.id })
                    }
                }
            }
            val season = seasons.firstOrNull { it.id == seasonId }
            val eps = state.episodes[seasonId]
            when {
                state.seasons == null || eps == null -> CircularProgressIndicator(Modifier.size(22.dp))
                eps.isEmpty() -> Text("No episodes.", color = SwColors.Muted)
                else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    items(eps, key = { it.episodeId }) { ep ->
                        val playing = ep.episodeId == current.episodeId && seasonId == current.seasonId
                        Row(
                            Modifier.fillMaxWidth()
                                .then(if (playing) Modifier.focusRequester(currentFocus) else Modifier)
                                .tvFocus(RoundedCornerShape(8.dp))
                                .background(if (playing) SwColors.Surface3 else Color.Transparent, RoundedCornerShape(8.dp))
                                .clickable(enabled = season != null) { season?.let { onPick(it, ep) } }
                                .padding(10.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            val key = com.stalkerweb.android.data.repo.WatchRules.makeKey(current.videoId, seasonId, ep.episodeId)
                            val seen = key in watched
                            val frac = if (seen) null else progress[key]?.takeIf { it.duration > 0 }?.let { (it.position / it.duration).toFloat().coerceIn(0f, 1f) }
                            Column(Modifier.weight(1f)) {
                                Text(com.stalkerweb.android.data.repo.episodeRowLabel(ep), color = if (playing) SwColors.PrimaryLight else SwColors.Text,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (frac != null && frac > 0f) LinearProgressIndicator(progress = { frac }, modifier = Modifier.fillMaxWidth(0.6f).padding(top = 3.dp).height(2.dp),
                                    color = SwColors.Primary, trackColor = SwColors.Surface3)
                            }
                            if (seen) Icon(Icons.Default.Check, "Watched", Modifier.size(16.dp), tint = SwColors.Success)
                        }
                    }
                }
            }
        }
    }
    LaunchedEffect(state.episodes[seasonId]) { runCatching { currentFocus.requestFocus() } }
}

/** "Up next" after an episode: plays the next one in 10 s unless cancelled. */
@Composable
private fun UpNextCard(title: String, onPlay: () -> Unit, onCancel: () -> Unit, modifier: Modifier) {
    var left by remember { mutableIntStateOf(10) }
    val playFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        runCatching { playFocus.requestFocus() }
        while (left > 0) { delay(1_000); left -= 1 }
        onPlay()
    }
    Surface(color = SwColors.Surface, shape = RoundedCornerShape(12.dp), modifier = modifier.width(300.dp)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Up next in $left s", style = MaterialTheme.typography.labelMedium, color = SwColors.Muted)
            Text(title, style = MaterialTheme.typography.titleSmall, color = SwColors.Text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onPlay, modifier = Modifier.focusRequester(playFocus)) { Text("Play now") }
                OutlinedButton(onClick = onCancel) { Text("Cancel") }
            }
        }
    }
}
