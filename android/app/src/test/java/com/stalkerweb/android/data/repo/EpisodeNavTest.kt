package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodSeason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The cases of frontend/src/lib/episodeNav.test.js, plus the last-episode rule.
class EpisodeNavTest {
    private val seasons = listOf(VodSeason("s1"), VodSeason("s2"), VodSeason("s3"))
    private fun ep(id: String) = VodEpisode(episodeId = id)
    private val eps = mapOf("s1" to listOf(ep("a"), ep("b")), "s2" to listOf(ep("c"), ep("d")))
    private fun ids(r: EpisodeRef?) = r?.let { listOf(it.season.id, it.episode.episodeId) }

    @Test fun stepsWithinASeason() {
        val n = episodeNeighbours(seasons, eps, "s2", "c")
        assertEquals(listOf("s1", "b"), ids(n.prev))
        assertEquals(listOf("s2", "d"), ids(n.next))
    }

    @Test fun crossesSeasons() {
        assertEquals(listOf("s2", "c"), ids(episodeNeighbours(seasons, eps, "s1", "b").next))
        assertEquals(listOf("s1", "b"), ids(episodeNeighbours(seasons, eps, "s2", "c").prev))
    }

    @Test fun asksForASeasonNotLoadedYet() {
        val n = episodeNeighbours(seasons, eps, "s2", "d")
        assertNull(n.next)
        assertEquals(listOf("s3"), n.needs)
    }

    @Test fun nothingBeforeTheFirstOrAfterTheLast() {
        assertNull(episodeNeighbours(seasons, eps, "s1", "a").prev)
        assertNull(episodeNeighbours(listOf(VodSeason("s1")), eps, "s1", "b").next)
        assertEquals(Neighbours(null, null, emptyList()), episodeNeighbours(seasons, eps, "s9", "x"))
    }
}
