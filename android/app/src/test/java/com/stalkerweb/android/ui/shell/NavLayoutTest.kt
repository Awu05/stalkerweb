package com.stalkerweb.android.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class NavLayoutTest {
    @Test fun railOnTvAndWideScreens() {
        assertEquals(NavLayout.RAIL, navLayoutFor(400, isTv = true))
        assertEquals(NavLayout.RAIL, navLayoutFor(840, isTv = false))
        assertEquals(NavLayout.RAIL, navLayoutFor(600, isTv = false))
    }

    @Test fun bottomBarOnPhones() {
        assertEquals(NavLayout.BOTTOM_BAR, navLayoutFor(411, isTv = false))
    }
}
