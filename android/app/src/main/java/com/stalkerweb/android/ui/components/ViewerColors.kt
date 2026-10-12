package com.stalkerweb.android.ui.components

/** A viewer's "#rrggbb" colour as ARGB, or null when it isn't one. */
fun parseHexColor(hex: String?): Long? {
    val digits = hex?.trim()?.removePrefix("#") ?: return null
    if (digits.length != 6) return null
    val rgb = digits.toLongOrNull(16) ?: return null
    return 0xFF000000L or rgb
}
