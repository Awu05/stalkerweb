package com.stalkerweb.android.data.repository

import com.stalkerweb.android.data.api.AddFavoriteRequest
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.Group
import com.stalkerweb.android.data.api.NowNextEntry
import com.stalkerweb.android.data.api.PortalActionResponse
import com.stalkerweb.android.data.api.PortalConfigResponse
import com.stalkerweb.android.data.api.PortalConnectRequest
import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.data.api.ProfilesResponse
import com.stalkerweb.android.data.api.SetActiveProfileRequest
import com.stalkerweb.android.data.api.StalkerApi
import com.stalkerweb.android.data.api.StatusResponse
import com.stalkerweb.android.data.api.VodCategory
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodItemsResponse
import com.stalkerweb.android.data.api.VodSeason
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.data.prefs.WatchedChannel
import android.os.SystemClock
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The active profile's hide rules. Genres match by exact name; languages match
 * the "LANGUAGE | SECTION" prefix, which is the only part that lines up between
 * channel genres and VOD categories.
 */
private data class ProfileFilters(
    val genres: Set<String> = emptySet(),
    val languages: Set<String> = emptySet(),
) {
    fun isEmpty() = genres.isEmpty() && languages.isEmpty()

    /** True when a genre/group name survives both filters. A channel with no
     *  genre is always kept — there's nothing to match it against. */
    fun allows(name: String?): Boolean {
        if (name == null) return true
        return name !in genres && languageOf(name) !in languages
    }
}

/** The language half of a "LANGUAGE | SECTION" name, normalised for comparison.
 *  Portal titles carry stray whitespace and inconsistent case, hence both. */
private fun languageOf(name: String): String =
    name.substringBefore('|').trim().uppercase()

/** A resolved live stream: its absolute URL and the engine hint for the player. */
data class StreamInfo(val url: String, val type: String)

class ChannelRepository(private val prefs: AppPrefs) {

    private var api: StalkerApi? = null

    /** Called once on app start — restores a previously saved URL. */
    fun initFromPrefs() {
        val url = prefs.serverUrl ?: return
        api = runCatching { StalkerApi.create(url, prefs.accessKey) }.getOrElse {
            // Stored URL is somehow invalid (e.g. data corruption). Clear it so
            // the user lands on the Setup screen rather than crashing on every launch.
            prefs.serverUrl = null
            null
        }
    }

    /** Persists the URL and access key, and rebuilds the Retrofit client. */
    fun setServerUrl(url: String, accessKey: String? = null) {
        val normalized = url.trimEnd('/')
        val key = accessKey?.trim()?.ifEmpty { null }
        // Drop the cached channel/logo snapshot when pointing at a different
        // server so the old server's channels don't flash before the refresh.
        if (normalized != prefs.serverUrl) prefs.clearChannelCache()
        if (normalized != prefs.serverUrl || key != prefs.accessKey) prefs.shareToken = null
        prefs.serverUrl = normalized
        prefs.accessKey = key
        api = runCatching { StalkerApi.create(normalized, key) }.getOrNull()
        invalidateDisabledGenres()
    }

    fun getServerUrl(): String? = prefs.serverUrl

    fun getAccessKey(): String? = prefs.accessKey

    /**
     * Base for links the player, Coil or a cast device open: they can't send
     * the access key header, so with a key set the links carry the server's
     * playback-only token (/k/<token>) instead.
     */
    private fun mediaBase(): String {
        val base = prefs.serverUrl?.trimEnd('/') ?: ""
        return prefs.shareToken?.let { "$base/k/$it" } ?: base
    }

    /** Fetches the playback token when a key is set and it isn't known yet. */
    private suspend fun ensureShareToken() {
        if (prefs.accessKey.isNullOrBlank() || prefs.shareToken != null) return
        runCatching { requireApi().getSettings() }.getOrNull()?.let { prefs.shareToken = it.accessShareToken }
    }

