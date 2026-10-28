package com.stalkerweb.android.data.api

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

@JsonClass(generateAdapter = false)
data class Channel(
    val uniqueId: String,
    val number: Int = 0,
    val name: String = "", // favorites can return a bare-stub channel while the list is still loading
    @param:Json(name = "iconPath") val logo: String? = null,
    val genre: String? = null,
    val genreId: String? = null,
    // The id this channel had before uniqueId became the portal's own id. Sent
    // by newer backends only, hence the default. Used once, on first run after
    // the switch, to move locally-keyed data (stream overrides, watch history)
    // onto the new ids — see AppPrefs.migrateLegacyChannelIds.
    val legacyId: String? = null,
)

@JsonClass(generateAdapter = false)
data class ChannelsResponse(
    val channels: List<Channel>,
    val total: Int = 0,
)

@JsonClass(generateAdapter = false)
data class FavoritesResponse(
    val channels: List<Channel>,
    val groups: List<FavoriteGroup> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class FavoriteGroup(
    val id: String,
    val name: String,
    val channels: List<Channel>,
)

@JsonClass(generateAdapter = false)
data class StatusResponse(
    val connected: Boolean,
    val portal: String? = null,
    val mac: String? = null,
)

@JsonClass(generateAdapter = false)
data class AddFavoriteRequest(
    val uniqueId: String,
)

@JsonClass(generateAdapter = false)
data class Group(
    val id: String,
    val name: String,
)

@JsonClass(generateAdapter = false)
data class GroupsResponse(
    val groups: List<Group>,
)

@JsonClass(generateAdapter = false)
data class NowInfo(
    val title: String,
    val startTime: Long,
    val endTime: Long,
)

@JsonClass(generateAdapter = false)
data class NextInfo(
    val title: String = "",
    val startTime: Long? = null,
)

@JsonClass(generateAdapter = false)
data class NowNextEntry(
    val now: NowInfo,
    val next: NextInfo? = null,
)

// ── Settings → Activity (backend routes/activity.js) ──────────────────────────

@JsonClass(generateAdapter = false)
data class ActivityViewer(val id: String, val name: String, val color: String? = null)

/** A stream playing now: kind live | vod (an episode's id is show:season:episode); via app | cast | xtream | link. */
@JsonClass(generateAdapter = false)
data class ActivityStream(
    val kind: String,
    val id: String,
    val via: String = "app",
    val title: String = "",
    val subtitle: String = "",
    val viewer: ActivityViewer? = null,
    val device: String = "",
    val ip: String = "",
    val startedAt: Long = 0,
    val lastSeen: Long = 0,
)

@JsonClass(generateAdapter = false)
data class ActivityPortal(val connected: Boolean = false, val host: String? = null, val openStreams: Int = 0, val casting: Int = 0)

@JsonClass(generateAdapter = false)
data class ActivityDownload(val title: String, val percent: Int? = null)

@JsonClass(generateAdapter = false)
data class ActivityResponse(
    val streams: List<ActivityStream> = emptyList(),
    val portal: ActivityPortal = ActivityPortal(),
    val downloads: List<ActivityDownload> = emptyList(),
    val now: Long = 0,
)

// ── Settings ──────────────────────────────────────────────────────────────────

@JsonClass(generateAdapter = false)
data class SettingsResponse(
    @param:Json(name = "epg_enabled") val epgEnabled: Boolean = true,
    @param:Json(name = "vod_enabled") val vodEnabled: Boolean = true,
    // With ACCESS_KEY set on the server: the playback-only token for links.
    @param:Json(name = "access_share_token") val accessShareToken: String? = null,
    @param:Json(name = "download_dir") val downloadDir: String = "",
    @param:Json(name = "idle_timeout_minutes") val idleTimeoutMinutes: Int? = null,
    @param:Json(name = "https_port") val httpsPort: Int? = null,
    @param:Json(name = "live_buffer_seconds") val liveBufferSeconds: Int = 0,
    @param:Json(name = "access_enabled") val accessEnabled: Boolean = false,
    @param:Json(name = "stbemu_stb_model") val stbModel: String = "",
    @param:Json(name = "stbemu_firmware") val firmware: String = "",
)

// ── VOD ───────────────────────────────────────────────────────────────────────

@JsonClass(generateAdapter = false)
data class VodCategory(
    val id: String,
    val title: String,
    val alias: String = "",
)

@JsonClass(generateAdapter = false)
data class VodCategoriesResponse(
    val categories: List<VodCategory> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class VodItem(
    val id: String,
    val name: String = "",
    val description: String = "",
    val year: String = "",
    val durationMin: Int = 0,
    val isHD: Boolean = false,
    val isSeries: Boolean = false,
    val screenshotUrl: String? = null,
    val cmd: String = "",
    // For the VOD filters and My List (backend VodManager._normalizeItem); empty when the portal sends none.
    val genres: List<String> = emptyList(),
    val rating: Double = 0.0,
    val added: String = "",
    val episodes: List<String> = emptyList(),
    val director: String = "",
    val actors: String = "",
)

@JsonClass(generateAdapter = false)
data class VodItemsResponse(
    val items: List<VodItem> = emptyList(),
    val totalItems: Int = 0,
    val totalPages: Int = 1,
    val page: Int = 1,
)

@JsonClass(generateAdapter = false)
data class VodSeason(
    val id: String,
    val name: String = "",
    val seasonNumber: String = "",
    val screenshotUrl: String? = null,
)

@JsonClass(generateAdapter = false)
data class VodSeasonsResponse(
    val seasons: List<VodSeason> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class VodEpisode(
    val episodeId: String,
    val seriesNumber: String = "",
    val name: String = "",
    val screenshotUrl: String? = null,
)

@JsonClass(generateAdapter = false)
data class VodEpisodesResponse(
    val episodes: List<VodEpisode> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class VodStreamResponse(
    val streamUrl: String,
    val videoId: String = "",
    val isHls: Boolean = true,
)

/** A link a cast device opens itself (backend lib/castLink.js). reachable: false when the server was reached as localhost. */
@JsonClass(generateAdapter = false)
data class CastLink(
    val url: String,
    val contentType: String,
    val live: Boolean = false,
    val reachable: Boolean = true,
)

// Live-channel stream resolution. `streamType` is the backend's engine hint
// (hls | mpegts | native | unsupported) so the player can pick the right
// container/MIME instead of assuming HLS for everything.
@JsonClass(generateAdapter = false)
data class StreamResponse(
    val streamUrl: String,
    val channelId: String = "",
    val channelName: String = "",
    val streamType: String = "hls",
)

// ── Portal connect / disconnect ───────────────────────────────────────────────

/**
 * Mirrors the body the web Setup page posts, which is the whole saved profile.
 *
 * Sending only portal/mac/timezone/lang is not equivalent: the backend fills
 * the absent fields with defaults that contradict the profile — most damagingly
 * `send_device_id: undefined !== false` becomes true, and serial_number/device_id
 * fall back to a generic STB identity. A portal that has the account bound to a
 * specific device then rejects the handshake, so a profile that connects fine
 * from the web UI fails here with a 401.
 *
 * The defaults below reproduce the backend's own defaults, so the manual
 * portal+MAC form behaves exactly as it did before.
 */
@JsonClass(generateAdapter = false)
data class PortalConnectRequest(
    val portal: String,
    val mac: String,
    val timezone: String = "Europe/London",
    val lang: String = "en",
    val login: String = "",
    val password: String = "",
    val token: String = "",
    @param:Json(name = "serial_number")    val serialNumber: String = "",
    @param:Json(name = "device_id")        val deviceId: String = "",
    @param:Json(name = "device_id2")       val deviceId2: String = "",
    val signature: String = "",
    @param:Json(name = "portal_signature") val portalSignature: String = "",
    @param:Json(name = "send_device_id")   val sendDeviceId: Boolean = true,
    @param:Json(name = "send_device_id2")  val sendDeviceId2: Boolean = true,
    @param:Json(name = "connection_timeout") val connectionTimeout: Int = 10,
)

@JsonClass(generateAdapter = false)
data class PortalActionResponse(
    val success: Boolean = false,
    val error: String? = null,
    val token: String? = null, // present on /connect and /reconnect success
)

@JsonClass(generateAdapter = false)
data class PortalConfigResponse(
    val portal: String? = null,
    val mac: String? = null,
    val timezone: String? = null,
    val lang: String? = null,
)

// ── Portal profiles ────────────────────────────────────────────────────────
// Saved portal connections, shared across every client via the backend
// (see backend/profiles/ProfilesManager.js) — picking one here does the same
// thing the web UI's Setup page does: connect + mark it the active profile.

// The device-identity fields matter as much as portal/mac: a portal can bind an
// account to a specific STB identity, and connecting without them (or with
// send_device_id flipped on) is rejected. They're carried through to
// PortalConnectRequest verbatim — see ServerRepository.connectProfile.
@JsonClass(generateAdapter = false)
data class Profile(
    val id: String,
    val name: String = "",
    val portal: String = "",
    val mac: String = "",
    val timezone: String = "Europe/London",
    val lang: String = "en",
    val login: String = "",
    val password: String = "",
    val token: String = "",
    @param:Json(name = "serial_number")    val serialNumber: String = "",
    @param:Json(name = "device_id")        val deviceId: String = "",
    @param:Json(name = "device_id2")       val deviceId2: String = "",
    val signature: String = "",
    @param:Json(name = "portal_signature") val portalSignature: String = "",
    @param:Json(name = "send_device_id")   val sendDeviceId: Boolean = true,
    @param:Json(name = "send_device_id2")  val sendDeviceId2: Boolean = true,
    @param:Json(name = "connection_timeout") val connectionTimeout: Int = 10,
    /** The box's UID (its System information screen): only to make device IDs from (DeviceId.kt). */
    val uid: String = "",
    /** How the device IDs are made ("typed", "mac", "mac-plain", "serial", "uid" — the web's names); "": not saved yet. */
    @param:Json(name = "device_id_source") val deviceIdSource: String = "",
    val disabledGenres: List<String> = emptyList(),
    // Coarser than disabledGenres and applied to VOD too (server-side). Hides
    // every genre whose "LANGUAGE | SECTION" name starts with one of these.
    val disabledLanguages: List<String> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class ProfilesResponse(
    val profiles: List<Profile> = emptyList(),
    val activeProfileId: String? = null,
)

@JsonClass(generateAdapter = false)
data class SetActiveProfileRequest(val id: String?)

/** A channel's recent stream failures (backend /api/channels/health). */
@JsonClass(generateAdapter = false)
data class ChannelHealth(
    val errors: Int = 0,
    val lastError: String? = null,
)

@JsonClass(generateAdapter = false)
data class NameRequest(val name: String)

@JsonClass(generateAdapter = false)
data class OrderRequest(val order: List<String>)

@JsonClass(generateAdapter = false)
data class LogoOverrideRequest(val name: String, val url: String)

/** The logo the server finds for a name (backend routes/logos.js /check). */
@JsonClass(generateAdapter = false)
data class LogoCheck(val logo: String? = null, val name: String? = null)

/** A programme in the guide (backend GuideManager.getChannelEvents); times in seconds. */
@JsonClass(generateAdapter = false)
data class EpgEvent(
    val id: Long? = null,
    val title: String = "",
    val startTime: Long = 0,
    val endTime: Long = 0,
    val description: String = "",
)

// ── The player's Stats (backend GET /api/activity/delivery) ──────────────────

/** mode: direct | relayed | repackaged | converted (data/repo/StreamStats.kt deliveryText). */
@JsonClass(generateAdapter = false)
data class StreamDelivery(val mode: String = "", val detail: String = "")

@JsonClass(generateAdapter = false)
data class DeliveryResponse(val delivery: StreamDelivery? = null)

// Skip intro / recap / credits (GET api/vod/skip): each part's start and end
// in seconds, or null where none is known.
@JsonClass(generateAdapter = false)
data class SkipPart(val start: Double = 0.0, val end: Double = 0.0)

@JsonClass(generateAdapter = false)
data class SkipResponse(
    val imdbId: String? = null,
    val intro: SkipPart? = null,
    val recap: SkipPart? = null,
    val outro: SkipPart? = null,
    /** The viewer's choice: intros and recaps skipped without asking. */
    val autoSkip: Boolean = false,
)

// Online subtitles for a movie or episode (GET api/vod/subtitles), from the
// site chosen in Settings ([SubtitlesResponse.provider]).
@JsonClass(generateAdapter = false)
data class OnlineSubtitle(
    val fileId: String,
    val language: String = "",
    val label: String = "",
    val downloads: Int = 0,
    val hearingImpaired: Boolean = false,
    val machine: Boolean = false,
)

@JsonClass(generateAdapter = false)
data class SubtitlesResponse(
    val configured: Boolean = false,
    /** "Wyzie Subs" or "OpenSubtitles". */
    val provider: String = "",
    val imdbId: String? = null,
    val results: List<OnlineSubtitle> = emptyList(),
    val error: String? = null,
)
