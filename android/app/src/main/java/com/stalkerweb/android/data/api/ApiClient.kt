package com.stalkerweb.android.data.api

import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.util.concurrent.TimeUnit

/** The headers every request carries: the access key and the chosen viewer, when set. */
fun requestHeaders(accessKey: String?, viewerId: String?): Map<String, String> = buildMap {
    if (!accessKey.isNullOrBlank()) put("Authorization", "Bearer $accessKey")
    if (!viewerId.isNullOrBlank()) put("X-Viewer", viewerId)
}

object ApiClient {
    /**
     * [accessKey] and [viewerId] are read on every request, so a viewer switch
     * applies to the next one without rebuilding the client. [events], when
     * given, hears about access-key and deleted-viewer answers (AppEvent).
     */
    fun create(baseUrl: String, accessKey: () -> String?, viewerId: () -> String?, events: AppEvents?): StalkerApi {
        val moshi = Moshi.Builder().addLast(KotlinJsonAdapterFactory()).build()
        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val builder = chain.request().newBuilder()
                requestHeaders(accessKey(), viewerId()).forEach { (k, v) -> builder.header(k, v) }
                val response = chain.proceed(builder.build())
                if (events != null && response.code in setOf(401, 409, 429)) {
                    appEventFor(response.code, response.peekBody(64 * 1024).string())?.let(events::emit)
                }
                response
            }
            .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
        return Retrofit.Builder()
            .baseUrl(if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/")
            .client(client)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()
            .create(StalkerApi::class.java)
    }
}
