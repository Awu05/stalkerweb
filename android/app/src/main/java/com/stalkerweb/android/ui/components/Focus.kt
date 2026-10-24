package com.stalkerweb.android.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.DrawScope
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
        .drawWithContent {
            drawContent()
            if (focused) {
                val ring = 3.dp.toPx()
                focusRing(shape, inset = 0f, width = ring, color = SwColors.PrimaryLight)
                focusRing(shape, inset = ring, width = 2.dp.toPx(), color = SwColors.Bg)
            }
        }
}

/** A stroke of [width] along [shape], kept inside the bounds, [inset] from the edge. */
private fun DrawScope.focusRing(shape: Shape, inset: Float, width: Float, color: Color) {
    val edge = inset + width / 2
    val inner = Size(size.width - 2 * edge, size.height - 2 * edge)
    if (inner.minDimension <= 0f) return
    val outline = shape.createOutline(inner, layoutDirection, this)
    translate(edge, edge) { drawOutline(outline, color, style = Stroke(width)) }
}
