package com.stalkerweb.android.data.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateRulesTest {
    private val assets = listOf(
        "stalkerweb-mobile-v0.4.36.apk" to "https://x/mobile.apk",
        "stalkerweb-tv-v0.4.36.apk" to "https://x/tv.apk",
    )

    @Test fun `the TV build takes the TV apk, the phone build the mobile one`() {
        assertEquals("https://x/tv.apk", apkFor(assets, isTv = true))
        assertEquals("https://x/mobile.apk", apkFor(assets, isTv = false))
        assertEquals("https://x/tv.apk", apkFor(assets.reversed(), isTv = true))
    }

    @Test fun `no apk for this build means none, not the other one`() {
        assertNull(apkFor(listOf(assets[0]), isTv = true))
        assertNull(apkFor(listOf(assets[1]), isTv = false))
        assertNull(apkFor(listOf("app-release.apk" to "u"), isTv = false))
        assertNull(apkFor(listOf("stalkerweb-tv-v0.4.36.apk.sha256" to "u"), isTv = true))
        assertNull(apkFor(emptyList(), isTv = false))
    }

    private val bothApps = listOf(
        "stalkerweb-solo_tv-v0.5.0.apk" to "st", "stalkerweb-solo_mobile-v0.5.0.apk" to "sm",
        "stalkerweb-tv-v0.5.0.apk" to "t", "stalkerweb-mobile-v0.5.0.apk" to "m",
    )

    @Test fun `each app picks only its own APK, whichever order they're listed in`() {
        for (list in listOf(bothApps, bothApps.reversed())) {
            assertEquals("t", apkFor(list, isTv = true)); assertEquals("m", apkFor(list, isTv = false))
            assertEquals("st", apkFor(list, isTv = true, isSolo = true)); assertEquals("sm", apkFor(list, isTv = false, isSolo = true))
        }
    }

    @Test fun `an older release without Solo APKs has none for Solo`() {
        assertNull(apkFor(bothApps.drop(2), isTv = true, isSolo = true))
    }

    @Test fun `a later version is newer, the same or an older one is not`() {
        assertTrue(isNewerVersion("0.4.36", "0.4.35"))
        assertTrue(isNewerVersion("v0.5.0", "0.4.99"))
        assertTrue(isNewerVersion("0.4.10", "0.4.9"))
        assertTrue(isNewerVersion("1.0", "0.9.9"))
        assertFalse(isNewerVersion("0.4.35", "0.4.35"))
        assertFalse(isNewerVersion("0.4.35", "v0.4.35"))
        assertFalse(isNewerVersion("0.3.97", "0.4.35"))
    }

    @Test fun `a pre-release sits between its release and the one before`() {
        assertFalse(isNewerVersion("0.4.35", "0.4.36-rc.1"))   // no downgrade offered
        assertTrue(isNewerVersion("0.4.36", "0.4.36-rc.1"))
        assertTrue(isNewerVersion("0.4.36-rc.1", "0.4.35"))
        assertTrue(isNewerVersion("0.4.36-rc.2", "0.4.36-rc.1"))
        assertTrue(isNewerVersion("0.4.36-rc.10", "0.4.36-rc.9"))
        assertTrue(isNewerVersion("0.4.36-rc.1", "0.4.36-beta.3"))
        assertFalse(isNewerVersion("0.4.36-rc.1", "0.4.36"))
        assertFalse(isNewerVersion("v0.4.36-rc.1", "0.4.36-rc.1"))
    }

    @Test fun `each check result reads as a line`() {
        assertEquals("Up to date (version 0.4.35).", checkMessage(UpdateCheck.UpToDate("0.4.35"), "0.4.35"))
        assertEquals("Version 0.4.36 is available.", checkMessage(UpdateCheck.Found(ReleaseInfo("v0.4.36", "0.4.36", "u")), "0.4.35"))
        assertEquals("Couldn't check for updates. Try again later.", checkMessage(UpdateCheck.Failed, "0.4.35"))
    }
}
