package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.ActivityPortal
import com.stalkerweb.android.data.api.ActivityStream
import org.junit.Assert.assertEquals
import org.junit.Test

/** The same cases as the web's frontend/src/lib/activity.test.js. */
class ActivityRulesTest {
    @Test fun `says how long something has played`() {
        assertEquals("just now", playingFor(0, 30_000))
        assertEquals("12 min", playingFor(0, 12 * 60_000L))
        assertEquals("1 h 5 min", playingFor(0, 65 * 60_000L))
        assertEquals("2 h", playingFor(0, 120 * 60_000L))
    }

    @Test fun `badges live, a movie, an episode and a cast`() {
        assertEquals("Live", kindLabel(ActivityStream(kind = "live", id = "5")))
        assertEquals("Movie", kindLabel(ActivityStream(kind = "vod", id = "100")))
        assertEquals("Episode", kindLabel(ActivityStream(kind = "vod", id = "200:s1:e3")))
        assertEquals("Cast", kindLabel(ActivityStream(kind = "live", id = "5", via = "cast")))
    }

    @Test fun `says how it got here`() {
        assertEquals("Xtream player", viaLabel(ActivityStream(kind = "live", id = "5", via = "xtream")))
        assertEquals("", viaLabel(ActivityStream(kind = "live", id = "5")))
    }

    @Test fun `sums up the portal`() {
        assertEquals("portal.example · 2 open streams · 1 channel cast to a TV", portalSummary(ActivityPortal(true, "portal.example", 2, 1)))
        assertEquals("p · 1 open stream", portalSummary(ActivityPortal(true, "p", 1, 0)))
        assertEquals("Portal not connected", portalSummary(ActivityPortal(false)))
    }
}
