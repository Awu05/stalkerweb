package com.stalkerweb.android.ui.vod

import com.stalkerweb.android.data.repo.StatsRepository
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
import com.stalkerweb.android.cast.castMediaOf
import com.stalkerweb.android.cast.resumeAfterCast
import com.stalkerweb.android.data.api.DownloadItem
import com.stalkerweb.android.data.api.SaveWatchRequest
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodItem
import com.stalkerweb.android.data.api.VodSeason
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.DownloadsRepository
import com.stalkerweb.android.data.repo.EpisodeRef
import com.stalkerweb.android.data.repo.MediaLinks
import com.stalkerweb.android.data.repo.Neighbours
import com.stalkerweb.android.data.repo.PlayerParams
import com.stalkerweb.android.data.repo.SkipNow
import com.stalkerweb.android.data.repo.EmbeddedSubtitle
import com.stalkerweb.android.data.repo.SubtitleChoice
import com.stalkerweb.android.data.repo.clampDelay
import com.stalkerweb.android.data.repo.startingChoice
import com.stalkerweb.android.data.api.SubtitlesResponse
import com.stalkerweb.android.data.prefs.AppPrefs
import androidx.media3.common.C
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import com.stalkerweb.android.data.repo.autoSkipTo
import com.stalkerweb.android.data.repo.skipAt
import com.stalkerweb.android.data.api.SkipResponse
import com.stalkerweb.android.data.repo.VodRepository
import com.stalkerweb.android.data.repo.WatchRepository
import com.stalkerweb.android.data.repo.WatchRules
import com.stalkerweb.android.data.repo.episodeNeighbours
import com.stalkerweb.android.service.PlaybackService
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** The subtitles menu: the video's own, the online ones (null: not asked yet), what's showing, and the online ones' delay. */
data class SubtitleState(
    val embedded: List<EmbeddedSubtitle> = emptyList(),
    val online: SubtitlesResponse? = null,
    val onlineLoading: Boolean = false,
    val choice: SubtitleChoice = SubtitleChoice(),
    val delay: Double = 0.0,
)

// The online file's track, told apart from the video's own by its label.
private const val ONLINE_LABEL = "Online subtitles"

