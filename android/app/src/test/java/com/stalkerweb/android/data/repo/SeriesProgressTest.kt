package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.HistoryEntry
import com.stalkerweb.android.data.api.ProgressEntry
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodSeason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The same cases as the web's frontend/src/lib/seriesProgress.test.js. */
class SeriesProgressTest {
    private val s1 = VodSeason("s1", "Season 1", "1")
    private val s2 = VodSeason("s2", "Season 2", "2")
    private fun ep(id: String, n: Int) = VodEpisode(id, n.toString(), "Episode $n")
    private val e1 = ep("e1", 1); private val e2 = ep("e2", 2); private val e3 = ep("e3", 3)
    private val f1 = ep("f1", 1); private val f2 = ep("f2", 2)
    private val all = mapOf("s1" to listOf(e1, e2, e3), "s2" to listOf(f1, f2))
    private fun target(
        history: List<HistoryEntry> = emptyList(), progress: List<ProgressEntry> = emptyList(),
        watched: List<String> = emptyList(), episodes: Map<String, List<VodEpisode>> = all,
    ) = continueTarget("200", listOf(s1, s2), episodes, history, progress, watched)
    private fun h(key: String, finished: Boolean) = HistoryEntry(id = "200", key = key, finished = finished)

    @Test fun readsKeysWhoseSeasonAndEpisodeIdsHaveColonsOfTheirOwn() {
        val c1 = VodSeason("200:1", "Season 1", "1"); val c2 = VodSeason("200:2", "Season 2", "2")
        val g1 = ep("200:2:1", 1); val g2 = ep("200:2:2", 2); val g3 = ep("200:2:3", 3)
        val eps = mapOf("200:1" to listOf(ep("200:1:1", 1)), "200:2" to listOf(g1, g2, g3))
        val key = "200:200:2:200:2:2"
        assertEquals(ContinueTarget.Play(true, c2, g2),
            continueTarget("200", listOf(c1, c2), eps, listOf(h(key, false)), listOf(ProgressEntry(key)), emptyList()))
        assertEquals(ContinueTarget.Play(false, c2, g3),
            continueTarget("200", listOf(c1, c2), eps, listOf(h(key, true)), emptyList(), emptyList()))
    }

    @Test fun startsAShowNotWatchedYetAtItsFirstEpisode() =
        assertEquals(ContinueTarget.Play(resume = false, season = s1, episode = e1), target())

    @Test fun resumesTheEpisodeStoppedPartway() {
        assertEquals(ContinueTarget.Play(true, s1, e2), target(history = listOf(h("200:s1:e2", false)), progress = listOf(ProgressEntry("200:s1:e2"))))
        // Its resume point gone (pushed out of the list): it plays from the start.
        assertEquals(ContinueTarget.Play(false, s1, e2), target(history = listOf(h("200:s1:e2", false))))
    }

    @Test fun playsTheNextEpisodeIntoTheNextSeason() {
        assertEquals(ContinueTarget.Play(false, s1, e3), target(history = listOf(h("200:s1:e2", true))))
        assertEquals(ContinueTarget.Play(false, s2, f1), target(history = listOf(h("200:s1:e3", true))))
    }

    @Test fun skipsEpisodesAlreadyWatched() =
        assertEquals(ContinueTarget.Play(false, s2, f1), target(history = listOf(h("200:s1:e1", true)), watched = listOf("200:s1:e2", "200:s1:e3")))

    @Test fun nothingToContinueAfterTheLastEpisode() = assertNull(target(history = listOf(h("200:s2:f2", true))))

    @Test fun asksForASeasonItHasToLookInto() {
        assertEquals(ContinueTarget.Needs("s2"), target(history = listOf(h("200:s1:e3", true)), episodes = mapOf("s1" to all.getValue("s1"))))
        assertEquals(ContinueTarget.Needs("s2"), target(history = listOf(h("200:s2:f1", false)), episodes = emptyMap()))
    }

    @Test fun withoutHistoryResumesTheShowsNewestResumePoint() =
        assertEquals(ContinueTarget.Play(true, s2, f2), target(progress = listOf(ProgressEntry("999:x:y"), ProgressEntry("200:s2:f2"))))

    @Test fun doesNotResumeAnEpisodeMarkedWatched() =
        assertEquals(ContinueTarget.Play(false, s1, e2), target(history = listOf(h("200:s1:e1", false)), watched = listOf("200:s1:e1")))

    @Test fun labels() {
        assertEquals("S2 · E5 · The Long Night", episodeLabel("2", "5", "The Long Night"))
        assertEquals("S2 · E5", episodeLabel("2", "5", "Episode 5"))
        assertEquals("E5 · Pilot", episodeLabel("", "5", "Pilot"))
        assertEquals("Pilot", episodeLabel("", "", "Pilot"))
        assertEquals("S2 · E5", historyEpisodeLabel(HistoryEntry(id = "200", params = "videoId=200&series=5&seasonId=s2&episodeId=e5&season=2", episodeTitle = "Episode 5")))
        assertEquals("Episode 5", historyEpisodeLabel(HistoryEntry(id = "200", params = "videoId=200&series=5&seasonId=s2&episodeId=e5", episodeTitle = "Episode 5")))
        assertEquals("", historyEpisodeLabel(HistoryEntry(id = "100", params = "videoId=100")))
        // Saved without it: the season looked up from the show's seasons (seasonId → number).
        val old = HistoryEntry(id = "200", params = "videoId=200&series=3&seasonId=s2&episodeId=e3", episodeTitle = "Episode 3")
        assertEquals("S2 · E3", historyEpisodeLabel(old, mapOf("200:s2" to "2")))
        assertEquals("200", seasonLookupFor(old))
        assertNull(seasonLookupFor(HistoryEntry(id = "200", params = "videoId=200&series=3&seasonId=s2&episodeId=e3&season=2")))
        assertNull(seasonLookupFor(HistoryEntry(id = "100", params = "videoId=100")))
        assertEquals("3", seasonNoOf(VodSeason("x", "x", "3")))
        assertEquals("4", seasonNoOf(VodSeason("x", "Season 4", "")))
        assertEquals("", seasonNoOf(VodSeason("x", "Specials", "")))
    }

    @Test fun countsASeasonsWatchedEpisodes() {
        val w = listOf("200:s1:e1", "200:s1:e2", "200:s2:f1", "300:s1:e1")
        assertEquals(2, watchedInSeason(w, "200", "s1"))
        assertEquals("2 watched", seasonWatchedLabel(2, null))
        assertEquals("2 of 3", seasonWatchedLabel(2, 3))
        assertEquals("Watched", seasonWatchedLabel(3, 3))
        assertEquals("", seasonWatchedLabel(0, 3))
        assertEquals(1, watchedOfEpisodes(listOf("200:s1:e1", "200:s1:gone"), "200", "s1", listOf(e1, e2)))
    }

    @Test fun episodeRowsCarryTheirNumber() {
        assertEquals("E11 · Narrow-Minded", episodeRowLabel(VodEpisode("x", "11", "Narrow-Minded")))
        assertEquals("Episode 11", episodeRowLabel(VodEpisode("x", "11", "Episode 11")))
        assertEquals("Episode 11", episodeRowLabel(VodEpisode("x", "11", "")))
        assertEquals("Pilot", episodeRowLabel(VodEpisode("x", "", "Pilot")))
    }
}
