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
)

@JsonClass(generateAdapter = false)
data class CreateViewerRequest(
    val name: String,
)
