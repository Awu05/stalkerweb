package com.stalkerweb.android.ui.vod

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PosterSizesTest {
    @Test fun tvPostersFollowTheScreenHeightAndRowsMatchTheGrid() {
        // A 21:9 screen: 1280 x 540 dp, the grid beside the rail and categories.
        val s = posterSizesFor(isTv = true, screenHeightDp = 540, gridWidthDp = 955, gridHeightDp = 370)
        assertEquals(6, s.columns)
        assertEquals(143, s.cellDp)
        assertEquals(s.cellDp, s.rowDp)
        // Wide enough for "Back to To watch" under a My List poster.
        assertTrue(s.cellDp >= 135)
    }

    @Test fun tvPostersStayWithinBounds() {
        assertEquals(160, posterSizesFor(true, 1080, 160 + 24, 900).cellDp)
        assertEquals(110, posterSizesFor(true, 300, 110 + 24, 300).cellDp)
    }

    @Test fun phoneGridStretchesLikeBefore() {
        val s = posterSizesFor(isTv = false, screenHeightDp = 800, gridWidthDp = 411, gridHeightDp = 600)
        assertEquals(2, s.columns)
        assertEquals(186, s.cellDp)
        assertEquals(150, s.rowDp)
    }

    @Test fun aPhoneOnItsSideFitsAWholePosterInTheGrid() {
        val s = posterSizesFor(isTv = false, screenHeightDp = 360, gridWidthDp = 475, gridHeightDp = 210)
        val minWidth = (210 - 56) * 2 / 3
        assertEquals(minWidth, s.rowDp)
        assertTrue(s.cellDp < 140)
        assertEquals(4, s.columns)
    }

    @Test fun neverBelowOneColumnOrTheSmallestPoster() {
        val s = posterSizesFor(isTv = false, screenHeightDp = 200, gridWidthDp = 60, gridHeightDp = 80)
        assertEquals(1, s.columns)
        assertEquals(90, s.cellDp)
        assertEquals(90, s.rowDp)
    }
}
