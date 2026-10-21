package com.stalkerweb.android.ui.player

import android.app.Application
import android.content.ComponentName
import android.widget.Toast
import androidx.annotation.OptIn
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.stalkerweb.android.cast.CastManager
import com.stalkerweb.android.cast.castMediaOf
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.EpgEvent
import com.stalkerweb.android.data.api.NowNextEntry
import com.stalkerweb.android.data.repo.StallAction
import com.stalkerweb.android.data.repo.StallState
import com.stalkerweb.android.data.repo.isLiveMediaId
import com.stalkerweb.android.data.repo.jumpTarget
import com.stalkerweb.android.data.repo.liveMediaId
import com.stalkerweb.android.data.repo.playerList
import com.stalkerweb.android.data.repo.stallTick
import com.stalkerweb.android.data.repo.LiveRepository
import com.stalkerweb.android.service.PlaybackService
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class PlayerUiState(
    val channels: List<Channel>        = emptyList(),
    val logoMap: Map<String, String>   = emptyMap(),
    val favoriteIds: Set<String>       = emptySet(),
    val activeChannelId: String        = "",
    val showChannelList: Boolean       = false,
    val selectedGenre: String?         = null,
    val sleepTimerEndsAt: Long?        = null,
    val overrideSheetChannel: Channel? = null,
    val isCasting: Boolean             = false,
    // The list's search and Favorites toggle (the web's channel list).
    val query: String                  = "",
    val favoritesOnly: Boolean         = false,
    // The playing channel's guide (null while loading), and now/next for the list rows.
    val showGuide: Boolean             = true,
    val guide: List<EpgEvent>?         = null,
    val nowNext: Map<String, NowNextEntry> = emptyMap(),
    /** A channel number being typed on the remote. */
    val jumpDigits: String             = "",
) {
    val genres: List<String>
        get() = channels.mapNotNull { it.genre }.filter { it.isNotBlank() }.distinct().sorted()

    val displayedChannels: List<Channel>
        get() = playerList(channels, query, favoritesOnly, selectedGenre, favoriteIds)
}

