package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.ViewerSummary

/** Which viewer to start as: [id] when known, otherwise ask ([needsPicker]). */
data class ViewerChoice(val id: String?, val needsPicker: Boolean)

/**
 * The saved viewer while it still exists; otherwise ask "Who's watching?" —
 * even when there's only one, so a new device can pick it or make another.
 * Mirrors frontend/src/lib/viewer.js.
 */
fun chooseViewer(viewers: List<ViewerSummary>, savedId: String?): ViewerChoice =
    if (savedId != null && viewers.any { it.id == savedId }) ViewerChoice(savedId, false)
    else ViewerChoice(null, true)
