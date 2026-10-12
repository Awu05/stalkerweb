package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.VodCategory
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodItemsResponse
import com.stalkerweb.android.data.api.VodSeason

/** Movies and series: categories, titles, seasons, episodes and streams. */
class VodRepository(private val apis: ApiProvider, private val links: MediaLinks) {

    suspend fun getVodCategories(type: String): List<VodCategory> =
        runCatching { apis.get().getVodCategories(type).categories }.getOrDefault(emptyList())

    suspend fun getVodItems(type: String, category: String, page: Int, search: String): VodItemsResponse {
        val resp = apis.get().getVodItems(type, category, page, search)
        return resp.copy(items = resp.items.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl)) })
    }

    suspend fun getVodSeasons(showId: String): List<VodSeason> =
        runCatching {
            apis.get().getVodSeasons(showId).seasons.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl)) }
        }.getOrDefault(emptyList())

    suspend fun getVodEpisodes(showId: String, seasonId: String): List<VodEpisode> =
        runCatching {
            apis.get().getVodEpisodes(showId, seasonId).episodes.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl)) }
        }.getOrDefault(emptyList())

    /** Resolves a VOD stream and returns the absolute, playable proxy URL. */
    suspend fun resolveVodStreamUrl(
        videoId: String,
        cmd: String = "",
        series: String = "",
        seasonId: String = "",
        episodeId: String = "",
    ): String {
        links.ensureShareToken()
        val resp = apis.get().getVodStream(videoId, cmd, series, seasonId, episodeId)
        val base = links.base()
        return if (resp.streamUrl.startsWith("http", ignoreCase = true)) resp.streamUrl
               else "$base${resp.streamUrl}"
    }
}