    fun defaultStreamUrl(channelId: String): String = "${mediaBase()}/proxy/stream/$channelId"

    /**
     * Resolves a channel to a playable URL + engine type by asking the backend
     * (`/api/stream/:id`), which runs create_link and classifies the stream
     * (hls/mpegts/native). A per-channel override skips the backend and is typed
     * by its extension. On any failure we fall back to the direct proxy URL
     * assuming HLS, so playback still attempts rather than dead-ending.
     */
    suspend fun resolveStream(channelId: String): StreamInfo {
        ensureShareToken()
        val base = mediaBase()
        prefs.getStreamOverride(channelId)?.let { return StreamInfo(it, inferStreamType(it)) }
        return runCatching {
            val resp = requireApi().getStream(channelId)
            val url = if (resp.streamUrl.startsWith("http", ignoreCase = true)) resp.streamUrl
                      else "$base${resp.streamUrl}"
            StreamInfo(url, resp.streamType.ifBlank { "hls" })
        }.getOrElse {
            StreamInfo("$base/proxy/stream/$channelId", "hls")
        }
    }

    /** Best-effort stream-type guess from a URL extension (used for overrides). */
    private fun inferStreamType(url: String): String {
        val path = url.substringBefore('?').substringBefore('#').lowercase()
        return when {
            path.endsWith(".m3u8") || path.endsWith(".m3u")                       -> "hls"
            path.endsWith(".mp4") || path.endsWith(".mkv") ||
                path.endsWith(".webm") || path.endsWith(".mov")                   -> "native"
            path.endsWith(".ts") || path.endsWith(".mpeg") || path.endsWith(".mpg") -> "mpegts"
            else                                                                  -> "hls"
        }
    }

    fun getStreamOverride(channelId: String): String? = prefs.getStreamOverride(channelId)

    fun setStreamOverride(channelId: String, url: String?) = prefs.setStreamOverride(channelId, url)

    suspend fun testConnection(): StatusResponse = requireApi().getStatus()

    /** Tests a candidate server URL without persisting it or touching the live
     *  client — so an abandoned/failed edit never leaves the app pointed at a
     *  broken server. Commit with [setServerUrl] only after this succeeds. */
    suspend fun testServerUrl(url: String, accessKey: String? = null): StatusResponse =
        StalkerApi.create(url.trimEnd('/'), accessKey?.trim()?.ifEmpty { null }).getStatus()

    // ── Portal management ─────────────────────────────────────────────────────

    suspend fun disconnectPortal(): PortalActionResponse =
        requireApi().disconnectPortal().also { invalidateDisabledGenres() }

    suspend fun reconnectPortal(): PortalActionResponse =
        requireApi().reconnectPortal()

    suspend fun getPortalConfig(): PortalConfigResponse? =
        runCatching { requireApi().getPortalConfig() }.getOrNull()

    // ── Portal profiles ─────────────────────────────────────────────────────────

    suspend fun getProfiles(): ProfilesResponse =
        runCatching { requireApi().getProfiles() }.getOrDefault(ProfilesResponse())

    suspend fun setActiveProfile(id: String?) =
        runCatching { requireApi().setActiveProfile(SetActiveProfileRequest(id)) }
            .also { invalidateDisabledGenres() }

    /** Connects using a saved profile and marks it active — mirrors the web
     *  Setup page's "connect from a saved profile" flow, which posts the whole
     *  profile. Passing only portal/mac/timezone/lang lets the backend
     *  substitute a generic STB identity, which portals that bind an account to
     *  a device reject — see PortalConnectRequest. */
    suspend fun connectProfile(profile: Profile): PortalActionResponse {
        val resp = requireApi().connectPortal(
            PortalConnectRequest(
                portal            = profile.portal,
                mac               = profile.mac,
                timezone          = profile.timezone,
                lang              = profile.lang,
                login             = profile.login,
                password          = profile.password,
                token             = profile.token,
                serialNumber      = profile.serialNumber,
                deviceId          = profile.deviceId,
                deviceId2         = profile.deviceId2,
                signature         = profile.signature,
                portalSignature   = profile.portalSignature,
                sendDeviceId      = profile.sendDeviceId,
                sendDeviceId2     = profile.sendDeviceId2,
                connectionTimeout = profile.connectionTimeout,
            )
        )
        if (resp.success) setActiveProfile(profile.id)
        return resp
    }

