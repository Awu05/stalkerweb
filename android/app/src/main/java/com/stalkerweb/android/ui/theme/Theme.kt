package com.stalkerweb.android.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.ripple.RippleAlpha
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.stalkerweb.android.BuildConfig

/** The web app's "Midnight Cinema" tokens (frontend/src/index.css), by the same names. */
object SwColors {
    val Bg           = Color(0xFF141417)
    val Surface      = Color(0xFF1C1C20)
    val Surface2     = Color(0xFF232328)
    val Surface3     = Color(0xFF28282E)
    val Border       = Color(0xFF28282E)
    val Text         = Color(0xFFE8E8EC)
    val Muted        = Color(0xFF9696A0)
    val Primary      = Color(0xFFE8E8EC)
    val PrimaryLight = Color(0xFFFFFFFF)
    val Live         = Color(0xFFEF4444)
    val Success      = Color(0xFF5BC39D)
    val Heart        = Color(0xFFF43F5E)
    val Warning      = Color(0xFFFBBF24)
}

private val DarkColors = darkColorScheme(
    primary                 = SwColors.Primary,
    onPrimary               = SwColors.Bg,
    primaryContainer        = SwColors.Surface3,
    onPrimaryContainer      = SwColors.PrimaryLight,
    secondary               = SwColors.Muted,
    onSecondary             = SwColors.Bg,
    tertiary                = SwColors.Success,
    onTertiary              = SwColors.Bg,
    background              = SwColors.Bg,
    onBackground            = SwColors.Text,
    surface                 = SwColors.Surface,
    onSurface               = SwColors.Text,
    surfaceVariant          = SwColors.Surface2,
    onSurfaceVariant        = SwColors.Muted,
    surfaceContainerLowest  = SwColors.Bg,
    surfaceContainerLow     = SwColors.Surface,
    surfaceContainer        = SwColors.Surface2,
    surfaceContainerHigh    = SwColors.Surface3,
    surfaceContainerHighest = Color(0xFF303036),
    outline                 = SwColors.Border,
    outlineVariant          = Color(0xFF1F1F24),
    error                   = SwColors.Live,
    onError                 = Color.White,
)

/** The web's --radius-sm / -md / -lg. */
private val SwShapes = Shapes(
    small  = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(10.dp),
    large  = RoundedCornerShape(12.dp),
)

/**
 * On a TV the remote's focus is the only pointer: Material's 10% focus layer
 * barely shows on this dark palette, so buttons, the sidebar and menus get a
 * bright white one (Modifier.tvFocus draws the ring on our own tiles).
 */
@OptIn(ExperimentalMaterial3Api::class)
private val TvRipple = RippleConfiguration(
    color = SwColors.PrimaryLight,
    rippleAlpha = RippleAlpha(draggedAlpha = 0.16f, focusedAlpha = 0.32f, hoveredAlpha = 0.08f, pressedAlpha = 0.20f),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StalkerTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DarkColors, typography = StalkerTypography, shapes = SwShapes) {
        // MaterialTheme doesn't provide LocalContentColor; screens with a
        // transparent Scaffold would otherwise get black text. Give the theme's.
        CompositionLocalProvider(
            LocalContentColor provides SwColors.Text,
            LocalRippleConfiguration provides (if (BuildConfig.IS_TV) TvRipple else LocalRippleConfiguration.current),
            content = content,
        )
    }
}
