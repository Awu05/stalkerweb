package com.stalkerweb.android.data.prefs

import android.content.Context
import com.stalkerweb.android.data.api.Channel
import org.json.JSONArray
import org.json.JSONObject

data class WatchedChannel(
    val uniqueId: String,
    val name: String,
    val logoUrl: String?,
    val watchedAt: Long,
)

class AppPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("stalkerweb_prefs", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = prefs.getString(KEY_SERVER_URL, null)
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value).apply()

    // The server's ACCESS_KEY, if it has one — sent as an Authorization header.
    var accessKey: String?
        get() = prefs.getString(KEY_ACCESS_KEY, null)
        set(value) = prefs.edit().putString(KEY_ACCESS_KEY, value).apply()

    // The server's playback-only token, put in stream and image links (players
    // and cast devices can't send the header). Fetched from the server.
    var shareToken: String?
        get() = prefs.getString(KEY_SHARE_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_SHARE_TOKEN, value).apply()

    // ── Watch history ─────────────────────────────────────────────────────────

    fun pushWatchedChannel(uniqueId: String, name: String, logoUrl: String?) {
        val list = getWatchedChannels().toMutableList()
        list.removeAll { it.uniqueId == uniqueId }
        list.add(0, WatchedChannel(uniqueId, name, logoUrl, System.currentTimeMillis()))
        prefs.edit().putString(KEY_WATCH_HISTORY, historyToJson(list.take(MAX_HISTORY))).apply()
    }

    private fun historyToJson(list: List<WatchedChannel>): String {
        val arr = JSONArray()
        list.forEach { ch ->
            arr.put(JSONObject().apply {
                put("uniqueId", ch.uniqueId)
                put("name", ch.name)
                if (ch.logoUrl != null) put("logoUrl", ch.logoUrl)
                put("watchedAt", ch.watchedAt)
            })
        }
        return arr.toString()
    }

    fun getWatchedChannels(): List<WatchedChannel> {
        val raw = prefs.getString(KEY_WATCH_HISTORY, null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                WatchedChannel(
                    uniqueId  = o.getString("uniqueId"),
                    name      = o.getString("name"),
                    logoUrl   = if (o.has("logoUrl")) o.getString("logoUrl") else null,
                    watchedAt = o.getLong("watchedAt"),
                )
            }
        }.getOrDefault(emptyList())
    }

    // ── Channel list + logo cache ─────────────────────────────────────────────
    // Lets the channel/player UI render instantly on cold start (and survive a
    // briefly-unreachable backend) while a fresh copy loads in the background.

    fun cacheChannels(channels: List<Channel>) {
        val arr = JSONArray()
        channels.forEach { ch ->
            arr.put(JSONObject().apply {
                put("uniqueId", ch.uniqueId)
                put("number", ch.number)
                put("name", ch.name)
                if (ch.logo != null) put("logo", ch.logo)
                if (ch.genre != null) put("genre", ch.genre)
                if (ch.genreId != null) put("genreId", ch.genreId)
            })
        }
        prefs.edit().putString(KEY_CHANNEL_CACHE, arr.toString()).apply()
    }

    fun getCachedChannels(): List<Channel> {
        val raw = prefs.getString(KEY_CHANNEL_CACHE, null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                Channel(
                    uniqueId = o.getString("uniqueId"),
                    number   = o.optInt("number", 0),
                    name     = o.getString("name"),
                    logo     = if (o.has("logo")) o.getString("logo") else null,
                    genre    = if (o.has("genre")) o.getString("genre") else null,
                    genreId  = if (o.has("genreId")) o.getString("genreId") else null,
                )
            }
            // The lists that render these key by uniqueId, and a LazyColumn throws
            // on a duplicate key. De-duplicating only on fetch isn't enough: a cache
            // written by an earlier build is already on disk and is rendered first,
            // so it would crash before the network refresh could replace it.
            .distinctBy { it.uniqueId }
        }.getOrDefault(emptyList())
    }

    fun cacheLogoMap(map: Map<String, String>) {
        val obj = JSONObject()
        map.forEach { (k, v) -> obj.put(k, v) }
        prefs.edit().putString(KEY_LOGO_CACHE, obj.toString()).apply()
    }

    fun getCachedLogoMap(): Map<String, String> {
        val raw = prefs.getString(KEY_LOGO_CACHE, null) ?: return emptyMap()
        return runCatching {
            val obj = JSONObject(raw)
            buildMap { obj.keys().forEach { k -> put(k, obj.getString(k)) } }
        }.getOrDefault(emptyMap())
    }

    fun clearChannelCache() {
        prefs.edit().remove(KEY_CHANNEL_CACHE).remove(KEY_LOGO_CACHE).apply()
    }

    // ── Legacy channel-id migration ───────────────────────────────────────────

    /**
     * One-shot: moves locally-keyed data from the old channel-id scheme (a hash
     * of name+number) onto the portal's own ids.
     *
     * The backend tolerates a legacy id on lookup, but data keyed by id *here*
     * needs rewriting rather than tolerance: a stream override is found by
     * building a key from the channel's current uniqueId, so an override stored
     * under the old id would simply never be found again, and watch history
     * would stop matching the channel list.
     *
     * No-ops against a backend too old to send legacyId, and re-runs on a later
     * load in that case rather than burning the flag.
     */
    fun migrateLegacyChannelIds(channels: List<Channel>) {
        if (prefs.getBoolean(KEY_LEGACY_IDS_MIGRATED, false)) return

        val legacyToCurrent = channels.mapNotNull { ch ->
            val legacy = ch.legacyId
            if (legacy.isNullOrBlank() || legacy == ch.uniqueId) null else legacy to ch.uniqueId
        }.toMap()
        // Older backend (or a portal whose ids never changed) — nothing to do,
        // and nothing proven, so leave the flag unset and try again next load.
        if (legacyToCurrent.isEmpty()) return

        val editor = prefs.edit()

        for ((legacy, current) in legacyToCurrent) {
            val stored = prefs.getString("$KEY_OVERRIDE_PREFIX$legacy", null) ?: continue
            // Don't clobber an override already set against the new id.
            if (prefs.getString("$KEY_OVERRIDE_PREFIX$current", null) == null) {
                editor.putString("$KEY_OVERRIDE_PREFIX$current", stored)
            }
            editor.remove("$KEY_OVERRIDE_PREFIX$legacy")
        }

        val history = getWatchedChannels()
        val remapped = history.map { w ->
            legacyToCurrent[w.uniqueId]?.let { w.copy(uniqueId = it) } ?: w
        }
        if (remapped != history) editor.putString(KEY_WATCH_HISTORY, historyToJson(remapped))

        editor.putBoolean(KEY_LEGACY_IDS_MIGRATED, true)
        editor.apply()
    }

    // ── Per-channel stream URL overrides ─────────────────────────────────────

    fun getStreamOverride(uniqueId: String): String? =
        prefs.getString("$KEY_OVERRIDE_PREFIX$uniqueId", null)
            ?.takeIf { it.isNotBlank() }

    fun setStreamOverride(uniqueId: String, url: String?) {
        val editor = prefs.edit()
        if (url.isNullOrBlank()) editor.remove("$KEY_OVERRIDE_PREFIX$uniqueId")
        else editor.putString("$KEY_OVERRIDE_PREFIX$uniqueId", url.trim())
        editor.apply()
    }

    companion object {
        private const val KEY_SERVER_URL      = "server_url"
        private const val KEY_ACCESS_KEY      = "access_key"
        private const val KEY_SHARE_TOKEN     = "share_token"
        private const val KEY_WATCH_HISTORY   = "watch_history"
        private const val KEY_OVERRIDE_PREFIX = "stream_override_"
        private const val KEY_CHANNEL_CACHE   = "channel_cache"
        private const val KEY_LOGO_CACHE      = "logo_cache"
        private const val MAX_HISTORY         = 10
        private const val KEY_LEGACY_IDS_MIGRATED = "legacy_channel_ids_migrated"
    }
}
