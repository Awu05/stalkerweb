package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Right after the server reconnects, its channel list can come back empty
// with loading: true. The cached list stays (shown, and on disk) until the
// real one arrives.
class ChannelListsTest {
    @Test fun `an empty list while loading keeps the cache`() {
        assertEquals(listOf("a"), keptList(cached = listOf("a"), fresh = emptyList(), loading = true))
        assertTrue(refetchesWhenLoaded(fresh = emptyList<String>(), loading = true))
    }

    @Test fun `a real list replaces it, an empty one once loading ended too`() {
        assertEquals(listOf("b"), keptList(cached = listOf("a"), fresh = listOf("b"), loading = true))
        assertEquals(emptyList<String>(), keptList(cached = listOf("a"), fresh = emptyList(), loading = false))
        assertFalse(refetchesWhenLoaded(fresh = emptyList<String>(), loading = false))
    }
}
