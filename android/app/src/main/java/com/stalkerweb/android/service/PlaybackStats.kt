package com.stalkerweb.android.service

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener

/** What the player's Stats panel shows, read from the app's one ExoPlayer. */
data class PlaybackSnapshot(
    val width: Int,
    val height: Int,
    val frameRate: Float?,
    val videoCodec: String?,
    val audioCodec: String?,
    val bitrate: Long?,
    val bufferedMs: Long,
    val droppedFrames: Long,
    val stalls: Int,
    val bandwidth: Long?,
)

/**
 * The ExoPlayer behind every MediaController (PlaybackService), with what a
 * controller can't see: dropped frames, stalls and ExoPlayer's download-speed
 * estimate. Counts start over with each stream — not when the same one is
 * loaded again (a retry or reconnect: what stalls lead to). Read on the main thread.
 */
@OptIn(UnstableApi::class)
object PlaybackStats : AnalyticsListener {
    private var player: ExoPlayer? = null
    private var dropped = 0L
    private var stalls = 0
    private var bandwidth = 0L
    private var wasReady = false
    private var seeking = false
    private var playing: String? = null   // the stream's address, to tell a new one from a retry

    fun attach(p: ExoPlayer) { player = p; p.addAnalyticsListener(this); reset() }
    fun detach(p: ExoPlayer) { p.removeAnalyticsListener(this); if (player === p) player = null }

    private fun reset() { dropped = 0; stalls = 0; wasReady = false; seeking = false }

    override fun onMediaItemTransition(eventTime: AnalyticsListener.EventTime, mediaItem: MediaItem?, reason: Int) {
        val uri = mediaItem?.localConfiguration?.uri?.toString()
        if (uri != playing) { playing = uri; reset() }
    }

    override fun onDroppedVideoFrames(eventTime: AnalyticsListener.EventTime, droppedFrames: Int, elapsedMs: Long) {
        dropped += droppedFrames
    }

    override fun onBandwidthEstimate(eventTime: AnalyticsListener.EventTime, totalLoadTimeMs: Int, totalBytesLoaded: Long, bitrateEstimate: Long) {
        bandwidth = bitrateEstimate
    }

    override fun onPositionDiscontinuity(
        eventTime: AnalyticsListener.EventTime,
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int,
    ) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK) seeking = true
    }

    // A wait for data after playback got going — not the first load, nor one a seek asked for.
    override fun onPlaybackStateChanged(eventTime: AnalyticsListener.EventTime, state: Int) {
        when (state) {
            Player.STATE_READY -> { wasReady = true; seeking = false }
            Player.STATE_BUFFERING -> if (wasReady && !seeking) stalls++
            else -> {}
        }
    }

    fun snapshot(): PlaybackSnapshot? {
        val p = player ?: return null
        val v = p.videoFormat
        val a = p.audioFormat
        val size = p.videoSize
        val rate = listOfNotNull(v?.bitrate, a?.bitrate).filter { it != Format.NO_VALUE && it > 0 }.sum()
        return PlaybackSnapshot(
            width = size.width.takeIf { it > 0 } ?: v?.width?.takeIf { it > 0 } ?: 0,
            height = size.height.takeIf { it > 0 } ?: v?.height?.takeIf { it > 0 } ?: 0,
            frameRate = v?.frameRate?.takeIf { it > 0 },
            videoCodec = v?.codecs ?: v?.sampleMimeType,
            audioCodec = a?.codecs ?: a?.sampleMimeType,
            bitrate = rate.toLong().takeIf { it > 0 },
            bufferedMs = p.totalBufferedDuration.takeIf { it != C.TIME_UNSET } ?: 0,
            droppedFrames = dropped,
            stalls = stalls,
            bandwidth = bandwidth.takeIf { it > 0 },
        )
    }
}
