package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.AddFavoriteRequest
import com.stalkerweb.android.data.api.ChannelHealth
import com.stalkerweb.android.data.api.FavoritesResponse
import com.stalkerweb.android.data.api.LogoOverrideRequest
import com.stalkerweb.android.data.api.NameRequest
import com.stalkerweb.android.data.api.OrderRequest
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.Group
import com.stalkerweb.android.data.api.NowNextEntry
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.data.prefs.WatchedChannel

/** [read] when the cache holds [current]'s list, else nothing: lists are filtered per viewer. */
fun <T> cachedFor(current: String?, cachedBy: String?, read: () -> List<T>): List<T> =
    if (current == cachedBy) read() else emptyList()

/** A resolved live stream: its absolute URL and the engine hint for the player. */
data class StreamInfo(val url: String, val type: String)

/** Live TV: channels and groups (filtered for the current viewer), favorites, logos, now/next, streams. */
class LiveRepository(
    private val prefs: AppPrefs,
    private val apis: ApiProvider,
    private val links: MediaLinks,
    private val viewers: ViewerRepository,
) {
    // ── Channels and groups ───────────────────────────────────────────────────

    suspend fun getChannels(): List<Channel> {
        val filter = viewers.filter()
        val channels = apis.get().getChannels().channels
            .filter(filter::keepsChannel)
            // The channel and player lists key by uniqueId; a portal returning the
            // same id twice would crash them with "Key was already used".
            .distinctBy { it.uniqueId }
        // Runs off the network list, which is the only place legacyId appears —
        // the on-disk cache doesn't store it. One-shot; see AppPrefs.
        prefs.migrateLegacyChannelIds(channels)
        prefs.cacheChannels(channels)
        prefs.channelsCacheViewer = prefs.viewerId
        return channels
    }

    /** Last-known channel list from disk — lets the UI render instantly on cold
     *  start while the network refresh runs in the background. Only the current
     *  viewer's: another viewer's list may show channels this one hides. */
    fun getCachedChannels(): List<Channel> =
        cachedFor(prefs.viewerId, prefs.channelsCacheViewer) { prefs.getCachedChannels() }

    /** Last-known logo map from disk (already absolute URLs). */
    fun getCachedLogoMap(): Map<String, String> = prefs.getCachedLogoMap()

    suspend fun getGroups(): List<Group> = runCatching {
        val filter = viewers.filter()
        apis.get().getGroups().groups
            // Stalker's catch-all pseudo-genre (id "*"): the UI has its own "All"
            // chip, and no channel carries genreId "*".
            .filter { it.id != ALL_GENRES_ID && filter.keepsGroup(it.name) }
    }.getOrDefault(emptyList())

    // The backend returns relative logo URLs (e.g. "/api/logos/render?url=…"),
    // which work for the same-origin web UI but not for Coil in the app — it
    // needs an absolute URL. Prefix them with the server base.
    suspend fun getLogoMap(): Map<String, String> =
        runCatching {
            val base = links.imageBase()
            apis.get().getLogoMap().mapValues { (_, url) ->
                if (url.startsWith("http", ignoreCase = true)) url else "$base$url"
            }.also { prefs.cacheLogoMap(it) }
        }.getOrDefault(emptyMap())

    // ── Favorites (the current viewer's) ──────────────────────────────────────

    suspend fun getFavoriteIds(): Set<String> =
        runCatching { apis.get().getFavorites().channels.map { it.uniqueId }.toSet() }
            .getOrDefault(emptySet())

    suspend fun addFavorite(uniqueId: String) =
        apis.get().addFavorite(AddFavoriteRequest(uniqueId))

    suspend fun removeFavorite(uniqueId: String) =
        apis.get().removeFavorite(uniqueId)

    /** The viewer's favorites: channels in their order, and groups (each with its channels). */
    suspend fun getFavorites(): FavoritesResponse = apis.get().getFavorites()

    suspend fun createGroup(name: String) = apis.get().createFavoriteGroup(NameRequest(name.trim()))
    suspend fun renameGroup(id: String, name: String) = apis.get().renameFavoriteGroup(id, NameRequest(name.trim()))
    suspend fun deleteGroup(id: String) = apis.get().deleteFavoriteGroup(id)
    suspend fun addToGroup(groupId: String, uniqueId: String) = apis.get().addToFavoriteGroup(groupId, AddFavoriteRequest(uniqueId))
    suspend fun removeFromGroup(groupId: String, uniqueId: String) = apis.get().removeFromFavoriteGroup(groupId, uniqueId)
    suspend fun reorderFavorites(order: List<String>) = apis.get().reorderFavorites(OrderRequest(order))
    suspend fun reorderGroups(order: List<String>) = apis.get().reorderFavoriteGroups(OrderRequest(order))

    /** Recent stream failures per channel; empty when unknown. */
    suspend fun getHealth(): Map<String, ChannelHealth> = runCatching { apis.get().getChannelHealth() }.getOrDefault(emptyMap())

    /** The logo the server finds for [name], made absolute for Coil; null when none. */
    suspend fun checkLogo(name: String): String? = runCatching { apis.get().checkLogo(name).logo }.getOrNull()
        ?.takeIf { it.isNotBlank() }?.let { links.absoluteImage(it) }

    suspend fun setLogoOverride(name: String, url: String) = apis.get().setLogoOverride(LogoOverrideRequest(name, url.trim()))

    /** The playing channel's programmes for the next hours, in order (the player's guide). */
    suspend fun channelGuide(channelId: String, hours: Int = 6): List<com.stalkerweb.android.data.api.EpgEvent> =
        cleanEvents(apis.get().getChannelEpg(channelId, hours).events.mapNotNull { it.toEvent() })

    suspend fun keepalive() { runCatching { apis.get().streamKeepalive() } }

    suspend fun getNowNext(): Map<String, NowNextEntry> =
        runCatching { apis.get().getNowNext() }.getOrDefault(emptyMap())

    // ── Streams ───────────────────────────────────────────────────────────────

    fun defaultStreamUrl(channelId: String): String = "${links.base()}/proxy/stream/$channelId"

    /**
     * Resolves a channel to a playable URL + engine type by asking the backend
     * (`/api/stream/:id`), which runs create_link and classifies the stream
     * (hls/mpegts/native). A per-channel override skips the backend and is typed
     * by its extension. On any failure we fall back to the direct proxy URL
     * assuming HLS, so playback still attempts rather than dead-ending.
     */
    /** The link a cast device opens for this channel (as HLS). */
    suspend fun castLink(channelId: String) = apis.get().getChannelCastLink(channelId)

    suspend fun resolveStream(channelId: String): StreamInfo {
        links.ensureShareToken()
        val base = links.base()
        prefs.getStreamOverride(channelId)?.let { return StreamInfo(it, inferStreamType(it)) }
        return runCatching {
            val resp = apis.get().getStream(channelId)
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

    // ── Watch history (this device) ───────────────────────────────────────────

    fun pushWatched(channel: Channel, logoUrl: String?) =
        prefs.pushWatchedChannel(channel.uniqueId, channel.name, logoUrl)

    fun getWatched(): List<WatchedChannel> = prefs.getWatchedChannels()

    fun removeWatched(uniqueId: String) = prefs.removeWatchedChannel(uniqueId)

    private companion object { const val ALL_GENRES_ID = "*" }
}
