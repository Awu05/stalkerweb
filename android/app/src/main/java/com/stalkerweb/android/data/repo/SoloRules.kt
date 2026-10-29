package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.DownloadJob

/**
 * Where Solo — the app with the StalkerWeb server inside — differs from the
 * remote apps on the same screens. Both flavors share every screen; these
 * say what Solo leaves out or words its own way (BuildConfig.IS_SOLO).
 */

/** Every card on the Settings screen, in screen order (tab by tab), with the tab it's on. */
enum class SettingsCard(val tab: String) {
    Viewers("viewers"),
    Filters("viewers"),
    HiddenLanguages("viewers"),
    Channels("viewers"),
    MoviesSeries("viewers"),
    ViewerPlayback("viewers"),
    AdultContent("viewers"),
    Server("connection"),
    IptvConnections("connection"),
    DeviceProfile("connection"),
    Links("links"),
    PlaybackGuide("playback"),
    ChannelLogos("logos"),
    LogoOverrides("logos"),
    LogoStripWords("logos"),
    Activity("activity"),
    AppUpdates("app"),
}

/**
 * The cards Settings shows. Solo has one person on one device, on a server
 * only it reaches: no viewers to manage, no activity from other devices, no
 * server to change — and no links for other apps, which would point at
 * 127.0.0.1, where nothing else can reach it.
 */
fun shownCards(isSolo: Boolean): List<SettingsCard> =
    if (isSolo) SettingsCard.entries - setOf(SettingsCard.Viewers, SettingsCard.Links, SettingsCard.Activity, SettingsCard.Server)
    else SettingsCard.entries.toList()

/** Single fields inside a card that one app shows and the other doesn't. */
enum class SettingsField { DownloadFolder }

/**
 * The fields Settings shows. Solo's downloads land in the device's Downloads
 * folder, and the server's own folder stays in the app's private storage: no
 * folder to choose.
 */
fun shownFields(isSolo: Boolean): Set<SettingsField> =
    if (isSolo) emptySet() else SettingsField.entries.toSet()

/** The Settings tabs that still have a card to show (Solo has no Activity tab). */
fun shownSettingsTabs(isSolo: Boolean): List<String> = shownCards(isSolo).map { it.tab }.distinct()

/** A tab's label: Solo's "viewers" tab holds just your filters, so it's called that. */
fun settingsTabLabel(id: String, label: String, isSolo: Boolean): String =
    if (isSolo && id == "viewers") "Filters" else label

/** "Ann's filters" — just "Your filters" in Solo, which has no one else. */
fun filtersTitle(viewerName: String?, isSolo: Boolean): String = ownedTitle("filters", viewerName, isSolo)

/** "Ann's channels" — just "Your channels" in Solo. */
fun channelsTitle(viewerName: String?, isSolo: Boolean): String = ownedTitle("channels", viewerName, isSolo)

/** "Ann's [what]", or "Your [what]" in Solo (or with no viewer known yet). */
fun ownedTitle(what: String, viewerName: String?, isSolo: Boolean): String =
    if (isSolo || viewerName == null) "Your $what" else "$viewerName's $what"

/**
 * The address a TV on the Wi-Fi reaches this device on, for cast links: the
 * first private IPv4 among [addresses] (10/8, 172.16/12, 192.168/16).
 * Loopback, link-local, IPv6 and the carrier's (100.64/10, mobile data) don't count.
 */
fun lanHostOf(addresses: List<String>): String? = addresses.firstOrNull { isPrivateIpv4(it) }

private fun isPrivateIpv4(address: String): Boolean {
    val parts = address.split(".")
    if (parts.size != 4) return false
    val b = parts.map { p -> p.takeIf { it.isNotEmpty() && it.length <= 3 && it.all(Char::isDigit) }?.toInt()?.takeIf { it <= 255 } ?: return false }
    return b[0] == 10 || (b[0] == 172 && b[1] in 16..31) || (b[0] == 192 && b[1] == 168)
}