    /** The active profile's hide rules — genre names and whole languages.
     *
     *  Applied client-side, as the backend never filters channels (every client
     *  applies it independently). VOD categories are the exception: the backend
     *  filters those, because clients would otherwise each need the same
     *  language mapping and the portal's catch-all category has to be dropped
     *  alongside them.
     *
     *  Briefly cached behind a mutex because getChannels() and getGroups() both
     *  need it and run concurrently: without this, one channel-list load fetched
     *  the (large) profiles payload twice. The mutex makes the second caller wait
     *  for the first rather than duplicating the request, and the short TTL keeps
     *  it fresh; anything that changes the active profile clears it outright. */
    private suspend fun getProfileFilters(): ProfileFilters = genresMutex.withLock {
        val now = SystemClock.elapsedRealtime()
        filtersCache?.let { (cachedAt, filters) ->
            if (now - cachedAt < DISABLED_GENRES_TTL_MS) return@withLock filters
        }
        val fresh = runCatching {
            val resp = requireApi().getProfiles()
            val active = resp.profiles.find { it.id == resp.activeProfileId }
            ProfileFilters(
                genres    = active?.disabledGenres.orEmpty().toSet(),
                languages = active?.disabledLanguages.orEmpty().map(::languageOf).filter { it.isNotEmpty() }.toSet(),
            )
        }.getOrDefault(ProfileFilters())
        filtersCache = now to fresh
        fresh
    }

    private fun invalidateDisabledGenres() { filtersCache = null }

    suspend fun getChannels(): List<Channel> {
        val channels = requireApi().getChannels().channels
        val filters  = getProfileFilters()
        val filtered = (if (filters.isEmpty()) channels
                        else channels.filter { filters.allows(it.genre) })
            // The channel and player lists key by uniqueId; a portal returning the
            // same id twice would crash them with "Key was already used".
            .distinctBy { it.uniqueId }
        // Runs off the network list, which is the only place legacyId appears —
        // the on-disk cache doesn't store it. One-shot; see AppPrefs.
        prefs.migrateLegacyChannelIds(filtered)
        prefs.cacheChannels(filtered)
        return filtered
    }

    /** Last-known channel list from disk — lets the UI render instantly on cold
     *  start while the network refresh runs in the background. */
    fun getCachedChannels(): List<Channel> = prefs.getCachedChannels()

    /** Last-known logo map from disk (already absolute URLs). */
    fun getCachedLogoMap(): Map<String, String> = prefs.getCachedLogoMap()

    suspend fun getGroups(): List<Group> =
        runCatching {
            val groups   = requireApi().getGroups().groups
                // Stalker's catch-all pseudo-genre (id "*"). The UI already offers
                // its own "All" chip, so keeping this one showed two identical
                // chips — and the portal's did not work: no channel carries
                // genreId "*", so selecting it filtered the list down to nothing.
                .filter { it.id != ALL_GENRES_ID }
            val filters = getProfileFilters()
            if (filters.isEmpty()) groups else groups.filter { filters.allows(it.name) }
        }.getOrDefault(emptyList())

    // The backend returns relative logo URLs (e.g. "/api/logos/render?url=…"),
    // which work for the same-origin web UI but not for Coil in the app — it
    // needs an absolute URL. Prefix them with the server base.
    suspend fun getLogoMap(): Map<String, String> =
        runCatching {
            ensureShareToken()
            val base = mediaBase()
            requireApi().getLogoMap().mapValues { (_, url) ->
                if (url.startsWith("http", ignoreCase = true)) url else "$base$url"
            }.also { prefs.cacheLogoMap(it) }
        }.getOrDefault(emptyMap())

