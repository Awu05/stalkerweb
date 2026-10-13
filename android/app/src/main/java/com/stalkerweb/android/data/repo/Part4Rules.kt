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
/** The guide as the server sent it, without programmes missing a start or end (one mustn't fail the guide). */
fun guideEvents(raw: Map<String, List<com.stalkerweb.android.data.api.EpgEventJson>>): Map<String, List<EpgEvent>> =
    raw.mapValues { (_, events) -> cleanEvents(events.mapNotNull { it.toEvent() }) }

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
fun linksFor(base: String, shareToken: String?, viewerId: String?, httpsPort: Int?, viewerName: String? = null): List<AppLink> {
    // The Xtream API picks the viewer by username (as the web says).
    val user = viewerName?.takeIf { it.isNotBlank() }?.let { "the username $it" } ?: "any username"
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
        add(AppLink("Xtream Codes Server", origin, if (k.isNotEmpty()) "The server for Xtream apps, with $user and the Xtream password" else "The server for Xtream apps, with $user and any password"))
        if (k.isNotEmpty()) add(AppLink("Xtream Password", shareToken!!, "The password for Xtream apps, with $user. It allows playback only."))
        add(AppLink("Stremio Addon", "$stremioOrigin$k$vp/stremio/manifest.json"))
        add(AppLink("M3U Playlist", "$origin$k/api/m3u$vq"))
        add(AppLink("VLC Playlist", "$origin$k/api/xspf$vq"))
        add(AppLink("XMLTV EPG Guide", "$origin$k/api/xmltv$vq"))
    }
}

// ── Viewer filters (Settings → Viewers): checked = shown, saved = the unchecked ──

fun shownFrom(all: List<String>, hidden: List<String>): Set<String> { val h = hidden.toSet(); return all.filter { it !in h }.toSet() }
fun hiddenFrom(all: List<String>, shown: Set<String>): List<String> = all.filter { it !in shown }

/** How the server compares VOD category names: trimmed, any case (backend/lib/vodCategoryFilter.js). */
fun titleKey(title: String): String = title.trim().uppercase()

/** The checked names: not hidden by name (compared by [key]) nor by an old hidden language (the web's ChannelFilters). */
fun shownWith(all: List<String>, hidden: List<String>, languages: List<String>, key: (String) -> String = { it }): Set<String> {
    val h = hidden.map(key).toSet()
    val l = languages.map(::languageOf).filter { it.isNotEmpty() }.toSet()
    return all.filter { key(it) !in h && languageOf(it) !in l }.toSet()
}

data class FiltersToSave(val genres: List<String>, val vodCategories: List<String>, val languages: List<String>)

/**
 * What a viewer's checklists save. Showing a name an old hidden language covers
 * drops that language, and the rest of it stays hidden name by name (the web's
 * releaseLanguages). Hidden names not listed now (another portal's) are kept.
 */
fun filtersToSave(
    savedGenres: List<String>, savedVod: List<String>, savedLanguages: List<String>,
    allGenres: List<String>, shownGenres: Set<String>, allVod: List<String>, shownVod: Set<String>,
): FiltersToSave {
    val released = (shownGenres + shownVod).map(::languageOf).toSet()
    val kept = savedLanguages.filter { languageOf(it) !in released }
    val keptSet = kept.map(::languageOf).toSet()
    fun hidden(saved: List<String>, all: List<String>, shown: Set<String>, key: (String) -> String): List<String> {
        val savedKeys = saved.map(key).toSet()
        val listed = all.map(key).toSet()
        val unlisted = saved.filter { key(it) !in listed }
        val listedHidden = all.filter { it !in shown && (key(it) in savedKeys || languageOf(it) !in keptSet) }
        return (unlisted + listedHidden).distinctBy(key)
    }
    return FiltersToSave(hidden(savedGenres, allGenres, shownGenres) { it }, hidden(savedVod, allVod, shownVod, ::titleKey), kept)
}
/** What to save: the unchecked names, plus hidden names not listed now (another portal's, or a list still loading) — as the web keeps them. */
fun mergeHidden(saved: List<String>, all: List<String>, shown: Set<String>): List<String> {
    val listed = all.toSet()
    return (saved.filter { it !in listed } + hiddenFrom(all, shown)).distinct()
}

// ── Reminders ─────────────────────────────────────────────────────────────────

/** [portal]: the portal the channel is on (blank for reminders saved before that was kept). */
data class Reminder(val id: String, val channelId: String, val channelName: String, val title: String, val startTime: Long, val portal: String = "")

object ReminderRules {
    fun reminderFor(channelId: String, channelName: String, e: EpgEvent, portal: String = "") =
        Reminder("$channelId:${e.startTime}", channelId, channelName, e.title, e.startTime, portal)
    /** A minute before the start. */
    fun dueAtMs(r: Reminder): Long = (r.startTime - 60) * 1000
    /** Not started yet — a reminder for something already on is pointless. */
    fun isUpcoming(r: Reminder, nowMs: Long): Boolean = r.startTime * 1000 > nowMs
    fun upcoming(list: List<Reminder>, nowMs: Long): List<Reminder> = list.filter { isUpcoming(it, nowMs) }
    /** Its alarm is still ahead: one firing now (or just fired) mustn't be set again. */
    fun needsAlarm(r: Reminder, nowMs: Long): Boolean = dueAtMs(r) > nowMs
    /** The reminders for [portal]'s channels (and older ones that didn't record a portal). */
    fun forPortal(list: List<Reminder>, portal: String?): List<Reminder> = list.filter { it.portal.isEmpty() || it.portal == portal }
}