@OptIn(UnstableApi::class)
class PlayerViewModel(
    application: Application,
    private val live: LiveRepository,
) : AndroidViewModel(application) {

    private val _state = MutableStateFlow(PlayerUiState())
    val state: StateFlow<PlayerUiState> = _state.asStateFlow()

    private val _player = MutableStateFlow<Player?>(null)
    val player: StateFlow<Player?> = _player.asStateFlow()

    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var sleepTimerJob: Job? = null

    // ── Auto-reconnect ───────────────────────────────────────────────────────
    // Live stream tokens expire mid-playback: the CDN starts answering 403 and
    // the backend proxy reports that as 410. ExoPlayer gives up after its own
    // short retries and raises onPlayerError — without this, playback just
    // stopped. Reloading the channel goes back through /api/stream, which calls
    // create_link for a fresh token. Mirrors the web player's recoverStream():
    // exponential backoff, capped, reset once media plays again.
    private var reconnectAttempts = 0
    private var reconnectJob: Job? = null
    private var watchdogJob: Job? = null
    private var guideJob: Job? = null
    private var nowNextJob: Job? = null
    private var jumpJob: Job? = null

    private val playerListener = object : Player.Listener {
        override fun onPlayerError(error: PlaybackException) {
            if (!playingLive()) return   // a movie or episode on the shared player: not ours to reconnect
            android.util.Log.w("PlayerViewModel", "playback error (${error.errorCodeName}) — reconnecting", error)
            scheduleReconnect()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) reconnectAttempts = 0
        }

        // A live pipe closing shows up as the end of the stream: a drop, not the end (as on the web).
        override fun onPlaybackStateChanged(playbackState: Int) {
            if (playbackState == Player.STATE_ENDED && playingLive()) scheduleReconnect()
        }
    }

    /** The shared player is on one of this player's live channels (not VOD). */
    private fun playingLive(): Boolean = isLiveMediaId(_player.value?.currentMediaItem?.mediaId)

    private fun scheduleReconnect() {
        if (reconnectJob?.isActive == true) return
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            android.util.Log.e("PlayerViewModel", "giving up after $reconnectAttempts reconnect attempts")
            return
        }
        reconnectAttempts++
        val backoffMs = minOf(1_500L shl (reconnectAttempts - 1), 15_000L)
        reconnectJob = viewModelScope.launch {
            delay(backoffMs)
            loadStream(_state.value.activeChannelId)
        }
    }

    private fun resetReconnect() {
        reconnectJob?.cancel()
        reconnectJob = null
        reconnectAttempts = 0
    }

    val castManager: CastManager? = runCatching { CastManager.get(application) }.getOrNull()?.takeIf { it.available }

    init {
        // While casting, the TV plays the channel and the phone doesn't (two
        // pulls of one channel can end each other's portal link); once it
        // ends, the phone plays it again.
        castManager?.let { cm ->
            viewModelScope.launch {
                var was = cm.isCasting.value
                cm.isCasting.collect { casting ->
                    _state.value = _state.value.copy(isCasting = casting)
                    if (casting && !was) _player.value?.takeIf { playingLive() }?.let { it.stop(); it.clearMediaItems() }
                    if (!casting && was) {
                        castOnTv?.let { id -> viewModelScope.launch { live.stopCast(id) } }
                        castOnTv = null
                        if (onScreen) _state.value.activeChannelId.takeIf { it.isNotEmpty() }?.let(::loadStream)
                    }
                    was = casting
                }
            }
        }
    }

    private var castSourceNo = 0
    // The channel the TV plays, so the server can let go of it when the TV
    // moves on: its FFmpeg holds the channel's one portal connection.
    private var castOnTv: String? = null

    /** What the Cast button sends for [channelId]: the channel as HLS, from the server. */
    private fun castChannel(channelId: String) {
        val cm = castManager ?: return
        val name = _state.value.channels.find { it.uniqueId == channelId }?.name
        castSourceNo = cm.setSource {
            val media = castMediaOf(live.castLink(channelId), name)
            castOnTv?.takeIf { it != channelId }?.let { old -> viewModelScope.launch { live.stopCast(old) } }
            castOnTv = channelId
            media
        }
    }

    fun init(channelId: String) {
        // Seed from the on-disk cache so channel navigation/metadata work instantly
        // while the network refresh runs below.
        val cached = live.getCachedChannels()
        _state.value = _state.value.copy(
            activeChannelId = channelId,
            channels        = if (cached.isNotEmpty()) cached else _state.value.channels,
            logoMap         = live.getCachedLogoMap().ifEmpty { _state.value.logoMap },
        )
        startWatchdog()
        loadGuide(channelId)

        // Reuse an existing connected MediaController; if the previous one disconnected
        // (PlaybackService was stopped while the app was in the background) fall through
        // and reconnect so player operations don't throw on a stale reference.
        val existingController = _player.value as? MediaController
        if (existingController != null) {
            if (existingController.isConnected) {
                loadStream(channelId)
                return
            }
            // Stale disconnected controller — clear it so we reconnect below.
            _player.value = null
        }

        // Connect to PlaybackService — starts it if not already running
        val token = SessionToken(getApplication(), ComponentName(getApplication(), PlaybackService::class.java))
        val future = MediaController.Builder(getApplication(), token).buildAsync()
        controllerFuture = future
        future.addListener({
            // future.get() runs on the main thread (directExecutor); if the
            // PlaybackService connection fails it throws, which would otherwise
            // crash the app on every channel open. Guard it.
            val controller = runCatching { future.get() }
                .onFailure { android.util.Log.e("PlayerViewModel", "MediaController connect failed", it) }
                .getOrNull()
            if (controller != null) {
                controller.addListener(playerListener)
                _player.value = controller
                loadStream(channelId)
            }
        }, MoreExecutors.directExecutor())

        viewModelScope.launch {
            runCatching {
                // coroutineScope keeps an `async` failure (e.g. a 503 when no
                // portal is connected) inside runCatching's reach — without it the
                // failure propagates to the parent job and crashes the app.
                coroutineScope {
                    val channels = async { live.getChannels() }
                    val logos    = async { live.getLogoMap() }
                    val favs     = async { live.getFavoriteIds() }
                    Triple(channels.await(), logos.await(), favs.await())
                }
            }.onSuccess { (channels, logos, favs) ->
                _state.value = _state.value.copy(
                    channels      = channels,
                    logoMap       = logos,
                    favoriteIds   = favs,
                )
            }
        }
    }

    fun loadStream(channelId: String) {
        if (!onScreen) return
        castChannel(channelId)
        if (castManager?.isCasting?.value == true) return   // on the TV, not here
        val p = _player.value ?: return
        // Only the newest load plays, and only while the screen is open: a slow
        // resolve finishing after Back (or after another zap) mustn't start it.
        val load = ++loadNo
        val channel = _state.value.channels.find { it.uniqueId == channelId }
        // Resolve via the backend so we know the engine type (hls/mpegts/native)
        // and feed ExoPlayer the correct MIME — assuming HLS for everything breaks
        // the raw-MPEG-TS channels the backend now serves.
        viewModelScope.launch {
            runCatching {
                val info = live.resolveStream(channelId)
                if (load != loadNo || !onScreen) return@launch
                val mime = when (info.type) {
                    "hls"    -> MimeTypes.APPLICATION_M3U8
                    "mpegts" -> MimeTypes.VIDEO_MP2T
                    else     -> null   // native / unknown → let ExoPlayer infer from the container
                }
                val builder = MediaItem.Builder()
                    .setUri(info.url)
                    .setMediaId(liveMediaId(channelId))
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(channel?.name).build())
                if (mime != null) builder.setMimeType(mime)
                p.setMediaItem(builder.build())
                p.prepare()
                p.playWhenReady = true
                if (channel != null) {
                    live.pushWatched(channel, _state.value.logoMap[channelId])
                }
            }.onFailure { e ->
                android.util.Log.e("PlayerViewModel", "loadStream failed: ${e.message}")
                // If the controller we used became disconnected, clear it so the next
                // init() call (e.g. from back-stack restore) will reconnect cleanly.
                // Only then: a plain network/portal failure leaves the controller
                // usable, and clearing it would make every later loadStream() —
                // including the reconnect below — return without doing anything.
                if (_player.value == p && (p as? MediaController)?.isConnected == false) _player.value = null
                // A reconnect whose re-resolve failed (portal briefly down or
                // rate-limiting) raises no player error, so keep backing off here.
                if (reconnectAttempts > 0) scheduleReconnect()
            }
        }
    }

    /** @param keepList leave the channel list open (TV and tablets, where it sits beside the picture). */
    fun selectChannel(channelId: String, keepList: Boolean = false) {
        _state.value = _state.value.copy(
            activeChannelId = channelId,
            showChannelList = keepList && _state.value.showChannelList,
        )
        resetReconnect()   // a deliberate zap starts a fresh backoff sequence
        loadStream(channelId)
        loadGuide(channelId)
    }

    /** The player screen closed: stop watching over the shared player (VOD may use it next). */
    // Each visit to the player screen is numbered: opening a channel from a
    // reminder starts the new screen before the old one is gone, and the old
    // one's leave() mustn't stop the new one.
    private var visit = 0
    // Whether a player screen is open, and the number of the latest loadStream().
    private var onScreen = false
    private var loadNo = 0

    /** The player screen opened: its number, for [leave]. */
    fun enter(): Int { onScreen = true; return ++visit }

    /**
     * The player screen [closed] went away. Unless another opened since: stop
     * watching over the shared player, and stop the live stream itself — this
     * view model lives as long as the app, so nothing else would, and it kept
     * playing behind the next screen. (A movie or episode playing now is the
     * VOD player's; casting carries on on the TV.)
     */
    fun leave(closed: Int) {
        if (closed != visit) return
        onScreen = false
        loadNo++   // a load still resolving finds it was dropped
        watchdogJob?.cancel()
        guideJob?.cancel()
        nowNextJob?.cancel()
        cancelDigits()
        resetReconnect()
        castManager?.clearSource(castSourceNo)   // what's on the TV carries on
        _player.value?.takeIf { playingLive() }?.let { p ->
            p.stop()
            p.clearMediaItems()
        }
    }

    fun closeChannelList() { _state.value = _state.value.copy(showChannelList = false) }
    fun setQuery(q: String) { _state.value = _state.value.copy(query = q) }
    fun toggleFavoritesOnly() { _state.value = _state.value.copy(favoritesOnly = !_state.value.favoritesOnly) }
    fun toggleGuide() { _state.value = _state.value.copy(showGuide = !_state.value.showGuide) }

    /** The playing channel in or out of favorites (the heart in the controls). */
    fun toggleActiveFavorite() {
        val s = _state.value
        s.channels.find { it.uniqueId == s.activeChannelId }?.let(::toggleFavorite)
    }

    // ── The playing channel's guide: loaded on a channel change and every 10 minutes ──
    private fun loadGuide(channelId: String) {
        guideJob?.cancel()
        _state.value = _state.value.copy(guide = null)
        guideJob = viewModelScope.launch {
            while (isActive) {
                val events = runCatching { live.channelGuide(channelId) }.getOrDefault(emptyList())
                if (_state.value.activeChannelId == channelId) _state.value = _state.value.copy(guide = events)
                delay(10 * 60_000L)
            }
        }
        // The list rows' "now" for every channel: on its own clock, not on each
        // zap (holding Down through 30 channels fetched the whole map 30 times).
        if (nowNextJob?.isActive != true) {
            nowNextJob = viewModelScope.launch {
                while (isActive) {
                    val nowNext = runCatching { live.getNowNext() }.getOrDefault(emptyMap())
                    if (nowNext.isNotEmpty()) _state.value = _state.value.copy(nowNext = nowNext)
                    delay(10 * 60_000L)
                }
            }
        }
    }

    // ── A channel number typed on the remote: tuned 1.2 s after the last digit ──
    fun typeDigit(d: Char) {
        val digits = (_state.value.jumpDigits + d).takeLast(4)
        _state.value = _state.value.copy(jumpDigits = digits)
        jumpJob?.cancel()
        jumpJob = viewModelScope.launch {
            delay(1_200)
            jumpTarget(_state.value.channels, digits)?.let { selectChannel(it.uniqueId) }
            _state.value = _state.value.copy(jumpDigits = "")
        }
    }

    fun cancelDigits() {
        jumpJob?.cancel()
        _state.value = _state.value.copy(jumpDigits = "")
    }

    // ── Stall watchdog and keepalive ──────────────────────────────────────────
    // A frozen live picture often raises no error at all: nudge it once, then
    // reconnect (the web's stall watchdog). And ping the server every 10
    // minutes while playing, as the web does.
    private fun startWatchdog() {
        if (watchdogJob?.isActive == true) return
        watchdogJob = viewModelScope.launch {
            var stall = StallState(0, System.currentTimeMillis(), nudged = false)
            var lastKeepalive = System.currentTimeMillis()
            while (isActive) {
                delay(2_000)
                val p = _player.value
                val now = System.currentTimeMillis()
                val idle = p == null || _state.value.isCasting || !p.playWhenReady || !isLiveMediaId(p.currentMediaItem?.mediaId) ||
                    p.playbackState == Player.STATE_IDLE || reconnectJob?.isActive == true
                val (next, action) = stallTick(stall, now, p?.currentPosition ?: 0, p?.bufferedPosition ?: 0, idle)
                stall = next
                when (action) {
                    is StallAction.Nudge -> p?.seekTo(action.toMs)
                    StallAction.Reconnect -> {
                        android.util.Log.w("PlayerViewModel", "picture frozen — reconnecting")
                        stall = StallState(0, now, nudged = false)
                        scheduleReconnect()
                    }
                    null -> {}
                }
                if (p?.isPlaying == true && now - lastKeepalive >= 10 * 60_000L) {
                    lastKeepalive = now
                    launch { live.keepalive() }
                }
            }
        }
    }

    fun toggleChannelList() {
        _state.value = _state.value.copy(showChannelList = !_state.value.showChannelList)
    }

    fun setGenre(genre: String?) {
        _state.value = _state.value.copy(selectedGenre = genre)
    }

    fun toggleFavorite(channel: Channel) {
        val id    = channel.uniqueId
        val isFav = id in _state.value.favoriteIds
        _state.value = _state.value.copy(
            favoriteIds = if (isFav) _state.value.favoriteIds - id
                          else _state.value.favoriteIds + id,
        )
        viewModelScope.launch {
            runCatching {
                if (isFav) live.removeFavorite(id) else live.addFavorite(id)
            }.onSuccess {
                Toast.makeText(getApplication(), if (isFav) "Removed ${channel.name} from favorites" else "Added ${channel.name} to favorites", Toast.LENGTH_SHORT).show()
            }.onFailure {
                _state.value = _state.value.copy(
                    favoriteIds = if (isFav) _state.value.favoriteIds + id
                                  else _state.value.favoriteIds - id,
                )
            }
        }
    }

    // Cycle over the full channel list, not `displayedChannels` — that's
    // pre-filtered to a single genre for the portrait genre-tab UI, so the
    // active channel is often just not in it, silently no-opping up/down.
    fun previousChannel(): Boolean {
        val channels = _state.value.channels
        val idx = channels.indexOfFirst { it.uniqueId == _state.value.activeChannelId }
        if (idx > 0) { selectChannel(channels[idx - 1].uniqueId); return true }
        return false
    }

    fun nextChannel(): Boolean {
        val channels = _state.value.channels
        val idx = channels.indexOfFirst { it.uniqueId == _state.value.activeChannelId }
        if (idx >= 0 && idx < channels.size - 1) { selectChannel(channels[idx + 1].uniqueId); return true }
        return false
    }

    // ── Sleep timer ───────────────────────────────────────────────────────────

    fun setSleepTimer(minutes: Int) {
        sleepTimerJob?.cancel()
        val endsAt = System.currentTimeMillis() + minutes * 60_000L
        _state.value = _state.value.copy(sleepTimerEndsAt = endsAt)
        sleepTimerJob = viewModelScope.launch {
            delay(minutes * 60_000L)
            _player.value?.pause()
            _state.value = _state.value.copy(sleepTimerEndsAt = null)
        }
    }

    fun cancelSleepTimer() {
        sleepTimerJob?.cancel()
        sleepTimerJob = null
        _state.value = _state.value.copy(sleepTimerEndsAt = null)
    }

    // ── Stream URL override sheet ─────────────────────────────────────────────

    fun showOverrideSheet(channel: Channel) {
        _state.value = _state.value.copy(overrideSheetChannel = channel)
    }

    fun dismissOverrideSheet() {
        _state.value = _state.value.copy(overrideSheetChannel = null)
    }

    fun saveStreamOverride(channelId: String, url: String?) {
        live.setStreamOverride(channelId, url)
        _state.value = _state.value.copy(overrideSheetChannel = null)
        // Reload stream with new URL if it's the active channel
        if (channelId == _state.value.activeChannelId) loadStream(channelId)
    }

    fun getStreamOverride(channelId: String): String? = live.getStreamOverride(channelId)

    fun getDefaultStreamUrl(channelId: String): String = live.defaultStreamUrl(channelId)

    private companion object {
        const val MAX_RECONNECT_ATTEMPTS = 8
    }

    override fun onCleared() {
        sleepTimerJob?.cancel()
        reconnectJob?.cancel()
        watchdogJob?.cancel()
        guideJob?.cancel()
        jumpJob?.cancel()
        (_player.value as? MediaController)?.removeListener(playerListener)
        castManager?.clearSource(castSourceNo)
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.onCleared()
    }
}
