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

    @GET("api/epg/now")
    suspend fun getNowNext(): Map<String, NowNextEntry>

    // Resolves a channel to its proxy stream URL + engine hint (hls/mpegts/native).
    @GET("api/stream/{channelId}")
    suspend fun getStream(@Path("channelId") channelId: String): StreamResponse

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
    ): VodItemsResponse

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

    companion object {
        /** A client for [baseUrl] with a fixed [accessKey] and no viewer — for testing a server in Setup. */
        fun create(baseUrl: String, accessKey: String? = null): StalkerApi =
            ApiClient.create(baseUrl, ApiClient.httpClient({ baseUrl }, { accessKey }, { null }, guard = null, events = null))
    }
}
