package com.stalkerweb.android.data.api

import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.net.ConnectException
import java.util.concurrent.TimeUnit

/** The headers every request carries: the access key and the chosen viewer, when set. */
fun requestHeaders(accessKey: String?, viewerId: String?): Map<String, String> = buildMap {
    if (!accessKey.isNullOrBlank()) put("Authorization", "Bearer $accessKey")
    if (!viewerId.isNullOrBlank()) put("X-Viewer", viewerId)
}

object ApiClient {
    private val CHECKED_CODES = setOf(401, 403, 409, 429)

    /**
     * The one HTTP client for the server: the API and images (Coil) alike. To
     * the server itself ([serverUrl]) it adds the access key and the viewer —
     * read on every request, so a viewer switch applies to the next one — and
     * passes answers through [guard], which reports access and deleted-viewer
     * problems on [events]. Other hosts (channel logos on the internet) get
     * none of that. [onConnectFailed] hears of each request the server itself
     * refused to connect (nothing listening on its port): Solo's server may
     * have moved to another one (SoloServer.onConnectionFailed).
     */
    fun httpClient(
        serverUrl: () -> String?,
        accessKey: () -> String?,
        viewerId: () -> String?,
        guard: AccessGuard?,
        events: AppEvents?,
        onConnectFailed: (() -> Unit)? = null,
    ): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(Interceptor { chain ->
            val request = chain.request()
            if (!sameServer(request.url, serverUrl())) return@Interceptor chain.proceed(request)
            if (guard?.blocked == true) return@Interceptor refusedResponse(request, guard.message)
            val builder = request.newBuilder()
            requestHeaders(accessKey(), viewerId()).forEach { (k, v) -> builder.header(k, v) }
            builder.header("User-Agent", APP_USER_AGENT)   // as the player's streams (Settings → Activity)
            val send = {
                val response: Response = try {
                    chain.proceed(builder.build())
                } catch (e: ConnectException) {
                    onConnectFailed?.invoke()
                    throw e
                }
                if (guard != null) {
                    val body = if (response.code in CHECKED_CODES) response.peekBody(64 * 1024).string() else null
                    guard.onResponse(response.code, body)?.let { events?.emit(it) }
                }
                response
            }
            // Until the key is known to be good, one request at a time: a burst
            // with a changed key would otherwise spend the whole lockout allowance.
            if (guard != null && !guard.verified) {
                synchronized(guard.lock) {
                    if (guard.blocked) refusedResponse(request, guard.message) else send()
                }
            } else {
                send()
            }
        })
        .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    fun create(baseUrl: String, client: OkHttpClient): StalkerApi {
        val moshi = Moshi.Builder().addLast(KotlinJsonAdapterFactory()).build()
        return Retrofit.Builder()
            .baseUrl(if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/")
            .client(client)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()
            .create(StalkerApi::class.java)
    }
}
