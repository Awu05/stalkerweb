package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.ChannelHealth

/** Channels with at least this many recent (unresolved) stream errors are "flaky" (as on the web). */
const val FLAKY_THRESHOLD = 2

private fun isFlaky(c: Channel, health: Map<String, ChannelHealth>) = (health[c.uniqueId]?.errors ?: 0) >= FLAKY_THRESHOLD

/** The channels shown: the genre ([groupId], null = All), then the name search, then without flaky ones if asked. */
fun filterChannels(channels: List<Channel>, groupId: String?, query: String, hideFlaky: Boolean, health: Map<String, ChannelHealth>): List<Channel> {
    val q = query.trim().lowercase()
    return channels.filter { c ->
        (groupId == null || c.genreId == groupId) &&
            (q.isEmpty() || c.name.lowercase().contains(q)) &&
            (!hideFlaky || !isFlaky(c, health))
    }
}

fun flakyCount(channels: List<Channel>, health: Map<String, ChannelHealth>): Int = channels.count { isFlaky(it, health) }

/** The channel whose number was typed on the remote, or null. */
fun jumpTarget(channels: List<Channel>, digits: String): Channel? {
    val n = digits.toIntOrNull() ?: return null
    return channels.firstOrNull { it.number == n }
}

/** [list] with the item at [index] moved by [delta] places; unchanged at either end or for a stale index. */
fun <T> moveItem(list: List<T>, index: Int, delta: Int): List<T> {
    val to = index + delta
    if (index !in list.indices || to !in list.indices) return list
    return list.toMutableList().apply { add(to, removeAt(index)) }
}
