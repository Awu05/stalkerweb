package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.ViewerDetails

// Mirrors frontend/src/lib/adultFilter.js.
private val ADULT_PATTERNS = listOf("adult", "for adults", "xxx", "18+", "erotic", "erotica", "hentai", "porn", "sexy", "nsfw")

fun isAdult(name: String?): Boolean {
    val lower = name?.lowercase() ?: return false
    return ADULT_PATTERNS.any { it in lower }
}

/** The language half of a "LANGUAGE | SECTION" name, for comparing (frontend/src/lib/languages.js). */
fun languageOf(name: String): String = name.substringBefore('|').trim().uppercase()

/**
 * What the current viewer hides from live TV: genres by exact name, whole
 * languages, and adult channels unless the viewer shows them. Applied here, as
 * the web's Channels page does, since the server doesn't filter channels.
 */
data class ViewerFilter(
    val disabledGenres: Set<String> = emptySet(),
    val disabledLanguages: Set<String> = emptySet(),
    val showAdult: Boolean = false,
) {
    fun keepsChannel(channel: Channel): Boolean {
        if (!showAdult && (isAdult(channel.genre) || isAdult(channel.name))) return false
        val genre = channel.genre ?: return true
        return genre !in disabledGenres && languageOf(genre) !in disabledLanguages
    }

    fun keepsGroup(name: String): Boolean =
        (showAdult || !isAdult(name)) && name !in disabledGenres && languageOf(name) !in disabledLanguages

    companion object {
        fun from(viewer: ViewerDetails?): ViewerFilter = if (viewer == null) ViewerFilter() else ViewerFilter(
            disabledGenres = viewer.disabledGenres.toSet(),
            disabledLanguages = viewer.disabledLanguages.map(::languageOf).filter { it.isNotEmpty() }.toSet(),
            showAdult = viewer.showAdult,
        )
    }
}
