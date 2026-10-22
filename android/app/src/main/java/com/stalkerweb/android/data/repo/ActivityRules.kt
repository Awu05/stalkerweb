package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.ActivityPortal
import com.stalkerweb.android.data.api.ActivityStream

// ── Settings → Activity: the words for what's playing (the web's lib/activity.js) ──

/** How long something has played: "just now", "12 min", "1 h 5 min". */
fun playingFor(startedAt: Long, now: Long): String {
    val mins = ((now - startedAt).coerceAtLeast(0) / 60_000).toInt()
    if (mins < 1) return "just now"
    if (mins < 60) return "$mins min"
    val h = mins / 60
    val m = mins % 60
    return if (m > 0) "$h h $m min" else "$h h"
}

/** The badge: Live, Movie, Episode — on a TV, "Cast". */
fun kindLabel(s: ActivityStream): String = when {
    s.via == "cast" -> "Cast"
    s.kind == "live" -> "Live"
    s.id.contains(':') -> "Episode"
    else -> "Movie"
}

/** How it got here: an Xtream player, a playlist link, a TV — or nothing for the app or a browser. */
fun viaLabel(s: ActivityStream): String = when (s.via) {
    "cast" -> "cast to a TV"
    "xtream" -> "Xtream player"
    "link" -> "playlist link"
    else -> ""
}

/** "portal.example · 2 open streams · 1 channel cast to a TV". */
fun portalSummary(p: ActivityPortal): String {
    if (!p.connected) return "Portal not connected"
    val parts = mutableListOf(p.host ?: "Portal")
    parts += if (p.openStreams == 1) "1 open stream" else "${p.openStreams} open streams"
    if (p.casting > 0) parts += if (p.casting == 1) "1 channel cast to a TV" else "${p.casting} channels cast to a TV"
    return parts.joinToString(" · ")
}
