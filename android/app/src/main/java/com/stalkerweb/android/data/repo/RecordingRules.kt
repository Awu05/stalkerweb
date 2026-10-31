package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Recording
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

// Live TV recordings (the server's recordings/): the Recordings screen's
// groups and lines, and when a "Record now" ends. The web's lib/recordings.js
// says the same, for the same inputs (RecordingRulesTest has its cases).

private const val MIN = 60_000L

/** One of "Record now"'s lengths. */
data class RecordChoice(val id: String, val label: String)

/** What "Record now" offers, in order. */
val RECORD_CHOICES = listOf(
    RecordChoice("programme", "Until the programme ends"),
    RecordChoice("30", "30 minutes"),
    RecordChoice("60", "1 hour"),
    RecordChoice("120", "2 hours"),
    RecordChoice("stop", "Until I stop it"),
)

/** When a recording started [now] ends: ms, or null for "until stopped". No guide end (or one gone by): an hour. */
fun endForChoice(choice: String, now: Long, programmeEnd: Long? = null): Long? = when (choice) {
    "stop" -> null
    "programme" -> if (programmeEnd != null && programmeEnd > now) programmeEnd else now + 60 * MIN
    else -> now + (choice.toIntOrNull()?.takeIf { it > 0 } ?: 60) * MIN
}

/** The Recordings screen's three lists. */
data class RecordingGroups(val scheduled: List<Recording>, val recording: List<Recording>, val done: List<Recording>) {
    val isEmpty: Boolean get() = scheduled.isEmpty() && recording.isEmpty() && done.isEmpty()
}

/** Scheduled (soonest first), recording, and done (newest first — failed and missed too); cancelled ones aren't shown. */
fun groupRecordings(list: List<Recording>): RecordingGroups {
    fun by(vararg s: String) = list.filter { it.status in s }
    return RecordingGroups(
        scheduled = by("scheduled").sortedBy { it.startAt },
        recording = by("recording"),
        done = by("done", "failed", "missed").sortedByDescending { it.startAt },
    )
}

// English names, as the web's en-GB dates: the same words whatever the device's language.
private val DAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

private fun at(ms: Long, zone: ZoneId) = Instant.ofEpochMilli(ms).atZone(zone)
private fun time(ms: Long, zone: ZoneId) = at(ms, zone).let { "%02d:%02d".format(Locale.ROOT, it.hour, it.minute) }
private fun shortDate(ms: Long, zone: ZoneId) = at(ms, zone).let { "${it.dayOfMonth} ${MONTHS[it.monthValue - 1]}" }

private fun dayLabel(ms: Long, now: Long, zone: ZoneId): String {
    val day = at(ms, zone).toLocalDate()
    val today = at(now, zone).toLocalDate()
    return when (day) {
        today -> "Today"
        today.plusDays(1) -> "Tomorrow"
        else -> "${DAYS[day.dayOfWeek.value - 1]} ${shortDate(ms, zone)}"
    }
}

private fun size(bytes: Long): String =
    if (bytes >= 1024L * 1024 * 1024) "%.1f GB".format(Locale.ROOT, bytes / (1024.0 * 1024 * 1024))
    else "${maxOf(0L, Math.round(bytes / (1024.0 * 1024)))} MB"

private fun length(ms: Long): String {
    val m = maxOf(0L, Math.round(ms.toDouble() / MIN))
    return if (m < 60) "$m min" else "${m / 60} h ${"%02d".format(Locale.ROOT, m % 60)}"
}

/** The line under a recording's title. [zone]: for tests; else the device's. */
fun recordingLabel(r: Recording, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String = when (r.status) {
    "scheduled" -> "${dayLabel(r.startAt, now, zone)} ${time(r.startAt, zone)}${r.endAt?.let { "–${time(it, zone)}" } ?: ""}"
    "recording" -> "Recording · ${length(now - r.startAt)} · ${size(r.bytes)}"
    "done" -> "Recorded ${shortDate(r.startAt, zone)} · ${length((r.endedAt ?: r.endAt ?: now) - r.startAt)} · ${size(r.bytes)}"
    "failed" -> "Failed — ${r.error?.takeIf { it.isNotBlank() } ?: "the recording didn't work"}"
    "missed" -> "Missed — the server wasn't running"
    else -> ""
}

/**
 * Where a recording was left, to keep on this device (AppPrefs) — not in the
 * server's Continue Watching (a recording isn't a VOD title). Null once it's
 * near the end (95%): finished, nothing to resume. Seconds.
 */
fun recordingPositionToKeep(position: Double, duration: Double): Double? =
    if (duration > 0 && position < duration * WatchRules.DONE_FRACTION) position else null

/** How soon before a booked recording Solo starts keeping its server up for it. */
const val RECORDING_SOON_MS = 15 * MIN

/**
 * Whether Solo's server must be kept up (SoloHold.RECORDING): one is
 * recording, or one is booked to start within [RECORDING_SOON_MS]. Solo
 * records on the device, so with the server stopped nothing records.
 */
fun recordingNeedsServer(list: List<Recording>, now: Long): Boolean =
    list.any { it.status == "recording" || (it.status == "scheduled" && it.startAt - now <= RECORDING_SOON_MS) }

/**
 * Solo: the finished recordings to save to Downloads/StalkerWeb, not yet
 * saved (by id, or let go as gone: goneKey). Only the .ts — never the index
 * beside it, which is the server's own — and not one with nothing in it.
 */
fun recordingsToPublish(list: List<Recording>, published: Set<String>): List<Recording> = list.filter {
    it.status == "done" && it.bytes > 0 && it.filePath?.endsWith(".ts", ignoreCase = true) == true &&
        it.id !in published && goneKey(it.id) !in published
}

/** A recording's name in the Downloads folder: the server's own file name. */
fun publicRecordingName(r: Recording): String =
    publicFileName(r.filePath.orEmpty().substringAfterLast('/').substringAfterLast('\\'))

/** What the Recordings screen says under its title: where recordings are made and kept. */
fun recordingsHint(isSolo: Boolean): String =
    if (isSolo) "Live TV recorded on this device while StalkerWeb Solo's server is running. Finished ones are also saved to Downloads/StalkerWeb. Kept until you delete them."
    else "Live TV recorded on the server — even with every app closed. Kept until you delete them."
