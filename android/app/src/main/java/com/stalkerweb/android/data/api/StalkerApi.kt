package com.stalkerweb.android.data.api

import retrofit2.http.*

interface StalkerApi {

    @GET("api/auth/status")
    suspend fun getStatus(): StatusResponse

    @GET("api/channels")
    suspend fun getChannels(): ChannelsResponse

    @GET("api/logos/map")
    suspend fun getLogoMap(): Map<String, String>

    @GET("api/channels/groups/all")
    suspend fun getGroups(): GroupsResponse

    @GET("api/favorites")
    suspend fun getFavorites(): FavoritesResponse

    @POST("api/favorites/channels")
    suspend fun addFavorite(@Body body: AddFavoriteRequest)

    @DELETE("api/favorites/channels/{id}")
    suspend fun removeFavorite(@Path("id") id: String)

    @POST("api/favorites/groups")
    suspend fun createFavoriteGroup(@Body body: NameRequest)

    @PUT("api/favorites/groups/{id}")
    suspend fun renameFavoriteGroup(@Path("id") id: String, @Body body: NameRequest)

    @DELETE("api/favorites/groups/{id}")
    suspend fun deleteFavoriteGroup(@Path("id") id: String)

    @POST("api/favorites/groups/{id}/channels")
    suspend fun addToFavoriteGroup(@Path("id") id: String, @Body body: AddFavoriteRequest)

    @DELETE("api/favorites/groups/{id}/channels/{chId}")
    suspend fun removeFromFavoriteGroup(@Path("id") id: String, @Path("chId") chId: String)

    @PUT("api/favorites/channels/order")
    suspend fun reorderFavorites(@Body body: OrderRequest)

    @PUT("api/favorites/groups/order")
    suspend fun reorderFavoriteGroups(@Body body: OrderRequest)

    @GET("api/channels/health")
    suspend fun getChannelHealth(): Map<String, ChannelHealth>

    @GET("api/logos/check")
    suspend fun checkLogo(@Query("name") name: String): LogoCheck

    @POST("api/logos")
    suspend fun setLogoOverride(@Body body: LogoOverrideRequest)

    @GET("api/epg/now")
    suspend fun getNowNext(): Map<String, NowNextEntry>

    // Resolves a channel to its proxy stream URL + engine hint (hls/mpegts/native).
    @GET("api/stream/{channelId}")
    suspend fun getStream(@Path("channelId") channelId: String): StreamResponse

    // A cast device's link for a channel: HLS, under the playback-only token.
    @GET("api/stream/{channelId}/cast")
    suspend fun getChannelCastLink(@Path("channelId") channelId: String): CastLink

    @DELETE("api/stream/{channelId}/cast")
    suspend fun stopChannelCast(@Path("channelId") channelId: String): retrofit2.Response<Unit>

    @GET("api/settings")
    suspend fun getSettings(): SettingsResponse

    // ── Portal connect / disconnect ───────────────────────────────────────────
    @POST("api/auth/connect")
    suspend fun connectPortal(@Body body: PortalConnectRequest): PortalActionResponse

    @DELETE("api/auth/disconnect")
    suspend fun disconnectPortal(): PortalActionResponse

    @POST("api/auth/reconnect")
    suspend fun reconnectPortal(): PortalActionResponse

    @GET("api/auth/config")
    suspend fun getPortalConfig(): PortalConfigResponse

    // ── Portal profiles ────────────────────────────────────────────────────────
    @GET("api/profiles")
    suspend fun getProfiles(): ProfilesResponse

    @PUT("api/profiles/active")
    suspend fun setActiveProfile(@Body body: SetActiveProfileRequest)

    // ── Viewers ───────────────────────────────────────────────────────────────
    @GET("api/viewers")
    suspend fun getViewers(): ViewersResponse

    @POST("api/viewers")
    suspend fun createViewer(@Body body: CreateViewerRequest): ViewerSummary

    @GET("api/viewers/me")
    suspend fun getMyViewer(): ViewerDetails

    // ── VOD ───────────────────────────────────────────────────────────────────
    @GET("api/vod/categories")
    suspend fun getVodCategories(@Query("type") type: String): VodCategoriesResponse

    @GET("api/vod/items")
    suspend fun getVodItems(
        @Query("type") type: String,
        @Query("category") category: String,
        @Query("page") page: Int = 1,
        @Query("search") search: String = "",
        @Query("sort") sort: String = "name",
    ): VodItemsResponse

    @GET("api/vod/listing")
    suspend fun getVodListing(
        @Query("type") type: String,
        @Query("category") category: String,
        @Query("from") from: Int = 0,
    ): ListingResponse

    @GET("api/vod/seasons/{showId}")
    suspend fun getVodSeasons(@Path("showId") showId: String): VodSeasonsResponse

