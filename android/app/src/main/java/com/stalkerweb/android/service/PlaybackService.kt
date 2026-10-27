package com.stalkerweb.android.service

import android.content.Intent
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.stalkerweb.android.data.api.APP_USER_AGENT
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

class PlaybackService : MediaSessionService() {

    private var mediaSession: MediaSession? = null

    // Stop playback whenever the whole app leaves the foreground (backgrounded,
    // swiped from recents, force-closed, or screen off). This is a viewer, not a
    // music player, so it must not keep streaming in the background.
    //
    // ProcessLifecycleOwner is the reliable signal here: relying on the player
    // controller's teardown races (the pause command may never reach the service
    // before the controller disconnects), and a bound MediaSessionService doesn't
    // reliably receive onTaskRemoved. Picture-in-Picture is handled for free — a
    // PiP activity stays STARTED, so the app lifecycle never reaches onStop and
    // playback continues in the PiP window as expected.
    private val appLifecycleObserver = object : DefaultLifecycleObserver {
        override fun onStop(owner: LifecycleOwner) {
            mediaSession?.player?.run {
                stop()
                clearMediaItems()
            }
            stopSelf()
        }
    }

    @OptIn(UnstableApi::class)
    override fun onCreate() {
        super.onCreate()
        // Streams fetched as the app (Settings → Activity names it), not as "Dalvik".
        val http = DefaultHttpDataSource.Factory().setUserAgent(APP_USER_AGENT)
        val player = ExoPlayer.Builder(this)
            // An online subtitle file that won't load never stops the movie (SubtitleSafeDataSource).
            .setMediaSourceFactory(DefaultMediaSourceFactory(SubtitleSafeDataSource.Factory(DefaultDataSource.Factory(this, http))))
            .build()
        PlaybackStats.attach(player)
        mediaSession = MediaSession.Builder(this, player).build()
        ProcessLifecycleOwner.get().lifecycle.addObserver(appLifecycleObserver)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        mediaSession

    // Backstop for the swipe-away case in case it is delivered before onStop.
    override fun onTaskRemoved(rootIntent: Intent?) {
        mediaSession?.player?.run {
            stop()
            clearMediaItems()
        }
        stopSelf()
    }

    override fun onDestroy() {
        ProcessLifecycleOwner.get().lifecycle.removeObserver(appLifecycleObserver)
        mediaSession?.run {
            (player as? ExoPlayer)?.let(PlaybackStats::detach)
            player.release()
            release()
        }
        mediaSession = null
        super.onDestroy()
    }
}
