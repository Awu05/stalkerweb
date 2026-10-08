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
    val title: String,
    val startTime: Long,
)

@JsonClass(generateAdapter = false)
data class NowNextEntry(
    val now: NowInfo,
    val next: NextInfo? = null,
)

// ── Settings ──────────────────────────────────────────────────────────────────

@JsonClass(generateAdapter = false)
data class SettingsResponse(
    @param:Json(name = "epg_enabled") val epgEnabled: Boolean = true,
    @param:Json(name = "vod_enabled") val vodEnabled: Boolean = true,
    // With ACCESS_KEY set on the server: the playback-only token for links.
    @param:Json(name = "access_share_token") val accessShareToken: String? = null,
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
// PortalConnectRequest verbatim — see ChannelRepository.connectProfile.
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
