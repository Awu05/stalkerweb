package com.stalkerweb.android.ui.vod

import android.app.Application
import android.content.ComponentName
import androidx.annotation.OptIn
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.repo.VodRepository
import com.stalkerweb.android.service.PlaybackService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

@OptIn(UnstableApi::class)
class VodPlayerViewModel(
    application: Application,
    private val vod: VodRepository,
) : AndroidViewModel(application) {

    private val _player = MutableStateFlow<Player?>(null)
    val player: StateFlow<Player?> = _player.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _loading = MutableStateFlow(true)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    /** Episodes of the season this video belongs to — empty for movies. */
    private val _episodes = MutableStateFlow<List<VodEpisode>>(emptyList())
    val episodes: StateFlow<List<VodEpisode>> = _episodes.asStateFlow()

    private val _currentEpisodeId = MutableStateFlow("")
    val currentEpisodeId: StateFlow<String> = _currentEpisodeId.asStateFlow()

    /** Set when playback reaches the end of an episode — drives the picker dialog. */
    private val _showEpisodePicker = MutableStateFlow(false)
    val showEpisodePicker: StateFlow<Boolean> = _showEpisodePicker.asStateFlow()

    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var pendingPlay: (() -> Unit)? = null
    private var started = false

    // Kept so a follow-up episode can be resolved without re-navigating.
    private var videoId = ""
    private var seasonId = ""
    // Show name from the incoming "Show · Episode" title, reused when building
    // the title of whatever episode the user picks next.
    private var titlePrefix = ""

    private val playbackListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            // An episode running to its end is the cue to offer the next one.
            // Movies never load an episode list, so they just stop as before.
            if (playbackState == Player.STATE_ENDED && _episodes.value.isNotEmpty()) {
                _showEpisodePicker.value = true
            }
        }
    }

    fun init(videoId: String, cmd: String, series: String, seasonId: String, episodeId: String, title: String) {
        if (started) return
        started = true

        this.videoId         = videoId
        this.seasonId        = seasonId
        this.titlePrefix     = if (title.contains(TITLE_SEPARATOR)) title.substringBefore(TITLE_SEPARATOR) else ""
        _currentEpisodeId.value = episodeId

        // Preload the season so the end-of-episode dialog can be shown instantly.
        if (seasonId.isNotBlank()) {
            viewModelScope.launch { _episodes.value = vod.getVodEpisodes(videoId, seasonId) }
        }

        val token  = SessionToken(getApplication(), ComponentName(getApplication(), PlaybackService::class.java))
        val future = MediaController.Builder(getApplication(), token).buildAsync()
        controllerFuture = future
        future.addListener({
            val controller = runCatching { future.get() }
                .onFailure { android.util.Log.e("VodPlayerVM", "controller connect failed", it) }
                .getOrNull()
            if (controller != null) {
                controller.addListener(playbackListener)
                _player.value = controller
                pendingPlay?.invoke()
                pendingPlay = null
            }
        }, MoreExecutors.directExecutor())

        viewModelScope.launch {
            runCatching {
                vod.resolveVodStreamUrl(videoId, cmd, series, seasonId, episodeId)
            }.onSuccess { url ->
                val play = { startPlayback(url, title) }
                if (_player.value != null) play() else pendingPlay = play
            }.onFailure {
                _loading.value = false
                _error.value = it.message ?: "Could not load video"
            }
        }
    }

    private fun startPlayback(url: String, title: String) {
        val p = _player.value ?: return
        _showEpisodePicker.value = false
        val builder = MediaItem.Builder()
            .setUri(url)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
        if (url.substringBefore('?').endsWith(".m3u8", ignoreCase = true)) {
            builder.setMimeType(MimeTypes.APPLICATION_M3U8)
        }
        runCatching {
            p.setMediaItem(builder.build())
            p.prepare()
            p.playWhenReady = true
        }.onFailure { e ->
            android.util.Log.e("VodPlayerVM", "startPlayback failed: ${e.message}")
            _error.value = e.message ?: "Playback error"
        }
        _loading.value = false
    }

    /** Plays another episode of the same season in place — no re-navigation. */
    fun playEpisode(episode: VodEpisode) {
        _showEpisodePicker.value = false
        _error.value   = null
        _loading.value = true
        _currentEpisodeId.value = episode.episodeId

        val label = episode.name.ifBlank { "Episode ${episode.seriesNumber}" }
        val title = if (titlePrefix.isBlank()) label else "$titlePrefix$TITLE_SEPARATOR$label"

        viewModelScope.launch {
            runCatching {
                // Episodes resolve by season/episode id; cmd is only for movies.
                vod.resolveVodStreamUrl(
                    videoId   = videoId,
                    cmd       = "",
                    series    = episode.seriesNumber,
                    seasonId  = seasonId,
                    episodeId = episode.episodeId,
                )
            }.onSuccess { url ->
                val play = { startPlayback(url, title) }
                if (_player.value != null) play() else pendingPlay = play
            }.onFailure {
                _loading.value = false
                _error.value = it.message ?: "Could not load episode"
            }
        }
    }

    fun dismissEpisodePicker() { _showEpisodePicker.value = false }

    override fun onCleared() {
        _player.value?.removeListener(playbackListener)
        _player.value?.pause()
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.onCleared()
    }

    private companion object {
        // Matches the "Show · Episode" title MainActivity builds for episodes.
        const val TITLE_SEPARATOR = " · "
    }
}
