package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.VodItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

// The cases of frontend/src/lib/vodFilters.test.js.
class VodFiltersTest {
    private val now = parseAdded("2026-10-09T12:00:00")!!
    private fun t(id: String, name: String = "Title $id", year: String = "", genres: List<String> = emptyList(),
                  rating: Double = 0.0, isHD: Boolean = false, added: String = "") =
        VodItem(id = id, name = name, year = year, genres = genres, rating = rating, isHD = isHD, added = added)
    private val items = listOf(
        t("1", name = "Zodiac", year = "2007", genres = listOf("Crime", "Drama"), rating = 7.7, isHD = true, added = "2026-10-05 10:00:00"),
        t("2", name = "Arrival", year = "2016", genres = listOf("Drama", "Sci-Fi"), rating = 7.9, added = "2026-08-01 10:00:00"),
        t("3", name = "Alien", year = "1979", genres = listOf("Horror"), rating = 8.5, isHD = true, added = "2026-10-08 10:00:00"),
        t("4", name = "Title 10"),
        t("5", name = "Title 9", year = "2021"),
    )
    private fun ids(list: List<VodItem>) = list.map { it.id }
    private fun f(state: VodFilterState, watched: Set<String> = emptySet(), search: String = "") =
        ids(applyVodFilters(items, state, watched, search, now))

    @Test fun keepsEverythingWithNoFilters() {
        assertFalse(VodFilterState().isActive)
        assertEquals(listOf("1", "2", "3", "4", "5"), f(VodFilterState()))
    }

    @Test fun filtersByGenreDecadeRatingAddedAndHdTogether() {
        assertEquals(listOf("1", "2"), f(VodFilterState(genre = "Drama")))
        assertEquals(listOf("1"), f(VodFilterState(year = "2000s")))
        assertEquals(listOf("3"), f(VodFilterState(year = "Older")))
        assertEquals(listOf("2"), f(VodFilterState(year = "2016")))
        assertEquals(listOf("2", "3"), f(VodFilterState(minRating = 7.8)))
        assertEquals(listOf("1", "3"), f(VodFilterState(addedDays = 7)))
        assertEquals(listOf("1", "3"), f(VodFilterState(hd = true)))
        assertEquals(listOf("1"), f(VodFilterState(genre = "Drama", hd = true)))
    }

    @Test fun leavesOutWatchedAndMatchesTheSearch() {
        assertEquals(listOf("2", "4", "5"), f(VodFilterState(unwatched = true), watched = setOf("1", "3")))
        assertEquals(listOf("3"), f(VodFilterState(), search = "ali"))
    }

    @Test fun sortsAToZWithNumbersInOrderOrNewestFirst() {
        assertEquals(listOf("3", "2", "5", "4", "1"), ids(sortVodItems(items, "name")))
        assertEquals(listOf("3", "1", "2"), ids(sortVodItems(items, "added")).take(3))
    }

    @Test fun offersWhatTheTitlesHave() {
        assertEquals(FilterOptions(listOf("Crime", "Drama", "Horror", "Sci-Fi"), listOf("2021", "2016", "2007", "1979"), true, true, hasAdded = true), filterOptions(items))
        val bare = filterOptions(listOf(t("1", year = "2020")))
        assertEquals(emptyList<String>(), bare.genres)
        assertFalse(bare.hasRating)
        assertFalse(bare.hasHD)
    }

    @Test fun groupsYearsByDecade() {
        assertEquals("2020s", decadeOf("2026"))
        assertEquals("1980s", decadeOf("1985"))
        assertEquals("Older", decadeOf("1979"))
        assertNull(decadeOf(""))
    }

    @Test fun yearChoicesAreYearsWhenFewDecadesWhenMany() {
        fun years(vararg ys: Int) = ys.mapIndexed { i, y -> t(i.toString(), year = y.toString()) }
        assertEquals(listOf("2026", "2025", "2024"), filterOptions(years(2026, 2025, 2026, 2024)).years)
        assertEquals(listOf("2010s", "2000s", "1990s"), filterOptions(years(*IntArray(30) { 1990 + it })).years)
        val list = years(2026, 2025, 2016)
        assertEquals(listOf("1"), ids(applyVodFilters(list, VodFilterState(year = "2025"), emptySet(), "", now)))
        assertEquals(listOf("0", "1"), ids(applyVodFilters(list, VodFilterState(year = "2020s"), emptySet(), "", now)))
        assertEquals(emptyList<String>(), ids(applyVodFilters(list, VodFilterState(year = "Older"), emptySet(), "", now)))
    }
}

class VodFilterChoicesTest {
    private fun t(id: String, genres: List<String> = emptyList(), added: String = "", isHD: Boolean = false, year: String = "") =
        VodItem(id = id, name = "T$id", genres = genres, added = added, isHD = isHD, year = year)

    @Test fun genresAreKeptAsTheyAreSpelled() {
        assertEquals(listOf("Comedie", "Comédie"), filterOptions(listOf(t("1", listOf("Comédie")), t("2", listOf("Comedie")))).genres.sorted())
    }

    @Test fun addedIsOfferedOnlyWhenTitlesAreDated() {
        assertFalse(filterOptions(listOf(t("1"))).hasAdded)
        org.junit.Assert.assertTrue(filterOptions(listOf(t("1", added = "2026-10-01 10:00:00"))).hasAdded)
    }

    @Test fun aFilterThatIsOnStaysOfferedWithItsChoice() {
        val none = filterOptions(emptyList())          // while the listing is still being read
        val shown = none.withChosen(VodFilterState(genre = "Drama", year = "2016", hd = true, addedDays = 7, minRating = 7.0))
        assertEquals(listOf("Drama"), shown.genres)
        assertEquals(listOf("2016"), shown.years)
        org.junit.Assert.assertTrue(shown.hasHD && shown.hasAdded && shown.hasRating)
    }

    @Test fun showingMoreStopsAtWhatThereIs() {
        assertEquals(280, nextVisibleCount(140, 500))
        assertEquals(140, nextVisibleCount(140, 90))   // fewer than shown: nothing more to show
        assertEquals(140, nextVisibleCount(140, 140))
    }
}
