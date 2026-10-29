package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.SkipPart
import com.stalkerweb.android.data.api.SkipResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SkipSegmentsTest {
    private val parts = SkipResponse(intro = SkipPart(60.0, 90.0), recap = SkipPart(0.0, 40.0), outro = SkipPart(2800.0, 2900.0))
    private val auto = parts.copy(skipMode = "auto")
    private val off = parts.copy(skipMode = "off")

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

    @Test fun `is nothing with intro skipping off`() {
        assertNull(skipAt(off, 10.0))
        assertNull(skipAt(off, 2850.0))
    }

    @Test fun `the skip mode is the viewer's, an older server's autoSkip, or the Skip button`() {
        assertEquals("off", skipModeOf("off", autoSkip = false))
        assertEquals("auto", skipModeOf(null, autoSkip = true))
        assertEquals("button", skipModeOf("nonsense", autoSkip = false))
        assertEquals("button", skipModeOf(null, autoSkip = false))
    }

    @Test fun `auto-skips an intro or recap once, never the credits`() {
        assertEquals(90.0, autoSkipTo(auto, 61.0, emptySet())?.to)
        assertNull(autoSkipTo(auto, 61.0, setOf("intro")))
        assertNull(autoSkipTo(auto, 2850.0, emptySet()))
    }

    @Test fun `auto-skips nothing unless the viewer chose to skip automatically`() {
        assertNull(autoSkipTo(parts, 61.0, emptySet()))
        assertNull(autoSkipTo(off, 61.0, emptySet()))
        assertEquals(90.0, autoSkipTo(parts.copy(autoSkip = true), 61.0, emptySet())?.to)
    }

    private val dur = 2950.0

    @Test fun `Next episode shows in the last 30 seconds, without any skip times`() {
        assertEquals(30.0, NEXT_PROMPT_SECS, 0.0)
        assertTrue(nextPromptAt(null, dur - 30, dur, hasNext = true))
        assertTrue(nextPromptAt(null, dur - 5, dur, hasNext = true))
        assertFalse(nextPromptAt(null, dur - 31, dur, hasNext = true))
    }

    @Test fun `Next episode shows during the credits too`() {
        assertTrue(nextPromptAt(parts, 2850.0, dur, hasNext = true))
        assertFalse(nextPromptAt(parts, 2700.0, dur, hasNext = true))
    }

    @Test fun `Next episode shows near the end with skipping off, but not in the credits then`() {
        assertTrue(nextPromptAt(off, dur - 10, dur, hasNext = true))
        assertFalse(nextPromptAt(off, 2850.0, dur, hasNext = true))
    }

    @Test fun `no Next episode without one, or before the duration is known`() {
        assertFalse(nextPromptAt(parts, 2850.0, dur, hasNext = false))
        assertFalse(nextPromptAt(null, dur - 5, dur, hasNext = false))
        assertFalse(nextPromptAt(null, 5.0, 0.0, hasNext = true))
        assertFalse(nextPromptAt(null, Double.NaN, dur, hasNext = true))
    }
}
