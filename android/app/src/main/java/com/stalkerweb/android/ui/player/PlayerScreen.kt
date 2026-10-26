package com.stalkerweb.android.ui.player

import com.stalkerweb.android.data.repo.StatsRepository
import com.stalkerweb.android.ui.components.StatsButton
import com.stalkerweb.android.ui.components.StreamStatsOverlay
import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.text.format.DateFormat
import android.view.KeyEvent as AndroidKeyEvent
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.stalkerweb.android.ui.components.CastButton
import androidx.compose.material.icons.filled.CastConnected
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.EpgEvent
import com.stalkerweb.android.data.api.NowNextEntry
import com.stalkerweb.android.data.repo.nowPlaying
import com.stalkerweb.android.data.repo.progressAt
import com.stalkerweb.android.data.repo.progressOf
import com.stalkerweb.android.ui.utils.rememberIsTV
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

private const val MAX_STREAM_RETRIES = 2

/** One audio or subtitle track the stream offers. */
private data class TrackOption(val label: String, val group: Tracks.Group, val index: Int, val selected: Boolean)

@OptIn(UnstableApi::class)
private fun trackOptions(tracks: Tracks, type: Int): List<TrackOption> =
    tracks.groups.filter { it.type == type && it.isSupported }.flatMap { g ->
        (0 until g.length).filter { g.isTrackSupported(it) }.map { i ->
            val f = g.getTrackFormat(i)
            val lang = f.language?.takeIf { it.isNotBlank() && it != C.LANGUAGE_UNDETERMINED }
                ?.let { Locale.forLanguageTag(it).displayLanguage.ifBlank { it } }
            TrackOption(f.label?.takeIf { it.isNotBlank() } ?: lang ?: "Track ${i + 1}", g, i, g.isTrackSelected(i))
        }
    }

/** The live player's state the controls need, gathered in one place. */
private class LiveControls(
    val state: PlayerUiState,
    val player: Player?,
    val displayName: String,
    val activeId: String,
    val isPlaying: Boolean,
    val isBuffering: Boolean,
    val castingTo: String? = null,   // the TV it plays on, while casting
    val playerError: String?,
    val showControls: Boolean,
    val nowSecs: Long,
    val audio: List<TrackOption>,
    val subtitles: List<TrackOption>,
    val isTV: Boolean,
    val statsOpen: Boolean = false,   // the Stats panel over the video
    val stats: StatsRepository? = null,
)

/** What the controls can do. */
private class LiveActions(
    val onBack: () -> Unit,
    val onToggleControls: () -> Unit,
    val onShowControls: () -> Unit,
    val onTogglePlayPause: () -> Unit,
    val onRetry: () -> Unit,
    val onSleepTimer: () -> Unit,
    val onToggleChannelList: () -> Unit,
    val onCloseChannelList: () -> Unit,
    val onSelectChannel: (Channel) -> Unit,
    val onLongClickChannel: (Channel) -> Unit,
    val onToggleFavorite: (Channel) -> Unit,
    val onToggleActiveFavorite: () -> Unit,
    val onToggleGuide: () -> Unit,
    val onQuery: (String) -> Unit,
    val onToggleFavoritesOnly: () -> Unit,
    val onSelectGenre: (String?) -> Unit,
    val onPreviousChannel: () -> Unit,
    val onNextChannel: () -> Unit,
    val onDigit: (Char) -> Unit,
    val onPickTrack: (TrackOption) -> Unit,
    val onSubtitlesOff: () -> Unit,
    val onExitFullscreen: () -> Unit,
    val onToggleStats: () -> Unit,
    val onGoFullscreen: () -> Unit,
)

