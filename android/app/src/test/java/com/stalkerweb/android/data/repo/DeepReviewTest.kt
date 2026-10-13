package com.stalkerweb.android.data.repo

import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import com.stalkerweb.android.data.api.EpgEvent
import com.stalkerweb.android.data.api.EpgResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The deep review of the four Android parity parts. */
class DeepReviewTest {
    private val e = EpgEvent(id = 1, title = "News", startTime = 10_800, endTime = 14_400)

    @Test fun anAlarmIsSetOnlyWhileItIsStillAhead() {
        val r = ReminderRules.reminderFor("42", "BBC One", e)
        assertTrue(ReminderRules.needsAlarm(r, nowMs = 10_000_000))
        // Firing now (a minute before): the app starting for it mustn't set it again.
        assertFalse(ReminderRules.needsAlarm(r, nowMs = (10_800L - 60) * 1000))
        assertFalse(ReminderRules.needsAlarm(r, nowMs = (10_800L - 30) * 1000))
    }

    @Test fun remindersBelongToTheirPortal() {
        val a = ReminderRules.reminderFor("42", "BBC One", e, portal = "http://a.tv/c/")
        val b = ReminderRules.reminderFor("42", "BBC One", e.copy(startTime = 20_000, endTime = 21_000), portal = "http://b.tv/c/")
        val old = Reminder("7:1", "7", "Old", "Old one", 30_000)             // saved before reminders had a portal
        assertEquals(listOf(a, old), ReminderRules.forPortal(listOf(a, b, old), "http://a.tv/c/"))
        assertEquals("http://a.tv/c/", a.portal)
    }

    @Test fun xtreamUsesTheViewersName() {
        val keyed = linksFor("http://h:8983", "tok", "view_a", null, viewerName = "Kids").associateBy { it.label }
        assertTrue(keyed.getValue("Xtream Codes Server").hint.contains("Kids"))
        assertTrue(keyed.getValue("Xtream Password").hint.contains("Kids"))
        assertFalse(keyed.getValue("Xtream Password").hint.contains("Any username", ignoreCase = true))
        val plain = linksFor("http://h:8983", null, "view_a", null, viewerName = "Kids").associateBy { it.label }
        assertTrue(plain.getValue("Xtream Codes Server").hint.contains("Kids"))
    }

    @Test fun checklistsHonourOldLanguagesAndIgnoreCase() {
        val shown = shownWith(listOf("AR | NEWS", "EN | NEWS", "Action"), hidden = listOf("action "), languages = listOf("ar"), key = ::titleKey)
        assertEquals(setOf("EN | NEWS"), shown)
    }

    @Test fun showingANameReleasesItsOldLanguage() {
        val f = filtersToSave(
            savedGenres = listOf("EN | KIDS"), savedVod = listOf("action"), savedLanguages = listOf("AR"),
            allGenres = listOf("AR | NEWS", "AR | SPORT", "EN | NEWS"), shownGenres = setOf("AR | NEWS", "EN | NEWS"),
            allVod = listOf("Action", "AR | FILMS"), shownVod = emptySet(),
        )
        assertEquals(emptyList<String>(), f.languages)
        assertEquals(listOf("EN | KIDS", "AR | SPORT"), f.genres)
        assertEquals(listOf("Action", "AR | FILMS"), f.vodCategories)

        // Nothing of it shown: the language stays, and its names aren't added one by one.
        val g = filtersToSave(emptyList(), emptyList(), listOf("AR"), listOf("AR | NEWS", "EN | NEWS"), setOf("EN | NEWS"), emptyList(), emptySet())
        assertEquals(listOf("AR"), g.languages)
        assertEquals(emptyList<String>(), g.genres)
    }

    @Test fun programmesWithNoTimesAreDroppedNotFatal() {
        val moshi = Moshi.Builder().addLast(KotlinJsonAdapterFactory()).build()
        val resp = moshi.adapter(EpgResponse::class.java).fromJson(
            """{"period":24,"channelCount":1,"epg":{"1":[{"id":1,"title":"A","startTime":10,"endTime":null},{"id":null,"title":"B","startTime":20,"endTime":30}]}}""",
        )!!
        assertEquals(listOf("B"), guideEvents(resp.epg).getValue("1").map { it.title })
    }
}
