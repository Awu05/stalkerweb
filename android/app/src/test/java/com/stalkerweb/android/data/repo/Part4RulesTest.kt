package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.EpgEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory

class Part4RulesTest {
    private val e = EpgEvent(id = 1, title = "News", startTime = 10_800, endTime = 14_400)   // 03:00–04:00

    @Test fun guideMaths() {
        assertEquals(1_800L, slotStart(3_599))
        assertEquals(Span(60f, 60f), eventSpan(e, 7_200, 90_000))        // starts an hour in
        assertEquals(Span(0f, 30f), eventSpan(e, 12_600, 90_000))         // clipped at the window start
        assertNull(eventSpan(e, 14_400, 90_000))                          // over before the window
        assertEquals(e, eventAt(listOf(e), 12_000))
        assertNull(eventAt(listOf(e), 14_400))
        assertEquals(0.5f, progressOf(e, 12_600), 0.001f)
        assertEquals(1f, progressOf(e, 99_999), 0.001f)
    }

    @Test fun serverEvents() {
        assertEquals("""[{"id":"a"}]""", parseSseData("""data: [{"id":"a"}]"""))
        assertNull(parseSseData(": keepalive"))
        assertNull(parseSseData(""))
    }

    @Test fun bytes() {
        assertEquals("0 B", formatBytes(0))
        assertEquals("512 B", formatBytes(512))
        assertEquals("1.5 KB", formatBytes(1536))
        assertEquals("12.3 MB", formatBytes(12_897_485))
        assertEquals("2.0 GB", formatBytes(2L * 1024 * 1024 * 1024))
    }

    @Test fun linksAsTheWebBuildsThem() {
        val plain = linksFor("http://192.168.1.5:8983", null, "view_a", null).associate { it.label to it.url }
        assertEquals("http://192.168.1.5:8983", plain["Xtream Codes Server"])
        assertEquals("http://192.168.1.5:8983/v/view_a/stremio/manifest.json", plain["Stremio Addon"])
        assertEquals("http://192.168.1.5:8983/api/m3u?viewer=view_a", plain["M3U Playlist"])
        assertEquals("http://192.168.1.5:8983/api/xspf?viewer=view_a", plain["VLC Playlist"])
        assertEquals("http://192.168.1.5:8983/api/xmltv?viewer=view_a", plain["XMLTV EPG Guide"])
        assertNull(plain["Xtream Password"])

        val keyed = linksFor("http://192.168.1.5:8983", "tok", "view_a", 8984).associate { it.label to it.url }
        assertEquals("tok", keyed["Xtream Password"])
        assertEquals("http://192.168.1.5:8983/k/tok/api/m3u?viewer=view_a", keyed["M3U Playlist"])
        assertEquals("https://192.168.1.5:8984/k/tok/v/view_a/stremio/manifest.json", keyed["Stremio Addon"])
    }

    @Test fun filterLists() {
        val all = listOf("NEWS", "SPORTS", "KIDS")
        assertEquals(setOf("NEWS", "KIDS"), shownFrom(all, listOf("SPORTS")))
        assertEquals(listOf("SPORTS"), hiddenFrom(all, setOf("NEWS", "KIDS")))
    }

    @Test fun reminders() {
        val r = ReminderRules.reminderFor("42", "BBC One", e)
        assertEquals("42:10800", r.id)
        assertEquals((10_800L - 60) * 1000, ReminderRules.dueAtMs(r))
        assertTrue(ReminderRules.isUpcoming(r, nowMs = 10_000_000))
        assertTrue(!ReminderRules.isUpcoming(r, nowMs = 10_800_000))      // started: dropped
        assertEquals(listOf(r), ReminderRules.upcoming(listOf(r, r.copy(id = "old", startTime = 1)), nowMs = 1_000_000))
    }

    // Review fixes

    @Test fun savingFiltersKeepsHiddenNamesNotListed() {
        // Hidden on another portal (or while the list was still loading): kept, as the web does.
        assertEquals(listOf("ADULT", "SPORTS"), mergeHidden(saved = listOf("ADULT", "NEWS"), all = listOf("NEWS", "SPORTS"), shown = setOf("NEWS")))
        assertEquals(listOf("ADULT"), mergeHidden(saved = listOf("ADULT"), all = emptyList(), shown = emptySet()))
    }

    @Test fun guideEventsAreCleaned() {
        val a = EpgEvent(id = 1, title = "A", startTime = 100, endTime = 200)
        val dup = a.copy(id = 2, title = "A again")
        val b = EpgEvent(id = 3, title = "B", startTime = 200, endTime = 300)
        val empty = EpgEvent(id = 4, title = "Zero", startTime = 300, endTime = 300)
        assertEquals(listOf(a, b), cleanEvents(listOf(b, empty, a, dup)))
    }

    @Test fun aProgrammeWithNoIdStillParses() {
        val moshi = Moshi.Builder().addLast(KotlinJsonAdapterFactory()).build()
        val e = moshi.adapter(EpgEvent::class.java).fromJson("""{"id":null,"title":"News","startTime":10,"endTime":20,"description":""}""")
        assertEquals("News", e?.title)
    }
}
