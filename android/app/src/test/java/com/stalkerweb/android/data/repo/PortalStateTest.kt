package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.StatusResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException

// Asleep: the server's idle timeout dropped the portal session; the channel
// list's own request wakes it (backend lib/portalSession.js).
class PortalStateTest {
    private val off = StatusResponse(connected = false, portal = "http://a.portal.example/c/", mac = "00:1A:79:12:34:56")

    @Test fun `asleep is usable - startup stays on the channels`() {
        assertTrue(portalUsable(off.copy(asleep = true)))
        assertFalse(startupOpensPortal(off.copy(asleep = true)))
        assertFalse(startupOpensPortal(off.copy(asleep = true, wakeError = "portal unreachable")))
        assertFalse(startupOpensPortal(off.copy(connected = true)))
    }

    @Test fun `disconnected opens the Portal screen at startup, no answer doesn't`() {
        assertFalse(portalUsable(off))
        assertTrue(startupOpensPortal(off))
        assertFalse(startupOpensPortal(null))
    }

    @Test fun `a 503 from a failed wake carries its reason`() {
        assertEquals("portal unreachable", wakeErrorOf("""{"error":"Couldn't reconnect to the portal: portal unreachable","wakeError":"portal unreachable"}"""))
        assertNull(wakeErrorOf("""{"error":"Not connected to a portal. POST /api/auth/connect first."}"""))
        assertNull(wakeErrorOf(null))
    }

    @Test fun `a slow wake is waited for, a few times`() {
        assertTrue(retriesWhileWaking(SocketTimeoutException(), attempt = 0))
        assertTrue(retriesWhileWaking(SocketTimeoutException(), attempt = WAKE_LOAD_RETRIES - 1))
        assertFalse(retriesWhileWaking(SocketTimeoutException(), attempt = WAKE_LOAD_RETRIES))
        assertFalse(retriesWhileWaking(IOException("no route"), attempt = 0))
    }
}
