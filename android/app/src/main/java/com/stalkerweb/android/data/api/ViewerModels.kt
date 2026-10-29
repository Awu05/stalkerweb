package com.stalkerweb.android.data.api

import com.squareup.moshi.JsonClass

// The server's viewers (backend routes/viewers.js): a summary in lists, the
// details (with that viewer's filters) for the current one.
@JsonClass(generateAdapter = false)
data class ViewerSummary(
    val id: String,
    val name: String = "",
    val color: String? = null,
)

@JsonClass(generateAdapter = false)
data class ViewersResponse(
    val viewers: List<ViewerSummary> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class ViewerDetails(
    val id: String,
    val name: String = "",
    val color: String? = null,
    val isDefault: Boolean = false,
    val disabledGenres: List<String> = emptyList(),
    val disabledLanguages: List<String> = emptyList(),
    val disabledVodCategories: List<String> = emptyList(),
    val showAdult: Boolean = false,
    /** Intro skipping: "off", "button" or "auto" (data/repo/SkipSegments.kt); null from an older server. */
    val skipMode: String? = null,
    /** An older server's on/off for skipping intros and recaps without asking. */
    val autoSkip: Boolean = false,
    /** The preferred audio language: two letters, or "" for the stream's own. */
    val audioLanguage: String = "",
)

/** The player's settings gear (and Settings): only what's set is sent. */
@JsonClass(generateAdapter = false)
data class PlayerSettingsRequest(val skipMode: String? = null, val audioLanguage: String? = null)

@JsonClass(generateAdapter = false)
data class CreateViewerRequest(
    val name: String,
)
