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
import com.stalkerweb.android.data.api.SaveWatchRequest
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodItem
import com.stalkerweb.android.data.api.VodSeason
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.EpisodeRef
import com.stalkerweb.android.data.repo.MediaLinks
import com.stalkerweb.android.data.repo.Neighbours
import com.stalkerweb.android.data.repo.PlayerParams
import com.stalkerweb.android.data.repo.VodRepository
import com.stalkerweb.android.data.repo.WatchRepository
import com.stalkerweb.android.data.repo.WatchRules
import com.stalkerweb.android.data.repo.episodeNeighbours
import com.stalkerweb.android.data.repo.isLastEpisode
import com.stalkerweb.android.service.PlaybackService
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class VodPlayerState(
    val params: PlayerParams? = null,
    val loading: Boolean = true,
    val error: String? = null,
    val resumedFrom: Double = 0.0,                    // > 0: the "Resumed from" banner
    val seasons: List<VodSeason>? = null,             // a show's seasons, in order (null while loading)
    val episodes: Map<String, List<VodEpisode>> = emptyMap(),
    val upNext: EpisodeRef? = null,                   // after an episode ends
) {
    val neighbours: Neighbours get() {
        val p = params ?: return Neighbours(null, null, emptyList())
        return if (seasons == null) Neighbours(null, null, emptyList())
               else episodeNeighbours(seasons, episodes, p.seasonId, p.episodeId)
    }
}

/**
 * The VOD player (the web's VodPlayerPage): plays [PlayerParams], resumes where
 * the viewer left off, saves the position (shared with the web), and for a
 * show offers its episodes, Previous / Next and an "Up next" after the end.
 */
