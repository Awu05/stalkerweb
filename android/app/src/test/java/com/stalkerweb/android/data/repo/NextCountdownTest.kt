package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NextCountdownTest {
    // The player checks twice a second.
    private fun NextCountdown.run(key: String, fromMs: Long, toMs: Long, showing: Boolean = true, playing: Boolean = true): Int? {
        var left: Int? = null
        var t = fromMs
        while (t <= toMs) { left = update(key, showing, playing, t)?.left; t += 500 }
        return left
    }
    private fun NextCountdown.at(key: String, nowMs: Long, showing: Boolean = true, playing: Boolean = true) =
        update(key, showing, playing, nowMs)?.left

    @Test fun countsFiveSecondsOfPlayingDownToZero() {
        val c = NextCountdown()
        assertEquals(5, c.at("ep1", 0))
        assertEquals(1, c.run("ep1", 500, 4_000))
        assertEquals(0, c.run("ep1", 4_500, 5_000))
    }

    @Test fun holdsWhilePaused() {
        val c = NextCountdown()
        c.run("ep1", 0, 2_000)
        assertEquals(3, c.run("ep1", 2_500, 20_000, playing = false))
        assertEquals(0, c.run("ep1", 20_500, 23_500))   // the first check after playing again only starts the clock
    }

    @Test fun nothingWhileTheButtonIsntShowingAndAFreshStartAfter() {
        val c = NextCountdown()
        assertNull(c.at("ep1", 0, showing = false))
        c.run("ep1", 500, 3_000)
        assertNull(c.at("ep1", 3_500, showing = false))
        assertEquals(5, c.at("ep1", 10_000))
    }

    @Test fun stoppedStaysStoppedForThatEpisodeOnly() {
        val c = NextCountdown()
        c.run("ep1", 0, 2_000)
        c.stop()
        assertNull(c.at("ep1", 2_500))
        assertNull(c.at("ep1", 3_000, showing = false))
        assertNull(c.at("ep1", 3_500))
        assertEquals(5, c.at("ep2", 4_000))
    }

    @Test fun aNewEpisodeStartsAgainFromFive() {
        val c = NextCountdown()
        c.run("ep1", 0, 3_000)
        assertEquals(5, c.at("ep2", 3_500))
    }

    @Test fun timeNotCheckedIsntCounted() {
        // Counting, then 30 s casting (no checks), then back: it carries on from where it was.
        val c = NextCountdown()
        c.run("ep1", 0, 2_000)
        c.hold()
        assertEquals(3, c.at("ep1", 32_000))
        assertEquals(2, c.run("ep1", 32_500, 33_000))
    }

    @Test fun fillsAllTheWayAtZero() {
        val c = NextCountdown()
        assertEquals(0f, c.update("ep1", true, true, 0)!!.filled)
        c.run("ep1", 500, 2_000)
        assertEquals(0.4f, c.update("ep1", true, true, 2_000)!!.filled, 0.001f)
        c.run("ep1", 2_500, 4_500)
        assertEquals(1f, c.update("ep1", true, true, 5_000)!!.filled)
    }
}

class NextCountdownAtTest {
    private val parts = com.stalkerweb.android.data.api.SkipResponse(
        intro = null, recap = null, outro = com.stalkerweb.android.data.api.SkipPart(2800.0, 2900.0),
    )
    @Test fun duringTheCreditsOnly() {
        org.junit.Assert.assertTrue(nextCountdownAt(parts, 2850.0))
        org.junit.Assert.assertFalse(nextCountdownAt(parts, 2790.0))
        org.junit.Assert.assertFalse(nextCountdownAt(null, 2990.0))
        org.junit.Assert.assertFalse(nextCountdownAt(parts.copy(skipMode = "off"), 2850.0))
    }
}

class NextEpisodeDelayTest {
    @Test fun theViewersChoiceOrFiveSeconds() {
        assertEquals(0, nextEpisodeDelayOf(0))
        assertEquals(-1, nextEpisodeDelayOf(-1))
        assertEquals(15, nextEpisodeDelayOf(15))
        assertEquals(5, nextEpisodeDelayOf(null))
        assertEquals(5, nextEpisodeDelayOf(7))
    }

    @Test fun zeroSecondsIsAtZeroStraightAway() {
        val c = NextCountdown()
        assertEquals(CountdownNow(0, 1f), c.update("ep1", true, false, 0, secs = 0))
    }

    @Test fun tenSecondsCountsFromTen() {
        val c = NextCountdown()
        assertEquals(10, c.update("ep1", true, true, 0, secs = 10)!!.left)
        var t = 500L
        while (t <= 9_000) { c.update("ep1", true, true, t, secs = 10); t += 500 }
        assertEquals(1, c.update("ep1", true, true, 9_000, secs = 10)!!.left)
        assertEquals(0.9f, c.update("ep1", true, true, 9_000, secs = 10)!!.filled, 0.001f)
    }
}
