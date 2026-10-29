package com.stalkerweb.android.data.repo

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
 * only it reaches: no viewers to manage, no activity from other devices, and
 * no server to change.
 */
fun shownCards(isSolo: Boolean): List<SettingsCard> =
    if (isSolo) SettingsCard.entries - setOf(SettingsCard.Viewers, SettingsCard.Activity, SettingsCard.Server)
    else SettingsCard.entries.toList()

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