    @GET("api/vod/episodes/{showId}/{seasonId}")
    suspend fun getVodEpisodes(
        @Path("showId") showId: String,
        @Path("seasonId") seasonId: String,
    ): VodEpisodesResponse

    @GET("api/vod/stream")
    suspend fun getVodStream(
        @Query("videoId") videoId: String,
        @Query("cmd") cmd: String = "",
        @Query("series") series: String = "",
        @Query("seasonId") seasonId: String = "",
        @Query("episodeId") episodeId: String = "",
    ): VodStreamResponse

    // A cast device's link for a movie or episode (as api/vod/stream).
    @GET("api/vod/cast")
    suspend fun getVodCastLink(
        @Query("videoId") videoId: String,
        @Query("cmd") cmd: String = "",
        @Query("series") series: String = "",
        @Query("seasonId") seasonId: String = "",
        @Query("episodeId") episodeId: String = "",
    ): CastLink

    // ── What the viewer watched (per viewer and portal) ────────────────────────
    @GET("api/vod/watch")
    suspend fun getWatch(): WatchState

    @PUT("api/vod/watch")
    suspend fun saveWatch(@Body body: SaveWatchRequest): WatchState

    @DELETE("api/vod/watch/history/{id}")
    suspend fun removeWatchTitle(@Path("id") id: String): WatchState

    @DELETE("api/vod/watch/history")
    suspend fun clearWatchHistory(): WatchState

    @PUT("api/vod/watch/list")
    suspend fun addToWatchList(@Body item: VodItem): WatchState

    @DELETE("api/vod/watch/list/{id}")
    suspend fun removeFromWatchList(@Path("id") id: String): WatchState

    @PUT("api/vod/watch/list/{id}/completed")
    suspend fun setWatchListCompleted(@Path("id") id: String, @Body body: CompletedRequest): WatchState

    @PUT("api/vod/watch/episodes/{key}")
    suspend fun setEpisodeWatched(@Path("key") key: String, @Body body: EpisodeWatchedRequest): WatchState

    // ── The live player ───────────────────────────────────────────────────────
    @GET("api/epg/{channelId}")
    suspend fun getChannelEpg(@Path("channelId") channelId: String, @Query("period") period: Int = 6): ChannelEpgResponse

    /** Keeps the portal session awake while watching (the web pings it every 10 minutes). */
    @GET("api/stream/keepalive")
    suspend fun streamKeepalive()

    // ── Part 4: guide, downloads, settings ────────────────────────────────────
    @GET("api/epg")
    suspend fun getEpg(@Query("period") period: Int = 24): EpgResponse

    @GET("api/downloads")
    suspend fun getDownloads(): DownloadsResponse

    @POST("api/downloads")
    suspend fun enqueueDownloads(@Body body: DownloadRequest)

    @DELETE("api/downloads/{id}")
    suspend fun removeDownload(@Path("id") id: String)

    @POST("api/settings")
    suspend fun saveSettings(@Body body: SettingsUpdate)

    @PUT("api/viewers/{id}")
    suspend fun updateViewer(@Path("id") id: String, @Body body: ViewerUpdate): ViewerSummary

    @DELETE("api/viewers/{id}")
    suspend fun deleteViewer(@Path("id") id: String)

    @PUT("api/viewers/me/filters")
    suspend fun saveMyFilters(@Body body: ViewerFiltersRequest): ViewerDetails

    @GET("api/vod/categories")
    suspend fun getPortalVodCategories(@Query("type") type: String, @Query("all") all: String = "1"): VodCategoriesResponse

    @POST("api/profiles")
    suspend fun createProfile(@Body body: Profile)

    @PUT("api/profiles/{id}")
    suspend fun updateProfile(@Path("id") id: String, @Body body: Profile)

    @DELETE("api/profiles/{id}")
    suspend fun deleteProfile(@Path("id") id: String)

    @GET("api/logos")
    suspend fun getLogos(): LogosInfo

    @POST("api/logos/refresh")
    suspend fun refreshLogos()

    @DELETE("api/logos/{name}")
    suspend fun deleteLogoOverride(@Path("name") name: String)

    @GET("api/logos/strip")
    suspend fun getStripWords(): StripWordsResponse

    @POST("api/logos/strip")
    suspend fun addStripWord(@Body body: WordRequest)

    @DELETE("api/logos/strip/{word}")
    suspend fun deleteStripWord(@Path("word") word: String)

    companion object {
        /** A client for [baseUrl] with a fixed [accessKey] and no viewer — for testing a server in Setup. */
        fun create(baseUrl: String, accessKey: String? = null): StalkerApi =
            ApiClient.create(baseUrl, ApiClient.httpClient({ baseUrl }, { accessKey }, { null }, guard = null, events = null))
    }
}
