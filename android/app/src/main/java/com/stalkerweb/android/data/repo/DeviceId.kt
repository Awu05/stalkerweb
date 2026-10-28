package com.stalkerweb.android.data.repo

import java.security.MessageDigest

/** "00:1a:79-aa bb cc" → "00:1A:79:AA:BB:CC", or "" if it isn't 12 hex digits. */
fun normalizeMac(mac: String): String {
    val hex = mac.filter { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }.uppercase()
    return if (hex.length == 12) hex.chunked(2).joinToString(":") else ""
}

private fun sha256Hex(s: String): String =
    if (s.isEmpty()) "" else MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { String.format(java.util.Locale.ROOT, "%02X", it) }

/**
 * The device ID a MAG box derives from its MAC: SHA-256 of the MAC in uppercase
 * with colons, as uppercase hex ("" until the MAC is complete). The web's
 * macDeviceId.js does the same.
 */
fun macDeviceId(mac: String): String = sha256Hex(normalizeMac(mac))

/**
 * How a provider wants Device ID 1 and 2 made — boxes differ: SHA-256, as
 * uppercase hex, of one of these. TYPED: not made, typed in as given.
 */
enum class DeviceIdSource(val label: String, val id: String) {
    TYPED("Typed in", "typed"),
    MAC("MAC, with colons", "mac"),
    MAC_PLAIN("MAC, no colons", "mac-plain"),
    SERIAL("Serial number", "serial"),
    UID("UID", "uid"),
}

/** A new connection's serial until one is typed — the server's own for a blank one. Not a box's: never hashed. */
const val SERIAL_PLACEHOLDER = "0000000000000"

/**
 * The device ID a source makes — "" when what it hashes isn't filled in yet
 * (or for TYPED). The MAC is read as a MAC (any case or separators); the
 * serial and the UID are hashed exactly as typed (a box shows them in
 * lowercase, and hashes them so).
 */
fun deviceIdFrom(source: DeviceIdSource, mac: String, serial: String, uid: String): String = when (source) {
    DeviceIdSource.TYPED -> ""
    DeviceIdSource.MAC -> macDeviceId(mac)
    DeviceIdSource.MAC_PLAIN -> sha256Hex(normalizeMac(mac).replace(":", ""))
    DeviceIdSource.SERIAL -> serial.trim().takeIf { it != SERIAL_PLACEHOLDER }?.let(::sha256Hex).orEmpty()
    DeviceIdSource.UID -> sha256Hex(uid.trim())
}

/**
 * Which source a connection's device IDs come from: the one saved with it
 * ([saved], the web's name), else — saved before it was — the one its IDs are
 * (TYPED when none of them makes both).
 */
fun deviceIdSourceOf(mac: String, serial: String, uid: String, deviceId: String, deviceId2: String, saved: String = ""): DeviceIdSource {
    DeviceIdSource.entries.firstOrNull { it.id == saved }?.let { return it }
    if (deviceId.isEmpty() || deviceId != deviceId2) return DeviceIdSource.TYPED
    return DeviceIdSource.entries.firstOrNull { it != DeviceIdSource.TYPED && deviceIdFrom(it, mac, serial, uid) == deviceId } ?: DeviceIdSource.TYPED
}
