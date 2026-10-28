package com.stalkerweb.android.data.api

import com.squareup.moshi.JsonClass

// What a viewer watched on the VOD pages, per portal — backend viewers/WatchStore.js.
// Every /api/vod/watch call answers with the whole state.

@JsonClass(generateAdapter = false)
data class ProgressEntry(
    val key: String,
    val title: String = "",
    val episodeTitle: String = "",
    val screenshotUrl: String = "",
    val params: String = "",
    val position: Double = 0.0,
    val duration: Double = 0.0,
    val updatedAt: Long = 0,
)

@JsonClass(generateAdapter = false)
data class HistoryEntry(
    val id: String,
    val key: String = "",
    val title: String = "",
    val episodeTitle: String = "",
    val screenshotUrl: String = "",
    val params: String = "",
    val position: Double = 0.0,
    val duration: Double = 0.0,
    val finished: Boolean = false,
    val updatedAt: Long = 0,
)

@JsonClass(generateAdapter = false)
data class ListEntry(
    val id: String,
    val item: VodItem,
    val addedAt: Long = 0,
    val completedAt: Long? = null,
)

@JsonClass(generateAdapter = false)
data class WatchState(
    val progress: List<ProgressEntry> = emptyList(),
    val history: List<HistoryEntry> = emptyList(),
    val watched: List<String> = emptyList(),
    /** Keys of episodes finished, or ticked by hand (newer servers). */
    val watchedEpisodes: List<String> = emptyList(),
    val list: List<ListEntry> = emptyList(),
)

/** A position reached. */
@JsonClass(generateAdapter = false)
data class SaveWatchRequest(
    val key: String,
    val title: String,
    val episodeTitle: String,
    val screenshotUrl: String,
    val params: String,
    val position: Double,
    val duration: Double,
)

@JsonClass(generateAdapter = false)
data class CompletedRequest(val completed: Boolean)

@JsonClass(generateAdapter = false)
data class EpisodeWatchedRequest(val watched: Boolean)

/** A category's whole listing, as read so far (backend routes/vod.js /listing). */
@JsonClass(generateAdapter = false)
data class ListingResponse(
    val items: List<VodItem> = emptyList(),
    val loaded: Int = 0,
    val total: Int = 0,
    val complete: Boolean = false,
    val partial: Boolean = false,
    val error: String? = null,
)
