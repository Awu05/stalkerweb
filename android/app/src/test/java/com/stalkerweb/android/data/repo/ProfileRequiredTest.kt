package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Profile
import org.junit.Assert.assertEquals
import org.junit.Test

class ProfileRequiredTest {
    // A connection filled in: everything a portal needs, login, password and signature empty.
    private val filled = Profile(
        id = "p1", name = "IPTV", portal = "http://portal.example/c/", mac = "00:1A:79:12:34:56", timezone = "America/New_York",
        lang = "en", serialNumber = "001a79123456", deviceId = "ABC", deviceId2 = "ABC",
    )

    @Test fun `needs nothing more for a connection filled in`() {
        assertEquals(emptyList<String>(), missingProfileFields(filled))
    }

    @Test fun `names what is missing`() {
        assertEquals(listOf("Profile name", "Serial number"), missingProfileFields(filled.copy(name = " ", serialNumber = "")))
        assertEquals(listOf("MAC address"), missingProfileFields(filled.copy(mac = "00:1A:79")))
    }

    @Test fun `needs a device ID only while it is sent`() {
        assertEquals(listOf("Device ID", "Device ID 2"), missingProfileFields(filled.copy(deviceId = "", deviceId2 = "")))
        assertEquals(emptyList<String>(), missingProfileFields(filled.copy(deviceId = "", sendDeviceId = false, deviceId2 = "", sendDeviceId2 = false)))
    }

    @Test fun `shows the blanks the server fills anyway as it does, so a working connection can be saved`() {
        val old = Profile(id = "p0", portal = "http://portal.example/c/", mac = "00:1A:79:12:34:56", name = "", serialNumber = "")
        val p = prepareProfile(old)
        assertEquals("portal.example", p.name)
        assertEquals(SERIAL_PLACEHOLDER, p.serialNumber)
        assertEquals(false, p.sendDeviceId)
        assertEquals(emptyList<String>(), missingProfileFields(p))
        assertEquals(filled, prepareProfile(filled))
    }
}
