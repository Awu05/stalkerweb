package com.stalkerweb.android.data.api

import com.squareup.moshi.JsonClass

// ── Live TV recordings (backend routes/recordings.js) ─────────────────────────

/**
 * One recording: booked, being made, or done. Times are ms, padding already
 * in; [endAt] null is "until stopped". [endedAt]: when it really stopped (one
 * stopped early). [filePath]: where the server keeps its .ts file.
 */
@JsonClass(generateAdapter = false)
data class Recording(
    val id: String,
    val viewerId: String? = null,
    val channelId: String = "",
    val channelName: String = "",
    val title: String = "",
    val startAt: Long = 0,
    val endAt: Long? = null,
    val status: String = "scheduled",       // scheduled | recording | done | failed | missed | cancelled
    val filePath: String? = null,
    val bytes: Long = 0,
    val error: String? = null,
    val partOf: String? = null,
    val endedAt: Long? = null,
    val createdAt: Long = 0,
    val viewerName: String? = null,
    /** Booked by this device's viewer (the server's word — Solo has no viewer id of its own). */
    val mine: Boolean = false,
    /** This viewer may delete it: its own, one whose viewer is gone, or — the admin — anyone's (the server decides). */
    val canDelete: Boolean = false,
    /** Who stopped or cancelled it, when that wasn't its owner. */
    val stoppedBy: String? = null,
)

/** What every recording takes on the server's disk, and what's free there (null: unknown). */
@JsonClass(generateAdapter = false)
data class RecordingDisk(val usedBytes: Long = 0, val freeBytes: Long? = null)

@JsonClass(generateAdapter = false)
data class RecordingsResponse(val recordings: List<Recording> = emptyList(), val disk: RecordingDisk? = null)

/**
 * A guide programme to record (POST /api/recordings): the server adds the
 * padding. [force]: one starting within 5 minutes with the stream limit in
 * use, asked and answered yes.
 */
@JsonClass(generateAdapter = false)
data class ScheduleRecordingRequest(
    val channelId: String,
    val channelName: String,
    val title: String,
    val startAt: Long,
    val endAt: Long,
    val force: Boolean = false,
)

/** Record a channel from now (POST /api/recordings/now); [endAt] null: until stopped. [force]: past the stream limit, asked. */
@JsonClass(generateAdapter = false)
data class RecordNowRequest(
    val channelId: String,
    val channelName: String,
    val title: String,
    val endAt: Long?,
    val force: Boolean = false,
)

@JsonClass(generateAdapter = false)
data class DeletedResponse(val deleted: String? = null)
