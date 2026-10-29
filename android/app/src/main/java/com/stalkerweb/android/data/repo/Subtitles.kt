package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.OnlineSubtitle
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

// The VOD player's subtitles — the web's lib/subtitles.js.

/** A subtitle track inside the video: its place among the player's tracks, and how it's named. */
data class EmbeddedSubtitle(val group: Int, val track: Int, val label: String, val language: String)

/** What's showing: off, one of the video's own ([embedded] group/track), or an online file. */
data class SubtitleChoice(val kind: String = "off", val group: Int = -1, val track: Int = -1, val fileId: String = "", val language: String = "")

const val SUBTITLE_DELAY_STEP = 0.5
const val SUBTITLE_MAX_DELAY = 60.0

// Videos name their tracks' languages in three letters ("eng", "spa"),
// the online sites in two ("en", "es"): the common ones, matched up.
private val TWO_LETTER = mapOf(
    "eng" to "en", "spa" to "es", "fre" to "fr", "fra" to "fr", "ger" to "de", "deu" to "de", "ita" to "it", "por" to "pt",
    "dut" to "nl", "nld" to "nl", "rus" to "ru", "ara" to "ar", "chi" to "zh", "zho" to "zh", "jpn" to "ja", "kor" to "ko",
    "tur" to "tr", "pol" to "pl", "swe" to "sv", "nor" to "no", "dan" to "da", "fin" to "fi", "gre" to "el", "ell" to "el",
    "heb" to "he", "hin" to "hi", "rum" to "ro", "ron" to "ro", "hun" to "hu", "cze" to "cs", "ces" to "cs",
    "per" to "fa", "fas" to "fa", "ukr" to "uk", "bul" to "bg", "hrv" to "hr", "srp" to "sr", "slo" to "sk", "slk" to "sk",
    "slv" to "sl", "tha" to "th", "vie" to "vi", "ind" to "id", "may" to "ms", "msa" to "ms", "ben" to "bn", "urd" to "ur",
    "tam" to "ta", "tel" to "te", "pan" to "pa", "cat" to "ca", "alb" to "sq", "sqi" to "sq", "nob" to "no", "nno" to "no",
)

/** A language code as two letters where it can be: "eng" → "en", "pt-BR" → "pt". */
fun baseLanguage(code: String?): String {
    val c = code.orEmpty().trim().lowercase(Locale.ROOT).split('-', '_').first()
    return TWO_LETTER[c] ?: c
}

/** "en" → "English"; an unknown code as it is. */
fun languageName(code: String?): String {
    val c = code.orEmpty().trim()
    if (c.isEmpty() || c == "und") return "Unknown language"
    val name = Locale.forLanguageTag(c).getDisplayLanguage(Locale.ENGLISH)
    return name.ifBlank { c }
}

/** The online subtitles by language, in the order given. */
fun byLanguage(results: List<OnlineSubtitle>): List<Pair<String, List<OnlineSubtitle>>> =
    results.groupBy { it.language }.toList()

/**
 * The subtitles to start a title with, from what was picked last
 * ("kind|language"): the video's own in that language, else the online ones
 * in it, people-made first. Null: none.
 */
fun startingChoice(saved: String, embedded: List<EmbeddedSubtitle>, online: List<OnlineSubtitle>): SubtitleChoice? {
    val (kind, language) = saved.split('|', limit = 2).let { it[0] to it.getOrElse(1) { "" } }
    if (kind == "off" || kind.isEmpty()) return null
    val lang = baseLanguage(language)
    fun same(l: String) = lang.isNotEmpty() && baseLanguage(l) == lang
    val inVideo = embedded.firstOrNull { same(it.language) } ?: if (kind == "embedded" && lang.isEmpty()) embedded.firstOrNull() else null
    if (inVideo != null) return SubtitleChoice("embedded", inVideo.group, inVideo.track, language = language)
    val fetched = online.firstOrNull { same(it.language) && !it.machine } ?: online.firstOrNull { same(it.language) }
    return fetched?.let { SubtitleChoice("online", fileId = it.fileId, language = language) }
}

/** A delay in half seconds, within a minute either way. */
fun clampDelay(d: Double): Double = ((d / SUBTITLE_DELAY_STEP).roundToInt() * SUBTITLE_DELAY_STEP).coerceIn(-SUBTITLE_MAX_DELAY, SUBTITLE_MAX_DELAY)

/** "1.5", "-0.5", "2" — as the server's offset takes it. */
fun formatDelay(d: Double): String = if (d == d.toLong().toDouble()) d.toLong().toString() else d.toString()

/** "+1.5 s", "−0.5 s", "0 s". */
fun delayLabel(d: Double): String = when {
    d == 0.0 -> "0 s"
    d > 0 -> "+${formatDelay(d)} s"
    else -> "−${formatDelay(abs(d))} s"
}
