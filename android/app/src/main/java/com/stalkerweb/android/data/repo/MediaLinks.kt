package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.prefs.AppPrefs

/**
 * Links the player, Coil or a cast device open. They can't send the access-key
 * header, so with a key set the links carry the server's playback-only token
 * (/k/<token>) instead.
 */
class MediaLinks(private val prefs: AppPrefs, private val apis: ApiProvider) {
    fun base(): String {
        val base = prefs.serverUrl?.trimEnd('/') ?: ""
        return prefs.shareToken?.let { "$base/k/$it" } ?: base
    }

    /** Fetches the playback token when a key is set and it isn't known yet. */
    suspend fun ensureShareToken() {
        if (prefs.accessKey.isNullOrBlank() || prefs.shareToken != null) return
        runCatching { apis.get().getSettings() }.getOrNull()?.let { prefs.shareToken = it.accessShareToken }
    }

    /** The server's relative image/stream URLs made absolute (Coil and ExoPlayer need that). */
    fun absolute(url: String?): String? = when {
        url.isNullOrBlank() -> url
        url.startsWith("http", ignoreCase = true) -> url
        else -> "${base()}$url"
    }
}
