package com.stalkerweb.android.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ViewerColorsTest {
    @Test fun readsSixDigitHex() {
        assertEquals(0xFF5B8DEFL, parseHexColor("#5b8def"))
        assertEquals(0xFF5B8DEFL, parseHexColor("5B8DEF"))
    }

    @Test fun refusesAnythingElse() {
        assertNull(parseHexColor(null))
        assertNull(parseHexColor("red"))
        assertNull(parseHexColor("#abc"))
        assertNull(parseHexColor("#GGGGGG"))
    }
}
