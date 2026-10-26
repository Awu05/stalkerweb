package com.stalkerweb.android.data.repo

import java.security.MessageDigest

/** "00:1a:79-aa bb cc" → "00:1A:79:AA:BB:CC", or "" if it isn't 12 hex digits. */
fun normalizeMac(mac: String): String {
    val hex = mac.filter { it.isDigit() || it.lowercaseChar() in 'a'..'f' }.uppercase()
    return if (hex.length == 12) hex.chunked(2).joinToString(":") else ""
}

/**
 * The device ID a MAG box derives from its MAC: SHA-256 of the MAC in uppercase
 * with colons, as uppercase hex ("" until the MAC is complete). The web's
 * macDeviceId.js does the same.
 */
fun macDeviceId(mac: String): String {
    val m = normalizeMac(mac)
    if (m.isEmpty()) return ""
    return MessageDigest.getInstance("SHA-256").digest(m.toByteArray()).joinToString("") { "%02X".format(it) }
}
