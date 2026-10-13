package com.stalkerweb.android.data.api

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

// ── Guide ─────────────────────────────────────────────────────────────────────
@JsonClass(generateAdapter = false)
data class EpgResponse(
    val period: Int = 24,
    val channelCount: Int = 0,
    val epg: Map<String, List<EpgEvent>> = emptyMap(),
)

// ── Downloads (backend downloads/DownloadManager.js) ──────────────────────────
@JsonClass(generateAdapter = false)
data class DownloadJob(
    val id: String,
    val title: String = "",
    val seriesTitle: String = "",
    val status: String = "queued",          // queued | downloading | done | error | canceled
    val bytesDownloaded: Long = 0,
    val totalBytes: Long = 0,
    val error: String? = null,
    val createdAt: Long = 0,
)

@JsonClass(generateAdapter = false)
data class DownloadsResponse(val downloads: List<DownloadJob> = emptyList())

/** One title to download on the server (a movie, or an episode with its season). */
@JsonClass(generateAdapter = false)
data class DownloadItem(
    val videoId: String,
    val cmd: String = "",
    val series: String = "0",
    val seasonId: String = "",
    val episodeId: String = "",
    val title: String,
    val seriesTitle: String = "",
)

@JsonClass(generateAdapter = false)
data class DownloadRequest(val items: List<DownloadItem>)

// ── Settings ──────────────────────────────────────────────────────────────────
/** Changes to the shared settings (POST /api/settings); null fields are left as they are. */
@JsonClass(generateAdapter = false)
data class SettingsUpdate(
    @param:Json(name = "epg_enabled") val epgEnabled: Boolean? = null,
    @param:Json(name = "vod_enabled") val vodEnabled: Boolean? = null,
    @param:Json(name = "download_dir") val downloadDir: String? = null,
    @param:Json(name = "idle_timeout_minutes") val idleTimeoutMinutes: Int? = null,
    @param:Json(name = "live_buffer_seconds") val liveBufferSeconds: Int? = null,
)

@JsonClass(generateAdapter = false)
data class ViewerUpdate(val name: String? = null, val color: String? = null)

@JsonClass(generateAdapter = false)
data class ViewerFiltersRequest(
    val disabledGenres: List<String>,
    val disabledVodCategories: List<String>,
    val showAdult: Boolean,
)

@JsonClass(generateAdapter = false)
data class LogoStats(
    @param:Json(name = "db_size") val dbSize: Int = 0,
    @param:Json(name = "overrides_count") val overridesCount: Int = 0,
    @param:Json(name = "total_channels") val totalChannels: Int = 0,
    @param:Json(name = "matched_channels") val matchedChannels: Int = 0,
)

@JsonClass(generateAdapter = false)
data class LogosInfo(val overrides: Map<String, String> = emptyMap(), val stats: LogoStats = LogoStats())

@JsonClass(generateAdapter = false)
data class StripWordsResponse(val stripWords: List<String> = emptyList())

@JsonClass(generateAdapter = false)
data class WordRequest(val word: String)
