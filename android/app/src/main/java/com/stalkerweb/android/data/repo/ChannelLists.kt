package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Channel

// Right after the server reconnects to the portal its channel list can come
// back empty with loading: true. The cached list stays — shown, and on disk —
// until the real one arrives, and the app asks again once loading ends.

/** The channels, and whether to ask again once the server has loaded them. */
data class ChannelList(val channels: List<Channel>, val refetch: Boolean)

/** [fresh], unless it is an empty list that came while loading and [cached] has some. */
fun <T> keptList(cached: List<T>, fresh: List<T>, loading: Boolean): List<T> =
    if (loading && fresh.isEmpty() && cached.isNotEmpty()) cached else fresh

/** Whether the list is worth asking for again once the server's load ends. */
fun <T> refetchesWhenLoaded(fresh: List<T>, loading: Boolean): Boolean = loading && fresh.isEmpty()
