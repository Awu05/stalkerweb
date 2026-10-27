package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.ListingResponse
import com.stalkerweb.android.data.api.SkipResponse
import com.stalkerweb.android.data.api.SubtitlesResponse
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.api.VodCategory
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodItemsResponse
import com.stalkerweb.android.data.api.VodSeason

/** Movies and series: categories, titles, seasons, episodes and streams. */
class VodRepository(private val apis: ApiProvider, private val links: MediaLinks) {

    suspend fun getVodCategories(type: String): List<VodCategory> =
        runCatching { apis.get().getVodCategories(type).categories }.getOrDefault(emptyList())

    suspend fun getVodItems(type: String, category: String, page: Int, search: String, sort: String = "name"): VodItemsResponse {
        val resp = apis.get().getVodItems(type, category, page, search, sort)
        return resp.copy(items = resp.items.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl)) })
    }

    /** A category's whole listing from [from] on, as read so far (for the filters and an added "All"). */
    suspend fun getListing(type: String, category: String, from: Int): ListingResponse {
        val resp = apis.get().getVodListing(type, category, from)
        return resp.copy(items = resp.items.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl)) })
    }

    /** What can be skipped in a movie or episode; null when the server couldn't say. */
    suspend fun skipParts(p: PlayerParams): SkipResponse? = runCatching {
        val q = TitleQuery(p)
        apis.get().getVodSkip(q.videoId, q.name, q.year, q.season, q.episode, q.movie)
    }.getOrNull()

    /** The online subtitles for a movie or episode; the error in words when they couldn't be had. */
    suspend fun onlineSubtitles(p: PlayerParams): SubtitlesResponse = runCatching {
        val q = TitleQuery(p)
        apis.get().getVodSubtitles(q.videoId, q.name, q.year, q.season, q.episode, q.movie)
    }.getOrElse { SubtitlesResponse(configured = true, error = it.message ?: "Couldn't look them up") }

    /**
     * Whether an online subtitle file can be had (the server keeps it once
     * fetched, so the player's own request is quick): null, or why not.
     */
    suspend fun checkSubtitleFile(fileId: String, delay: Double): String? = try {
        apis.get().getSubtitleFile("$fileId.vtt", if (delay == 0.0) null else formatDelay(delay)).close()
        null
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e   // a newer pick or delay took over: not a failure
    } catch (e: Exception) {
        e.toApiError().message ?: "couldn't be fetched"
    }

    /** The link the player fetches an online subtitle file from (with the playback token, like the stream). */
    fun subtitleFileUrl(fileId: String, delay: Double): String {
        val offset = if (delay == 0.0) "" else "?offset=${formatDelay(delay)}"
        return "${links.base()}/api/vod/subtitles/file/$fileId.vtt$offset"
    }

    suspend fun getVodSeasons(showId: String): List<VodSeason> =
        runCatching {
            apis.get().getVodSeasons(showId).seasons.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl)) }
        }.getOrDefault(emptyList())

    suspend fun getVodEpisodes(showId: String, seasonId: String): List<VodEpisode> =
        runCatching {
            apis.get().getVodEpisodes(showId, seasonId).episodes.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl)) }
        }.getOrDefault(emptyList())

    /** A season's episodes, or null when they couldn't be read (not the same as a season with none). */
    suspend fun getVodEpisodesOrNull(showId: String, seasonId: String): List<VodEpisode>? =
        runCatching {
            apis.get().getVodEpisodes(showId, seasonId).episodes.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl)) }
        }.getOrNull()

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

    /** The link a cast device opens for this movie or episode. */
    suspend fun castLink(videoId: String, cmd: String = "", series: String = "", seasonId: String = "", episodeId: String = "") =
        apis.get().getVodCastLink(videoId, cmd, series, seasonId, episodeId)
}

/**
 * A movie or episode as the server's skip-intro and subtitle lookups both ask
 * for it — the same query, since both go through the same IMDb match.
 */
private class TitleQuery(p: PlayerParams) {
    val videoId = p.videoId
    val name = p.title
    val year = p.year
    val season = p.season
    val episode = if (p.isEpisode) p.series.takeIf { it != "0" }.orEmpty() else ""
    val movie = if (p.isEpisode) "" else "1"
}