@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(
    channelId: String,
    channelName: String,
    viewModel: PlayerViewModel,
    isInPipMode: Boolean = false,
    onSetPipEnabled: (Boolean) -> Unit = {},
    onBack: () -> Unit,
) {
    val context       = LocalContext.current
    val activity      = context as? Activity
    val configuration = LocalConfiguration.current
    val isLandscape   = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    val isTV          = rememberIsTV()
    // TV and tablets: the list sits beside the picture and stays open while you choose.
    // (The narrow side, so a phone turned sideways — often 900dp wide — isn't one.)
    val wide          = isTV || configuration.smallestScreenWidthDp >= 600
    val state         by viewModel.state.collectAsStateWithLifecycle()
    val player        by viewModel.player.collectAsStateWithLifecycle()
    val castDevice    = viewModel.castManager?.deviceName?.collectAsStateWithLifecycle()?.value
    LaunchedEffect(viewModel.castManager) {
        val cm = viewModel.castManager ?: return@LaunchedEffect
        cm.error.collect { msg -> if (msg != null) { android.widget.Toast.makeText(context, msg, android.widget.Toast.LENGTH_LONG).show(); cm.clearError() } }
    }

    var showControls by remember { mutableStateOf(true) }
    var isPlaying    by remember { mutableStateOf(false) }
    var isBuffering  by remember { mutableStateOf(true) }
    var playerError  by remember { mutableStateOf<String?>(null) }
    var showSleepTimer by remember { mutableStateOf(false) }
    var tracks       by remember { mutableStateOf(Tracks.EMPTY) }

    val activeId = state.activeChannelId.ifBlank { channelId }

    // "Now" for the guide's progress and the list's now/next, every 15 s (as on the web).
    var nowSecs by remember { mutableLongStateOf(System.currentTimeMillis() / 1000) }
    LaunchedEffect(Unit) { while (true) { delay(15_000); nowSecs = System.currentTimeMillis() / 1000 } }

    // Auto-retry on playback error: Stalker create_link tokens are short-lived, so
    // a stream that errors out (expired token, transient CDN hiccup) usually plays
    // again after re-resolving. Retry a couple of times with a short backoff before
    // surfacing the error. The listener outlives channel switches, so read the live
    // channel id via rememberUpdatedState and reset the budget when it changes.
    val retryScope = rememberCoroutineScope()
    val currentActiveId by rememberUpdatedState(activeId)
    var retryCount by remember { mutableStateOf(0) }
    LaunchedEffect(activeId) { retryCount = 0 }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(playing: Boolean) { isPlaying = playing }
            override fun onPlaybackStateChanged(playbackState: Int) {
                isBuffering = playbackState == Player.STATE_BUFFERING ||
                              playbackState == Player.STATE_IDLE
                if (playbackState == Player.STATE_READY) { playerError = null; retryCount = 0 }
            }
            override fun onTracksChanged(newTracks: Tracks) { tracks = newTracks }
            override fun onPlayerError(error: PlaybackException) {
                if (retryCount < MAX_STREAM_RETRIES) {
                    retryCount++
                    isBuffering = true
                    playerError = null
                    retryScope.launch {
                        delay(1500L * retryCount)          // brief, growing backoff
                        viewModel.loadStream(currentActiveId)  // re-resolve (token may have expired)
                    }
                } else {
                    isBuffering = false
                    playerError = error.message ?: "Playback error"
                }
            }
        }
        player?.addListener(listener)
        player?.let { tracks = it.currentTracks }
        onDispose { player?.removeListener(listener) }
    }

    DisposableEffect(Unit) {
        val visit = viewModel.enter()
        viewModel.init(channelId)
        // PIP is a touch/phone convenience (shrink to a floating window while
        // multitasking) — meaningless on a TV where there's no home-screen
        // multitasking gesture to trigger it usefully, and it just gets in the way.
        if (!isTV) onSetPipEnabled(true)
        onDispose {
            viewModel.leave(visit)
            onSetPipEnabled(false)
            activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    // Keep the screen awake while video is actually playing so Android's display
    // timeout doesn't sleep the device mid-stream. The flag is cleared on pause and
    // when leaving the player, so normal idle timeout resumes.
    DisposableEffect(activity, isPlaying) {
        val window = activity?.window
        if (isPlaying) window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }

    LaunchedEffect(activeId) { playerError = null }

    // The controls hide after 3 s of playing — but not while the channel list is
    // open: it covers their List button, and nothing else would close it.
    LaunchedEffect(showControls, isPlaying, isLandscape, isTV, state.showChannelList) {
        if (showControls && isPlaying && (isLandscape || isTV) && !state.showChannelList) {
            delay(3_000)
            showControls = false
        }
    }

    // Back: first a number being typed, then the list, then out of the player.
    // (The list is only on screen in landscape and on TV; portrait shows its own.)
    BackHandler(enabled = state.jumpDigits.isNotEmpty() || (state.showChannelList && (isLandscape || isTV))) {
        if (state.jumpDigits.isNotEmpty()) viewModel.cancelDigits() else viewModel.closeChannelList()
    }

    val displayName = state.channels.find { it.uniqueId == activeId }?.name ?: channelName

    // Sleep timer dialog
    if (showSleepTimer) {
        SleepTimerDialog(
            currentEndsAt = state.sleepTimerEndsAt,
            onSet         = { viewModel.setSleepTimer(it) },
            onCancel      = { viewModel.cancelSleepTimer() },
            onDismiss     = { showSleepTimer = false },
        )
    }

    // Stream override sheet
    state.overrideSheetChannel?.let { ch ->
        StreamOverrideSheet(
            channel         = ch,
            currentOverride = viewModel.getStreamOverride(ch.uniqueId),
            defaultUrl      = viewModel.getDefaultStreamUrl(ch.uniqueId),
            onSave          = { url -> viewModel.saveStreamOverride(ch.uniqueId, url) },
            onDismiss       = { viewModel.dismissOverrideSheet() },
        )
    }

    // Above the Picture-in-Picture return, so a trip there keeps it open.
    var statsOpen by remember { mutableStateOf(false) }
    if (isInPipMode) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            ExoPlayerSurface(player = player, modifier = Modifier.fillMaxSize())
        }
        return
    }

    val controls = LiveControls(
        state = state, player = player, displayName = displayName, activeId = activeId,
        castingTo = if (state.isCasting) castDevice ?: "TV" else null,
        isPlaying = isPlaying, isBuffering = isBuffering, playerError = playerError, showControls = showControls,
        nowSecs = nowSecs, audio = trackOptions(tracks, C.TRACK_TYPE_AUDIO), subtitles = trackOptions(tracks, C.TRACK_TYPE_TEXT),
        isTV = isTV, statsOpen = statsOpen, stats = viewModel.stats,
    )
    val actions = LiveActions(
        onBack                 = onBack,
        onToggleControls       = { showControls = !showControls },
        onShowControls         = { showControls = true },
        onTogglePlayPause      = { if (isPlaying) player?.pause() else player?.play() },
        onRetry                = { viewModel.loadStream(activeId) },
        onSleepTimer           = { showSleepTimer = true },
        onToggleChannelList    = { viewModel.toggleChannelList(); showControls = true },
        onCloseChannelList     = viewModel::closeChannelList,
        onSelectChannel        = { viewModel.selectChannel(it.uniqueId, keepList = wide) },
        onLongClickChannel     = { viewModel.showOverrideSheet(it) },
        onToggleFavorite       = { viewModel.toggleFavorite(it) },
        onToggleActiveFavorite = viewModel::toggleActiveFavorite,
        onToggleGuide          = viewModel::toggleGuide,
        onQuery                = viewModel::setQuery,
        onToggleFavoritesOnly  = viewModel::toggleFavoritesOnly,
        onSelectGenre          = viewModel::setGenre,
        onPreviousChannel      = { viewModel.previousChannel() },
        onNextChannel          = { viewModel.nextChannel() },
        onDigit                = viewModel::typeDigit,
        onPickTrack            = { opt ->
            player?.let { p ->
                p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                    .setTrackTypeDisabled(opt.group.type, false)
                    .setOverrideForType(TrackSelectionOverride(opt.group.mediaTrackGroup, opt.index))
                    .build()
            }
        },
        onSubtitlesOff         = {
            player?.let { p ->
                p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
            }
        },
        onExitFullscreen       = { if (!isTV) activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT },
        onToggleStats          = { statsOpen = !statsOpen },
        onGoFullscreen         = { activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE },
    )

    if (isLandscape || isTV) LandscapePlayer(controls, actions, viewModel.castManager)
    else PortraitPlayer(controls, actions, viewModel.castManager)
}

