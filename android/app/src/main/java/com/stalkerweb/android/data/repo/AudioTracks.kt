package com.stalkerweb.android.data.repo

// The movie & series player's audio tracks (the settings gear) — the web's
// lib/audioTracks.js: their names, and the one in the viewer's preferred language.

/** An audio track in the video: its place among the player's tracks, its language, name and channel count. */
data class AudioTrack(val group: Int, val track: Int, val language: String, val name: String, val channels: Int, val selected: Boolean)

// The preferred-language choices, as ISO 639-1 codes (stored per viewer).
private val AUDIO_LANGUAGES = listOf(
    "en", "es", "fr", "de", "it", "pt", "ru", "ar", "tr", "hi", "zh", "ja", "ko", "nl", "pl", "sv", "el", "he", "fa", "ro", "uk",
    "cs", "da", "fi", "hu", "no", "bg", "hr", "sr", "sk", "th", "vi", "id", "ms", "bn", "ur", "ta", "te", "pa",
)

/** "Stream default" (""), then the languages by name: code to name. */
fun audioLanguageOptions(): List<Pair<String, String>> =
    listOf("" to "Stream default") + AUDIO_LANGUAGES.map { it to languageName(it) }.sortedBy { it.second }

/** The name of a preferred language ("" is the stream's own). */
fun audioLanguageName(code: String): String = if (code.isEmpty()) "Stream default" else languageName(code)

// A language a track can be matched by: "und" (undetermined) and "mul" aren't.
private fun known(code: String?): String =
    baseLanguage(code).takeIf { it.isNotEmpty() && it != "und" && it != "mul" && it != "zxx" }.orEmpty()

/** Whether two language codes are one language: "eng" = "en" = "en-US". */
fun sameLanguage(a: String?, b: String?): Boolean {
    val x = known(a)
    return x.isNotEmpty() && x == known(b)
}

/** A channel count as people say it: 6 → "5.1", 2 → "Stereo". */
fun channelsLabel(channels: Int): String =
    if (channels <= 0) "" else mapOf(1 to "Mono", 2 to "Stereo", 6 to "5.1", 7 to "6.1", 8 to "7.1")[channels] ?: "$channels channels"

/** Each track's name: its language, and where two share one, what tells them apart ("English · 5.1"). */
fun audioTrackLabels(tracks: List<AudioTrack>): List<String> {
    val count = tracks.map { known(it.language) }.filter { it.isNotEmpty() }.groupingBy { it }.eachCount()
    return tracks.mapIndexed { i, t ->
        val l = known(t.language)
        if (l.isEmpty()) return@mapIndexed t.name.ifBlank { "Audio ${i + 1}" }
        val lang = languageName(l)
        if ((count[l] ?: 0) < 2) return@mapIndexed lang
        val name = t.name.takeIf { it.isNotBlank() && !it.equals(lang, ignoreCase = true) }.orEmpty()
        "$lang · ${name.ifEmpty { channelsLabel(t.channels).ifEmpty { "Track ${i + 1}" } }}"
    }
}

/** The first track in [language] (two letters), or null — then the stream's own plays. */
fun preferredAudioTrack(tracks: List<AudioTrack>, language: String): AudioTrack? =
    if (language.isEmpty()) null else tracks.firstOrNull { sameLanguage(it.language, language) }
