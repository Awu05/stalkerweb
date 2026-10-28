package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodSeason

data class EpisodeRef(val season: VodSeason, val episode: VodEpisode)

/** The episodes before and after, and the neighbouring seasons that must be loaded to know. */
data class Neighbours(val prev: EpisodeRef?, val next: EpisodeRef?, val needs: List<String>)

/**
 * The episodes either side of the one playing, across seasons: after a
 * season's last episode comes the next season's first. A port of
 * frontend/src/lib/episodeNav.js. [seasons] are in order; [bySeason] holds the
 * seasons loaded so far.
 */
fun episodeNeighbours(seasons: List<VodSeason>, bySeason: Map<String, List<VodEpisode>>, seasonId: String, episodeId: String): Neighbours {
    val none = Neighbours(null, null, emptyList())
    val si = seasons.indexOfFirst { it.id == seasonId }
    val eps = bySeason[seasonId]
    if (si < 0 || eps == null) return none
    val ei = eps.indexOfFirst { it.episodeId == episodeId }
    if (ei < 0) return none
    val needs = mutableListOf<String>()
    fun side(offset: Int): EpisodeRef? {
        eps.getOrNull(ei + offset)?.let { return EpisodeRef(seasons[si], it) }
        val season = seasons.getOrNull(si + offset) ?: return null
        val list = bySeason[season.id] ?: run { needs.add(season.id); return null }
        val episode = (if (offset > 0) list.firstOrNull() else list.lastOrNull()) ?: return null
        return EpisodeRef(season, episode)
    }
    val prev = side(-1)
    val next = side(1)
    return Neighbours(prev, next, needs)
}
