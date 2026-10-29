package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.DownloadJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SoloRulesTest {
    @Test fun `Solo shows no viewers, activity or server settings`() {
        assertFalse(shownCards(isSolo = true).any { it in setOf(SettingsCard.Viewers, SettingsCard.Activity, SettingsCard.Server) })
        assertEquals(SettingsCard.entries.toList(), shownCards(isSolo = false))
    }

    @Test fun `Solo keeps the rest, in the same order`() {
        assertEquals(SettingsCard.entries - setOf(SettingsCard.Viewers, SettingsCard.Links, SettingsCard.Activity, SettingsCard.Server), shownCards(isSolo = true))
    }

    @Test fun `Solo has no links for other apps, nor their tab`() {
        assertFalse(SettingsCard.Links in shownCards(isSolo = true))
        assertFalse("links" in shownSettingsTabs(isSolo = true))
        assertTrue("links" in shownSettingsTabs(isSolo = false))
    }

    @Test fun `Solo has no download folder to choose`() {
        assertFalse(SettingsField.DownloadFolder in shownFields(isSolo = true))
        assertTrue(SettingsField.DownloadFolder in shownFields(isSolo = false))
    }

    @Test fun `a download queued or under way keeps the server busy, finished ones do not`() {
        fun job(status: String) = DownloadJob(id = status, status = status)
        assertTrue(anyDownloadActive(listOf(job("done"), job("queued"))))
        assertTrue(anyDownloadActive(listOf(job("downloading"))))
        assertFalse(anyDownloadActive(listOf(job("done"), job("error"), job("canceled"))))
        assertFalse(anyDownloadActive(emptyList()))
    }

    @Test fun `a tab with nothing left to show is left out in Solo`() {
        assertFalse("activity" in shownSettingsTabs(isSolo = true))
        assertTrue("viewers" in shownSettingsTabs(isSolo = true))
        assertTrue("connection" in shownSettingsTabs(isSolo = true))
        assertEquals(SettingsCard.entries.map { it.tab }.distinct(), shownSettingsTabs(isSolo = false))
    }

    @Test fun `in Solo the filters are just yours`() {
        assertEquals("Your filters", filtersTitle("Ann", isSolo = true))
        assertEquals("Your channels", channelsTitle("Ann", isSolo = true))
        assertEquals("Ann's filters", filtersTitle("Ann", isSolo = false))
        assertEquals("Your channels", channelsTitle(null, isSolo = false))
        assertEquals("Filters", settingsTabLabel("viewers", "Viewers", isSolo = true))
        assertEquals("Viewers", settingsTabLabel("viewers", "Viewers", isSolo = false))
        assertEquals("Logos", settingsTabLabel("logos", "Logos", isSolo = true))
    }

    @Test fun `the cast address is the Wi-Fi's private IPv4`() {
        assertEquals("192.168.1.20", lanHostOf(listOf("127.0.0.1", "fe80::1", "169.254.3.3", "192.168.1.20")))
        assertNull(lanHostOf(listOf("127.0.0.1", "100.64.0.5")))   // mobile data (carrier NAT) only
    }

    @Test fun `the private ranges are 10, 172_16-31 and 192_168`() {
        assertEquals("10.0.0.7", lanHostOf(listOf("10.0.0.7")))
        assertEquals("172.31.255.1", lanHostOf(listOf("172.15.0.1", "172.32.0.1", "172.31.255.1")))
        assertNull(lanHostOf(listOf("192.169.0.1", "8.8.8.8", "not an address", "10.0.0", "10.0.0.256")))
        assertNull(lanHostOf(emptyList()))
    }

    @Test fun `without Wi-Fi Solo says casting needs it`() {
        assertEquals("Casting needs Wi-Fi", castMessage(reachable = false, isSolo = true))
        assertNull(castMessage(reachable = true, isSolo = true))
    }

    @Test fun `the remote apps say to set the server up by its network address`() {
        assertEquals(
            "The TV can't reach this server's address — set it up by its network address (not localhost) to cast",
            castMessage(reachable = false, isSolo = false),
        )
        assertNull(castMessage(reachable = true, isSolo = false))
    }

    @Test fun `the server stays up as media while playing or casting, as a sync while downloading`() {
        assertNull(soloForeground(emptySet()))
        assertEquals(SoloForeground.DataSync, soloForeground(setOf(SoloHold.DOWNLOADING)))
        assertEquals(SoloForeground.MediaPlayback, soloForeground(setOf(SoloHold.PLAYING)))
        assertEquals(SoloForeground.MediaPlayback, soloForeground(setOf(SoloHold.CASTING, SoloHold.DOWNLOADING)))
        // A reason the app doesn't know (a newer one, say) still keeps it up.
        assertEquals(SoloForeground.DataSync, soloForeground(setOf("something else")))
    }

    @Test fun `the App updates card names Solo as Solo, on a phone or a TV`() {
        assertEquals("StalkerWeb Solo (phone)", appName(isTv = false, isSolo = true))
        assertEquals("StalkerWeb Solo (TV)", appName(isTv = true, isSolo = true))
        assertEquals("StalkerWeb mobile", appName(isTv = false, isSolo = false))
        assertEquals("StalkerWeb TV", appName(isTv = true, isSolo = false))
    }

    @Test fun `Solo's empty Downloads says the files go to Downloads, not a server`() {
        assertTrue(downloadsEmptyHint(isSolo = true).contains("Downloads/StalkerWeb"))
        assertFalse(downloadsEmptyHint(isSolo = true).contains("server"))
        assertEquals("Download a movie or episode from VOD to save it on the server.", downloadsEmptyHint(isSolo = false))
    }

    @Test fun `only Solo follows its downloads to keep a server up`() {
        assertTrue(followsDownloads(isSolo = true))
        assertFalse(followsDownloads(isSolo = false))
    }

    @Test fun `when the app's process ends, a download or a cast still holds the server, playing doesn't`() {
        assertEquals(setOf(SoloHold.DOWNLOADING, SoloHold.CASTING), holdsLeftByApp(setOf(SoloHold.PLAYING, SoloHold.DOWNLOADING, SoloHold.CASTING)))
        assertEquals(emptySet<String>(), holdsLeftByApp(setOf(SoloHold.PLAYING)))
        assertEquals(setOf(SoloHold.CASTING), holdsLeftByApp(setOf(SoloHold.CASTING)))
    }

    @Test fun `each hold left behind goes once the server says it's over`() {
        val left = setOf(SoloHold.DOWNLOADING, SoloHold.CASTING)
        assertEquals(left, holdsAfterStatus(left, SoloStatus(downloadsActive = true, castActive = true)))
        assertEquals(setOf(SoloHold.CASTING), holdsAfterStatus(left, SoloStatus(downloadsActive = false, castActive = true)))
        assertEquals(setOf(SoloHold.DOWNLOADING), holdsAfterStatus(left, SoloStatus(downloadsActive = true, castActive = false)))
        assertEquals(emptySet<String>(), holdsAfterStatus(left, SoloStatus(downloadsActive = false, castActive = false)))
        // A download the server has going doesn't bring back a hold the app never left.
        assertEquals(setOf(SoloHold.CASTING), holdsAfterStatus(setOf(SoloHold.CASTING), SoloStatus(downloadsActive = true, castActive = true)))
        // One the server can't speak for isn't kept.
        assertEquals(emptySet<String>(), holdsAfterStatus(setOf("something else"), SoloStatus(downloadsActive = true, castActive = true)))
    }

    @Test fun `reads the server's status, and nothing else as one`() {
        assertEquals(SoloStatus(downloadsActive = true, castActive = false), parseSoloStatus("""{"downloadsActive":true,"castActive":false}"""))
        assertEquals(SoloStatus(downloadsActive = false, castActive = true), parseSoloStatus("""{ "castActive" : true, "downloadsActive" : false }"""))
        assertNull(parseSoloStatus("""{"downloadsActive":true}"""))
        assertNull(parseSoloStatus("""{"downloadsActive":"yes","castActive":false}"""))
        assertNull(parseSoloStatus("""{"error":"Unauthorized"}"""))
        assertNull(parseSoloStatus(""))
    }

    @Test fun `a restart doesn't stop a server that's still starting, unless it's stuck`() {
        assertTrue(restartsNode(answered = true, startingForMs = 1_000))
        assertFalse(restartsNode(answered = false, startingForMs = 25_000))
        assertFalse(restartsNode(answered = false, startingForMs = SOLO_STUCK_START_MS - 1))
        assertTrue(restartsNode(answered = false, startingForMs = SOLO_STUCK_START_MS))
    }

    @Test fun `the first start of a server version is waited for longer`() {
        assertEquals(20_000L, startWaitMs(20_000, installed = true))
        assertEquals(60_000L, startWaitMs(20_000, installed = false))
        assertEquals(90_000L, startWaitMs(90_000, installed = false))
    }

    @Test fun `the health proof is the server's HMAC of the nonce, under the key`() {
        // As routes/solo.js computes it (the same vector is in backend/tests/solo.test.js's key).
        val proof = "ba68c1cebc43bea9dfe350e31cc229496dc2dbcf5ee2bac40606c4b5a9046449"
        assertEquals(proof, soloHealthProof("correct horse battery", "abcdefghijklmnop0123"))
        assertTrue(healthProves("""{"status":"ok","proof":"$proof"}""", "correct horse battery", "abcdefghijklmnop0123"))
        assertFalse(healthProves("""{"status":"ok","proof":"$proof"}""", "another key", "abcdefghijklmnop0123"))
        assertFalse(healthProves("""{"status":"ok","proof":"$proof"}""", "correct horse battery", "a different nonce1"))
        assertFalse(healthProves("""{"status":"ok"}""", "correct horse battery", "abcdefghijklmnop0123"))   // not our server
        assertFalse(healthProves("not json", "correct horse battery", "abcdefghijklmnop0123"))
    }

    @Test fun `a refused key restarts the server at most 3 times in 2 minutes`() {
        val now = 1_000_000L
        assertTrue(mayRestartForAccess(emptyList(), now))
        assertTrue(mayRestartForAccess(listOf(now - 10_000, now - 5_000), now))
        assertFalse(mayRestartForAccess(listOf(now - 100_000, now - 10_000, now - 5_000), now))
        // Older ones don't count.
        assertTrue(mayRestartForAccess(listOf(now - 200_000, now - 130_000, now - 10_000, now - 5_000), now))
    }

    @Test fun `cast links take Wi-Fi over Ethernet over the hotspot, whatever came up first`() {
        val wifi = LanNetwork(LanKind.Wifi, listOf("192.168.1.20"))
        val wired = LanNetwork(LanKind.Ethernet, listOf("10.0.0.5"))
        val hotspot = LanNetwork(LanKind.Hotspot, listOf("192.168.43.1"))
        assertEquals("192.168.1.20", lanHostAmong(listOf(wired, wifi, hotspot)))
        assertEquals("192.168.1.20", lanHostAmong(listOf(hotspot, wifi, wired)))
        assertEquals("10.0.0.5", lanHostAmong(listOf(hotspot, wired)))
        assertEquals("192.168.43.1", lanHostAmong(listOf(hotspot)))   // a TV on the phone's own hotspot
        assertEquals("10.0.0.5", lanHostAmong(listOf(LanNetwork(LanKind.Wifi, listOf("fe80::1")), wired)))   // a Wi-Fi with no usable address
        assertNull(lanHostAmong(emptyList()))
    }

    @Test fun `a hotspot or tethering interface is told from the Wi-Fi itself`() {
        for (n in listOf("ap0", "swlan0", "softap0", "wlan1", "rndis0", "bt-pan")) assertTrue(n, isTetherInterface(n))
        for (n in listOf("wlan0", "eth0", "rmnet0", "lo", "tun0", "p2p0")) assertFalse(n, isTetherInterface(n))
    }

    @Test fun `notifications are asked for once, when the server is first held, on Android 13 and up`() {
        val held = setOf(SoloHold.PLAYING)
        assertTrue(asksForNotifications(33, granted = false, askedBefore = false, holds = held))
        assertFalse(asksForNotifications(32, granted = false, askedBefore = false, holds = held))
        assertFalse(asksForNotifications(34, granted = true, askedBefore = false, holds = held))
        assertFalse(asksForNotifications(34, granted = false, askedBefore = true, holds = held))
        assertFalse(asksForNotifications(34, granted = false, askedBefore = false, holds = emptySet()))
    }
}
