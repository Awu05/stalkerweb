package com.stalkerweb.android.ui.components

import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.view.View
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import androidx.media3.ui.TimeBar

/**
 * Media3's own controls (play/pause, ±seconds, previous/next, settings) mark
 * focus with a faint ripple that's lost over the video on a TV. Give each of
 * their buttons the app's cue instead: a white ring on a light disc, and a lift.
 * The cue is a foreground, so the ±seconds buttons — TextViews whose background
 * is their icon — keep it, and the buttons keep their own touch ripple. TV only.
 */
@OptIn(UnstableApi::class)
fun PlayerView.highlightControllerFocus() {
    val density = resources.displayMetrics.density
    fun visit(v: View) {
        if (v is ViewGroup) { for (i in 0 until v.childCount) visit(v.getChildAt(i)); return }
        if (!v.isFocusable || v is TimeBar) return
        val ring = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(0x40FFFFFF)
            setStroke((3 * density).toInt(), 0xFFFFFFFF.toInt())
        }
        v.foreground = StateListDrawable().apply { addState(intArrayOf(android.R.attr.state_focused), ring) }
        v.setOnFocusChangeListener { button, focused ->
            val scale = if (focused) 1.2f else 1f
            button.animate().scaleX(scale).scaleY(scale).setDuration(120).start()
        }
    }
    visit(this)
}
