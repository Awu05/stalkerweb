package com.stalkerweb.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** A sideways-scrolling row of equal-width items (Recently watched, My List); the remote scrolls it by focus. */
@Composable
fun <T> RowStrip(items: List<T>, key: (T) -> Any, itemWidth: Dp, modifier: Modifier = Modifier, content: @Composable (T) -> Unit) {
    LazyRow(
        modifier,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(vertical = 6.dp, horizontal = 4.dp),   // room for the focus lift
    ) {
        items(items, key = key) { item -> Box(Modifier.width(itemWidth)) { content(item) } }
    }
}
