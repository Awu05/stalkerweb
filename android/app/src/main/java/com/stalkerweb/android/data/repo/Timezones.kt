package com.stalkerweb.android.data.repo

import java.text.Normalizer
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

// The time zones a connection can use — the web's lib/timezones.js.

/** Every IANA time zone Java knows ("Europe/London"…), with UTC; [current] too if it isn't one. In order. */
fun allTimezones(current: String = ""): List<String> {
    val zones = ZoneId.getAvailableZoneIds()
        // Java also lists old aliases ("SystemV/…", "Etc/GMT+5", "EST5EDT"): the region/city names are the ones to offer.
        .filter { it.contains('/') && !it.startsWith("Etc/") && !it.startsWith("SystemV/") }
        .toMutableSet()
    zones += "UTC"
    if (current.isNotBlank()) zones += current
    return zones.sorted()
}

/** A zone's UTC offset at [at]: "UTC+01:00", "UTC−05:00", "UTC" — "" for one Java doesn't know. */
fun utcOffset(zone: String, at: Instant = Instant.now()): String {
    val offset = runCatching { ZoneId.of(zone).rules.getOffset(at) }.getOrNull() ?: return ""
    if (offset == ZoneOffset.UTC) return "UTC"
    val secs = offset.totalSeconds
    val sign = if (secs < 0) "−" else "+"
    val abs = kotlin.math.abs(secs)
    return "UTC$sign%02d:%02d".format(abs / 3600, abs % 3600 / 60)
}

// For matching: lower case, no accents, "_" and "/" as spaces, the minus as "-".
private fun plain(s: String): String =
    Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "")
        .lowercase().replace(Regex("[_/]+"), " ").replace('−', '-').trim()

/**
 * The zones matching a search, best first: every word of it in the zone's
 * name or its UTC offset, the ones whose city starts with it ahead. An empty
 * search keeps them all, in order.
 */
fun filterTimezones(zones: List<String>, query: String, offsetOf: (String) -> String = { utcOffset(it) }): List<String> {
    val words = plain(query).split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return zones
    val q = words.joinToString(" ")
    return zones.mapNotNull { z ->
        val name = plain(z)
        val hay = "$name ${plain(offsetOf(z))}"
        if (!words.all { hay.contains(it) }) return@mapNotNull null
        val city = plain(z.substringAfterLast('/'))
        val score = when {
            city == q -> 0
            city.startsWith(q) -> 1
            name.split(' ').any { it.startsWith(words[0]) } -> 2
            else -> 3
        }
        score to z
    }.sortedWith(compareBy<Pair<Int, String>> { it.first }.thenBy { it.second }).map { it.second }
}
