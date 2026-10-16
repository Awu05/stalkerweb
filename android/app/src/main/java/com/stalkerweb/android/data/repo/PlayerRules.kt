package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.EpgEvent

// ── The live player's rules (the web's PlayerPage) ───────────────────────────

/** What's on the playing channel: the programme now (if any) and the next ones. */
data class NowPlaying(val now: EpgEvent?, val later: List<EpgEvent>)

/** The programme on at [nowSecs] and the [count] after it (or the next [count] when nothing is on). */
fun nowPlaying(events: List<EpgEvent>, nowSecs: Long, count: Int = 2): NowPlaying {
    val idx = eventAt(events, nowSecs)?.let(events::indexOf) ?: -1
    val later = if (idx >= 0) events.drop(idx + 1) else events.filter { it.startTime > nowSecs }
    return NowPlaying(events.getOrNull(idx), later.take(count))
}

/** The player's channel list: a search (name or number), Favorites only, and a genre (by name). */
fun playerList(channels: List<Channel>, query: String, favoritesOnly: Boolean, genre: String?, favoriteIds: Set<String>): List<Channel> {
    val q = query.trim().lowercase()
    return channels.filter { c ->
        (q.isEmpty() || c.name.lowercase().contains(q) || (c.number > 0 && c.number.toString().startsWith(q))) &&
            (!favoritesOnly || c.uniqueId in favoriteIds) &&
            (genre == null || c.genre == genre)
    }
}

// ── Which items are the live player's ────────────────────────────────────────
// The live and VOD players drive one shared player (PlaybackService). The live
// player's reconnects and watchdog must only ever act on its own items.

fun liveMediaId(channelId: String): String = "live:$channelId"
fun isLiveMediaId(mediaId: String?): Boolean = mediaId?.startsWith("live:") == true

// ── Stall watchdog (the web's lib/stallRecovery.js watchdogTick) ─────────────

data class StallState(val lastPositionMs: Long, val lastAdvanceMs: Long, val nudged: Boolean)

sealed class StallAction {
    /** Frozen with video loaded ahead: step over the spot it's stuck on. */
    data class Nudge(val toMs: Long) : StallAction()
    /** Frozen for good: reconnect (a fresh link from the server). */
    object Reconnect : StallAction()
}

/**
 * One tick of the watchdog. A live stream can freeze without any error (the
 * source stops, or restarts and leaves a hole). If the clock hasn't moved for
 * 3 s while it should be playing, nudge it once past where it's stuck when
 * there's video loaded ahead; after 12 s frozen, reconnect. A nudge doesn't
 * count as playing, so one that doesn't help never delays the reconnect.
 */
fun stallTick(state: StallState, nowMs: Long, positionMs: Long, bufferedMs: Long, idle: Boolean): Pair<StallState, StallAction?> {
    // Moving, or jumped back (a live HLS window slides by a segment, a rewind, a new item): not a freeze.
    if (idle || positionMs > state.lastPositionMs + 250 || positionMs < state.lastPositionMs - 1_000) {
        return StallState(positionMs, nowMs, nudged = false) to null
    }
    var s = state
    val frozenFor = nowMs - s.lastAdvanceMs
    if (!s.nudged && frozenFor >= 3_000) {
        if (bufferedMs - positionMs >= 1_000) {
            val to = positionMs + 200
            return s.copy(lastPositionMs = to, nudged = true) to StallAction.Nudge(to)
        }
        s = s.copy(nudged = true)
    }
    return s to (if (frozenFor > 12_000) StallAction.Reconnect else null)
}