    suspend fun getFavoriteIds(): Set<String> =
        runCatching { requireApi().getFavorites().channels.map { it.uniqueId }.toSet() }
            .getOrDefault(emptySet())

    suspend fun addFavorite(uniqueId: String) =
        requireApi().addFavorite(AddFavoriteRequest(uniqueId))

    suspend fun removeFavorite(uniqueId: String) =
        requireApi().removeFavorite(uniqueId)

    suspend fun getNowNext(): Map<String, NowNextEntry> =
        runCatching { requireApi().getNowNext() }.getOrDefault(emptyMap())

    // ── Settings ──────────────────────────────────────────────────────────────

    /** Whether the VOD section should be shown (controlled from the web Profiles page). */
    suspend fun isVodEnabled(): Boolean =
        runCatching {
            requireApi().getSettings().also { if (!prefs.accessKey.isNullOrBlank()) prefs.shareToken = it.accessShareToken }.vodEnabled
        }.getOrDefault(false)

    // ── VOD ─────────────────────────────────────────────────────────────────────

    suspend fun getVodCategories(type: String): List<VodCategory> =
        runCatching { requireApi().getVodCategories(type).categories }.getOrDefault(emptyList())

    suspend fun getVodItems(type: String, category: String, page: Int, search: String): VodItemsResponse {
        ensureShareToken()
        val resp = requireApi().getVodItems(type, category, page, search)
        return resp.copy(items = resp.items.map { it.copy(screenshotUrl = absoluteUrl(it.screenshotUrl)) })
    }

    suspend fun getVodSeasons(showId: String): List<VodSeason> =
        runCatching {
            requireApi().getVodSeasons(showId).seasons.map { it.copy(screenshotUrl = absoluteUrl(it.screenshotUrl)) }
        }.getOrDefault(emptyList())

    suspend fun getVodEpisodes(showId: String, seasonId: String): List<VodEpisode> =
        runCatching {
            requireApi().getVodEpisodes(showId, seasonId).episodes.map { it.copy(screenshotUrl = absoluteUrl(it.screenshotUrl)) }
        }.getOrDefault(emptyList())

    /**
     * The backend returns relative image URLs (e.g. "/api/logos/render?url=…"),
     * which resolve against the origin in the same-origin web UI but not for
     * Coil in the app — it needs an absolute URL. Prefix with the server base.
     */
    private fun absoluteUrl(url: String?): String? = when {
        url.isNullOrBlank()                      -> url
        url.startsWith("http", ignoreCase = true) -> url
        else                                     -> "${mediaBase()}$url"
    }

    /** Resolves a VOD stream and returns the absolute, playable proxy URL. */
    suspend fun resolveVodStreamUrl(
        videoId: String,
        cmd: String = "",
        series: String = "",
        seasonId: String = "",
        episodeId: String = "",
    ): String {
        ensureShareToken()
        val resp = requireApi().getVodStream(videoId, cmd, series, seasonId, episodeId)
        val base = mediaBase()
        return if (resp.streamUrl.startsWith("http", ignoreCase = true)) resp.streamUrl
               else "$base${resp.streamUrl}"
    }

    // ── Watch history ─────────────────────────────────────────────────────────

    fun pushWatched(channel: Channel, logoUrl: String?) =
        prefs.pushWatchedChannel(channel.uniqueId, channel.name, logoUrl)

    fun getWatched(): List<WatchedChannel> = prefs.getWatchedChannels()

    private val genresMutex = Mutex()
    private var filtersCache: Pair<Long, ProfileFilters>? = null

    private fun requireApi(): StalkerApi =
        api ?: throw IllegalStateException("No server URL configured")

    private companion object {
        const val DISABLED_GENRES_TTL_MS = 15_000L
        const val ALL_GENRES_ID = "*"
    }
}
