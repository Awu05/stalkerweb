package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Test

// sha256("00:1A:79:AA:BB:CC") in uppercase hex, worked out with Node's crypto.
private const val EXPECTED = "21DA59C248805FDF0F36FA2C4CA4569E10D1F80268D8104C7AF8BB776D657ED8"

class DeviceIdTest {
    @Test fun `hashes the uppercase MAC with colons as uppercase hex`() {
        assertEquals(EXPECTED, macDeviceId("00:1A:79:AA:BB:CC"))
    }

    @Test fun `reads a MAC typed in lowercase, with dashes or without separators`() {
        assertEquals(EXPECTED, macDeviceId("00:1a:79:aa:bb:cc"))
        assertEquals(EXPECTED, macDeviceId("00-1A-79-AA-BB-CC"))
        assertEquals(EXPECTED, macDeviceId(" 001a79aabbcc "))
    }

    @Test fun `is empty until the MAC is complete`() {
        assertEquals("", macDeviceId(""))
        assertEquals("", macDeviceId("00:1A:79:AA:BB"))
        assertEquals("", normalizeMac("00:1A:79:AA:BB:CC:DD"))
    }
}
