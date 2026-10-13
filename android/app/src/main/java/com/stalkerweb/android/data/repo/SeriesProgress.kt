package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.HistoryEntry
import com.stalkerweb.android.data.api.ProgressEntry
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodSeason

// Where a viewer is in a show: what Continue plays, how an episode is named on
// a tile, and how much of a season is watched. Mirrors the web's
// frontend/src/lib/seriesProgress.js — keep the two in step.
// Keys are the watch keys "showId:seasonId:episodeId" (WatchRules.makeKey).

sealed class ContinueTarget {
    /** Play [episode] of [season]; [resume]: it was stopped partway (the player picks up there). */
    data class Play(val resume: Boolean, val season: VodSeason, val episode: VodEpisode) : ContinueTarget()
    /** [seasonId]'s episodes must be loaded to know. */
    data class Needs(val seasonId: String) : ContinueTarget()
}

private fun keyParts(key: String): Pair<String, String> {
    val p = key.split(':')
    return p.getOrElse(1) { "" } to p.getOrElse(2) { "" }
}

/**
 * What Continue does for a show: the episode last played, unfinished → resume
 * it; finished → the next episode not yet watched, into the next seasons;
 * never played → the first episode not yet watched. Null once everything after
 * the last one played is watched.
 */
fun continueTarget(
    showId: String,
    seasons: List<VodSeason>,
    episodesBySeason: Map<String, List<VodEpisode>>,
    history: List<HistoryEntry>,
    progress: List<ProgressEntry>,
    watchedEpisodes: List<String>,
): ContinueTarget? {
    val watched = watchedEpisodes.toSet()
    // "Resume" only where there's a point to resume from (it can drop off the list): else it plays from the start.
    val resumable = progress.map { it.key }.toSet()
    fun locate(key: String): ContinueTarget? {
        val (seasonId, episodeId) = keyParts(key)
        val season = seasons.firstOrNull { it.id == seasonId } ?: return null
        val eps = episodesBySeason[season.id] ?: return ContinueTarget.Needs(season.id)
        val episode = eps.firstOrNull { it.episodeId == episodeId } ?: return null
        return ContinueTarget.Play(resume = key in resumable, season = season, episode = episode)
    }

    var after: Pair<String, String>? = null
    val last = history.firstOrNull { it.id == showId && it.key.contains(':') }
    if (last != null) {
        if (!last.finished && last.key !in watched) locate(last.key)?.let { return it }
        after = keyParts(last.key)
    } else {
        progress.firstOrNull { it.key.startsWith("$showId:") && it.key !in watched }?.let { p -> locate(p.key)?.let { return it } }
    }

    // The next one not watched, from after the last played (or from the start).
    var si = after?.let { a -> seasons.indexOfFirst { it.id == a.first } } ?: 0
    if (si < 0) { si = 0; after = null }
    val start = after
    for (i in si until seasons.size) {
        val season = seasons[i]
        val eps = episodesBySeason[season.id] ?: return ContinueTarget.Needs(season.id)
        val from = if (start != null && i == si) eps.indexOfFirst { it.episodeId == start.second } + 1 else 0
        for (j in from until eps.size) {
            if (WatchRules.makeKey(showId, season.id, eps[j].episodeId) !in watched) return ContinueTarget.Play(false, season, eps[j])
        }
    }
    return null
}

/** A season's number, or the one in its name ("Season 4") when the portal leaves it out. */
fun seasonNoOf(season: VodSeason): String =
    season.seasonNumber.trim().ifEmpty { Regex("""\d+""").find(season.name)?.value.orEmpty() }

// "Episode 5", or nothing: no title of its own.
private fun isPlaceholder(name: String, episode: String): Boolean {
    val n = name.trim()
    return n.isEmpty() || Regex("""(?i)^episode\s*\d+$""").matches(n) || (episode.isNotEmpty() && n == episode)
}

/** "S2 · E5 · The Long Night"; "S2 · E5" for an episode with no title of its own. */
fun episodeLabel(season: String, episode: String, name: String): String {
    val out = buildList {
        if (season.isNotEmpty()) add("S$season")
        if (episode.isNotEmpty() && episode != "0") add("E$episode")
        if (!isPlaceholder(name, episode)) add(name.trim())
    }
    return out.joinToString(" · ").ifEmpty { name.trim() }
}

/**
 * A Recently watched entry's episode, from its player link. Links saved before
 * the season was kept are looked up in [seasonNos] ("showId:seasonId" →
 * number, from the show's seasons); not found, the episode as before.
 */
fun historyEpisodeLabel(entry: HistoryEntry, seasonNos: Map<String, String> = emptyMap()): String {
    val p = PlayerParams.parse(entry.params)
    val season = p.season.ifEmpty { seasonNos["${p.videoId}:${p.seasonId}"].orEmpty() }
    if (season.isEmpty()) return entry.episodeTitle
    return episodeLabel(season, p.series, entry.episodeTitle)
}

/** The show whose seasons a Recently watched entry needs looked up (an episode saved without its season), or null. */
fun seasonLookupFor(entry: HistoryEntry): String? {
    val p = PlayerParams.parse(entry.params)
    return if (p.seasonId.isNotEmpty() && p.season.isEmpty()) p.videoId.ifEmpty { null } else null
}

/** How many of a season's episodes are watched. */
fun watchedInSeason(watchedEpisodes: List<String>, showId: String, seasonId: String): Int =
    watchedEpisodes.count { it.startsWith("$showId:$seasonId:") }

/** How many of these episodes (a season's, as listed now) are watched. */
fun watchedOfEpisodes(watchedEpisodes: List<String>, showId: String, seasonId: String, episodes: List<VodEpisode>): Int {
    val w = watchedEpisodes.toSet()
    return episodes.count { WatchRules.makeKey(showId, seasonId, it.episodeId) in w }
}

/** "Watched", "2 of 3" (its episodes known), "2 watched", or nothing. */
fun seasonWatchedLabel(count: Int, total: Int?): String = when {
    count <= 0 -> ""
    total != null && total > 0 -> if (count >= total) "Watched" else "$count of $total"
    else -> "$count watched"
}
