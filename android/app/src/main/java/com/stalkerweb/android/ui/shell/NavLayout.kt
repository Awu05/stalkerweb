package com.stalkerweb.android.ui.shell

/** The shell's navigation: a side rail (TV, wide screens) or a bottom bar (phones). */
enum class NavLayout { RAIL, BOTTOM_BAR }

fun navLayoutFor(widthDp: Int, isTv: Boolean): NavLayout =
    if (isTv || widthDp >= 600) NavLayout.RAIL else NavLayout.BOTTOM_BAR
