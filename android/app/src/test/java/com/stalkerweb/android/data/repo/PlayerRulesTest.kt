package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.EpgEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlayerRulesTest {
    private fun ev(start: Long, end: Long, title: String) = EpgEvent(title = title, startTime = start, endTime = end)

    @Test fun nowAndTheNextTwo() {
        val a = ev(0, 100, "A"); val b = ev(100, 200, "B"); val c = ev(200, 300, "C"); val d = ev(300, 400, "D")
        assertEquals(NowPlaying(a, listOf(b, c)), nowPlaying(listOf(a, b, c, d), nowSecs = 50))
        // Between programmes: nothing on now, the next two still shown.
        assertEquals(NowPlaying(null, listOf(c, d)), nowPlaying(listOf(a, c, d), nowSecs = 150))
        assertEquals(NowPlaying(null, emptyList()), nowPlaying(listOf(a), nowSecs = 500))
    }

    private val news = Channel(uniqueId = "1", name = "BBC News", number = 101, genre = "NEWS")
    private val sport = Channel(uniqueId = "2", name = "Sky Sports", number = 202, genre = "SPORTS")
    private val kids = Channel(uniqueId = "3", name = "Cartoon", number = 7, genre = "KIDS")

    @Test fun theListFiltersBySearchFavoritesAndGenre() {
        val all = listOf(news, sport, kids)
        assertEquals(all, playerList(all, query = "", favoritesOnly = false, genre = null, favoriteIds = emptySet()))
        assertEquals(listOf(sport), playerList(all, "sky", false, null, emptySet()))
        assertEquals(listOf(sport), playerList(all, "202", false, null, emptySet()))          // by number too
        assertEquals(listOf(kids), playerList(all, "", true, null, setOf("3")))
        assertEquals(listOf(news), playerList(all, "", false, "NEWS", emptySet()))
        assertEquals(emptyList<Channel>(), playerList(all, "", true, "NEWS", setOf("3")))
    }

    @Test fun aFrozenPictureIsNudgedOnceThenReconnected() {
        var s = StallState(lastPositionMs = 1_000, lastAdvanceMs = 0, nudged = false)
        // Playing: the clock moves, nothing to do.
        var (next, action) = stallTick(s, nowMs = 2_000, positionMs = 2_000, bufferedMs = 5_000, idle = false)
        assertNull(action); s = next
        // Frozen for 3 s with video loaded ahead: nudge past it.
        stallTick(s, nowMs = 5_000, positionMs = 2_000, bufferedMs = 5_000, idle = false).let { (n, a) -> assertEquals(StallAction.Nudge(2_200), a); s = n }
        // Still frozen: no second nudge…
        stallTick(s, nowMs = 9_000, positionMs = 2_200, bufferedMs = 5_000, idle = false).let { (n, a) -> assertNull(a); s = n }
        // …and past 12 s from the start of the freeze, reconnect.
        assertEquals(StallAction.Reconnect, stallTick(s, nowMs = 14_500, positionMs = 2_200, bufferedMs = 5_000, idle = false).second)
    }

    @Test fun pausedOrNothingLoadedIsNotAStall() {
        val s = StallState(lastPositionMs = 1_000, lastAdvanceMs = 0, nudged = false)
        assertNull(stallTick(s, nowMs = 60_000, positionMs = 1_000, bufferedMs = 1_000, idle = true).second)
        // Nothing loaded ahead: no nudge, but still a reconnect after 12 s.
        val (n, a) = stallTick(s, nowMs = 4_000, positionMs = 1_000, bufferedMs = 1_100, idle = false)
        assertNull(a)
        assertEquals(StallAction.Reconnect, stallTick(n, nowMs = 13_000, positionMs = 1_000, bufferedMs = 1_100, idle = false).second)
    }

    @Test fun aJumpBackIsNotAFreeze() {
        // A live HLS window slides (the position drops a segment), a rewind, or a new item: start counting again.
        val s = StallState(lastPositionMs = 50_000, lastAdvanceMs = 0, nudged = false)
        val (n, a) = stallTick(s, nowMs = 5_000, positionMs = 42_000, bufferedMs = 60_000, idle = false)
        assertNull(a)
        assertEquals(StallState(42_000, 5_000, nudged = false), n)
    }

    @Test fun onlyTheLivePlayersOwnItemsCount() {
        assertEquals("live:42", liveMediaId("42"))
        assertEquals(true, isLiveMediaId("live:42"))
        assertEquals(false, isLiveMediaId("vod:9:0::"))
        assertEquals(false, isLiveMediaId(null))
    }
}
