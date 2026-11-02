package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WakeRulesTest {
    @Test fun `back in the app after a while away wakes the server`() {
        val now = 1_000_000_000L
        assertEquals(5 * 60_000L, WAKE_AFTER_HIDDEN_MS)
        assertTrue(wakesOnReturn(now - 6 * 60_000L, now))
        assertFalse(wakesOnReturn(now - 60_000L, now))   // a quick switch away
        assertFalse(wakesOnReturn(null, now))            // never left
    }
}
