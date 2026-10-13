package com.stalkerweb.android.data.repo

/** The server's watch rules (backend viewers/WatchStore.js). */
object WatchRules {
    const val RESUME_MIN_SECS = 30.0    // less is "only just started"
    const val DONE_FRACTION = 0.95      // more is finished

    /** Where to pick up a saved position, or null to start from the top. */
    fun resumeAt(position: Double, duration: Double): Double? =
        if (duration > 0 && position >= RESUME_MIN_SECS && position < duration * DONE_FRACTION) position else null

    /** A movie's id, or "id:season:episode" — so each episode has its own resume point. */
    fun makeKey(videoId: String, seasonId: String = "", episodeId: String = ""): String =
        listOf(videoId, seasonId, episodeId).filter { it.isNotEmpty() }.joinToString(":")
}
