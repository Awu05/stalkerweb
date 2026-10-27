// Generated from theme/tokens.json by theme/build.mjs — do not edit; change tokens.json and run `node theme/build.mjs`.
package com.stalkerweb.android.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** The theme's colours (the website's --color-… by the same names). Each fill has its On… colour. */
object SwColors {
    val Bg           = Color(0xFF141417)
    val Surface      = Color(0xFF1C1C20)
    val Surface2     = Color(0xFF232328)
    val Surface3     = Color(0xFF28282E)
    val Surface4     = Color(0xFF303036)
    val Border       = Color(0xFF28282E)
    val BorderStrong = Color(0xFF3C3C44)
    val OutlineSoft  = Color(0xFF1F1F24)
    val Text         = Color(0xFFE8E8EC)
    val Muted        = Color(0xFF9696A0)
    val Primary      = Color(0xFFE8E8EC)
    val OnPrimary    = Color(0xFF141417)
    val PrimaryHover = Color(0xFFC8C8CE)
    val PrimaryLight = Color(0xFFFFFFFF)
    val PrimaryGlow  = Color(0x59E8E8EC)
    val Accent       = Color(0xFFE8E8EC)
    val AccentLight  = Color(0xFFFFFFFF)
    val Live         = Color(0xFFEF4444)
    val LiveFill     = Color(0xFFDC2626)
    val OnLive       = Color(0xFFFFFFFF)
    val Success      = Color(0xFF5BC39D)
    val OnSuccess    = Color(0xFF0B1A14)
    val Heart        = Color(0xFFF43F5E)
    val Warning      = Color(0xFFFBBF24)
    val OnWarning    = Color(0xFF141417)
}

/** The theme's corner radii (the website's --radius-…). */
object SwRadius {
    val Sm = 8.dp
    val Md = 10.dp
    val Lg = 12.dp
}

/** A colour a viewer can pick for their avatar, and the colour its initials go in. */
data class ViewerColor(val hex: String, val color: Color, val on: Color)

/** The viewer colours, in order (the first is the Default viewer's). */
val VIEWER_COLORS: List<ViewerColor> = listOf(
    ViewerColor("#5b8def", Color(0xFF5B8DEF), Color(0xFFFFFFFF)),
    ViewerColor("#e5484d", Color(0xFFE5484D), Color(0xFFFFFFFF)),
    ViewerColor("#30a46c", Color(0xFF30A46C), Color(0xFFFFFFFF)),
    ViewerColor("#f5a524", Color(0xFFF5A524), Color(0xFF141417)),
    ViewerColor("#8e4ec6", Color(0xFF8E4EC6), Color(0xFFFFFFFF)),
    ViewerColor("#12a594", Color(0xFF12A594), Color(0xFFFFFFFF)),
    ViewerColor("#e93d82", Color(0xFFE93D82), Color(0xFFFFFFFF)),
    ViewerColor("#978365", Color(0xFF978365), Color(0xFFFFFFFF)),
)
