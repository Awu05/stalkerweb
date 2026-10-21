package com.stalkerweb.android.cast

import com.stalkerweb.android.data.api.CastLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CastRulesTest {
    @Test fun `a movie starts on the TV where the phone was, live from now`() {
        val movie = castMediaOf(CastLink("http://s/k/t/proxy/vod/stream.mp4?videoId=1", "video/mp4"), "Heat", startMs = 61_000)
        assertEquals(61_000L, movie.startMs)
        assertEquals("video/mp4", movie.contentType)
        val live = castMediaOf(CastLink("http://s/k/t/proxy/cast/live/5/index.m3u8", "application/x-mpegURL", live = true), "News", startMs = 61_000)
        assertEquals(0L, live.startMs)
        assertEquals(true, live.live)
    }

    @Test(expected = UnreachableCastLink::class)
    fun `a link only this machine can open is refused`() {
        castMediaOf(CastLink("http://localhost:8983/proxy/vod/stream.mp4", "video/mp4", reachable = false), "Heat")
    }

    @Test fun `the phone picks up where the TV got to, unless it was at the end or hadn't started`() {
        assertEquals(1_200_000L, resumeAfterCast(1_200_000, 6_000_000))
        assertNull(resumeAfterCast(5_800_000, 6_000_000))
        assertNull(resumeAfterCast(0, 6_000_000))
        assertEquals(30_000L, resumeAfterCast(30_000, 0))   // duration unknown
    }
}
