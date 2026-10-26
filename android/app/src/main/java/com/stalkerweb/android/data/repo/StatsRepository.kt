package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.StreamDelivery

/** What the player's Stats panel asks the server: how a stream is sent here, and the round trip. */
class StatsRepository(private val apis: ApiProvider) {
    /** kind live | vod; id the channel, or the movie's key ("100", "200:s1:e3"). */
    suspend fun delivery(kind: String, id: String): StreamDelivery? = apis.get().getStreamDelivery(kind, id).delivery

    /** Milliseconds for the server to answer a tiny request. */
    suspend fun pingMs(): Long {
        val t0 = System.nanoTime()
        apis.get().health()
        return (System.nanoTime() - t0) / 1_000_000
    }
}
