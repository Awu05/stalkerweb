package com.stalkerweb.android.data.repo

import java.net.URLDecoder
import java.net.URLEncoder

/**
 * What the VOD player plays, in the web player's link format — history and
 * My List entries carry it, so a title started on the TV resumes on the web
 * and the other way round. Written exactly as the web's buildPlayerParams
 * (frontend/src/pages/VodPage.jsx): form-encoded, with the poster,
 * description, director and actors encodeURIComponent'ed inside that.
 * [screenshotUrl] is relative to the server ("/api/logos/render?url=…").
 */
data class PlayerParams(
    val videoId: String,
    val title: String = "",
    val cmd: String = "",
    val series: String = "0",
    val seasonId: String = "",
    val episodeId: String = "",
    /** The season's number, for labels ("S2 · E5"); links saved before it was kept have none. */
    val season: String = "",
    val episodeTitle: String = "",
    val year: String = "",
    val durationMin: Int = 0,
    val isHD: Boolean = false,
    val screenshotUrl: String = "",
    val description: String = "",
    val director: String = "",
    val actors: String = "",
) {
    val isEpisode: Boolean get() = seasonId.isNotEmpty() || episodeId.isNotEmpty()
    val key: String get() = WatchRules.makeKey(videoId, seasonId, episodeId)

    fun toQuery(): String = buildList {
        add("videoId" to videoId); add("title" to title); add("cmd" to cmd); add("series" to series)
        if (seasonId.isNotEmpty()) add("seasonId" to seasonId)
        if (episodeId.isNotEmpty()) add("episodeId" to episodeId)
        if (season.isNotEmpty()) add("season" to season)
        if (episodeTitle.isNotEmpty()) add("episodeTitle" to episodeTitle)
        if (year.isNotEmpty()) add("year" to year)
        if (durationMin > 0) add("durationMin" to durationMin.toString())
        if (isHD) add("isHD" to "true")
        if (screenshotUrl.isNotEmpty()) add("screenshotUrl" to encodeURIComponent(screenshotUrl))
        if (description.isNotEmpty()) add("description" to encodeURIComponent(description))
        if (director.isNotEmpty()) add("director" to encodeURIComponent(director))
        if (actors.isNotEmpty()) add("actors" to encodeURIComponent(actors))
    }.joinToString("&") { (k, v) -> "$k=${formEncode(v)}" }

    companion object {
        fun parse(query: String): PlayerParams {
            val q = query.removePrefix("?").split("&").filter { it.isNotEmpty() }.associate { part ->
                val i = part.indexOf('=')
                if (i < 0) formDecode(part) to "" else formDecode(part.substring(0, i)) to formDecode(part.substring(i + 1))
            }
            fun s(k: String) = q[k].orEmpty()
            fun inner(k: String) = decodeURIComponent(s(k))
            return PlayerParams(
                videoId = s("videoId"), title = s("title"), cmd = s("cmd"), series = q["series"] ?: "0",
                seasonId = s("seasonId"), episodeId = s("episodeId"), season = s("season"), episodeTitle = s("episodeTitle"),
                year = s("year"), durationMin = s("durationMin").toIntOrNull() ?: 0, isHD = s("isHD") == "true",
                screenshotUrl = inner("screenshotUrl"), description = inner("description"),
                director = inner("director"), actors = inner("actors"),
            )
        }

        // URLSearchParams' form encoding — the same as URLEncoder (space → "+").
        private fun formEncode(s: String): String = URLEncoder.encode(s, "UTF-8")
        private fun formDecode(s: String): String = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)

        // JavaScript's encodeURIComponent: like URLEncoder, but "%20" for space and !'()~ left as they are.
        fun encodeURIComponent(s: String): String = URLEncoder.encode(s, "UTF-8")
            .replace("+", "%20").replace("%21", "!").replace("%27", "'")
            .replace("%28", "(").replace("%29", ")").replace("%7E", "~")

        // decodeURIComponent: "+" is a plus, not a space. An undecodable value stays as it is.
        fun decodeURIComponent(s: String): String =
            runCatching { URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") }.getOrDefault(s)
    }
}
