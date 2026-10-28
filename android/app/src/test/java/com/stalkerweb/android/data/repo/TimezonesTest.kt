package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class TimezonesTest {
    private val zones = listOf("America/New_York", "America/Argentina/Buenos_Aires", "Europe/London", "Europe/Lisbon", "Asia/Kolkata", "UTC")
    private val offsets = mapOf(
        "America/New_York" to "UTC−05:00", "America/Argentina/Buenos_Aires" to "UTC−03:00", "Europe/London" to "UTC",
        "Europe/Lisbon" to "UTC", "Asia/Kolkata" to "UTC+05:30", "UTC" to "UTC",
    )
    private val offsetOf: (String) -> String = { offsets[it].orEmpty() }

    @Test fun `lists the region and city zones, with UTC and the saved one`() {
        val all = allTimezones("Mars/Olympus_Mons")
        assertTrue("Europe/London" in all)
        assertTrue("UTC" in all)
        assertTrue("Mars/Olympus_Mons" in all)
        assertTrue(all.none { it.startsWith("SystemV/") || it.startsWith("Etc/") })
        assertEquals(all.sorted(), all)
    }

    @Test fun `names a zone by its offset at a moment`() {
        val winter = Instant.parse("2026-01-15T12:00:00Z")
        assertEquals("UTC", utcOffset("Europe/London", winter))
        assertEquals("UTC+05:30", utcOffset("Asia/Kolkata", winter))
        assertEquals("UTC−05:00", utcOffset("America/New_York", winter))
        assertEquals("", utcOffset("Not/AZone", winter))
    }

    @Test fun `matches by any part of the name, city matches first`() {
        assertEquals(listOf("America/New_York"), filterTimezones(zones, "new york", offsetOf))
        assertEquals(listOf("America/Argentina/Buenos_Aires"), filterTimezones(zones, "buenos", offsetOf))
        assertEquals(listOf("Europe/Lisbon", "Europe/London"), filterTimezones(zones, "europe", offsetOf))
    }

    @Test fun `matches by UTC offset`() {
        assertEquals(listOf("Asia/Kolkata"), filterTimezones(zones, "+05:30", offsetOf))
        assertEquals(listOf("America/New_York"), filterTimezones(zones, "utc-05", offsetOf))
    }

    @Test fun `keeps everything for an empty search, nothing for no match`() {
        assertEquals(zones, filterTimezones(zones, "  ", offsetOf))
        assertEquals(emptyList<String>(), filterTimezones(zones, "atlantis", offsetOf))
    }
}
