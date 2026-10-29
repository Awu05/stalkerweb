package com.stalkerweb.android.ui.utils

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveKeysTest {
    private val dpad = listOf(
        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT,
        KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER,
    )
    private val everywhere = listOf(LiveFocus.Picture, LiveFocus.Control, LiveFocus.Nothing)

    // ── On the picture ──

    @Test fun `on the picture, up and down change channel, right opens the list and OK brings up the controls`() {
        val key = { code: Int -> livePictureKey(code, LiveFocus.Picture, listOpen = false, canMoveLeft = false) }
        assertEquals(LiveKey.PreviousChannel, key(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals(LiveKey.NextChannel, key(KeyEvent.KEYCODE_DPAD_DOWN))
        assertEquals(LiveKey.OpenList, key(KeyEvent.KEYCODE_DPAD_RIGHT))
        assertEquals(LiveKey.OpenControls, key(KeyEvent.KEYCODE_DPAD_CENTER))
        assertEquals(LiveKey.OpenControls, key(KeyEvent.KEYCODE_ENTER))
        assertEquals(LiveKey.OpenControls, key(KeyEvent.KEYCODE_NUMPAD_ENTER))
        assertEquals(LiveKey.Pass, key(KeyEvent.KEYCODE_DPAD_LEFT))
    }

    @Test fun `the picture's d-pad isn't taken by the keys that work anywhere`() {
        for (code in dpad) assertEquals(LiveKey.Pass, liveAnywhereKey(code, LiveFocus.Picture, listOpen = false))
    }

    // ── On a control ──

    @Test fun `on a button, the d-pad and OK are the button's`() {
        for (code in dpad) {
            assertEquals(LiveKey.Pass, livePictureKey(code, LiveFocus.Control, listOpen = false, canMoveLeft = true))
            assertEquals(LiveKey.Pass, liveAnywhereKey(code, LiveFocus.Control, listOpen = false))
        }
    }

    // ── Nothing focused ──

    @Test fun `with nothing in focus, the d-pad and OK put the remote back on the picture`() {
        for (code in dpad) {
            assertEquals(LiveKey.FocusPicture, liveAnywhereKey(code, LiveFocus.Nothing, listOpen = false))
            assertEquals(LiveKey.FocusPicture, liveAnywhereKey(code, LiveFocus.Nothing, listOpen = true))
        }
    }

    // ── Keys that work wherever the focus is ──

    @Test fun `media, channel, guide and stats keys work wherever the focus is`() {
        for (focus in everywhere) {
            val key = { code: Int -> liveAnywhereKey(code, focus, listOpen = false) }
            assertEquals(LiveKey.PlayPause, key(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
            assertEquals(LiveKey.Play, key(KeyEvent.KEYCODE_MEDIA_PLAY))
            assertEquals(LiveKey.Pause, key(KeyEvent.KEYCODE_MEDIA_PAUSE))
            assertEquals(LiveKey.NextChannel, key(KeyEvent.KEYCODE_CHANNEL_UP))
            assertEquals(LiveKey.PreviousChannel, key(KeyEvent.KEYCODE_CHANNEL_DOWN))
            assertEquals(LiveKey.Guide, key(KeyEvent.KEYCODE_INFO))
            assertEquals(LiveKey.Guide, key(KeyEvent.KEYCODE_GUIDE))
            assertEquals(LiveKey.Guide, key(KeyEvent.KEYCODE_G))
            assertEquals(LiveKey.Stats, key(KeyEvent.KEYCODE_MENU))
            assertEquals(LiveKey.Stats, key(KeyEvent.KEYCODE_S))
        }
    }

    @Test fun `number keys type a channel number wherever the focus is, with the list closed`() {
        for (focus in everywhere) {
            val key = { code: Int -> liveAnywhereKey(code, focus, listOpen = false) }
            assertEquals(LiveKey.Digit('0'), key(KeyEvent.KEYCODE_0))
            assertEquals(LiveKey.Digit('7'), key(KeyEvent.KEYCODE_7))
            assertEquals(LiveKey.Digit('9'), key(KeyEvent.KEYCODE_9))
            assertEquals(LiveKey.Digit('3'), key(KeyEvent.KEYCODE_NUMPAD_3))
        }
    }

    // ── With the channel list open ──

    @Test fun `with the list open, CH+ and CH- are ignored (the list's own up and down walk it)`() {
        for (focus in listOf(LiveFocus.Picture, LiveFocus.Control, LiveFocus.List)) {
            assertEquals(LiveKey.Ignore, liveAnywhereKey(KeyEvent.KEYCODE_CHANNEL_UP, focus, listOpen = true))
            assertEquals(LiveKey.Ignore, liveAnywhereKey(KeyEvent.KEYCODE_CHANNEL_DOWN, focus, listOpen = true))
        }
    }

    @Test fun `with the list open, number and letter keys are left to the list (its search)`() {
        for (code in listOf(KeyEvent.KEYCODE_1, KeyEvent.KEYCODE_NUMPAD_1, KeyEvent.KEYCODE_G, KeyEvent.KEYCODE_S)) {
            assertEquals(LiveKey.Pass, liveAnywhereKey(code, LiveFocus.List, listOpen = true))
        }
    }

    @Test fun `with the list open, the media, guide and stats keys still work`() {
        val key = { code: Int -> liveAnywhereKey(code, LiveFocus.List, listOpen = true) }
        assertEquals(LiveKey.PlayPause, key(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
        assertEquals(LiveKey.Guide, key(KeyEvent.KEYCODE_INFO))
        assertEquals(LiveKey.Stats, key(KeyEvent.KEYCODE_MENU))
        for (code in dpad) assertEquals(LiveKey.Pass, key(code))
    }

    @Test fun `in the list, left moves left as normal, and closes the list only when there's nothing further left`() {
        val left = { focus: LiveFocus, canMoveLeft: Boolean -> livePictureKey(KeyEvent.KEYCODE_DPAD_LEFT, focus, listOpen = true, canMoveLeft = canMoveLeft) }
        assertEquals(LiveKey.Pass, left(LiveFocus.List, true))        // a row's heart, the header's buttons
        assertEquals(LiveKey.CloseList, left(LiveFocus.List, false))  // a row, the search, the genre
        assertEquals(LiveKey.CloseList, left(LiveFocus.Picture, false))
    }

    @Test fun `in the list, up, down, right and OK are the list's`() {
        for (code in dpad - KeyEvent.KEYCODE_DPAD_LEFT) {
            assertEquals(LiveKey.Pass, livePictureKey(code, LiveFocus.List, listOpen = true, canMoveLeft = true))
        }
    }

    @Test fun `OK on the picture with the list open does nothing (it must not hide the controls)`() {
        for (code in listOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER)) {
            assertEquals(LiveKey.Ignore, livePictureKey(code, LiveFocus.Picture, listOpen = true, canMoveLeft = false))
        }
        // Up / Down / Right: left to the focus, as before.
        assertEquals(LiveKey.Pass, livePictureKey(KeyEvent.KEYCODE_DPAD_UP, LiveFocus.Picture, listOpen = true, canMoveLeft = false))
        assertEquals(LiveKey.Pass, livePictureKey(KeyEvent.KEYCODE_DPAD_RIGHT, LiveFocus.Picture, listOpen = true, canMoveLeft = false))
    }

    // ── A used key's repeats and release ──

    private val ok = KeyEvent.KEYCODE_DPAD_CENTER

    @Test fun `a used key's repeats and its release are swallowed`() {
        val used = UsedKeys()
        assertFalse(used.swallow(ok, down = true, repeatCount = 0))   // the first press: the player's to use
        used.use(ok)
        assertTrue(used.swallow(ok, down = true, repeatCount = 1))
        assertTrue(used.swallow(ok, down = true, repeatCount = 2))
        assertTrue(used.swallow(ok, down = false, repeatCount = 0))   // the release
        // Released: the next press is a new one.
        assertFalse(used.swallow(ok, down = true, repeatCount = 0))
        assertFalse(used.swallow(ok, down = false, repeatCount = 0))
    }

    @Test fun `keys the player didn't use go through`() {
        val used = UsedKeys()
        assertFalse(used.swallow(ok, down = true, repeatCount = 1))
        assertFalse(used.swallow(ok, down = false, repeatCount = 0))
        used.use(KeyEvent.KEYCODE_DPAD_UP)
        assertFalse(used.swallow(KeyEvent.KEYCODE_DPAD_DOWN, down = true, repeatCount = 0))
        assertFalse(used.swallow(KeyEvent.KEYCODE_DPAD_DOWN, down = false, repeatCount = 0))
    }

    @Test fun `another key pressed meanwhile doesn't let the used key's release through`() {
        val used = UsedKeys()
        used.use(ok)
        assertFalse(used.swallow(KeyEvent.KEYCODE_DPAD_DOWN, down = true, repeatCount = 0))
        assertTrue(used.swallow(ok, down = false, repeatCount = 0))
    }

    @Test fun `a fresh press of the used key forgets a release that never came`() {
        val used = UsedKeys()
        used.use(ok)
        assertFalse(used.swallow(ok, down = true, repeatCount = 0))
        assertFalse(used.swallow(ok, down = false, repeatCount = 0))
    }
}
