package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WatchRulesTest {
    @Test fun resumesOnlyBetweenThirtySecondsAndNinetyFivePercent() {
        assertEquals(600.0, WatchRules.resumeAt(600.0, 6000.0)!!, 0.0)
        assertNull(WatchRules.resumeAt(20.0, 6000.0))       // only just started
        assertNull(WatchRules.resumeAt(5800.0, 6000.0))     // as good as finished
        assertNull(WatchRules.resumeAt(600.0, 0.0))         // length unknown
    }

    @Test fun keysAMovieOrAnEpisode() {
        assertEquals("42", WatchRules.makeKey("42"))
        assertEquals("7:s1:e2", WatchRules.makeKey("7", "s1", "e2"))
    }
}
