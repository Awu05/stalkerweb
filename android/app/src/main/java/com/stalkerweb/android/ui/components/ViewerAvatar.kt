package com.stalkerweb.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.theme.VIEWER_COLORS

/** A viewer's round avatar: their initial on their colour (the web's ViewerAvatar). */
@Composable
fun ViewerAvatar(name: String, color: String?, size: Dp, modifier: Modifier = Modifier) {
    val bg = parseHexColor(color)?.let { Color(it) } ?: SwColors.Surface3
    // Initials that read on the colour (the theme picks white or near-black for each).
    val ink = VIEWER_COLORS.firstOrNull { it.hex.equals(color?.trim(), ignoreCase = true) }?.on
        ?: if (parseHexColor(color) == null) SwColors.Text else Color.White
    Box(modifier.size(size).background(bg, CircleShape), contentAlignment = Alignment.Center) {
        Text(
            text = name.trim().take(1).uppercase().ifEmpty { "?" },
            color = ink,
            fontWeight = FontWeight.SemiBold,
            fontSize = (size.value * 0.42f).sp,
        )
    }
}
