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
import com.stalkerweb.android.BuildConfig

// The colours, radii and viewer colours are the theme's: SwColors, SwRadius and
// VIEWER_COLORS in Tokens.kt, written from theme/tokens.json by theme/build.mjs
// (the website's come from the same file). Material's scheme is made of them,
// each fill with the colour that reads on it.

private val DarkColors = darkColorScheme(
    primary                 = SwColors.Primary,
    onPrimary               = SwColors.OnPrimary,
    primaryContainer        = SwColors.Surface3,
    onPrimaryContainer      = SwColors.PrimaryLight,
    secondary               = SwColors.Muted,
    onSecondary             = SwColors.Bg,
    tertiary                = SwColors.Success,
    onTertiary              = SwColors.OnSuccess,
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
    surfaceContainerHighest = SwColors.Surface4,
    outline                 = SwColors.Border,
    outlineVariant          = SwColors.OutlineSoft,
    error                   = SwColors.Live,
    onError                 = SwColors.Bg,   // dark reads on the red (white needs LiveFill)
)

/** The web's --radius-sm / -md / -lg. */
private val SwShapes = Shapes(
    small  = RoundedCornerShape(SwRadius.Sm),
    medium = RoundedCornerShape(SwRadius.Md),
    large  = RoundedCornerShape(SwRadius.Lg),
)

/**
 * On a TV the remote's focus is the only pointer: Material's 10% focus layer
 * barely shows on this palette, so buttons, the sidebar and menus get a much
 * stronger one (Modifier.tvFocus draws the ring on our own tiles). Its colour
 * stays the content's — light on dark buttons, dark on the near-white filled
 * ones, where a white layer wouldn't show at all.
 */
@OptIn(ExperimentalMaterial3Api::class)
private val TvRipple = RippleConfiguration(
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
