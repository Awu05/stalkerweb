package com.stalkerweb.android.ui.components

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonColors
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.foundation.layout.size
import androidx.compose.ui.unit.Dp
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV
import kotlinx.coroutines.delay

// How long the remote rests on a button before its name shows (the web's tooltips wait as long).
private const val TV_TIP_DELAY_MS = 500L

/**
 * The app's icon button: Material's, with its name in a tooltip — on a phone
 * when it's pressed and held, on a TV when the remote rests on it. [label] is
 * what it does, in the words the website's tooltip uses for the same button.
 * [size]: the button's own size (the [modifier] places it: align, padding,
 * a background). [lit]: a toggle that's on (subtitles showing, the stats open) — a light disc
 * behind it, as the website shows one. Every icon button is one of these
 * (ThemeUsageTest checks).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TipIconButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    size: Dp? = null,
    lit: Boolean = false,
    colors: IconButtonColors = IconButtonDefaults.iconButtonColors(),
    content: @Composable () -> Unit,
) {
    val tip = rememberTooltipState()
    val isTV = rememberIsTV()
    var focused by remember { mutableStateOf(false) }
    if (isTV) {
        LaunchedEffect(focused) {
            if (focused) { delay(TV_TIP_DELAY_MS); tip.show() } else tip.dismiss()
        }
    }
    // The caller's modifier goes on the outermost layout: its align(), size
    // and padding are for where the button sits in the caller's own Box/Row.
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),
        tooltip = { PlainTooltip { Text(label) } },
        state = tip,
        modifier = modifier,
    ) {
        IconButton(
            onClick = onClick,
            modifier = Modifier.onFocusChanged { focused = it.hasFocus }.then(if (size != null) Modifier.size(size) else Modifier),
            enabled = enabled,
            colors = if (lit) colors.copy(containerColor = SwColors.PrimaryLight.copy(alpha = 0.18f)) else colors,
            content = content,
        )
    }
}
