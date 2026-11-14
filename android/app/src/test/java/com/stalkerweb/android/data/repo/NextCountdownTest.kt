package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NextCountdownTest {
    // The player checks twice a second.
    private fun NextCountdown.run(key: String, fromMs: Long, toMs: Long, showing: Boolean = true, playing: Boolean = true): Int? {
        var left: Int? = null
        var t = fromMs
        while (t <= toMs) { left = update(key, showing, playing, t); t += 500 }
        return left
    }

    @Test fun countsFiveSecondsOfPlayingDownToZero() {
        val c = NextCountdown()
        assertEquals(5, c.update("ep1", showing = true, playing = true, nowMs = 0))
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
        assertNull(c.update("ep1", showing = false, playing = true, nowMs = 0))
        c.run("ep1", 500, 3_000)
        assertNull(c.update("ep1", showing = false, playing = true, nowMs = 3_500))
        assertEquals(5, c.update("ep1", showing = true, playing = true, nowMs = 10_000))
    }

    @Test fun stoppedStaysStoppedForThatEpisodeOnly() {
        val c = NextCountdown()
        c.run("ep1", 0, 2_000)
        c.stop("ep1")
        assertNull(c.update("ep1", showing = true, playing = true, nowMs = 2_500))
        assertNull(c.update("ep1", showing = false, playing = true, nowMs = 3_000))
        assertNull(c.update("ep1", showing = true, playing = true, nowMs = 3_500))
        assertEquals(5, c.update("ep2", showing = true, playing = true, nowMs = 4_000))
    }

    @Test fun aNewEpisodeStartsAgainFromFive() {
        val c = NextCountdown()
        c.run("ep1", 0, 3_000)
        assertEquals(5, c.update("ep2", showing = true, playing = true, nowMs = 3_500))
    }
}
