package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.Channel
import com.stalkerweb.android.data.api.ViewerDetails
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewerFilterTest {
    private fun ch(name: String, genre: String?) = Channel(uniqueId = name, name = name, genre = genre)
    private val viewer = ViewerDetails(
        id = "view_a",
        disabledGenres = listOf("ENGLISH | SPORTS"),
        disabledLanguages = listOf("french | movies"),   // stored as given; the language part counts
    )
    private val filter = ViewerFilter.from(viewer)

    @Test fun hidesDisabledGenresByExactName() {
        assertFalse(filter.keepsChannel(ch("ESPN", "ENGLISH | SPORTS")))
        assertTrue(filter.keepsChannel(ch("CNN", "ENGLISH | NEWS")))
    }

    @Test fun hidesWholeLanguages() {
        assertFalse(filter.keepsChannel(ch("TF1", " French | News")))
        assertFalse(filter.keepsGroup("FRENCH | KIDS"))
    }

    @Test fun hidesAdultUnlessTheViewerShowsIt() {
        assertFalse(filter.keepsChannel(ch("Late Night", "XXX | NIGHT")))
        assertFalse(filter.keepsChannel(ch("Hot 18+ TV", null)))
        assertTrue(ViewerFilter.from(viewer.copy(showAdult = true)).keepsChannel(ch("Late Night", "XXX | NIGHT")))
    }

    @Test fun keepsChannelsWithNoGenre() {
        assertTrue(filter.keepsChannel(ch("Local", null)))
    }

    @Test fun anUnknownViewerHidesOnlyAdult() {
        val none = ViewerFilter.from(null)
        assertTrue(none.keepsChannel(ch("ESPN", "ENGLISH | SPORTS")))
        assertFalse(none.keepsChannel(ch("x", "ADULT")))
    }
}
