package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayerParamsTest {
    // Produced by the web's buildPlayerParams (frontend/src/pages/VodPage.jsx).
    private val webMovie = "videoId=42&title=Am%C3%A9lie+%26+Co&cmd=%2Fmedia%2F42.mpg&series=0&year=2001&durationMin=122&isHD=true" +
        "&screenshotUrl=%252Fapi%252Flogos%252Frender%253Furl%253Dhttp%25253A%25252F%25252Fp%25252Fa.jpg" +
        "&description=It%27s%2520%28great%29%2520100%2525%2520fun%21&director=Jean-Pierre%2520Jeunet"
    private val webEpisode = "videoId=7&title=Bluey&cmd=&series=2&seasonId=s1&episodeId=e2&episodeTitle=Hospital"

    private val movie = PlayerParams(
        videoId = "42", title = "Amélie & Co", cmd = "/media/42.mpg", year = "2001", durationMin = 122, isHD = true,
        screenshotUrl = "/api/logos/render?url=http%3A%2F%2Fp%2Fa.jpg", description = "It's (great) 100% fun!", director = "Jean-Pierre Jeunet",
    )

    @Test fun readsTheWebsLink() {
        assertEquals(movie, PlayerParams.parse(webMovie))
        val ep = PlayerParams.parse(webEpisode)
        assertEquals(PlayerParams(videoId = "7", title = "Bluey", series = "2", seasonId = "s1", episodeId = "e2", episodeTitle = "Hospital"), ep)
        assertTrue(ep.isEpisode)
        assertFalse(movie.isEpisode)
    }

    @Test fun writesExactlyWhatTheWebWrites() {
        assertEquals(webMovie, movie.toQuery())
        assertEquals(webEpisode, PlayerParams.parse(webEpisode).toQuery())
    }

    @Test fun survivesARoundTrip() {
        val odd = movie.copy(title = "Tom + Jerry ~ 50% (redux)!", description = "a+b c&d=e")
        assertEquals(odd, PlayerParams.parse(odd.toQuery()))
    }
}
