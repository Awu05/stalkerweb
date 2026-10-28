package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.Locale

class TimezonesTest {
    private val winter = Instant.parse("2026-01-15T12:00:00Z")
    private val entries = zoneEntries("", winter)
    private fun ids(list: List<ZoneEntry>) = list.map { it.id }

    @Test fun `has the zones by their current names, not the old ones`() {
        val names = TIMEZONE_LIST.map { it.first }
        for (z in listOf("UTC", "Asia/Kolkata", "Europe/Kyiv", "America/Argentina/Buenos_Aires")) assertTrue(z, z in names)
        for (z in listOf("Asia/Calcutta", "US/Eastern", "Europe/Kiev")) assertFalse(z, z in names)
    }

    @Test fun `reads a zone by its offset, in plain digits whatever the language`() {
        val before = Locale.getDefault()
        Locale.setDefault(Locale.forLanguageTag("ar-EG"))
        try {
            assertEquals("UTC+05:30", utcOffset("Asia/Kolkata", winter))
            assertEquals("UTC−05:00", utcOffset("America/New_York", winter))
            assertEquals("UTC", utcOffset("Europe/London", winter))
            assertEquals("", utcOffset("Not/AZone", winter))
        } finally {
            Locale.setDefault(before)
        }
    }

    @Test fun `reads a search that is an offset, the ways people type it`() {
        assertEquals(60, parseOffset("UTC+1"))
        assertEquals(60, parseOffset("+1"))
        assertEquals(-300, parseOffset("-5"))
        assertEquals(330, parseOffset("gmt+5:30"))
        assertEquals(330, parseOffset("+0530"))
        assertEquals(0, parseOffset("gmt"))
        assertNull(parseOffset("london"))
        assertNull(parseOffset("+25"))
    }

    @Test fun `finds a zone by its name or country, city matches first`() {
        assertEquals(listOf("America/New_York"), ids(filterZones(entries, "new york")))
        assertEquals("Asia/Kolkata", ids(filterZones(entries, "india")).first())
        assertEquals("America/Argentina/Buenos_Aires", ids(filterZones(entries, "buenos")).first())
    }

    @Test fun `finds the zones at an offset`() {
        val plusOne = ids(filterZones(entries, "UTC+1"))
        assertTrue("Europe/Paris" in plusOne)
        assertFalse("Australia/Sydney" in plusOne)
        assertEquals(listOf("Asia/Colombo", "Asia/Kolkata"), ids(filterZones(entries, "+5:30")))
    }

    @Test fun `keeps everything for an empty search, a saved zone not in the list, and knows a typo`() {
        assertEquals(entries, filterZones(entries, "  "))
        assertEquals(emptyList<ZoneEntry>(), filterZones(entries, "atlantis"))
        assertEquals("Etc/GMT-3", zoneEntries("Etc/GMT-3", winter).first().id)
        assertTrue(isZone("Etc/GMT-3"))
        assertFalse(isZone("Europe/Londno"))
    }
}
