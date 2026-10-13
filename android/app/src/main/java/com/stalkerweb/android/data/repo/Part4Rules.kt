package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.EpgEvent
import java.net.URI
import java.net.URLEncoder
import java.util.Locale

// ── Guide ─────────────────────────────────────────────────────────────────────

/** Where a programme sits on the guide's timeline: minutes from the window start, and its length. */
data class Span(val offsetMinutes: Float, val durationMinutes: Float)

/** The start of the [slotMinutes] slot holding [nowSecs]. */
fun slotStart(nowSecs: Long, slotMinutes: Int = 30): Long = nowSecs - nowSecs % (slotMinutes * 60L)

/** [event] clipped to the window, or null when it's outside it. */
fun eventSpan(event: EpgEvent, windowStart: Long, windowEnd: Long): Span? {
    val s = maxOf(event.startTime, windowStart)
    val e = minOf(event.endTime, windowEnd)
    if (e <= s) return null
    return Span((s - windowStart) / 60f, (e - s) / 60f)
}

/** The programme airing at [timeSecs]. */
/** A channel's programmes in time order, without duplicates (portals send some) or empty ones. */
fun cleanEvents(events: List<EpgEvent>): List<EpgEvent> =
    events.filter { it.endTime > it.startTime }.sortedBy { it.startTime }.distinctBy { it.startTime }

fun eventAt(events: List<EpgEvent>, timeSecs: Long): EpgEvent? = events.firstOrNull { it.startTime <= timeSecs && it.endTime > timeSecs }

/** How far through [event] [nowSecs] is, 0–1. */
fun progressOf(event: EpgEvent, nowSecs: Long): Float {
    val span = (event.endTime - event.startTime).coerceAtLeast(1)
    return ((nowSecs - event.startTime).toFloat() / span).coerceIn(0f, 1f)
}

// ── Downloads ─────────────────────────────────────────────────────────────────

/** The payload of a server-sent event line ("data: …"), or null for comments and blanks. */
fun parseSseData(line: String): String? = if (line.startsWith("data:")) line.removePrefix("data:").trimStart() else null

/** "512 B", "1.5 KB", "12.3 MB", "2.0 GB". */
fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val units = listOf("KB", "MB", "GB", "TB")
    var v = bytes / 1024.0
    var i = 0
    while (v >= 1024 && i < units.size - 1) { v /= 1024; i++ }
    return String.format(Locale.ROOT, "%.1f %s", v, units[i])
}

// ── Links (Settings → Links), as the web's Setup page builds them ────────────

data class AppLink(val label: String, val url: String, val hint: String = "")

/**
 * This viewer's links for IPTV apps. With an access key, they carry the
 * playback-only token (/k/<token>); Stremio wants https, so with an HTTPS port
 * its link uses it.
 */
fun linksFor(base: String, shareToken: String?, viewerId: String?, httpsPort: Int?): List<AppLink> {
    val origin = base.trimEnd('/')
    val k = shareToken?.takeIf { it.isNotBlank() }?.let { "/k/$it" } ?: ""
    val id = viewerId?.takeIf { it.isNotBlank() }?.let { URLEncoder.encode(it, "UTF-8") }
    val vq = id?.let { "?viewer=$it" } ?: ""
    val vp = id?.let { "/v/$it" } ?: ""
    val stremioOrigin = runCatching {
        val u = URI(origin)
        if (u.scheme == "http" && httpsPort != null) "https://${u.host}:$httpsPort" else origin
    }.getOrDefault(origin)
    return buildList {
        add(AppLink("Xtream Codes Server", origin, "Server address for Xtream-compatible apps"))
        if (k.isNotEmpty()) add(AppLink("Xtream Password", shareToken!!, "Any username; this as the password"))
        add(AppLink("Stremio Addon", "$stremioOrigin$k$vp/stremio/manifest.json"))
        add(AppLink("M3U Playlist", "$origin$k/api/m3u$vq"))
        add(AppLink("VLC Playlist", "$origin$k/api/xspf$vq"))
        add(AppLink("XMLTV EPG Guide", "$origin$k/api/xmltv$vq"))
    }
}

// ── Viewer filters (Settings → Viewers): checked = shown, saved = the unchecked ──

fun shownFrom(all: List<String>, hidden: List<String>): Set<String> { val h = hidden.toSet(); return all.filter { it !in h }.toSet() }
fun hiddenFrom(all: List<String>, shown: Set<String>): List<String> = all.filter { it !in shown }
/** What to save: the unchecked names, plus hidden names not listed now (another portal's, or a list still loading) — as the web keeps them. */
fun mergeHidden(saved: List<String>, all: List<String>, shown: Set<String>): List<String> {
    val listed = all.toSet()
    return (saved.filter { it !in listed } + hiddenFrom(all, shown)).distinct()
}

// ── Reminders ─────────────────────────────────────────────────────────────────

data class Reminder(val id: String, val channelId: String, val channelName: String, val title: String, val startTime: Long)

object ReminderRules {
    fun reminderFor(channelId: String, channelName: String, e: EpgEvent) =
        Reminder("$channelId:${e.startTime}", channelId, channelName, e.title, e.startTime)
    /** A minute before the start. */
    fun dueAtMs(r: Reminder): Long = (r.startTime - 60) * 1000
    /** Not started yet — a reminder for something already on is pointless. */
    fun isUpcoming(r: Reminder, nowMs: Long): Boolean = r.startTime * 1000 > nowMs
    fun upcoming(list: List<Reminder>, nowMs: Long): List<Reminder> = list.filter { isUpcoming(it, nowMs) }
}