data class VodPlayerState(
    val params: PlayerParams? = null,
    val loading: Boolean = true,
    val error: String? = null,
    val resumedFrom: Double = 0.0,                    // > 0: the "Resumed from" banner
    val seasons: List<VodSeason>? = null,             // a show's seasons, in order (null while loading)
    val episodes: Map<String, List<VodEpisode>> = emptyMap(),
    val upNext: EpisodeRef? = null,                   // after an episode ends
    val skip: SkipNow? = null,                        // an intro, recap or the credits playing: the Skip button
    val subtitles: SubtitleState = SubtitleState(),
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
    private val downloads: DownloadsRepository,
    /** The Stats panel's questions for the server. */
    val stats: StatsRepository,
    /** The subtitles picked last and their delay, on this device. */
    private val prefs: AppPrefs,
) : AndroidViewModel(application) {

    /** The viewer's watch state — the top bar's My List button reads it. */
    val watchState = watch.state

    private val _player = MutableStateFlow<Player?>(null)
    val player: StateFlow<Player?> = _player.asStateFlow()

    /** Chromecast (null without Google Play services' Cast). While casting the TV plays and the phone waits. */
    val cast: CastManager? = runCatching { CastManager.get(application) }.getOrNull()?.takeIf { it.available }
    private var castSourceNo = 0
    private val casting get() = cast?.isCasting?.value == true
    // Where the TV got to when casting ended: the phone resumes there (the save
    // of it may not be back from the server yet).
    private var afterCastMs: Long? = null
    // Where the phone was when it let go for the TV (the TV may ask after it has).
    private var releasedAt: Pair<String, Long>? = null

    private val _state = MutableStateFlow(VodPlayerState())

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    /** This movie or episode, downloaded to the server. */
    fun download() {
        val p = _state.value.params ?: return
        val item = DownloadItem(
            videoId = p.videoId, cmd = p.cmd, series = p.series, seasonId = p.seasonId, episodeId = p.episodeId,
            title = if (p.isEpisode) p.episodeTitle.ifBlank { p.title } else p.title, seriesTitle = if (p.isEpisode) p.title else "",
        )
        viewModelScope.launch {
            runCatching { downloads.enqueue(listOf(item)) }
                .onSuccess { _messages.tryEmit("Queued \"${item.title}\" for download") }
                .onFailure { _messages.tryEmit(it.toApiError().message ?: "Could not queue download") }
        }
    }
    val state: StateFlow<VodPlayerState> = _state.asStateFlow()

    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var pendingPlay: (() -> Unit)? = null
    private var started = false
    private var saver: Job? = null

    // Which title the player's media (and so its duration and position) belongs
    // to — read from the media item itself (its mediaId is the title's key).
    // Switching episode in place plays the old one until the new stream loads:
    // a rebuffer or seek in that window reports the OLD media, so resuming and
    // saving can't land on the new episode's key (web v0.4.28).
    private var mediaKey: String? = null
    private var resumedKey: String? = null

    // Subtitles: the stream playing (an online file is added to it), the title
    // whose starting subtitles were chosen, and an online file waiting for its
    // track to show up among the player's.
    private var streamUrl: String? = null
    private var subtitlesStartedFor: String? = null
    private var selectOnlineTrack = false

    // Skip intro / recap / credits: the parts of the title playing (its key →
    // what the server found), and the kinds auto-skipped in it — each once, so
    // going back to watch one stays put.
    private var skipParts: Pair<String, SkipResponse?>? = null
    private var autoSkipped: Pair<String, MutableSet<String>>? = null

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            val p = _player.value ?: return
            val id = p.currentMediaItem?.mediaId
            if (playbackState == Player.STATE_READY && id != null && id != mediaKey) {
                mediaKey = id
                resume(p)
                startSubtitles()   // its tracks are known by now
            }
            if (playbackState == Player.STATE_ENDED) {
                persist()
                _state.value.neighbours.next?.let { _state.value = _state.value.copy(upNext = it) }
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (!isPlaying) persist()
        }

        override fun onTracksChanged(tracks: Tracks) {
            val p = _player.value ?: return
            if (p.currentMediaItem?.mediaId != _state.value.params?.key) return
            subtitleTracksChanged(p, tracks)
        }

        // A stream that fails after it was handed to the player (404, decoder): say so, with Retry.
        override fun onPlayerError(error: PlaybackException) {
            _state.value = _state.value.copy(loading = false, error = error.message ?: "Playback error")
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

        // Fresh resume points (watched elsewhere since); the resume waits for the media to be ready.
        watch.load()
        load(params)
        // Twice a second: the Skip button, and auto-skip.
        viewModelScope.launch {
            while (isActive) { checkSkip(); delay(500) }
        }
        // Every 10 s while playing (as the web does) — on the TV, from its position.
        saver = viewModelScope.launch {
            while (isActive) {
                delay(10_000)
                if (casting) { if (cast?.remote?.value?.playing == true) persistFromTv() }
                else if (_player.value?.isPlaying == true) persist()
            }
        }
        cast?.let { cm ->
            viewModelScope.launch {
                var was = cm.isCasting.value
                cm.isCasting.collect { now ->
                    if (now && !was) {
                        persist()
                        // Let go of the stream, not just pause: some allow one connection per link.
                        _player.value?.takeIf { it.currentMediaItem?.mediaId == mediaKey }?.let {
                            releasedAt = mediaKey!! to it.currentPosition
                            it.stop(); it.clearMediaItems()
                        }
                        mediaKey = null
                    }
                    if (!now && was) {
                        // Back on the phone, from where the TV got to (saved, so the resume finds it).
                        persistFromTv()
                        cm.remote.value.let { afterCastMs = resumeAfterCast(it.positionMs, it.durationMs) }
                        _state.value.params?.let { mediaKey = null; resumedKey = null; load(it) }
                    }
                    was = now
                }
            }
        }
    }

    // What the Cast button sends: this title, from where the phone is (or where it was left off).
    private fun castSource(params: PlayerParams) {
        val cm = cast ?: return
        castSourceNo = cm.setSource {
            val p = _player.value
            val here = when {
                p != null && p.currentMediaItem?.mediaId == params.key -> p.currentPosition
                releasedAt?.first == params.key -> releasedAt!!.second
                else -> ((watch.progressFor(params.key)?.position ?: 0.0) * 1000).toLong()
            }
            val link = vod.castLink(params.videoId, params.cmd, params.series, params.seasonId, params.episodeId)
            castMediaOf(link, params.title, params.episodeTitle.ifBlank { null }, links.absoluteImage(params.screenshotUrl), here)
        }
    }

    private var loadJob: Job? = null

    private fun load(params: PlayerParams) {
        // The stream loads afresh (another title, Retry, back from casting): its
        // subtitles start again from what was picked last. The lists stay for the same title.
        subtitlesStartedFor = null
        selectOnlineTrack = false
        val same = _state.value.params?.key == params.key
        _state.value = _state.value.copy(subtitles = (if (same) _state.value.subtitles else SubtitleState())
            .copy(embedded = emptyList(), choice = SubtitleChoice(), delay = prefs.subtitleDelay))
        _state.value = _state.value.copy(params = params, loading = true, error = null, resumedFrom = 0.0, upNext = null, skip = null)
        if (skipParts?.first != params.key) {
            skipParts = null
            viewModelScope.launch {
                val found = vod.skipParts(params)
                if (_state.value.params?.key == params.key) skipParts = params.key to found
            }
        }
        // Next pressed twice: only the last title's stream may start.
        loadJob?.cancel()
        pendingPlay = null
        castSource(params)
        if (casting) { _state.value = _state.value.copy(loading = false); return }   // it's on the TV
        loadJob = viewModelScope.launch {
            runCatching { vod.resolveVodStreamUrl(params.videoId, params.cmd, params.series, params.seasonId, params.episodeId) }
                .onSuccess { url ->
                    if (_state.value.params?.key != params.key) return@onSuccess
                    val play = { startPlayback(url, params) }
                    if (_player.value != null) play() else pendingPlay = play
                }
                .onFailure { _state.value = _state.value.copy(loading = false, error = it.toApiError().message ?: "Could not load video") }
        }
    }

    private fun startPlayback(url: String, params: PlayerParams) {
        val p = _player.value ?: return
        val episodeName = if (params.isEpisode) com.stalkerweb.android.data.repo.episodeLabel(params.season, params.series, params.episodeTitle) else ""
        val title = if (episodeName.isNotEmpty()) "${params.title} · $episodeName" else params.title
        streamUrl = url
        val builder = MediaItem.Builder().setUri(url).setMediaId(params.key)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
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
        val key = mediaKey ?: return
        if (resumedKey == key) return
        resumedKey = key
        afterCastMs?.let { ms ->
            afterCastMs = null
            p.seekTo(ms)
            _state.value = _state.value.copy(resumedFrom = ms / 1000.0)
            return
        }
        val duration = p.duration.takeIf { it > 0 }?.div(1000.0) ?: return
        val saved = watch.progressFor(key) ?: return
        val at = WatchRules.resumeAt(saved.position, duration) ?: return
        p.seekTo((at * 1000).toLong())
        _state.value = _state.value.copy(resumedFrom = at)
    }

    private fun checkSkip() {
        val p = _player.value
        val key = skipParts?.first
        val parts = skipParts?.second
        if (p == null || key == null || parts == null || casting || p.currentMediaItem?.mediaId != key || mediaKey != key) {
            if (_state.value.skip != null) _state.value = _state.value.copy(skip = null)
            return
        }
        val t = p.currentPosition / 1000.0
        if (parts.autoSkip) {
            if (autoSkipped?.first != key) autoSkipped = key to mutableSetOf<String>()
            val done = autoSkipped!!.second
            autoSkipTo(parts, t, done)?.let { s ->
                done += s.kind
                p.seekTo(seekable(p, s.to))
                return
            }
        }
        val now = if (_state.value.upNext != null) null else skipAt(parts, t)
        if (now != _state.value.skip) _state.value = _state.value.copy(skip = now)
    }

    // A skip's landing point, short of the very end (the end itself is the episode over).
    private fun seekable(p: Player, secs: Double): Long {
        val ms = (secs * 1000).toLong()
        return p.duration.takeIf { it > 0 }?.let { minOf(ms, it) } ?: ms
    }

    /** The Skip button: past the part playing, or — at the credits, with one to come — the next episode. */
    fun skip(toNextEpisode: Boolean) {
        if (toNextEpisode && _state.value.neighbours.next != null) { playNext(); return }
        val p = _player.value ?: return
        val s = _state.value.skip ?: return
        p.seekTo(seekable(p, s.to))
        _state.value = _state.value.copy(skip = null)
    }

    // ── Subtitles ─────────────────────────────────────────────────────────────

    private fun subtitleTracksChanged(p: Player, tracks: Tracks) {
        val embedded = mutableListOf<EmbeddedSubtitle>()
        var onlineAt: Pair<Int, Int>? = null
        tracks.groups.forEachIndexed { g, group ->
            if (group.type != C.TRACK_TYPE_TEXT) return@forEachIndexed
            for (t in 0 until group.length) {
                if (!group.isTrackSupported(t)) continue
                val f = group.getTrackFormat(t)
                if (f.label == ONLINE_LABEL) { onlineAt = g to t; continue }
                embedded += EmbeddedSubtitle(g, t, f.label.orEmpty(), f.language.orEmpty())
            }
        }
        val subs = _state.value.subtitles
        if (embedded != subs.embedded) _state.value = _state.value.copy(subtitles = subs.copy(embedded = embedded))
        // The online file has just been added: show it.
        val online = onlineAt
        if (selectOnlineTrack && online != null) {
            selectOnlineTrack = false
            p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .setOverrideForType(TrackSelectionOverride(tracks.groups[online.first].mediaTrackGroup, online.second))
                .build()
        }
        startSubtitles()
    }

    // Each title starts with the language picked last: the video's own, else
    // the online ones (asked for then).
    private fun startSubtitles() {
        val key = _state.value.params?.key ?: return
        if (subtitlesStartedFor == key || mediaKey != key) return
        val saved = prefs.subtitleChoice
        // Off — as picked, or nothing in that language — is off: not whatever the video marks as its default.
        val textOff = { _player.value?.let { it.trackSelectionParameters = it.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build() } }
        if (saved.startsWith("off")) { subtitlesStartedFor = key; textOff(); return }
        val subs = _state.value.subtitles
        startingChoice(saved, subs.embedded, emptyList())?.let { subtitlesStartedFor = key; apply(it); return }
        // No language to look for online (a track picked without one): nothing online could match.
        if (saved.substringAfter('|').isBlank()) { subtitlesStartedFor = key; textOff(); return }
        val online = subs.online
        if (online == null) { loadOnlineSubtitles(); return }
        subtitlesStartedFor = key
        startingChoice(saved, emptyList(), online.results)?.let(::apply) ?: textOff()
    }

    /** The online list for this title, asked once (when the menu opens, or to start with). */
    fun loadOnlineSubtitles() {
        val params = _state.value.params ?: return
        val subs = _state.value.subtitles
        // Asked once — again after it failed.
        if (subs.onlineLoading || (subs.online != null && subs.online.error == null)) return
        _state.value = _state.value.copy(subtitles = subs.copy(onlineLoading = true))
        viewModelScope.launch {
            val r = vod.onlineSubtitles(params)
            if (_state.value.params?.key != params.key) return@launch
            _state.value = _state.value.copy(subtitles = _state.value.subtitles.copy(online = r, onlineLoading = false))
            startSubtitles()
        }
    }

    /** A viewer's pick — kept for the next title. */
    fun pickSubtitles(choice: SubtitleChoice) {
        subtitlesStartedFor = _state.value.params?.key
        apply(choice)
        prefs.subtitleChoice = "${choice.kind}|${if (choice.kind == "off") "" else choice.language}"
    }

    fun setSubtitleDelay(d: Double) {
        val next = clampDelay(d)
        prefs.subtitleDelay = next
        val subs = _state.value.subtitles
        _state.value = _state.value.copy(subtitles = subs.copy(delay = next))
        // Once the presses stop: each change reloads the stream with the file moved.
        delayJob?.cancel()
        if (subs.choice.kind == "online") delayJob = viewModelScope.launch {
            delay(1_200)
            _state.value.subtitles.choice.takeIf { it.kind == "online" }?.let(::apply)
        }
    }

    private var delayJob: Job? = null

    // Shows a choice, the others off. An online file is added to the stream,
    // which then carries on from where it is.
    private fun apply(choice: SubtitleChoice) {
        val p = _player.value ?: return
        val params = _state.value.params ?: return
        _state.value = _state.value.copy(subtitles = _state.value.subtitles.copy(choice = choice))
        val text = p.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT)
        when (choice.kind) {
            "off" -> p.trackSelectionParameters = text.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
            "embedded" -> {
                val group = p.currentTracks.groups.getOrNull(choice.group) ?: return
                p.trackSelectionParameters = text.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                    .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, choice.track)).build()
            }
            "online" -> {
                // Fetched first: added to the stream, a file that won't load
                // would stop the video itself (and come back with every Retry).
                val delay = _state.value.subtitles.delay
                onlineJob?.cancel()
                onlineJob = viewModelScope.launch {
                    val failed = vod.checkSubtitleFile(choice.fileId, delay)
                    if (_state.value.params?.key != params.key || _state.value.subtitles.choice != choice) return@launch
                    if (failed != null) { subtitleFailed(failed); return@launch }
                    addOnlineSubtitle(p, params, choice, delay)
                }
            }
        }
    }

    private var onlineJob: Job? = null

    // The stream again with the online file beside it, from where it is.
    private fun addOnlineSubtitle(p: Player, params: PlayerParams, choice: SubtitleChoice, delay: Double) {
        val url = streamUrl ?: return
        val current = p.currentMediaItem?.takeIf { it.mediaId == params.key } ?: return
        val sub = MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse(vod.subtitleFileUrl(choice.fileId, delay)))
            .setMimeType(MimeTypes.TEXT_VTT)
            .setLanguage(choice.language.ifEmpty { null })
            .setLabel(ONLINE_LABEL)
            .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
            .build()
        val item = current.buildUpon().setUri(url).setSubtitleConfigurations(listOf(sub)).build()
        val at = p.currentPosition
        val playing = p.playWhenReady
        selectOnlineTrack = true
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).build()
        p.setMediaItem(item, at)
        p.prepare()
        p.playWhenReady = playing
    }

    // An online file that couldn't be had: subtitles off for this title (the
    // pick kept for the next one), and the viewer told.
    private fun subtitleFailed(why: String) {
        _state.value = _state.value.copy(subtitles = _state.value.subtitles.copy(choice = SubtitleChoice()))
        _player.value?.let { it.trackSelectionParameters = it.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build() }
        _messages.tryEmit("Subtitles couldn't be loaded: $why")
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
        if (mediaKey == null || mediaKey != params.key || p.currentMediaItem?.mediaId != params.key) return
        val duration = p.duration.takeIf { it > 0 }?.div(1000.0) ?: return
        save(params, p.currentPosition / 1000.0, duration)
    }

    /** Saves where the TV is in this title (it plays the one on screen). */
    private fun persistFromTv() {
        val params = _state.value.params ?: return
        val r = cast?.remote?.value ?: return
        if (r.durationMs <= 0 || r.positionMs <= 0) return
        save(params, r.positionMs / 1000.0, r.durationMs / 1000.0)
    }

    private fun save(params: PlayerParams, position: Double, duration: Double) {
        val stored = params.copy(screenshotUrl = links.relativeImage(params.screenshotUrl))
        watch.saveProgress(SaveWatchRequest(
            key = params.key,
            title = params.title,
            episodeTitle = params.episodeTitle,
            screenshotUrl = stored.screenshotUrl,
            params = stored.toQuery(),
            position = position,
            duration = duration,
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
        if (casting) persistFromTv() else persist()
        mediaKey = null
        load(params.copy(
            series = episode.seriesNumber.ifBlank { "0" }, seasonId = season.id, episodeId = episode.episodeId,
            season = com.stalkerweb.android.data.repo.seasonNoOf(season),
            episodeTitle = episode.name.ifBlank { "Episode ${episode.seriesNumber}" },
        ))
        loadSeason(season.id)
    }

    /** The stream again, after an error. */
    fun retry() { _state.value.params?.let { mediaKey = null; resumedKey = null; load(it) } }

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
        if (casting) persistFromTv() else persist()
        cast?.clearSource(castSourceNo)
        saver?.cancel()
        _player.value?.removeListener(listener)
        _player.value?.pause()
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.onCleared()
    }
}
