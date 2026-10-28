package com.stalkerweb.android.data.repo

import java.text.Normalizer
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import kotlin.math.abs

// The time zones a connection can use — the web's lib/timezones.js: the list
// in shared/timezones.json (TimezoneList.kt), by the zones' current names,
// each with its country and its UTC offset now.

/** A zone as the picker shows and searches it. [offset] in minutes east of UTC (null: unknown). */
data class ZoneEntry(val id: String, val country: String, val offset: Int?, val label: String, val words: String, val countryWords: String, val city: String)

private val ACCENTS = Regex("\\p{M}+")
private val SEPARATORS = Regex("[_/]+")
private val SPACES = Regex("\\s+")
private val OFFSET = Regex("^(?:utc|gmt)?([+-])(\\d{1,2})(?::?(\\d{2}))?$")

// For matching: lower case, no accents, "_" and "/" as spaces.
private fun plain(s: String): String =
    Normalizer.normalize(s, Normalizer.Form.NFD).replace(ACCENTS, "").lowercase(Locale.ROOT).replace(SEPARATORS, " ").trim()

/** Whether Java knows a time zone by this name (one not in the list can still be used). */
fun isZone(name: String): Boolean = name.isNotBlank() && runCatching { ZoneId.of(name.trim()) }.isSuccess

/** A zone's UTC offset at [at], in minutes east; null for one Java doesn't know. */
fun offsetMinutes(zone: String, at: Instant = Instant.now()): Int? =
    runCatching { ZoneId.of(zone).rules.getOffset(at).totalSeconds / 60 }.getOrNull()

/** 330 → "UTC+05:30", −300 → "UTC−05:00", 0 → "UTC", null → "". */
fun offsetLabel(mins: Int?): String {
    if (mins == null) return ""
    if (mins == 0) return "UTC"
    val a = abs(mins)
    return String.format(Locale.ROOT, "UTC%s%02d:%02d", if (mins > 0) "+" else "−", a / 60, a % 60)
}

/** A zone's UTC offset now, as "UTC+01:00" ("" for one Java doesn't know). */
fun utcOffset(zone: String, at: Instant = Instant.now()): String = offsetLabel(offsetMinutes(zone, at))

/** A search that's an offset — "UTC+1", "+1", "-5", "gmt+5:30", "+0530", "UTC" — as minutes east; null otherwise. */
fun parseOffset(query: String): Int? {
    val q = query.trim().lowercase(Locale.ROOT).replace(SPACES, "").replace('−', '-')
    if (q == "utc" || q == "gmt" || q == "z") return 0
    val m = OFFSET.find(q) ?: return null
    val hours = m.groupValues[2].toInt()
    val minutes = m.groupValues[3].ifEmpty { "0" }.toInt()
    if (hours > 14 || minutes > 59) return null
    return (if (m.groupValues[1] == "-") -1 else 1) * (hours * 60 + minutes)
}

private fun entry(id: String, cc: String, at: Instant): ZoneEntry {
    val country = if (cc.isEmpty()) "" else Locale("", cc).getDisplayCountry(Locale.ENGLISH)
    val offset = offsetMinutes(id, at)
    return ZoneEntry(id, country, offset, offsetLabel(offset), plain("$id $country"), plain(country), plain(id.substringAfterLast('/')))
}

/**
 * The list as the picker shows and searches it, worked out once (the
 * offsets at [at]) — [current] added first if it isn't in it (a zone saved
 * before, or typed in).
 */
fun zoneEntries(current: String = "", at: Instant = Instant.now()): List<ZoneEntry> {
    val list = TIMEZONE_LIST.map { (id, cc) -> entry(id, cc, at) }
    return if (current.isBlank() || list.any { it.id == current }) list else listOf(entry(current, "", at)) + list
}

/**
 * The zones matching a search, best first. An offset ("UTC+1", "-5",
 * "+05:30") matches the zones at that offset now. Anything else: every word
 * in the zone's name or country, the ones whose city is it — or starts with
 * it — and its country by that name, ahead. An empty search keeps them all.
 */
fun filterZones(entries: List<ZoneEntry>, query: String): List<ZoneEntry> {
    parseOffset(query)?.let { off -> return entries.filter { it.offset == off } }
    val words = plain(query).split(SPACES).filter { it.isNotEmpty() }
    if (words.isEmpty()) return entries
    val q = words.joinToString(" ")
    return entries.mapNotNull { z ->
        if (!words.all { z.words.contains(it) }) return@mapNotNull null
        val score = when {
            z.city == q || z.countryWords == q -> 0
            z.city.startsWith(q) -> 1
            z.words.split(' ').any { it.startsWith(words[0]) } -> 2
            else -> 3
        }
        score to z
    }.sortedWith(compareBy<Pair<Int, ZoneEntry>> { it.first }.thenBy { it.second.id }).map { it.second }
}
