package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Profile
import com.stalkerweb.android.data.api.StatusResponse
import java.net.URI

/** What the app is connected to: the IPTV connection's name and the portal's address. */
data class ConnectionLabel(val name: String, val host: String)

/** A portal address in one form, for comparing: no trailing /c/, then "/c/" added. */
fun normalizePortal(url: String): String =
    url.trim().replace(Regex("/c/?$"), "").removeSuffix("/") + "/c/"

/** "host:port" (or just the host) of a URL; the URL itself when it can't be read. */
fun hostOf(url: String): String = runCatching {
    val uri = URI(url.trim())
    val host = uri.host ?: return@runCatching url
    if (uri.port > 0) "$host:${uri.port}" else host
}.getOrDefault(url)

/**
 * The saved profile for this portal and MAC (else any for this portal), else
 * just the portal's address. Null when not connected. Mirrors
 * frontend/src/lib/connection.js.
 */
fun connectionLabel(status: StatusResponse?, profiles: List<Profile>): ConnectionLabel? {
    if (status?.connected != true) return null
    val raw = status.portal?.takeIf { it.isNotBlank() } ?: return null
    val host = hostOf(raw)
    val portal = normalizePortal(raw)
    val mac = status.mac.orEmpty().uppercase()
    val match = profiles.firstOrNull { it.portal.isNotBlank() && normalizePortal(it.portal) == portal && it.mac.uppercase() == mac }
        ?: profiles.firstOrNull { it.portal.isNotBlank() && normalizePortal(it.portal) == portal }
    return ConnectionLabel(match?.name?.trim()?.takeIf { it.isNotEmpty() } ?: host, host)
}
