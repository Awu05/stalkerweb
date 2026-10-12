package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Test

class ChannelCacheTest {
    private val list = listOf("a", "b")

    @Test fun theCacheIsOnlyForTheViewerWhoseListItIs() {
        assertEquals(list, cachedFor("view_a", "view_a") { list })
        // A switched-to viewer must not see the last viewer's (filtered) list.
        assertEquals(emptyList<String>(), cachedFor("view_kid", "view_a") { list })
        assertEquals(emptyList<String>(), cachedFor("view_a", null) { list })
    }
}
