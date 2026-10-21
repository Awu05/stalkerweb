package com.stalkerweb.android.cast

import android.content.Context
import android.util.Log
import androidx.mediarouter.media.MediaRouteSelector
import androidx.mediarouter.media.MediaRouter
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaLoadRequestData
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaSeekOptions
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.SessionManagerListener
import com.google.android.gms.cast.framework.media.RemoteMediaClient
import com.google.android.gms.common.images.WebImage
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** What to send to the TV: a cast link from the server (api/stream/:id/cast, api/vod/cast). */
data class CastMedia(
    val url: String,
    val contentType: String,
    val live: Boolean,
    val title: String?,
    val subtitle: String? = null,
    val imageUrl: String? = null,
    val startMs: Long = 0,
)

/** A cast device the picker lists. */
data class CastDevice(val id: String, val name: String, val description: String?)

/** The TV's playback, for a movie's controls while it's cast. */
data class RemoteState(val playing: Boolean = false, val positionMs: Long = 0, val durationMs: Long = 0, val idle: Boolean = true)

/**
 * Chromecast for the whole app (one per process: [get]). The player on screen
 * says what it would cast with [setSource]; when a session starts — or it
 * changes its source while one is on — that is loaded on the TV. The picker
 * ([devices], [select], [stopCasting]) is Compose's own: MediaRouteButton
 * needs an AppCompat theme and a FragmentActivity, which this app hasn't got.
 */
class CastManager private constructor(private val context: Context) {

    private val castContext: CastContext? = runCatching { CastContext.getSharedInstance(context) }
        .onFailure { Log.w(TAG, "Cast not available: ${it.message}") }
        .getOrNull()

    /** False on a device without Google Play services' Cast: no button then. */
    val available: Boolean get() = castContext != null

    private val scope = MainScope()

    private val _isCasting = MutableStateFlow(false)
    val isCasting: StateFlow<Boolean> = _isCasting.asStateFlow()

    private val _deviceName = MutableStateFlow<String?>(null)
    val deviceName: StateFlow<String?> = _deviceName.asStateFlow()

    private val _remote = MutableStateFlow(RemoteState())
    val remote: StateFlow<RemoteState> = _remote.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    /** Why the last cast didn't start (the server couldn't give a link, the TV refused it). */
    val error: StateFlow<String?> = _error.asStateFlow()

    // ── What to cast ─────────────────────────────────────────────────────────

    private var source: (suspend () -> CastMedia)? = null
    private var sourceNo = 0
    private var loadJob: Job? = null

    /**
     * The player on screen's media, asked for when casting starts (and now, if
     * it's on). Returns a number for [clearSource].
     */
    fun setSource(provider: suspend () -> CastMedia): Int {
        source = provider
        if (_isCasting.value) reload()
        return ++sourceNo
    }

    /** The player that set source [no] closed — unless another has set one since (it opens before the old one goes). */
    fun clearSource(no: Int) {
        if (no == sourceNo) source = null
    }

    /** The source again (another channel or episode while casting). */
    fun reload() {
        val provider = source ?: return
        val session = currentSession() ?: return
        loadJob?.cancel()
        loadJob = scope.launch {
            runCatching { provider() }
                .onSuccess { load(session, it); _error.value = null }
                .onFailure { _error.value = it.message ?: "Couldn't cast this"; Log.w(TAG, "cast source failed", it) }
        }
    }

    private fun load(session: CastSession, m: CastMedia) {
        val meta = MediaMetadata(if (m.live) MediaMetadata.MEDIA_TYPE_GENERIC else MediaMetadata.MEDIA_TYPE_MOVIE).apply {
            m.title?.takeIf { it.isNotBlank() }?.let { putString(MediaMetadata.KEY_TITLE, it) }
            m.subtitle?.takeIf { it.isNotBlank() }?.let { putString(MediaMetadata.KEY_SUBTITLE, it) }
            m.imageUrl?.takeIf { it.isNotBlank() }?.let { addImage(WebImage(android.net.Uri.parse(it))) }
        }
        val info = MediaInfo.Builder(m.url)
            .setStreamType(if (m.live) MediaInfo.STREAM_TYPE_LIVE else MediaInfo.STREAM_TYPE_BUFFERED)
            .setContentType(m.contentType)
            .setMetadata(meta)
            .build()
        session.remoteMediaClient?.load(
            MediaLoadRequestData.Builder().setMediaInfo(info).setAutoplay(true)
                .setCurrentTime(if (m.live) 0 else m.startMs).build(),
        )?.setResultCallback { r ->
            if (!r.status.isSuccess) _error.value = "The TV couldn't play this (${r.status.statusCode})"
        }
    }

    // ── Controls for what's on the TV ────────────────────────────────────────

    private fun client(): RemoteMediaClient? = currentSession()?.remoteMediaClient

    fun togglePlay() { client()?.togglePlayback() }
    fun seekBy(deltaMs: Long) {
        val c = client() ?: return
        val to = (c.approximateStreamPosition + deltaMs).coerceAtLeast(0)
        c.seek(MediaSeekOptions.Builder().setPosition(to).build())
    }
    fun seekTo(ms: Long) { client()?.seek(MediaSeekOptions.Builder().setPosition(ms.coerceAtLeast(0)).build()) }