// ── Landscape / fullscreen layout ─────────────────────────────────────────────

/** The digit a remote's number key (top row or keypad) stands for. */
private fun digitOf(keyCode: Int): Char? = when (keyCode) {
    in AndroidKeyEvent.KEYCODE_0..AndroidKeyEvent.KEYCODE_9 -> '0' + (keyCode - AndroidKeyEvent.KEYCODE_0)
    in AndroidKeyEvent.KEYCODE_NUMPAD_0..AndroidKeyEvent.KEYCODE_NUMPAD_9 -> '0' + (keyCode - AndroidKeyEvent.KEYCODE_NUMPAD_0)
    else -> null
}

@OptIn(UnstableApi::class)
@Composable
private fun LandscapePlayer(c: LiveControls, a: LiveActions, castManager: com.stalkerweb.android.cast.CastManager?) {
    val s = c.state
    val playerFocusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        try { playerFocusRequester.requestFocus() } catch (_: Exception) {}
    }
    // Back on the picture when the list closes (TV: focus was in the list).
    LaunchedEffect(s.showChannelList) {
        if (!s.showChannelList) runCatching { playerFocusRequester.requestFocus() }
    }
    val isFav = c.activeId in s.favoriteIds

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(playerFocusRequester)
            .focusable()
            .onKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onKeyEvent false
                a.onShowControls()
                digitOf(event.nativeKeyEvent.keyCode)?.let { if (!s.showChannelList) { a.onDigit(it); return@onKeyEvent true } }
                when (event.key) {
                    Key.DirectionCenter, Key.Enter -> { a.onTogglePlayPause(); true }
                    Key.MediaPlayPause             -> { a.onTogglePlayPause(); true }
                    Key.MediaPlay                  -> { c.player?.play(); true }
                    Key.MediaPause                 -> { c.player?.pause(); true }
                    // D-pad Up/Down walk the list as it reads; CH+ is the next channel, as on any remote.
                    Key.DirectionUp, Key.ChannelDown     -> { if (!s.showChannelList) { a.onPreviousChannel(); true } else false }
                    Key.DirectionDown, Key.ChannelUp     -> { if (!s.showChannelList) { a.onNextChannel(); true } else false }
                    Key.DirectionRight             -> { if (!s.showChannelList) { a.onToggleChannelList(); true } else false }
                    Key.DirectionLeft              -> { if (s.showChannelList) { a.onCloseChannelList(); true } else false }
                    Key.Info, Key.Guide, Key.G     -> { a.onToggleGuide(); true }
                    // The remote's ≡ (focus stays on the picture, so the top bar's button is out of its reach).
                    Key.Menu, Key.S                -> { a.onToggleStats(); true }
                    else                           -> false
                }
            }
            .clickable(
                indication        = null,
                interactionSource = remember { MutableInteractionSource() },
            ) { a.onToggleControls() }
    ) {
        ExoPlayerSurface(player = c.player, modifier = Modifier.fillMaxSize())

        PlaybackOverlay(isBuffering = c.isBuffering, playerError = c.playerError, onRetry = a.onRetry, castingTo = c.castingTo)

        JumpBubble(s.jumpDigits, Modifier.align(Alignment.TopCenter).padding(top = 72.dp))

        if (c.statsOpen && c.castingTo == null && c.stats != null) {
            StreamStatsOverlay(c.stats, "live", c.activeId.ifEmpty { null }, Modifier.align(Alignment.TopStart).statusBarsPadding().padding(start = 12.dp, top = 64.dp, bottom = 12.dp))
        }

        // Top bar
        AnimatedVisibility(
            visible  = c.showControls,
            enter    = fadeIn() + slideInVertically { -it },
            exit     = fadeOut() + slideOutVertically { -it },
            modifier = Modifier.align(Alignment.TopStart),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color.Black.copy(alpha = 0.55f))
                    .statusBarsPadding()
                    .padding(horizontal = 4.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = a.onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White)
                }
                Text(
                    text     = c.displayName,
                    style    = MaterialTheme.typography.titleMedium,
                    color    = Color.White,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                SleepTimerChip(s.sleepTimerEndsAt)
                LiveBadge()
                Spacer(Modifier.width(4.dp))
                StatsButton(c.statsOpen, a.onToggleStats)
                IconButton(onClick = a.onSleepTimer) {
                    Icon(Icons.Default.Bedtime, "Sleep timer", tint = if (s.sleepTimerEndsAt != null) MaterialTheme.colorScheme.primary else Color.White)
                }
                if (!c.isTV && castManager != null) {
                    CastButton(castManager)
                }
                IconButton(onClick = a.onToggleChannelList) {
                    Icon(Icons.AutoMirrored.Filled.List, "Channel list", tint = Color.White)
                }
            }
        }

        // Bottom: the playing channel's guide, then the controls
        AnimatedVisibility(
            visible  = c.showControls,
            enter    = fadeIn() + slideInVertically { it },
            exit     = fadeOut() + slideOutVertically { it },
            modifier = Modifier.align(Alignment.BottomStart),
        ) {
            Column(Modifier.fillMaxWidth()) {
                if (s.showGuide) NowPlayingGuide(s.guide, c.nowSecs, dark = true, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color.Black.copy(alpha = 0.55f))
                        .navigationBarsPadding()
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = a.onTogglePlayPause) {
                        Icon(
                            if (c.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                            "Play/Pause", tint = Color.White,
                        )
                    }
                    Spacer(Modifier.weight(1f))
                    TrackButtons(c.audio, c.subtitles, a)
                    IconButton(onClick = a.onToggleActiveFavorite) {
                        Icon(
                            if (isFav) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                            if (isFav) "Remove from favorites" else "Add to favorites",
                            tint = if (isFav) MaterialTheme.colorScheme.error else Color.White,
                        )
                    }
                    IconButton(onClick = a.onToggleGuide) {
                        Icon(Icons.Default.Info, if (s.showGuide) "Hide programme guide" else "Show programme guide",
                            tint = if (s.showGuide) MaterialTheme.colorScheme.primary else Color.White)
                    }
                    if (!c.isTV) {
                        IconButton(onClick = a.onExitFullscreen) {
                            Icon(Icons.Default.FullscreenExit, "Exit fullscreen", tint = Color.White)
                        }
                    }
                }
            }
        }

        // With the list open, a tap on the picture closes it (as on the web).
        if (s.showChannelList) {
            Box(
                Modifier.fillMaxSize().clickable(
                    indication        = null,
                    interactionSource = remember { MutableInteractionSource() },
                ) { a.onCloseChannelList() },
            )
        }

        // Channel list panel slides from right
        AnimatedVisibility(
            visible  = s.showChannelList,
            enter    = slideInHorizontally { it },
            exit     = slideOutHorizontally { it },
            modifier = Modifier.align(Alignment.CenterEnd),
        ) {
            ChannelListPanel(c, a, dark = true, onClose = a.onCloseChannelList)
        }
    }
}