@OptIn(UnstableApi::class)
class VodPlayerViewModel(
    application: Application,
    private val vod: VodRepository,
    private val watch: WatchRepository,
    private val links: MediaLinks,
) : AndroidViewModel(application) {

    /** The viewer's watch state — the top bar's My List button reads it. */
    val watchState = watch.state

    private val _player = MutableStateFlow<Player?>(null)
    val player: StateFlow<Player?> = _player.asStateFlow()

    private val _state = MutableStateFlow(VodPlayerState())
    val state: StateFlow<VodPlayerState> = _state.asStateFlow()

    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var pendingPlay: (() -> Unit)? = null
    private var started = false
    private var saver: Job? = null

    // Which title the player's media (and so its duration and position) belongs
    // to. Switching episode in place plays the old one until the new stream
    // loads: resuming and saving wait for the new one (web v0.4.28).
    private var streamKey: String? = null
    private var mediaKey: String? = null
    private var resumedKey: String? = null

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            val p = _player.value ?: return
            if (playbackState == Player.STATE_READY && mediaKey != streamKey) {
                mediaKey = streamKey
                resume(p)
            }
            if (playbackState == Player.STATE_ENDED) {
                persist()
                _state.value.neighbours.next?.let { _state.value = _state.value.copy(upNext = it) }
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (!isPlaying) persist()
        }
    }

    fun init(params: PlayerParams) {
        if (started) return
        started = true
        _state.value = VodPlayerState(params = params)
        if (params.isEpisode) loadSeasons(params)

        val app = getApplication<Application>()
        val token = SessionToken(app, ComponentName(app, PlaybackService::class.java))
        val future = MediaController.Builder(app, token).buildAsync()
        controllerFuture = future
        future.addListener({
            runCatching { future.get() }.getOrNull()?.let { controller ->
                controller.addListener(listener)
                _player.value = controller
                pendingPlay?.invoke()
                pendingPlay = null
            }
        }, MoreExecutors.directExecutor())

        load(params)
        // Every 10 s while playing (as the web does).
        saver = viewModelScope.launch {
            while (isActive) {
                delay(10_000)
                if (_player.value?.isPlaying == true) persist()
            }
        }
    }

    private fun load(params: PlayerParams) {
        streamKey = params.key
        _state.value = _state.value.copy(params = params, loading = true, error = null, resumedFrom = 0.0, upNext = null)
        viewModelScope.launch {
            runCatching { vod.resolveVodStreamUrl(params.videoId, params.cmd, params.series, params.seasonId, params.episodeId) }
                .onSuccess { url ->
                    val play = { startPlayback(url, params) }
                    if (_player.value != null) play() else pendingPlay = play
                }
                .onFailure { _state.value = _state.value.copy(loading = false, error = it.toApiError().message ?: "Could not load video") }
        }
    }

    private fun startPlayback(url: String, params: PlayerParams) {
        val p = _player.value ?: return
        val title = if (params.episodeTitle.isNotEmpty()) "${params.title} · ${params.episodeTitle}" else params.title
        val builder = MediaItem.Builder().setUri(url).setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
        if (url.substringBefore('?').endsWith(".m3u8", ignoreCase = true)) builder.setMimeType(MimeTypes.APPLICATION_M3U8)
        runCatching {
            p.setMediaItem(builder.build())
            p.prepare()
            p.playWhenReady = true
        }.onFailure { _state.value = _state.value.copy(error = it.message ?: "Playback error") }
        _state.value = _state.value.copy(loading = false)
    }

    // Where the viewer left off, once this title's media is ready (30 s … 95%).
    private fun resume(p: Player) {
        val key = streamKey ?: return
        if (resumedKey == key) return
        resumedKey = key
        val duration = p.duration.takeIf { it > 0 }?.div(1000.0) ?: return
        val saved = watch.progressFor(key) ?: return
        val at = WatchRules.resumeAt(saved.position, duration) ?: return
        p.seekTo((at * 1000).toLong())
        _state.value = _state.value.copy(resumedFrom = at)
    }

    fun startOver() {
        _player.value?.seekTo(0)
        _state.value = _state.value.copy(resumedFrom = 0.0)
    }

    fun dismissResumed() { _state.value = _state.value.copy(resumedFrom = 0.0) }

    /** Saves the position — only for the media actually playing, never the next episode's key. */
    private fun persist() {
        val p = _player.value ?: return
        val params = _state.value.params ?: return
        if (mediaKey == null || mediaKey != params.key) return
        val duration = p.duration.takeIf { it > 0 }?.div(1000.0) ?: return
        val s = _state.value
        val last = params.isEpisode && s.seasons != null && isLastEpisode(s.seasons, s.episodes, params.seasonId, params.episodeId)
        val stored = params.copy(screenshotUrl = links.relativeImage(params.screenshotUrl))
        watch.saveProgress(SaveWatchRequest(
            key = params.key,
            title = params.title,
            episodeTitle = params.episodeTitle,
            screenshotUrl = stored.screenshotUrl,
            params = stored.toQuery(),
            position = p.currentPosition / 1000.0,
            duration = duration,
            lastEpisode = last,
        ))
    }

    // ── A show's episodes ─────────────────────────────────────────────────────

    private fun loadSeasons(params: PlayerParams) {
        viewModelScope.launch {
            val seasons = vod.getVodSeasons(params.videoId)
            _state.value = _state.value.copy(seasons = seasons)
            loadSeason(params.seasonId)
        }
    }

    /** Loads a season's episodes (once), then any neighbouring season needed for Previous / Next. */
    fun loadSeason(seasonId: String) {
        val params = _state.value.params ?: return
        if (seasonId.isEmpty() || _state.value.episodes.containsKey(seasonId)) return
        viewModelScope.launch {
            val eps = vod.getVodEpisodes(params.videoId, seasonId)
            _state.value = _state.value.copy(episodes = _state.value.episodes + (seasonId to eps))
            _state.value.neighbours.needs.forEach(::loadSeason)
        }
    }

    /** Another episode of the same show, in place. */
    fun playEpisode(season: VodSeason, episode: VodEpisode) {
        val params = _state.value.params ?: return
        persist()
        mediaKey = null
        load(params.copy(
            series = episode.seriesNumber.ifBlank { "0" }, seasonId = season.id, episodeId = episode.episodeId,
            episodeTitle = episode.name.ifBlank { "Episode ${episode.seriesNumber}" },
        ))
        loadSeason(season.id)
    }

    fun playNext() { _state.value.neighbours.next?.let { playEpisode(it.season, it.episode) } }
    fun playPrevious() { _state.value.neighbours.prev?.let { playEpisode(it.season, it.episode) } }
    fun cancelUpNext() { _state.value = _state.value.copy(upNext = null) }

    // ── My List ───────────────────────────────────────────────────────────────

    /** This movie or show, as My List keeps it. */
    fun myListItem(): VodItem? = _state.value.params?.let { p ->
        VodItem(
            id = p.videoId, name = p.title, cmd = if (p.isEpisode) "" else p.cmd, year = p.year, durationMin = p.durationMin,
            isHD = p.isHD, isSeries = p.isEpisode, screenshotUrl = links.absoluteImage(p.screenshotUrl),
            description = p.description, director = p.director, actors = p.actors,
        )
    }

    fun toggleMyList() { myListItem()?.let(watch::toggleMyList) }

    override fun onCleared() {
        persist()
        saver?.cancel()
        _player.value?.removeListener(listener)
        _player.value?.pause()
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.onCleared()
    }
}
