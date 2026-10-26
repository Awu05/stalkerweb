package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.SkipPart
import com.stalkerweb.android.data.api.SkipResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SkipSegmentsTest {
    private val parts = SkipResponse(intro = SkipPart(60.0, 90.0), recap = SkipPart(0.0, 40.0), outro = SkipPart(2800.0, 2900.0))

    @Test fun `names the part playing and where a skip lands`() {
        assertEquals(SkipNow("recap", "Skip recap", 40.0), skipAt(parts, 10.0))
        assertEquals(SkipNow("intro", "Skip intro", 90.0), skipAt(parts, 60.0))
        assertEquals(SkipNow("outro", "Skip credits", 2900.0), skipAt(parts, 2850.0))
    }

    @Test fun `is nothing between parts, in a part's last second, or without times`() {
        assertNull(skipAt(parts, 50.0))
        assertNull(skipAt(parts, 89.5))
        assertNull(skipAt(null, 10.0))
        assertNull(skipAt(SkipResponse(), 10.0))
    }

    @Test fun `auto-skips an intro or recap once, never the credits`() {
        assertEquals(90.0, autoSkipTo(parts, 61.0, emptySet())?.to)
        assertNull(autoSkipTo(parts, 61.0, setOf("intro")))
        assertNull(autoSkipTo(parts, 2850.0, emptySet()))
    }
}
