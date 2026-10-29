package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioTracksTest {
    private fun track(i: Int, lang: String = "", name: String = "", channels: Int = 0) = AudioTrack(0, i, lang, name, channels, selected = false)

    @Test fun `matches two- and three-letter codes and regions by their language`() {
        assertTrue(sameLanguage("eng", "en"))
        assertTrue(sameLanguage("en-US", "en"))
        assertTrue(sameLanguage("ger", "deu"))
        assertTrue(sameLanguage("per", "fa"))
        assertTrue(sameLanguage("ukr", "uk"))
        assertFalse(sameLanguage("spa", "en"))
        assertFalse(sameLanguage("", "en"))
        assertFalse(sameLanguage("und", ""))
    }

    @Test fun `names the usual channel layouts`() {
        assertEquals("5.1", channelsLabel(6))
        assertEquals("Stereo", channelsLabel(2))
        assertEquals("7.1", channelsLabel(8))
        assertEquals("", channelsLabel(0))
    }

    @Test fun `names a track by its language`() {
        assertEquals(listOf("English", "Spanish"), audioTrackLabels(listOf(track(0, "eng"), track(1, "spa"))))
    }

    @Test fun `tells apart two in the same language by name, then channels, then number`() {
        val labels = audioTrackLabels(listOf(
            track(0, "en", name = "Commentary"), track(1, "en", channels = 6), track(2, "en"), track(3, "fr"),
        ))
        assertEquals(listOf("English · Commentary", "English · 5.1", "English · Track 3", "French"), labels)
    }

    @Test fun `falls back to the track name, then its number, without a language`() {
        assertEquals(listOf("Main", "Audio 2"), audioTrackLabels(listOf(track(0, name = "Main"), track(1, "und"))))
    }

    @Test fun `the preferred track is the first in that language, or none`() {
        val tracks = listOf(track(0, "rus"), track(1, "eng"), track(2, "en"))
        assertEquals(1, preferredAudioTrack(tracks, "en")?.track)
        assertNull(preferredAudioTrack(tracks, "fr"))
        assertNull(preferredAudioTrack(tracks, ""))
    }

    @Test fun `the language choices start with the stream default, then two-letter codes by name`() {
        val opts = audioLanguageOptions()
        assertEquals("" to "Stream default", opts.first())
        assertEquals("English", opts.first { it.first == "en" }.second)
        assertTrue(opts.drop(1).all { Regex("^[a-z]{2}$").matches(it.first) })
        assertTrue(opts.drop(1).zipWithNext().all { (a, b) -> a.second <= b.second })
    }
}