// ── Portrait / YouTube-style layout ──────────────────────────────────────────

@OptIn(UnstableApi::class)
@Composable
private fun PortraitPlayer(c: LiveControls, a: LiveActions, castManager: com.stalkerweb.android.cast.CastManager?) {
    val s = c.state
    val isFav = c.activeId in s.favoriteIds
    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .background(MaterialTheme.colorScheme.background)
    ) {
        // 16:9 video box
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .background(Color.Black)
                .clickable(
                    indication        = null,
                    interactionSource = remember { MutableInteractionSource() },
                ) { a.onToggleControls() }
        ) {
            ExoPlayerSurface(player = c.player, modifier = Modifier.fillMaxSize())

            PlaybackOverlay(isBuffering = c.isBuffering, playerError = c.playerError, onRetry = a.onRetry, castingTo = c.castingTo)

            // Clear of the back button, and as tall as the small portrait picture allows (it scrolls).
            if (c.statsOpen && c.castingTo == null && c.stats != null) {
                StreamStatsOverlay(c.stats, "live", c.activeId.ifEmpty { null }, Modifier.align(Alignment.TopStart).padding(start = 56.dp, top = 8.dp, bottom = 8.dp))
            }

            if (c.showControls) {
                Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f))) {
                    IconButton(
                        onClick  = a.onBack,
                        modifier = Modifier.align(Alignment.TopStart).padding(4.dp),
                    ) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White)
                    }
                    Row(
                        modifier = Modifier.align(Alignment.TopEnd).padding(4.dp),
                        horizontalArrangement = Arrangement.spacedBy(0.dp),
                    ) {
                        TrackButtons(c.audio, c.subtitles, a)
                        StatsButton(c.statsOpen, a.onToggleStats)
                        IconButton(onClick = a.onSleepTimer) {
                            Icon(
                                Icons.Default.Bedtime, "Sleep timer",
                                tint = if (s.sleepTimerEndsAt != null) MaterialTheme.colorScheme.primary else Color.White,
                            )
                        }
                        if (castManager != null) CastButton(castManager)
                        IconButton(onClick = a.onGoFullscreen) {
                            Icon(Icons.Default.Fullscreen, "Fullscreen", tint = Color.White)
                        }
                    }
                    IconButton(
                        onClick  = a.onTogglePlayPause,
                        modifier = Modifier.align(Alignment.Center).size(52.dp),
                    ) {
                        Icon(
                            if (c.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                            "Play/Pause", tint = Color.White, modifier = Modifier.size(40.dp),
                        )
                    }
                }
            }
        }

        // Info strip: the channel, its heart and the guide toggle
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surface)
                .padding(start = 12.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text     = c.displayName,
                style    = MaterialTheme.typography.titleSmall,
                color    = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            SleepTimerChip(s.sleepTimerEndsAt)
            Spacer(Modifier.width(4.dp))
            LiveBadge()
            IconButton(onClick = a.onToggleActiveFavorite) {
                Icon(
                    if (isFav) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                    if (isFav) "Remove from favorites" else "Add to favorites",
                    tint = if (isFav) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                )
            }
            IconButton(onClick = a.onToggleGuide) {
                Icon(Icons.Default.Info, if (s.showGuide) "Hide programme guide" else "Show programme guide",
                    tint = if (s.showGuide) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            }
        }
        if (s.showGuide) NowPlayingGuide(s.guide, c.nowSecs, dark = false, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))

        HorizontalDivider()

        // Genre filter chips
        val genres = remember(s.channels) { s.genres }
        if (genres.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                FilterChip(
                    selected = s.selectedGenre == null,
                    onClick  = { a.onSelectGenre(null) },
                    label    = { Text("All", style = MaterialTheme.typography.labelSmall) },
                )
                genres.forEach { genre ->
                    FilterChip(
                        selected = s.selectedGenre == genre,
                        onClick  = { a.onSelectGenre(genre) },
                        label    = { Text(genre, style = MaterialTheme.typography.labelSmall) },
                    )
                }
            }
            HorizontalDivider()
        }

        ChannelListPanel(c, a, dark = false, onClose = null)
    }
}

