package com.stalkerweb.android.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.CacheDrawScope
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import com.stalkerweb.android.ui.theme.SwColors

/**
 * The remote's focus cue: a thick white ring with a dark edge inside it (so it
 * shows on white pills and bright posters too) and a lift that draws over the
 * neighbours. Put it before the clickable/focusable it describes:
 * `Modifier.tvFocus().clickable { … }`.
 */
fun Modifier.tvFocus(shape: Shape = RoundedCornerShape(10.dp)): Modifier = composed {
    var focused by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (focused) 1.06f else 1f, label = "tvFocusScale")
    this
        .onFocusChanged { focused = it.hasFocus }
        .zIndex(if (focused) 1f else 0f)
        .graphicsLayer { scaleX = scale; scaleY = scale }
        .drawWithCache {
            // The dark band is the full 5dp and the white 3dp is laid over its
            // outer part, so the two always meet — separate rings of the same
            // corner radius don't, and a sliver of the tile showed at each corner.
            val white = ringOf(shape, 3.dp.toPx())
            val dark = ringOf(shape, 5.dp.toPx())
            onDrawWithContent {
                drawContent()
                if (focused) {
                    dark?.let { (o, w) -> translate(w / 2, w / 2) { drawOutline(o, SwColors.Bg, style = Stroke(w)) } }
                    white?.let { (o, w) -> translate(w / 2, w / 2) { drawOutline(o, SwColors.PrimaryLight, style = Stroke(w)) } }
                }
            }
        }
}

/** The outline a stroke of [width] follows to sit just inside [shape]'s edge, with that width. */
private fun CacheDrawScope.ringOf(shape: Shape, width: Float): Pair<Outline, Float>? {
    val inner = Size(size.width - width, size.height - width)
    if (inner.minDimension <= 0f) return null
    return shape.createOutline(inner, layoutDirection, this) to width
}
