package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Recording
import com.stalkerweb.android.data.api.RecordingDisk
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

/** The lengths offered: "until the programme ends" only with a guide end ([programmeEnd], ms) still to come. */
fun recordChoices(programmeEnd: Long?, now: Long): List<RecordChoice> =
    if (programmeEnd != null && programmeEnd > now) RECORD_CHOICES else RECORD_CHOICES.filter { it.id != "programme" }

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

/**
 * Scheduled (soonest first), recording, and done (newest first — failed and
 * missed too). Cancelled ones aren't shown — unless someone else cancelled it
 * ([Recording.stoppedBy]), so its owner sees who.
 */
fun groupRecordings(list: List<Recording>): RecordingGroups {
    fun by(vararg s: String) = list.filter { it.status in s }
    return RecordingGroups(
        scheduled = by("scheduled").sortedBy { it.startAt },
        recording = by("recording"),
        done = list.filter { it.status in setOf("done", "failed", "missed") || (it.status == "cancelled" && !it.stoppedBy.isNullOrBlank()) }
            .sortedByDescending { it.startAt },
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

/** The Recordings screen's disk line (the web's diskLine): what they take, what's free. */
fun diskLine(disk: RecordingDisk?): String {
    if (disk == null) return ""
    val free = disk.freeBytes?.let { "${size(it)} free" }
    if (disk.usedBytes <= 0) return free?.let { "$it for recordings" } ?: ""
    return listOfNotNull("Recordings use ${size(disk.usedBytes)}", free).joinToString(" · ")
}

private fun length(ms: Long): String {
    val m = maxOf(0L, Math.round(ms.toDouble() / MIN))
    return if (m < 60) "$m min" else "${m / 60} h ${"%02d".format(Locale.ROOT, m % 60)}"
}

/** How a recording was started, for its label (the web's sourceLabel): Manual or Scheduled. */
fun sourceLabel(r: Recording): String = when (r.source) {
    "manual" -> "Manual"
    "scheduled" -> "Scheduled"
    else -> ""
}

/**
 * The line under a recording's title. [zone]: for tests; else the device's. A booked one says how long it was
 * booked for: bookedMs (a part 2, after a restart, keeps its part 1's) or, from an older server, its start to end.
 */
fun recordingLabel(r: Recording, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
    val booked = if (r.source == "scheduled") (r.bookedMs ?: r.endAt?.let { it - r.startAt })?.let(::length) else null
    val of = booked?.let { " of $it" } ?: ""
    return when (r.status) {
        "scheduled" -> "${dayLabel(r.startAt, now, zone)} ${time(r.startAt, zone)}${r.endAt?.let { "–${time(it, zone)}" } ?: ""}${booked?.let { " · $it" } ?: ""}"
        "recording" -> "Recording · ${length(now - r.startAt)}$of · ${size(r.bytes)}"
        "done" -> "Recorded ${shortDate(r.startAt, zone)} · ${length((r.endedAt ?: r.endAt ?: now) - r.startAt)}$of · ${size(r.bytes)}" +
            (r.stoppedBy?.takeIf { it.isNotBlank() }?.let { " · Stopped by $it" } ?: "")
        "failed" -> "Failed — ${r.error?.takeIf { it.isNotBlank() } ?: "the recording didn't work"}"
        "missed" -> "Missed — the server wasn't running"
        "cancelled" -> r.stoppedBy?.takeIf { it.isNotBlank() }?.let { "Cancelled by $it" } ?: "Cancelled"
        else -> ""
    }
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
 * Whether one is recording, or booked to start within [RECORDING_SOON_MS]:
 * Solo's app follows the list meanwhile (RecordingsRepository.watch), to save
 * each one to Downloads as it finishes. Keeping the server up for them is the
 * server's own doing (recordingPlan, SoloServerService).
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

/**
 * The id of the recording being made on [channelId] in [list] (GET
 * /api/recordings) — started in this player, on another device or from the
 * guide — or null. The live player's Record button follows it (the web's recordingOn).
 */
fun recordingOn(list: List<Recording>, channelId: String): String? =
    list.firstOrNull { it.status == "recording" && it.channelId == channelId }?.id

/**
 * Where the app plays a recording from: in Solo, its copy in
 * Downloads/StalkerWeb once it's there ([copy], a content:// URI — the only
 * copy then); else the server's HLS ([serverUrl]). The remote apps always
 * play the server's.
 */
fun recordingPlayUrl(isSolo: Boolean, copy: String?, serverUrl: String): String =
    if (isSolo && !copy.isNullOrBlank()) copy else serverUrl

/** Solo: the private files deleted once a finished recording is saved to Downloads — the .ts and its index. */
fun privateFilesAfterPublish(tsPath: String): List<String> = listOf(tsPath, "$tsPath.index")

/** What deleting a recording in the app deletes on the device besides the server's: Solo's Downloads copy, or null. */
fun copyToDelete(isSolo: Boolean, copy: String?): String? = copy?.takeIf { isSolo && it.isNotBlank() }

/** A recording's name in the Downloads folder: the server's own file name. */
fun publicRecordingName(r: Recording): String =
    publicFileName(r.filePath.orEmpty().substringAfterLast('/').substringAfterLast('\\'))

/** What the Recordings screen says under its title: where recordings are made and kept. */
fun recordingsHint(isSolo: Boolean): String =
    if (isSolo) "Live TV recorded on this device while StalkerWeb Solo's server is running. Finished ones are saved to Downloads/StalkerWeb. Kept until you delete them."
    else "Live TV recorded on the server — even with every app closed. Kept until you delete them."

/**
 * Solo: the recordings that are this device's own ([Recording.mine], the
 * server's word) — the only ones it saves to Downloads/StalkerWeb, whatever
 * list it was handed.
 */
fun ownRecordings(list: List<Recording>): List<Recording> = list.filter { it.mine }

/**
 * Whether a list asked for with Everyone's recordings [asked] may be shown now
 * the switch is [current]: one asked for before it changed is dropped, so it
 * never overwrites the other mode's. (Who may delete one is the server's word:
 * [Recording.canDelete].)
 */
fun keepRecordingsResult(asked: Boolean, current: Boolean): Boolean = asked == current

/**
 * A finished recording's HLS on the server (routes/recordingFile.js), naming
 * this device's viewer — the player sends no X-Viewer, and the server applies
 * the viewer's channel filters to someone else's recording. Solo has no viewer id.
 */
fun recordingServerUrl(base: String, id: String, viewerId: String?): String {
    fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
    val viewer = viewerId?.takeIf { it.isNotBlank() }?.let { "?viewer=${enc(it)}" } ?: ""
    return "$base/proxy/recording/${enc(id)}/index.m3u8$viewer"
}