/**
 * What the Cast button says when the TV can't be sent a link, or null when it
 * can. Solo's server is on the device itself, so the TV reaches it over the
 * Wi-Fi only; a remote app's server was set up by an address only this device
 * can open (localhost).
 */
fun castMessage(reachable: Boolean, isSolo: Boolean): String? = when {
    reachable -> null
    isSolo -> "Casting needs Wi-Fi"
    else -> "The TV can't reach this server's address — set it up by its network address (not localhost) to cast"
}

/** The app's name on the App updates card: Solo is its own app, on a phone or a TV. */
fun appName(isTv: Boolean, isSolo: Boolean): String = when {
    isSolo -> "StalkerWeb Solo (${if (isTv) "TV" else "phone"})"
    isTv -> "StalkerWeb TV"
    else -> "StalkerWeb mobile"
}

/** What the empty Downloads screen says: Solo saves to this device's Downloads folder, not to a server. */
fun downloadsEmptyHint(isSolo: Boolean): String =
    if (isSolo) "Download a movie or episode from VOD to save it to Downloads/StalkerWeb on this device."
    else "Download a movie or episode from VOD to save it on the server."

/** Whether any of [jobs] is still to finish (queued or downloading): the server is busy with it. */
fun anyDownloadActive(jobs: List<DownloadJob>): Boolean =
    jobs.any { it.status == "queued" || it.status == "downloading" }

/** Why the app needs Solo's server kept running: SoloServer.hold / release. */
object SoloHold {
    const val PLAYING = "playing"
    const val CASTING = "casting"
    const val DOWNLOADING = "downloading"
}

/** How Android is told the server is in use (the foreground service type). */
enum class SoloForeground { MediaPlayback, DataSync }

/**
 * Playing or casting keeps the server up as media playback, which Android
 * doesn't time-limit; anything else (downloading) as a data sync. Nothing
 * held: it needn't be kept up.
 */
fun soloForeground(holds: Set<String>): SoloForeground? = when {
    holds.isEmpty() -> null
    SoloHold.PLAYING in holds || SoloHold.CASTING in holds -> SoloForeground.MediaPlayback
    else -> SoloForeground.DataSync
}

/**
 * Whether the app follows its downloads to hold the server up for them
 * (DownloadsRepository.watch): Solo only — a remote app's downloads are on a
 * server it doesn't keep running.
 */
fun followsDownloads(isSolo: Boolean): Boolean = isSolo

/**
 * What the server is still held for once the app's process has ended (swiped
 * away, or stopped by Android). Playing was in the app and ended with it; a
 * download goes on in the server, and a cast on the TV, which keeps fetching
 * from it — those are kept until the server says they're over ([holdsAfterStatus]).
 */
fun holdsLeftByApp(holds: Set<String>): Set<String> = holds - SoloHold.PLAYING

/** The server's word on what still needs it (GET /api/solo/status). */
data class SoloStatus(val downloadsActive: Boolean, val castActive: Boolean)

/** The server's answer to GET /api/solo/status, or null when it isn't one. */
fun parseSoloStatus(json: String): SoloStatus? {
    fun flag(name: String) = Regex(""""$name"\s*:\s*(true|false)\b""").find(json)?.groupValues?.get(1)?.toBooleanStrict()
    return SoloStatus(flag("downloadsActive") ?: return null, flag("castActive") ?: return null)
}

/**
 * [left] (holdsLeftByApp) once the server has said [status]: each is let go
 * when the server no longer has it going. One the server can't speak for
 * isn't kept — nothing in the app is left to let go of it.
 */
fun holdsAfterStatus(left: Set<String>, status: SoloStatus): Set<String> = left.filterTo(mutableSetOf()) {
    when (it) {
        SoloHold.DOWNLOADING -> status.downloadsActive
        SoloHold.CASTING -> status.castActive
        else -> false
    }
}

/** How long a server that's still starting (installing or booting) is given before a restart may stop it after all. */
const val SOLO_STUCK_START_MS = 180_000L

