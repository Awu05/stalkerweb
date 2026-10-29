package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SoloRulesTest {
    @Test fun `Solo shows no viewers, activity or server settings`() {
        assertFalse(shownCards(isSolo = true).any { it in setOf(SettingsCard.Viewers, SettingsCard.Activity, SettingsCard.Server) })
        assertEquals(SettingsCard.entries.toList(), shownCards(isSolo = false))
    }

    @Test fun `Solo keeps the rest, in the same order`() {
        assertEquals(SettingsCard.entries - setOf(SettingsCard.Viewers, SettingsCard.Activity, SettingsCard.Server), shownCards(isSolo = true))
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
        assertNotNull(castMessage(reachable = false, isSolo = false))
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
}
