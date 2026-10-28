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

    @Test fun `only ASCII hex digits count, as on the web`() {
        assertEquals("", macDeviceId("００:１２:３４:５６:７８:９０"))
    }

    // A made-up box shaped like a real one (MAG250: its serial is its MAC in lowercase, its UID ends with
// the MAC), and the IDs its providers would expect — worked out separately with Node's crypto.
    private val mac = "00:1A:79:12:34:56"
    private val serial = "001a79123456"
    private val uid = "1234000000003456"
    private val expected = mapOf(
        DeviceIdSource.MAC to "667094E7E8FF0347F6EC27A8E8115BE76E2AA9CD5C8F13C6FA00BCEDFAC02B41",
        DeviceIdSource.MAC_PLAIN to "B45247562461D2938E199C57D45E2E9A098B957DE23CA0E79FDFC93FA3B0CA0F",
        DeviceIdSource.SERIAL to "F08152E46364DAEE6395A9D1C02389A97573928E94F821FD8B87A3936064B4EA",
        DeviceIdSource.UID to "F53C390E841C37F1A9E6DA3B31901D66B28A0604FC67FC26508EDC21794483AE",
    )

    @Test fun `makes each provider's device ID for a box`() {
        for ((source, id) in expected) assertEquals(source.name, id, deviceIdFrom(source, mac, serial, uid))
    }

    @Test fun `hashes the serial and UID exactly as typed, and nothing until they are filled in`() {
        assertEquals(expected[DeviceIdSource.SERIAL], deviceIdFrom(DeviceIdSource.SERIAL, "", " 001a79123456 ", ""))
        assertEquals("", deviceIdFrom(DeviceIdSource.SERIAL, mac, "", uid))
        assertEquals("", deviceIdFrom(DeviceIdSource.TYPED, mac, serial, uid))
    }

    @Test fun `tells which source saved IDs came from`() {
        for ((source, id) in expected) assertEquals(source, deviceIdSourceOf(mac, serial, uid, id, id))
        assertEquals(DeviceIdSource.TYPED, deviceIdSourceOf(mac, serial, uid, "ABC", "ABC"))
        assertEquals(DeviceIdSource.TYPED, deviceIdSourceOf(mac, serial, uid, expected.getValue(DeviceIdSource.MAC), "OTHER"))
    }

    @Test fun `uses the source saved with a connection, and never hashes the placeholder serial`() {
        val mac = expected.getValue(DeviceIdSource.MAC)
        assertEquals(DeviceIdSource.SERIAL, deviceIdSourceOf(this.mac, serial, uid, mac, mac, saved = "serial"))
        assertEquals(DeviceIdSource.MAC, deviceIdSourceOf(this.mac, serial, uid, mac, mac, saved = "nonsense"))
        assertEquals("", deviceIdFrom(DeviceIdSource.SERIAL, "", SERIAL_PLACEHOLDER, ""))
    }
}
