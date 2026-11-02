package com.stalkerweb.android.data.api

import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Test

// What a timer or a poll asks for goes with X-Background: 1 (tagged Background,
// the header added in one place — backgroundInterceptor), so it never wakes the
// server's portal session (asleep after the idle timeout, backend
// middleware/session.js). Someone opening a screen sends none.
class BackgroundRequestsTest {
    private val seen = mutableListOf<Pair<String, String?>>()
    private val api = ApiClient.create(
        "http://server.example/",
        OkHttpClient.Builder()
            .addInterceptor(backgroundInterceptor)
            .addInterceptor { chain ->
                val r = chain.request()
                seen += r.url.encodedPath to r.header("X-Background")
                Response.Builder().request(r).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                    .body("{}".toResponseBody("application/json".toMediaType())).build()
            }
            .build(),
    )

    // The answer ("{}") may not fit the type: only the request matters here.
    private fun ask(call: suspend () -> Unit) = runBlocking { runCatching { call() } }

    @Test fun `every polling call can be marked`() {
        val bg = background(true)
        ask { api.getStatus(bg) }
        ask { api.getNowNext(bg) }
        ask { api.getChannelHealth(bg) }
        ask { api.getChannelEpg("1", 6, bg) }
        ask { api.getRecordings(bg) }
        ask { api.getDownloads(bg) }
        ask { api.getActivity(bg) }
        ask { api.getStreamDelivery("live", "1", bg) }
        ask { api.health(bg) }
        assertEquals(9, seen.size)
        seen.forEach { (path, mark) -> assertEquals(path, "1", mark) }
    }

    @Test fun `a request someone makes carries no mark`() {
        ask { api.getNowNext() }
        ask { api.getStatus(background(false)) }
        assertEquals(listOf(null, null), seen.map { it.second })
    }
}
