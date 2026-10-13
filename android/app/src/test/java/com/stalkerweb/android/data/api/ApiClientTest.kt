package com.stalkerweb.android.data.api

import org.junit.Assert.assertEquals
import org.junit.Test

class ApiClientTest {
    @Test fun sendsTheKeyAndTheViewerWhenSet() {
        assertEquals(
            mapOf("Authorization" to "Bearer secret-key-123", "X-Viewer" to "view_a"),
            requestHeaders("secret-key-123", "view_a"),
        )
    }

    @Test fun leavesOutWhatIsNotSet() {
        assertEquals(mapOf("X-Viewer" to "view_a"), requestHeaders(null, "view_a"))
        assertEquals(mapOf("Authorization" to "Bearer k"), requestHeaders("k", " "))
        assertEquals(emptyMap<String, String>(), requestHeaders("", null))
    }
}