    /** Where the TV is in what it plays (0 when nothing). */
    fun positionMs(): Long = client()?.approximateStreamPosition ?: 0

    private val progress = RemoteMediaClient.ProgressListener { pos, dur -> publish(pos, dur) }
    private val remoteCallback = object : RemoteMediaClient.Callback() {
        override fun onStatusUpdated() { client()?.let { publish(it.approximateStreamPosition, it.streamDuration) } }
    }

    private fun publish(pos: Long, dur: Long) {
        val c = client()
        _remote.value = RemoteState(
            playing = c?.isPlaying == true || c?.isBuffering == true,
            positionMs = pos, durationMs = dur.coerceAtLeast(0),
            idle = c == null || c.isIdle(),
        )
    }

    private fun RemoteMediaClient.isIdle() = playerState == com.google.android.gms.cast.MediaStatus.PLAYER_STATE_IDLE ||
        playerState == com.google.android.gms.cast.MediaStatus.PLAYER_STATE_UNKNOWN

    private fun watch(session: CastSession) {
        session.remoteMediaClient?.registerCallback(remoteCallback)
        session.remoteMediaClient?.addProgressListener(progress, 1_000)
    }

    // ── Sessions ─────────────────────────────────────────────────────────────

    private fun currentSession(): CastSession? = castContext?.sessionManager?.currentCastSession?.takeIf { it.isConnected }

    private val sessionListener = object : SessionManagerListener<CastSession> {
        override fun onSessionStarted(session: CastSession, sessionId: String) { started(session); reload() }
        override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) { started(session) }
        override fun onSessionEnded(session: CastSession, error: Int) = ended()
        override fun onSessionSuspended(session: CastSession, reason: Int) = ended()
        override fun onSessionStartFailed(session: CastSession, error: Int) { ended(); _error.value = "Couldn't connect to the TV" }
        override fun onSessionStarting(session: CastSession) {}
        override fun onSessionEnding(session: CastSession) {
            // The last position, for the phone to pick up from.
            session.remoteMediaClient?.let { publish(it.approximateStreamPosition, it.streamDuration) }
        }
        override fun onSessionResuming(session: CastSession, sessionId: String) {}
        override fun onSessionResumeFailed(session: CastSession, error: Int) = ended()
    }

    private fun started(session: CastSession) {
        _isCasting.value = true
        _deviceName.value = session.castDevice?.friendlyName
        _error.value = null
        watch(session)
    }

    private fun ended() {
        loadJob?.cancel()
        _isCasting.value = false
        _deviceName.value = null
        _remote.value = _remote.value.copy(playing = false, idle = true)
    }

    // ── The device picker ────────────────────────────────────────────────────

    private val router: MediaRouter? by lazy { runCatching { MediaRouter.getInstance(context) }.getOrNull() }
    private val selector: MediaRouteSelector? get() = castContext?.mergedSelector

    private val _devices = MutableStateFlow<List<CastDevice>>(emptyList())
    val devices: StateFlow<List<CastDevice>> = _devices.asStateFlow()

    private val routerCallback = object : MediaRouter.Callback() {
        override fun onRouteAdded(router: MediaRouter, route: MediaRouter.RouteInfo) = refreshDevices()
        override fun onRouteRemoved(router: MediaRouter, route: MediaRouter.RouteInfo) = refreshDevices()
        override fun onRouteChanged(router: MediaRouter, route: MediaRouter.RouteInfo) = refreshDevices()
    }

    private fun castRoutes(): List<MediaRouter.RouteInfo> {
        val r = router ?: return emptyList()
        val sel = selector ?: return emptyList()
        return r.routes.filter { !it.isDefault && it.isEnabled && it.matchesSelector(sel) }
    }

    private fun refreshDevices() {
        _devices.value = castRoutes().map { CastDevice(it.id, it.name, it.description) }
    }

    /** The picker is open: look for devices. */
    fun startDiscovery() {
        val r = router ?: return
        val sel = selector ?: return
        r.addCallback(sel, routerCallback, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY)
        refreshDevices()
    }

    fun stopDiscovery() { router?.removeCallback(routerCallback) }

    /** Casts to this device (the session's start loads the source). */
    fun select(device: CastDevice) {
        castRoutes().firstOrNull { it.id == device.id }?.let { router?.selectRoute(it) }
    }

    fun stopCasting() {
        castContext?.sessionManager?.endCurrentSession(true)
        router?.let { r -> r.selectRoute(r.defaultRoute) }
    }

    fun clearError() { _error.value = null }

    init {
        castContext?.sessionManager?.addSessionManagerListener(sessionListener, CastSession::class.java)
        currentSession()?.let(::started)
    }

    companion object {
        private const val TAG = "CastManager"
        @Volatile private var instance: CastManager? = null

        /** The app's one CastManager (it must be first made on the main thread). */
        fun get(context: Context): CastManager =
            instance ?: synchronized(this) { instance ?: CastManager(context.applicationContext).also { instance = it } }
    }
}
