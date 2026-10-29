package com.stalkerweb.android.data.repo

import android.view.KeyEvent
import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.ChannelHealth
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LiveRulesTest {
    private fun ch(id: String, number: Int, name: String, genreId: String) = Channel(uniqueId = id, number = number, name = name, genreId = genreId)
    private val channels = listOf(
        ch("a", 1, "BBC One", "news"), ch("b", 2, "CNN", "news"), ch("c", 10, "ESPN", "sports"), ch("d", 101, "Sky Sports", "sports"),
    )
    private val health = mapOf("b" to ChannelHealth(errors = 3), "c" to ChannelHealth(errors = 1))
    private fun ids(list: List<Channel>) = list.map { it.uniqueId }

    @Test fun filtersByGenreSearchAndFlakyTogether() {
        assertEquals(listOf("a", "b", "c", "d"), ids(filterChannels(channels, null, "", false, health)))
        assertEquals(listOf("c", "d"), ids(filterChannels(channels, "sports", "", false, health)))
        assertEquals(listOf("d"), ids(filterChannels(channels, "sports", "  sky ", false, health)))
        assertEquals(listOf("a", "c", "d"), ids(filterChannels(channels, null, "", true, health)))
        assertEquals(listOf("a"), ids(filterChannels(channels, "news", "", true, health)))
    }

    @Test fun searchIsByNameIgnoringCase() {
        assertEquals(listOf("d"), ids(filterChannels(channels, null, "SKY", false, health)))
        assertEquals(listOf("c", "d"), ids(filterChannels(channels, null, "s", false, health)))
    }

    @Test fun countsFlakyChannels() {
        assertEquals(1, flakyCount(channels, health))
        assertEquals(0, flakyCount(channels, emptyMap()))
    }

    @Test fun jumpsToTheChannelNumber() {
        assertEquals("c", jumpTarget(channels, "10")?.uniqueId)
        assertEquals("c", jumpTarget(channels, "010")?.uniqueId)
        assertNull(jumpTarget(channels, "99"))
        assertNull(jumpTarget(channels, ""))
    }

    @Test fun zeroIsNoChannelNumber() {
        // Channels without a number have 0: typing 0 must not open the first of them.
        val unnumbered = channels + Channel(uniqueId = "z", number = 0, name = "No number", genreId = "news")
        assertNull(jumpTarget(unnumbered, "0"))
        assertNull(jumpTarget(unnumbered, "00"))
    }

    @Test fun movesAnItemWithinBounds() {
        val l = listOf("a", "b", "c")
        assertEquals(listOf("b", "a", "c"), moveItem(l, 1, -1))
        assertEquals(listOf("a", "c", "b"), moveItem(l, 1, 1))
        assertEquals(l, moveItem(l, 0, -1))
        assertEquals(l, moveItem(l, 2, 1))
        assertEquals(l, moveItem(l, 7, 1))
    }

    @Test fun `on the picture, up and down change channel and OK brings up the controls`() {
        val key = { code: Int -> liveKey(code, onPicture = true, listOpen = false) }
        assertEquals(LiveKey.PreviousChannel, key(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals(LiveKey.NextChannel, key(KeyEvent.KEYCODE_DPAD_DOWN))
        assertEquals(LiveKey.OpenControls, key(KeyEvent.KEYCODE_DPAD_CENTER))
        assertEquals(LiveKey.OpenControls, key(KeyEvent.KEYCODE_ENTER))
        assertEquals(LiveKey.OpenList, key(KeyEvent.KEYCODE_DPAD_RIGHT))
        assertEquals(LiveKey.Pass, key(KeyEvent.KEYCODE_DPAD_LEFT))
    }

    @Test fun `on a button, the d-pad and OK are the button's — only media and channel keys still act`() {
        val key = { code: Int -> liveKey(code, onPicture = false, listOpen = false) }
        for (code in listOf(KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT,
                KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER)) {
            assertEquals(LiveKey.Pass, key(code))
        }
        assertEquals(LiveKey.PlayPause, key(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
        assertEquals(LiveKey.NextChannel, key(KeyEvent.KEYCODE_CHANNEL_UP))
        assertEquals(LiveKey.PreviousChannel, key(KeyEvent.KEYCODE_CHANNEL_DOWN))
    }

    @Test fun `with the channel list open the d-pad walks the list, and left closes it`() {
        val key = { code: Int -> liveKey(code, onPicture = false, listOpen = true) }   // the list has the focus
        assertEquals(LiveKey.Pass, key(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals(LiveKey.Pass, key(KeyEvent.KEYCODE_DPAD_DOWN))
        assertEquals(LiveKey.Pass, key(KeyEvent.KEYCODE_DPAD_RIGHT))
        assertEquals(LiveKey.CloseList, key(KeyEvent.KEYCODE_DPAD_LEFT))
    }
}
