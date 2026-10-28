package com.stalkerweb.android.ui.utils

import android.view.KeyEvent
import androidx.compose.ui.input.key.Key

/**
 * The remote's keys before any view or button sees them (MainActivity's
 * dispatchKeyEvent). A screen that must see a key wherever the focus is — the
 * VOD player's OK-to-skip, with Media3's controls gone and the focus with them
 * — sets [handler] while it's on screen; it answers true for a key it used.
 */
object RemoteKeys {
    @Volatile var handler: ((KeyEvent) -> Boolean)? = null
}

/** The remote's OK (the centre button), or Enter. */
fun isOkKey(keyCode: Int): Boolean =
    keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER

/** The remote's OK, or Enter, as Compose names keys. */
fun isOkKey(key: Key): Boolean = key == Key.DirectionCenter || key == Key.Enter || key == Key.NumPadEnter
