package com.stalkerweb.android.ui.utils

import android.view.KeyEvent

/** Where the remote's focus is in the live player (ui/player/PlayerScreen). */
enum class LiveFocus {
    /** The picture itself. */
    Picture,
    /** One of the buttons over the picture (the controls, Retry). */
    Control,
    /** Something in the channel list. */
    List,
    /** Nothing at all — its button went away (a new stream's tracks, Retry at play). */
    Nothing,
}

/** What a remote key does in the live player. */
sealed interface LiveKey {
    data object PlayPause : LiveKey
    data object Play : LiveKey
    data object Pause : LiveKey
    data object PreviousChannel : LiveKey
    data object NextChannel : LiveKey
    /** A number key: the next digit of a channel number. */
    data class Digit(val digit: Char) : LiveKey
    /** The controls come up with Play/Pause in focus. */
    data object OpenControls : LiveKey
    data object OpenList : LiveKey
    data object CloseList : LiveKey
    data object Guide : LiveKey
    data object Stats : LiveKey
    /** Nothing in focus: the remote back on the picture. */
    data object FocusPicture : LiveKey
    /** Taken, and nothing done with it. */
    data object Ignore : LiveKey
    /** Left to whatever has the focus. */
    data object Pass : LiveKey
}

/** The digit a remote's number key (top row or keypad) stands for. */
fun digitOf(keyCode: Int): Char? = when (keyCode) {
    in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> '0' + (keyCode - KeyEvent.KEYCODE_0)
    in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> '0' + (keyCode - KeyEvent.KEYCODE_NUMPAD_0)
    else -> null
}

private fun isDpadOrOk(keyCode: Int) = isOkKey(keyCode) || keyCode in KeyEvent.KEYCODE_DPAD_UP..KeyEvent.KEYCODE_DPAD_RIGHT

/**
 * The keys that work wherever the focus is (on a TV, seen before any button
 * does: RemoteKeys). The media keys, CH+/CH−, Guide/Info and ≡ (Stats)
 * always; the number keys while the channel list is closed (open, they and
 * the letters are its search's). CH+/CH− are ignored while the list is open
 * — its own Up/Down walk it. With nothing in focus at all, the D-pad and OK
 * put the remote back on the picture.
 */
fun liveAnywhereKey(keyCode: Int, focus: LiveFocus, listOpen: Boolean): LiveKey = when (keyCode) {
    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> LiveKey.PlayPause
    KeyEvent.KEYCODE_MEDIA_PLAY -> LiveKey.Play
    KeyEvent.KEYCODE_MEDIA_PAUSE -> LiveKey.Pause
    // CH+ is the next channel, as on any remote.
    KeyEvent.KEYCODE_CHANNEL_UP -> if (listOpen) LiveKey.Ignore else LiveKey.NextChannel
    KeyEvent.KEYCODE_CHANNEL_DOWN -> if (listOpen) LiveKey.Ignore else LiveKey.PreviousChannel
    KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_GUIDE -> LiveKey.Guide
    // The remote's ≡: the Stats panel.
    KeyEvent.KEYCODE_MENU -> LiveKey.Stats
    KeyEvent.KEYCODE_G -> if (listOpen) LiveKey.Pass else LiveKey.Guide
    KeyEvent.KEYCODE_S -> if (listOpen) LiveKey.Pass else LiveKey.Stats
    else -> {
        val digit = digitOf(keyCode)
        when {
            digit != null -> if (listOpen) LiveKey.Pass else LiveKey.Digit(digit)
            focus == LiveFocus.Nothing && isDpadOrOk(keyCode) -> LiveKey.FocusPicture
            else -> LiveKey.Pass
        }
    }
}

/**
 * The D-pad and OK, as the picture takes them. On the picture, Up/Down change
 * channel (as on any set-top box), Right opens the channel list and OK brings
 * the controls up; on a button the D-pad and OK are the button's. With the
 * list open the D-pad walks it, and Left moves left as usual — it closes the
 * list only when there's nothing further left ([canMoveLeft]: the focus has
 * somewhere to go). OK on the picture with the list open does nothing.
 */
fun livePictureKey(keyCode: Int, focus: LiveFocus, listOpen: Boolean, canMoveLeft: Boolean): LiveKey = when {
    listOpen -> when {
        keyCode == KeyEvent.KEYCODE_DPAD_LEFT -> if (canMoveLeft) LiveKey.Pass else LiveKey.CloseList
        isOkKey(keyCode) && focus == LiveFocus.Picture -> LiveKey.Ignore
        else -> LiveKey.Pass
    }
    focus != LiveFocus.Picture -> LiveKey.Pass
    // Up/Down walk the channels as the list reads them.
    keyCode == KeyEvent.KEYCODE_DPAD_UP -> LiveKey.PreviousChannel
    keyCode == KeyEvent.KEYCODE_DPAD_DOWN -> LiveKey.NextChannel
    keyCode == KeyEvent.KEYCODE_DPAD_RIGHT -> LiveKey.OpenList
    isOkKey(keyCode) -> LiveKey.OpenControls
    else -> LiveKey.Pass
}

/**
 * The key the player used, until its release: its auto-repeats and its
 * release are the player's too, or they'd reach whatever took the focus
 * meanwhile (held OK: the controls come up on the press, and Play/Pause would
 * be pressed by the repeats and the release).
 */
class UsedKeys {
    private var key: Int? = null

    fun use(keyCode: Int) { key = keyCode }

    /** True for a repeat or the release of the used key: the player keeps it. */
    fun swallow(keyCode: Int, down: Boolean, repeatCount: Int): Boolean {
        if (keyCode != key) return false
        // A new press of it: its last release never came.
        if (down && repeatCount == 0) { key = null; return false }
        if (!down) key = null
        return true
    }
}
