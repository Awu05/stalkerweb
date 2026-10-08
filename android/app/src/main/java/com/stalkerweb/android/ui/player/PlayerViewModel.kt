package com.stalkerweb.android.ui.player

import android.app.Application
import android.content.ComponentName
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
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.repository.ChannelRepository
import com.stalkerweb.android.service.PlaybackService
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
) {
    val genres: List<String>
        get() = channels.mapNotNull { it.genre }.filter { it.isNotBlank() }.distinct().sorted()

    val displayedChannels: List<Channel>
        get() = if (selectedGenre == null) channels
                else channels.filter { it.genre == selectedGenre }
}

@OptIn(UnstableApi::class)
class PlayerViewModel(
    application: Application,
    private val repository: ChannelRepository,
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

    private val playerListener = object : Player.Listener {
        override fun onPlayerError(error: PlaybackException) {
            android.util.Log.w("PlayerViewModel", "playback error (${error.errorCodeName}) — reconnecting", error)
            scheduleReconnect()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) reconnectAttempts = 0
        }
    }

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

    val castManager: CastManager? = runCatching { CastManager(application) }.getOrNull()

    init {
        // Mirror cast session state into UI state
        castManager?.let { cm ->
            viewModelScope.launch {
                cm.isCasting.collect { casting ->
                    _state.value = _state.value.copy(isCasting = casting)
                }
            }
        }
    }

    fun init(channelId: String) {
        // Seed from the on-disk cache so channel navigation/metadata work instantly
        // while the network refresh runs below.
        val cached = repository.getCachedChannels()
        _state.value = _state.value.copy(
            activeChannelId = channelId,
            channels        = if (cached.isNotEmpty()) cached else _state.value.channels,
            logoMap         = repository.getCachedLogoMap().ifEmpty { _state.value.logoMap },
        )

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
                    val channels = async { repository.getChannels() }
                    val logos    = async { repository.getLogoMap() }
                    val favs     = async { repository.getFavoriteIds() }
                    Triple(channels.await(), logos.await(), favs.await())
                }
            }.onSuccess { (channels, logos, favs) ->
                val firstGenre = channels.mapNotNull { it.genre }
                    .filter { it.isNotBlank() }.distinct().sorted().firstOrNull()
                _state.value = _state.value.copy(
                    channels      = channels,
                    logoMap       = logos,
                    favoriteIds   = favs,
                    selectedGenre = firstGenre,
                )
            }
        }
    }

    fun loadStream(channelId: String) {
        val p = _player.value ?: return
        val channel = _state.value.channels.find { it.uniqueId == channelId }
        // Resolve via the backend so we know the engine type (hls/mpegts/native)
        // and feed ExoPlayer the correct MIME — assuming HLS for everything breaks
        // the raw-MPEG-TS channels the backend now serves.
        viewModelScope.launch {
            runCatching {
                val info = repository.resolveStream(channelId)
                val mime = when (info.type) {
                    "hls"    -> MimeTypes.APPLICATION_M3U8
                    "mpegts" -> MimeTypes.VIDEO_MP2T
                    else     -> null   // native / unknown → let ExoPlayer infer from the container
                }
                val builder = MediaItem.Builder()
                    .setUri(info.url)
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(channel?.name).build())
                if (mime != null) builder.setMimeType(mime)
                p.setMediaItem(builder.build())
                p.prepare()
                p.playWhenReady = true
                if (channel != null) {
                    repository.pushWatched(channel, _state.value.logoMap[channelId])
                }
                // Keep Cast session in sync with channel changes
                castManager?.setStream(info.url, channel?.name)
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

    fun selectChannel(channelId: String) {
        _state.value = _state.value.copy(
            activeChannelId = channelId,
            showChannelList = false,
        )
        resetReconnect()   // a deliberate zap starts a fresh backoff sequence
        loadStream(channelId)
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
                if (isFav) repository.removeFavorite(id) else repository.addFavorite(id)
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
        repository.setStreamOverride(channelId, url)
        _state.value = _state.value.copy(overrideSheetChannel = null)
        // Reload stream with new URL if it's the active channel
        if (channelId == _state.value.activeChannelId) loadStream(channelId)
    }

    fun getStreamOverride(channelId: String): String? = repository.getStreamOverride(channelId)

    fun getDefaultStreamUrl(channelId: String): String = repository.defaultStreamUrl(channelId)

    private companion object {
        const val MAX_RECONNECT_ATTEMPTS = 8
    }

    override fun onCleared() {
        sleepTimerJob?.cancel()
        reconnectJob?.cancel()
        (_player.value as? MediaController)?.removeListener(playerListener)
        castManager?.release()
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.onCleared()
    }
}
