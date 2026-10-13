package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.data.api.StatusResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectionLabelTest {
    private val status = StatusResponse(connected = true, portal = "http://tv.example.com:8080/c/", mac = "00:1a:79:aa:bb:cc")
    private val home = Profile(id = "p1", name = "Home IPTV", portal = "http://tv.example.com:8080", mac = "00:1A:79:AA:BB:CC")
    private val backup = Profile(id = "p2", name = "Backup", portal = "http://tv.example.com:8080/c", mac = "00:1A:79:00:00:01")

    @Test fun namesTheProfileForThisPortalAndMac() {
        assertEquals(ConnectionLabel("Home IPTV", "tv.example.com:8080"), connectionLabel(status, listOf(backup, home)))
    }

    @Test fun fallsBackToAnyProfileForThePortalThenToTheHost() {
        assertEquals("Backup", connectionLabel(status, listOf(backup))?.name)
        assertEquals(ConnectionLabel("tv.example.com:8080", "tv.example.com:8080"), connectionLabel(status, emptyList()))
    }

    @Test fun isNothingWhileDisconnected() {
        assertNull(connectionLabel(status.copy(connected = false), listOf(home)))
        assertNull(connectionLabel(null, listOf(home)))
    }

    @Test fun normalizesPortals() {
        assertEquals("http://x/c/", normalizePortal("http://x"))
        assertEquals("http://x/c/", normalizePortal(" http://x/c "))
        assertEquals("http://x/c/", normalizePortal("http://x/"))
    }
}