// ── The playing channel's guide (the web's NowPlayingGuide) ──────────────────

@Composable
private fun NowPlayingGuide(events: List<EpgEvent>?, nowSecs: Long, dark: Boolean, modifier: Modifier = Modifier) {
    if (events == null) return
    val context = LocalContext.current
    val clock = remember { DateFormat.getTimeFormat(context) }
    fun at(secs: Long) = clock.format(Date(secs * 1000))
    val np = nowPlaying(events, nowSecs)
    val text = if (dark) Color.White else MaterialTheme.colorScheme.onSurface
    val muted = if (dark) Color.White.copy(alpha = 0.6f) else MaterialTheme.colorScheme.onSurfaceVariant
    Surface(
        color = if (dark) Color.Black.copy(alpha = 0.6f) else MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(10.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        if (np.now == null && np.later.isEmpty()) {
            Text("No guide information for this channel.", color = muted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(10.dp))
            return@Surface
        }
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            np.now?.let { cur ->
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("NOW", color = MaterialTheme.colorScheme.error, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.width(8.dp))
                        Text("${at(cur.startTime)} – ${at(cur.endTime)}", color = muted, style = MaterialTheme.typography.labelSmall)
                    }
                    Text(cur.title.ifBlank { "Untitled" }, color = text, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (cur.description.isNotBlank()) {
                        Text(cur.description, color = muted, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    LinearProgressIndicator(
                        progress = { progressOf(cur, nowSecs) },
                        modifier = Modifier.fillMaxWidth().padding(top = 6.dp).height(3.dp),
                    )
                }
            }
            if (np.later.isNotEmpty()) {
                Column(Modifier.widthIn(max = 240.dp).then(if (np.now == null) Modifier.weight(1f) else Modifier), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    np.later.forEachIndexed { i, e ->
                        Column {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(if (i == 0) "NEXT" else "LATER", color = muted, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                                Spacer(Modifier.width(8.dp))
                                Text(at(e.startTime), color = muted, style = MaterialTheme.typography.labelSmall)
                            }
                            Text(e.title.ifBlank { "Untitled" }, color = text, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
}

// ── Audio and subtitle tracks ────────────────────────────────────────────────

@Composable
private fun TrackButtons(audio: List<TrackOption>, subtitles: List<TrackOption>, a: LiveActions) {
    // Audio only when there's a choice; subtitles whenever the stream has any.
    if (audio.size > 1) {
        var open by remember { mutableStateOf(false) }
        Box {
            IconButton(onClick = { open = true }) { Icon(Icons.Default.Audiotrack, "Audio track", tint = Color.White) }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                audio.forEach { t ->
                    DropdownMenuItem(
                        text = { Text(t.label) },
                        leadingIcon = { if (t.selected) Icon(Icons.Default.Check, null) },
                        onClick = { open = false; a.onPickTrack(t) },
                    )
                }
            }
        }
    }
    if (subtitles.isNotEmpty()) {
        var open by remember { mutableStateOf(false) }
        val anyOn = subtitles.any { it.selected }
        Box {
            IconButton(onClick = { open = true }) {
                Icon(Icons.Default.Subtitles, "Subtitles", tint = if (anyOn) MaterialTheme.colorScheme.primary else Color.White)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                DropdownMenuItem(
                    text = { Text("Off") },
                    leadingIcon = { if (!anyOn) Icon(Icons.Default.Check, null) },
                    onClick = { open = false; a.onSubtitlesOff() },
                )
                subtitles.forEach { t ->
                    DropdownMenuItem(
                        text = { Text(t.label) },
                        leadingIcon = { if (t.selected) Icon(Icons.Default.Check, null) },
                        onClick = { open = false; a.onPickTrack(t) },
                    )
                }
            }
        }
    }
}

// ── Shared small composables ──────────────────────────────────────────────────

/** The channel number being typed on the remote. */
@Composable
private fun JumpBubble(digits: String, modifier: Modifier) {
    if (digits.isEmpty()) return
    Surface(color = Color.Black.copy(alpha = 0.75f), shape = RoundedCornerShape(12.dp), modifier = modifier) {
        Text(digits, color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun ExoPlayerSurface(player: Player?, modifier: Modifier) {
    AndroidView(
        factory = { ctx ->
            PlayerView(ctx).apply {
                this.player = player
                useController = false
                resizeMode    = AspectRatioFrameLayout.RESIZE_MODE_FIT
            }
        },
        update  = { view -> view.player = player },
        modifier = modifier,
    )
}

@Composable
private fun SleepTimerChip(endsAt: Long?) {
    if (endsAt == null) return
    var remaining by remember { mutableLongStateOf(0L) }
    LaunchedEffect(endsAt) {
        while (true) {
            remaining = ((endsAt - System.currentTimeMillis()) / 1000L).coerceAtLeast(0)
            if (remaining == 0L) break
            delay(1_000)
        }
    }
    val mins = TimeUnit.SECONDS.toMinutes(remaining)
    val secs = remaining % 60
    Surface(
        color  = MaterialTheme.colorScheme.primary.copy(alpha = 0.15f),
        shape  = MaterialTheme.shapes.extraSmall,
    ) {
        Text(
            "%d:%02d".format(mins, secs),
            style    = MaterialTheme.typography.labelSmall,
            color    = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

@Composable
private fun PlaybackOverlay(isBuffering: Boolean, playerError: String?, onRetry: () -> Unit, castingTo: String? = null) {
    if (castingTo != null) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Default.CastConnected, null, tint = Color.White, modifier = Modifier.size(40.dp))
                Text("Playing on $castingTo", color = Color.White, style = MaterialTheme.typography.bodyMedium)
            }
        }
        return
    }
    if (isBuffering && playerError == null) {
        Box(Modifier.fillMaxSize()) {
            CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
        }
    }
    if (playerError != null) {
        Box(Modifier.fillMaxSize()) {
            Column(
                modifier            = Modifier.align(Alignment.Center),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(Icons.Default.ErrorOutline, null, tint = Color.Red, modifier = Modifier.size(36.dp))
                Text(playerError, color = Color.White, style = MaterialTheme.typography.bodySmall)
                Button(onClick = onRetry) { Text("Retry") }
            }
        }
    }
}

@Composable
private fun LiveBadge() {
    Surface(color = MaterialTheme.colorScheme.error, shape = MaterialTheme.shapes.extraSmall) {
        Text(
            "LIVE",
            style    = MaterialTheme.typography.labelSmall,
            color    = Color.White,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

// ── The channel list (the web's ChannelList): search, Favorites, genre, now/next ──

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ChannelListPanel(c: LiveControls, a: LiveActions, dark: Boolean, onClose: (() -> Unit)?) {
    val s        = c.state
    // Worked out when its inputs change, not on every 15 s tick (thousands of channels).
    val channels = remember(s.channels, s.query, s.favoritesOnly, s.selectedGenre, s.favoriteIds) { s.displayedChannels }
    val genres   = remember(s.channels) { s.genres }
    val activeIdx = channels.indexOfFirst { it.uniqueId == c.activeId }
    val bg       = if (dark) Color.Black.copy(alpha = 0.9f) else Color.Transparent
    val textCol  = if (dark) Color.White.copy(alpha = 0.85f) else MaterialTheme.colorScheme.onSurface
    val mutedCol = if (dark) Color.White.copy(alpha = 0.45f) else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
    val divCol   = if (dark) Color.White.copy(alpha = 0.06f) else MaterialTheme.colorScheme.outlineVariant

    // Opens on the playing channel; on TV the highlight starts there too.
    val listState = rememberLazyListState()
    // The playing channel, or the first row when a filter leaves it out.
    val activeFocus = remember { FocusRequester() }
    LaunchedEffect(channels.isNotEmpty()) {
        if (channels.isEmpty()) return@LaunchedEffect
        listState.scrollToItem((activeIdx - 3).coerceAtLeast(0))
        if (c.isTV && dark) runCatching { delay(50); activeFocus.requestFocus() }
    }

    Surface(
        modifier = if (dark) Modifier.fillMaxHeight().width(320.dp) else Modifier.fillMaxSize(),
        color    = bg,
    ) {
        Column(if (dark) Modifier.statusBarsPadding().navigationBarsPadding() else Modifier) {
            // Search, Favorites only, and (beside the picture) close
            Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 2.dp, top = 6.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier.weight(1f).background(if (dark) Color.White.copy(alpha = 0.08f) else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                        .padding(horizontal = 8.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Default.Search, null, tint = mutedCol, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Box(Modifier.weight(1f)) {
                        if (s.query.isEmpty()) Text("Search channels", color = mutedCol, style = MaterialTheme.typography.bodySmall)
                        BasicTextField(
                            value = s.query,
                            onValueChange = a.onQuery,
                            singleLine = true,
                            textStyle = MaterialTheme.typography.bodySmall.copy(color = textCol),
                            cursorBrush = SolidColor(textCol),
                            // On TV, moving onto the field mustn't pop the keyboard up; OK opens it.
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search, showKeyboardOnFocus = !c.isTV),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    if (s.query.isNotEmpty()) {
                        Icon(Icons.Default.Close, "Clear search", tint = mutedCol, modifier = Modifier.size(16.dp).clickable { a.onQuery("") })
                    }
                }
                IconButton(onClick = a.onToggleFavoritesOnly) {
                    Icon(
                        if (s.favoritesOnly) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                        if (s.favoritesOnly) "Show all channels" else "Show favorites only",
                        tint = if (s.favoritesOnly) MaterialTheme.colorScheme.error else mutedCol,
                    )
                }
                if (onClose != null) {
                    IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close channel list", tint = textCol) }
                }
            }
            // Beside the picture, the genre is a picker (on a phone's portrait list it's the chips above).
            if (dark && genres.isNotEmpty()) {
                var open by remember { mutableStateOf(false) }
                Box(Modifier.padding(horizontal = 10.dp, vertical = 2.dp)) {
                    Row(
                        Modifier.fillMaxWidth().background(Color.White.copy(alpha = 0.08f), RoundedCornerShape(8.dp)).clickable { open = true }
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(s.selectedGenre ?: "All genres", color = textCol, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f),
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Icon(Icons.Default.ArrowDropDown, null, tint = mutedCol)
                    }
                    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                        DropdownMenuItem(text = { Text("All genres") }, onClick = { open = false; a.onSelectGenre(null) })
                        genres.forEach { g -> DropdownMenuItem(text = { Text(g) }, onClick = { open = false; a.onSelectGenre(g) }) }
                    }
                }
            }

            if (channels.isEmpty()) {
                Text(if (s.favoritesOnly) "No favorites here." else "No channels match.", color = mutedCol,
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp))
            }
            LazyColumn(state = listState) {
                itemsIndexed(channels, key = { _, ch -> ch.uniqueId }) { index, ch ->
                    val isActive = ch.uniqueId == c.activeId
                    val isFav    = ch.uniqueId in s.favoriteIds
                    var focused  by remember { mutableStateOf(false) }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .then(if (isActive || (activeIdx < 0 && index == 0)) Modifier.focusRequester(activeFocus) else Modifier)
                            .onFocusChanged { focused = it.isFocused }
                            .border(
                                width = if (focused) 2.dp else 0.dp,
                                color = if (focused) MaterialTheme.colorScheme.primary else Color.Transparent,
                                shape = RoundedCornerShape(4.dp),
                            )
                            .background(
                                if (isActive) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
                                else if (focused) MaterialTheme.colorScheme.primary.copy(alpha = 0.10f)
                                else Color.Transparent
                            )
                            .combinedClickable(
                                onClick     = { a.onSelectChannel(ch) },
                                onLongClick = { a.onLongClickChannel(ch) },
                            )
                            .padding(horizontal = 10.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // Number bubble
                        Text(
                            if (ch.number > 0) ch.number.toString() else "",
                            color = mutedCol, style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.width(34.dp), maxLines = 1,
                        )
                        val logoUrl = s.logoMap[ch.uniqueId]
                        if (!logoUrl.isNullOrBlank()) {
                            AsyncImage(
                                model              = logoUrl,
                                contentDescription = ch.name,
                                contentScale       = ContentScale.Fit,
                                modifier           = Modifier.size(28.dp),
                            )
                        } else {
                            Icon(Icons.Default.Tv, null, Modifier.size(28.dp), tint = mutedCol)
                        }
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                text     = ch.name,
                                color    = if (isActive) MaterialTheme.colorScheme.primary else textCol,
                                style    = MaterialTheme.typography.bodySmall,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            NowLine(s.nowNext[ch.uniqueId], c.nowSecs, mutedCol)
                        }
                        IconButton(onClick = { a.onToggleFavorite(ch) }, modifier = Modifier.size(32.dp)) {
                            Icon(
                                imageVector        = if (isFav) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                                contentDescription = if (isFav) "Remove ${ch.name} from favorites" else "Add ${ch.name} to favorites",
                                tint               = if (isFav) MaterialTheme.colorScheme.error else mutedCol,
                                modifier           = Modifier.size(16.dp),
                            )
                        }
                    }
                    HorizontalDivider(thickness = 0.5.dp, color = divCol)
                }
            }
        }
    }
}

/** What's on a row's channel now, with how far through it is. */
@Composable
private fun NowLine(entry: NowNextEntry?, nowSecs: Long, muted: Color) {
    val now = entry?.now ?: return
    if (now.title.isBlank()) return
    Text(now.title, color = muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
    if (now.endTime > now.startTime) {
        val p = progressAt(now.startTime, now.endTime, nowSecs)
        LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth().padding(top = 3.dp).height(2.dp))
    }
}
