package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Profile

// What a connection needs before it can be saved — the web's lib/profileRequired.js
// (but the timeout, which the apps don't show: it stays as saved, 10 s by
// default). Everything else (login, password, token, signature) is optional.
// A device ID is needed only while it's sent to the portal.

private val REQUIRED: List<Pair<String, (Profile) -> Boolean>> = listOf(
    "Profile name" to { p -> p.name.isNotBlank() },
    "Portal URL" to { p -> p.portal.isNotBlank() },
    "MAC address" to { p -> normalizeMac(p.mac).isNotEmpty() },
    "Timezone" to { p -> p.timezone.isNotBlank() },
    "Language" to { p -> p.lang.isNotBlank() },
    "Serial number" to { p -> p.serialNumber.isNotBlank() },
    "Device ID" to { p -> !p.sendDeviceId || p.deviceId.isNotBlank() },
    "Device ID 2" to { p -> !p.sendDeviceId2 || p.deviceId2.isNotBlank() },
)

/** The required fields still missing from a connection, by label. */
fun missingProfileFields(p: Profile): List<String> = REQUIRED.filterNot { (_, ok) -> ok(p) }.map { it.first }
