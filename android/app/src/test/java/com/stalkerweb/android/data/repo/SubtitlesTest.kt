package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.OnlineSubtitle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SubtitlesTest {
    private val online = listOf(
        OnlineSubtitle("1", "en", downloads = 900),
        OnlineSubtitle("2", "en", downloads = 10),
        OnlineSubtitle("3", "es", downloads = 50, machine = true),
        OnlineSubtitle("4", "es", downloads = 5),
    )
    private val embedded = listOf(EmbeddedSubtitle(0, 0, "", "fre"), EmbeddedSubtitle(1, 0, "English", "eng"), EmbeddedSubtitle(2, 0, "", "spa"))

    @Test fun `matches three-letter and regional codes to two letters`() {
        assertEquals("en", baseLanguage("eng"))
        assertEquals("es", baseLanguage("spa"))
        assertEquals("pt", baseLanguage("pt-BR"))
        assertEquals("xx", baseLanguage("xx"))
    }

    @Test fun `names a language from its code`() {
        assertEquals("English", languageName("en"))
        assertEquals("Unknown language", languageName(""))
    }

    @Test fun `prefers the video's own subtitles in the language picked last`() {
        assertEquals(SubtitleChoice("embedded", 1, 0, language = "en"), startingChoice("online|en", embedded, online))
        assertEquals(SubtitleChoice("embedded", 2, 0, language = "es"), startingChoice("online|es", embedded, online))
    }

    @Test fun `falls back to OpenSubtitles' in that language, people-made first`() {
        assertEquals(SubtitleChoice("online", fileId = "4", language = "es"), startingChoice("online|es", emptyList(), online))
    }

    @Test fun `starts with none when they were off, or none is in that language`() {
        assertNull(startingChoice("off|", embedded, online))
        assertNull(startingChoice("online|de", embedded, online))
    }

    @Test fun `groups the online subtitles by language`() {
        assertEquals(listOf("en", "es"), byLanguage(online).map { it.first })
    }

    @Test fun `the delay moves in half seconds, within a minute either way`() {
        assertEquals(1.5, clampDelay(1.3), 0.0)
        assertEquals(-60.0, clampDelay(-200.0), 0.0)
        assertEquals("+1.5 s", delayLabel(1.5))
        assertEquals("−0.5 s", delayLabel(-0.5))
        assertEquals("0 s", delayLabel(0.0))
        assertEquals("2", formatDelay(2.0))
    }
}
