package com.stalkerweb.android.ui.vod

/** The VOD grid's columns and poster widths (dp), for the grid's own size. */
data class PosterSizes(val columns: Int, val cellDp: Int, val rowDp: Int)

const val GRID_PADDING_DP = 12
const val GRID_GAP_DP = 14
private const val TITLE_DP = 56     // the title and year under a poster
private const val SMALLEST_DP = 90

/**
 * On a TV a poster follows the screen's height (about 540 dp on any TV,
 * however wide). Elsewhere it's 140 dp, smaller when the grid is too short for
 * a whole poster and its title (a phone on its side). The grid's columns are
 * stretched to fill its width; the Recently watched and My List rows use the
 * same width on a TV, so the rows and the grid line up, and at most 150 dp elsewhere.
 */
fun posterSizesFor(isTv: Boolean, screenHeightDp: Int, gridWidthDp: Int, gridHeightDp: Int): PosterSizes {
    val fit = ((gridHeightDp - TITLE_DP) * 2 / 3).coerceAtLeast(SMALLEST_DP)
    val min = if (isTv) (screenHeightDp / 4).coerceIn(110, 160) else minOf(140, fit)
    val usable = gridWidthDp - 2 * GRID_PADDING_DP
    val columns = maxOf(1, (usable + GRID_GAP_DP) / (min + GRID_GAP_DP))
    val cell = maxOf(min, (usable - GRID_GAP_DP * (columns - 1)) / columns)
    return PosterSizes(columns, cell, if (isTv) cell else minOf(150, fit))
}