/**
 * Whether a restart the app asks for (Try again, a key refused) starts Node
 * again. Not while the server is still starting — unpacking itself on a first
 * start, or booting: stopping it then only starts that over. It's waited for
 * again, unless it has been at it for [SOLO_STUCK_START_MS] without answering.
 */
fun restartsNode(answered: Boolean, startingForMs: Long): Boolean = answered || startingForMs >= SOLO_STUCK_START_MS

/** How long the first start of a server version may take: it unpacks the server first. */
const val SOLO_FIRST_START_MS = 60_000L

/** How long to wait for the server to answer: [askedMs], or longer when this version isn't [installed] yet. */
fun startWaitMs(askedMs: Long, installed: Boolean): Long = if (installed) askedMs else maxOf(askedMs, SOLO_FIRST_START_MS)

/**
 * What Solo's server proves on GET /api/health?nonce=<nonce>: HMAC-SHA256 of
 * "solo-health:<nonce>" keyed with the access key, in hex (routes/solo.js).
 * Only a server holding the key can give it, so the app sends the key to a
 * port only after the server there has given it (SoloServer).
 */
fun soloHealthProof(key: String, nonce: String): String {
    val mac = javax.crypto.Mac.getInstance("HmacSHA256")
    mac.init(javax.crypto.spec.SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    return mac.doFinal("solo-health:$nonce".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}

/** Whether a /api/health answer carries the proof for [nonce] under [key] (compared in constant time). */
fun healthProves(json: String, key: String, nonce: String): Boolean {
    val proof = Regex(""""proof"\s*:\s*"([0-9a-f]{64})"""").find(json)?.groupValues?.get(1) ?: return false
    return java.security.MessageDigest.isEqual(proof.toByteArray(), soloHealthProof(key, nonce).toByteArray())
}

/** Restarts for a refused key allowed in [SOLO_RESTART_WINDOW_MS]: more means the restart doesn't help. */
const val SOLO_MAX_RESTARTS = 3
const val SOLO_RESTART_WINDOW_MS = 120_000L

/**
 * Whether a refused key (AccessProblem) may restart the server again, given
 * when it was restarted for one before ([restartsAt]): not after
 * [SOLO_MAX_RESTARTS] in [SOLO_RESTART_WINDOW_MS] — then the Failed screen,
 * with Try again, rather than restart for ever.
 */
fun mayRestartForAccess(restartsAt: List<Long>, nowMs: Long): Boolean =
    restartsAt.count { nowMs - it in 0 until SOLO_RESTART_WINDOW_MS } < SOLO_MAX_RESTARTS

/** The kinds of network a TV may reach this device on, best first. */
enum class LanKind { Wifi, Ethernet, Hotspot }

/** A network the device is on (or gives, as a hotspot), and its addresses. */
data class LanNetwork(val kind: LanKind, val addresses: List<String>)

/**
 * The address for cast links: Wi-Fi first, then Ethernet, then the device's
 * own hotspot (a TV joined to it) — the same answer whichever came up first.
 * Within a kind, the networks' order as given (the caller keeps it stable).
 */
fun lanHostAmong(networks: List<LanNetwork>): String? =
    networks.sortedBy { it.kind.ordinal }.firstNotNullOfOrNull { lanHostOf(it.addresses) }

/**
 * Whether a network interface is one the device shares its connection on —
 * a hotspot (ap0, swlan0, softap0, wlan1…) or USB/Bluetooth tethering — whose
 * clients (a TV on the phone's hotspot) can reach it. wlan0 is the Wi-Fi itself.
 */
fun isTetherInterface(name: String): Boolean =
    Regex("""(ap|swlan|softap|rndis|usb|bt-pan)\d*|wlan[1-9]\d*""").matches(name)

/**
 * Whether to ask for notifications now (Android 13+): once, the first time the
 * server is held in the foreground (playing, casting, downloading) — its
 * "running" notification shows only with them. Never asked again, never in
 * the way: the server runs the same without.
 */
fun asksForNotifications(sdk: Int, granted: Boolean, askedBefore: Boolean, holds: Set<String>): Boolean =
    sdk >= 33 && !granted && !askedBefore && holds.isNotEmpty()
