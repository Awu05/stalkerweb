package com.stalkerweb.android.data.repo

import android.view.KeyEvent
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.ChannelHealth

/** What a remote key does in the live player (ui/player/PlayerScreen). */
enum class LiveKey { PlayPause, Play, Pause, PreviousChannel, NextChannel, OpenControls, OpenList, CloseList, Guide, Stats, Pass }

/**
 * A remote key in the live player. On the picture, Up/Down change channel (as
 * on any set-top box) and OK brings the controls up with a button in focus;
 * on one of those buttons the D-pad and OK are the button's — moving between
 * them, pressing them. The media and channel keys work wherever the focus is.
 * [Pass]: left to whatever has the focus.
 */
fun liveKey(keyCode: Int, onPicture: Boolean, listOpen: Boolean): LiveKey = when (keyCode) {
    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> LiveKey.PlayPause
    KeyEvent.KEYCODE_MEDIA_PLAY -> LiveKey.Play
    KeyEvent.KEYCODE_MEDIA_PAUSE -> LiveKey.Pause
    // CH+ is the next channel, as on any remote.
    KeyEvent.KEYCODE_CHANNEL_UP -> LiveKey.NextChannel
    KeyEvent.KEYCODE_CHANNEL_DOWN -> LiveKey.PreviousChannel
    KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_GUIDE, KeyEvent.KEYCODE_G -> LiveKey.Guide
    // The remote's ≡: the Stats panel.
    KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_S -> LiveKey.Stats
    else -> when {
        // The list has the focus: the D-pad walks it, Left closes it.
        listOpen -> if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT) LiveKey.CloseList else LiveKey.Pass
        !onPicture -> LiveKey.Pass
        else -> when (keyCode) {
            // Up/Down walk the channels as the list reads them.
            KeyEvent.KEYCODE_DPAD_UP -> LiveKey.PreviousChannel
            KeyEvent.KEYCODE_DPAD_DOWN -> LiveKey.NextChannel
            KeyEvent.KEYCODE_DPAD_RIGHT -> LiveKey.OpenList
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> LiveKey.OpenControls
            else -> LiveKey.Pass
        }
    }
}

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
    // 0 is "no number": typing it must not open the first channel without one.
    val n = digits.toIntOrNull()?.takeIf { it > 0 } ?: return null
    return channels.firstOrNull { it.number == n }
}

/** [list] with the item at [index] moved by [delta] places; unchanged at either end or for a stale index. */
fun <T> moveItem(list: List<T>, index: Int, delta: Int): List<T> {
    val to = index + delta
    if (index !in list.indices || to !in list.indices) return list
    return list.toMutableList().apply { add(to, removeAt(index)) }
}
