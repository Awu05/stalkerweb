package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.prefs.AppPrefs

/**
 * Links to the server's media. Streams go to the player and cast devices,
 * which can't send the access-key header, so with a key set they carry the
 * server's playback-only token (/k/<token>) instead ([base]). Images load
 * through the app's own HTTP client (Coil, StalkerWebApp), which sends the key
 * and goes through the access guard, so they use the plain address
 * ([imageBase]) — a stale token in an image link would count as a wrong key.
 */
class MediaLinks(private val prefs: AppPrefs, private val apis: ApiProvider) {
    fun imageBase(): String = prefs.serverUrl?.trimEnd('/') ?: ""

    fun base(): String {
        val base = prefs.serverUrl?.trimEnd('/') ?: ""
        return prefs.shareToken?.let { "$base/k/$it" } ?: base
    }

    /** Fetches the playback token when a key is set and it isn't known yet. */
    suspend fun ensureShareToken() {
        if (prefs.accessKey.isNullOrBlank() || prefs.shareToken != null) return
        runCatching { apis.get().getSettings() }.getOrNull()?.let { prefs.shareToken = it.accessShareToken }
    }

    /** The server's relative image URLs made absolute (Coil needs that). */
    fun absoluteImage(url: String?): String? = when {
        url.isNullOrBlank() -> url
        url.startsWith("http", ignoreCase = true) -> url
        else -> "${imageBase()}$url"
    }

    /** An image URL as the server's own path — what history and My List store, so the web can show it too. */
    fun relativeImage(url: String?): String {
        if (url.isNullOrBlank()) return ""
        val base = imageBase()
        return if (base.isNotEmpty() && url.startsWith(base)) url.removePrefix(base) else url
    }
}
