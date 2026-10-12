# Android Parity Part 2: VOD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Android app the web's VOD:
- Recently watched, resume and progress saving that's shared with the web
- My List, with To watch and Completed
- filters, A–Z / Newest sorting, Movies and Series "All"
- a player with episodes, Previous / Next and auto-play next

**Architecture:**
- **Pure Kotlin ports of the web's VOD logic:**
  - `VodFilters` (from `vodFilters.js`)
  - `EpisodeNav` (from `episodeNav.js`)
  - `RequestOrder` (from the ordering in `vodProgress.js`)
  - `PlayerParams` (the web player's link format)
  - `WatchRules`

  These are unit-tested against the web's own cases.
- **`WatchRepository`** keeps the viewer's watch state, from the server's `/api/vod/watch*` routes.
- **`VodViewModel` and `VodScreen`** are rewritten to the web's layout.
- **The VOD player** takes a single `params` argument, the same as the web's player link. It resumes, saves progress and handles episodes, with Media3's own controller doing the seeking.

**Tech Stack:** Kotlin 2.4, Compose (BOM 2026.06.00, Material 3), Navigation Compose, Retrofit 3 and Moshi, Media3 1.10 (MediaController and PlayerView), Coil 2.7. JUnit 4 for tests.

**Spec:** `docs/superpowers/specs/2026-10-12-android-parity-2-vod-design.md`

## Global Constraints

- **Branch** `feat/android-vod`, stacked on `feat/android-shell-viewers`. The PR goes into main.
- **Compiling:** there's no local JDK, so CI compiles and tests on each push. Use `gh pr checks <PR> --watch`. The unit tests are named in the log, in the form `Name > test PASSED`.
- **Package** `com.stalkerweb.android`. Models go in `data/api` (R8 keep rule).
- **Watch rules:**
  - `RESUME_MIN_SECS = 30`, `DONE_FRACTION = 0.95`
  - keys are `"id"` or `"id:season:episode"`
  - the progress poll runs every 10 s
  - the listing poll runs every 1.2 s
  - filtered titles show 140 at a time
- **Player link:**
  - The keys, in order: `videoId`, `title`, `cmd`, `series`, then `seasonId`, `episodeId`, `episodeTitle`, `year`, `durationMin`, `isHD`, `screenshotUrl`, `description`, `director`, `actors`.
  - The outer encoding is form encoding.
  - The last four values are `encodeURIComponent`-encoded inside it.
  - `screenshotUrl` is stored relative to the server.
- **Sort:** `"name"` (A–Z, the default) or `"added"`. It's remembered per device in `AppPrefs.vodSort`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **History saved on the web plays on Android, and the other way round.** That includes entries with accents, `&`, `%` and apostrophes in titles or descriptions. Pinned by the `PlayerParams` fixture tests in Task 1.
2. **Switching episode in place never saves or resumes against the wrong episode.** Pinned by the `mediaKey` guard in Task 5. It needs the player, so it's checked by hand.
3. **A My List change survives a slow progress answer arriving after it.** Pinned by the `RequestOrder` tests in Task 1.
4. **A category with no dated titles, no years or no ratings.** The filter bar hides the empty filters instead of offering choices that match nothing. Pinned by the `filterOptions` tests in Task 1.
5. **A viewer switch while VOD is open.** The old viewer's history and My List must not show for the new one. `WatchRepository` clears its state on the switch (Task 2), checked by hand.

---

## File map

| File | Responsibility |
|------|----------------|
| `data/api/Models.kt` | `VodItem` + genres, rating, added, episodes, director, actors |
| `data/api/WatchModels.kt` | `WatchState`, `ProgressEntry`, `HistoryEntry`, `ListEntry`, `SaveWatchRequest`, `CompletedRequest`, `ListingResponse` |
| `data/api/StalkerApi.kt` | + watch routes, listing, `sort` on items |
| `data/repo/VodFilters.kt` | filter state, decades, sorting, filtering, options (pure) |
| `data/repo/EpisodeNav.kt` | neighbours, last episode (pure) |
| `data/repo/RequestOrder.kt` | answer ordering (pure) |
| `data/repo/PlayerParams.kt` | the web player link (pure) |
| `data/repo/WatchRules.kt` | resume / done thresholds, keys (pure) |
| `data/repo/WatchRepository.kt` | the viewer's watch state |
| `data/repo/VodRepository.kt` | + listing, sort |
| `data/repo/MediaLinks.kt` | + `relativeImage` |
| `data/repo/AppContainer.kt` | + `watch` |
| `data/prefs/AppPrefs.kt` | + `vodSort` |
| `ui/components/PosterTile.kt` | long-press = bookmark (TV-reachable), progress bar, Watched badge |
| `ui/vod/VodViewModel.kt` | rewritten: modes, search, filters, sort, listing poll, series sheet |
| `ui/vod/VodScreen.kt` | rewritten: web layout |
| `ui/vod/VodPlayerViewModel.kt`, `ui/vod/VodPlayerScreen.kt` | rewritten: params, resume, save, episodes, up next, My List |
| `AppNavigation.kt`, `MainActivity.kt` | VodPlayer route takes `params` |

---

### Task 1: The pure VOD rules and their tests

**Files:**
- Create: `data/repo/VodFilters.kt`, `data/repo/EpisodeNav.kt`, `data/repo/RequestOrder.kt`, `data/repo/PlayerParams.kt`, `data/repo/WatchRules.kt`
- Modify: `data/api/Models.kt` (`VodItem` fields)
- Test: `android/app/src/test/java/com/stalkerweb/android/data/repo/VodFiltersTest.kt`, `EpisodeNavTest.kt`, `RequestOrderTest.kt`, `PlayerParamsTest.kt`, `WatchRulesTest.kt`

**Interfaces:**
- Produces:
  - `VodFilterState`, `FilterOptions`
  - `decadeOf`, `parseAdded`, `naturalOrder`, `sortVodItems`, `applyVodFilters`, `filterOptions`
  - `EpisodeRef`, `Neighbours`, `episodeNeighbours`, `isLastEpisode`
  - `RequestOrder`, `PlayerParams`, `WatchRules`

- [ ] **Step 1: Extend `VodItem`**

In `data/api/Models.kt`, replace the `VodItem` class with:
```kotlin
@JsonClass(generateAdapter = false)
data class VodItem(
    val id: String,
    val name: String = "",
    val description: String = "",
    val year: String = "",
    val durationMin: Int = 0,
    val isHD: Boolean = false,
    val isSeries: Boolean = false,
    val screenshotUrl: String? = null,
    val cmd: String = "",
    // For the VOD filters and My List (backend VodManager._normalizeItem); empty when the portal sends none.
    val genres: List<String> = emptyList(),
    val rating: Double = 0.0,
    val added: String = "",
    val episodes: List<String> = emptyList(),
    val director: String = "",
    val actors: String = "",
)
```

- [ ] **Step 2: Write the failing tests**

`VodFiltersTest.kt`:
```kotlin
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
        assertEquals(FilterOptions(listOf("Crime", "Drama", "Horror", "Sci-Fi"), listOf("2021", "2016", "2007", "1979"), true, true), filterOptions(items))
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
```

`EpisodeNavTest.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodSeason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The cases of frontend/src/lib/episodeNav.test.js, plus the last-episode rule.
class EpisodeNavTest {
    private val seasons = listOf(VodSeason("s1"), VodSeason("s2"), VodSeason("s3"))
    private fun ep(id: String) = VodEpisode(episodeId = id)
    private val eps = mapOf("s1" to listOf(ep("a"), ep("b")), "s2" to listOf(ep("c"), ep("d")))
    private fun ids(r: EpisodeRef?) = r?.let { listOf(it.season.id, it.episode.episodeId) }

    @Test fun stepsWithinASeason() {
        val n = episodeNeighbours(seasons, eps, "s2", "c")
        assertEquals(listOf("s1", "b"), ids(n.prev))
        assertEquals(listOf("s2", "d"), ids(n.next))
    }

    @Test fun crossesSeasons() {
        assertEquals(listOf("s2", "c"), ids(episodeNeighbours(seasons, eps, "s1", "b").next))
        assertEquals(listOf("s1", "b"), ids(episodeNeighbours(seasons, eps, "s2", "c").prev))
    }

    @Test fun asksForASeasonNotLoadedYet() {
        val n = episodeNeighbours(seasons, eps, "s2", "d")
        assertNull(n.next)
        assertEquals(listOf("s3"), n.needs)
    }

    @Test fun nothingBeforeTheFirstOrAfterTheLast() {
        assertNull(episodeNeighbours(seasons, eps, "s1", "a").prev)
        assertNull(episodeNeighbours(listOf(VodSeason("s1")), eps, "s1", "b").next)
        assertEquals(Neighbours(null, null, emptyList()), episodeNeighbours(seasons, eps, "s9", "x"))
    }

    @Test fun theLastEpisodeOnlyWhenItIsFoundAndNothingFollows() {
        assertTrue(isLastEpisode(listOf(VodSeason("s1")), eps, "s1", "b"))
        assertFalse(isLastEpisode(seasons, eps, "s1", "b"))
        assertFalse(isLastEpisode(seasons, eps, "s2", "d"))          // season 3 not loaded yet
        assertFalse(isLastEpisode(emptyList(), eps, "s1", "b"))      // seasons failed to load
    }
}
```

`RequestOrderTest.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RequestOrderTest {
    @Test fun aStaleAnswerDoesNotUndoALaterLocalChange() {
        val order = RequestOrder()
        val save = order.next(local = false)   // progress save in flight
        val add = order.next(local = true)     // My List change made here
        assertFalse(order.accept(save))        // its answer has the old list
        assertTrue(order.accept(add))
    }

    @Test fun anOlderAnswerDoesNotReplaceANewerOne() {
        val order = RequestOrder()
        val first = order.next(local = false)
        val second = order.next(local = false)
        assertTrue(order.accept(second))
        assertFalse(order.accept(first))
    }
}
```

`PlayerParamsTest.kt`:
```kotlin
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
```

`WatchRulesTest.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WatchRulesTest {
    @Test fun resumesOnlyBetweenThirtySecondsAndNinetyFivePercent() {
        assertEquals(600.0, WatchRules.resumeAt(600.0, 6000.0)!!, 0.0)
        assertNull(WatchRules.resumeAt(20.0, 6000.0))       // only just started
        assertNull(WatchRules.resumeAt(5800.0, 6000.0))     // as good as finished
        assertNull(WatchRules.resumeAt(600.0, 0.0))         // length unknown
    }

    @Test fun keysAMovieOrAnEpisode() {
        assertEquals("42", WatchRules.makeKey("42"))
        assertEquals("7:s1:e2", WatchRules.makeKey("7", "s1", "e2"))
    }
}
```

- [ ] **Step 3: Push the tests and confirm they fail in CI**

```bash
git add android/app/src
git commit -m "test(android): VOD filters, episode order, request order, player link, watch rules (failing)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```
Expected: `build-apk` fails to compile with "Unresolved reference" errors for the missing names.

- [ ] **Step 4: Write the implementations**

`data/repo/VodFilters.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.VodItem
import java.text.Collator
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale

// The VOD page's filters, sorting and filter choices — a port of
// frontend/src/lib/vodFilters.js. The portal can only search and sort, so a
// filter reads the whole category (/api/vod/listing) and filters it here.

data class VodFilterState(
    val genre: String = "",
    val year: String = "",        // a year ("2025") or a decade ("2010s", "Older")
    val minRating: Double = 0.0,
    val addedDays: Int = 0,
    val hd: Boolean = false,
    val unwatched: Boolean = false,
) {
    val isActive: Boolean get() = genre.isNotEmpty() || year.isNotEmpty() || minRating > 0 || addedDays > 0 || hd || unwatched
}

data class FilterOptions(val genres: List<String>, val years: List<String>, val hasRating: Boolean, val hasHD: Boolean)

private fun yearOf(year: String): Int? = Regex("""^\s*(\d+)""").find(year)?.groupValues?.get(1)?.toIntOrNull()

/** "2020s" … "1980s", "Older" for anything before 1980, or null. */
fun decadeOf(year: String): String? {
    val y = yearOf(year) ?: return null
    if (y < 1900) return null
    return if (y < 1980) "Older" else "${y / 10 * 10}s"
}

private fun isDecade(sel: String) = sel == "Older" || sel.endsWith("s")

private fun yearMatches(item: VodItem, sel: String): Boolean =
    if (isDecade(sel)) decadeOf(item.year) == sel else yearOf(item.year)?.toString() == sel

/** The portal's "2026-10-05 10:00:00" (local time) as epoch ms, or null. */
fun parseAdded(added: String): Long? {
    val s = added.trim().replace(' ', 'T')
    if (s.isEmpty()) return null
    return runCatching { LocalDateTime.parse(s).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli() }
        .recoverCatching { LocalDate.parse(s).atStartOfDay(ZoneId.of("UTC")).toInstant().toEpochMilli() }
        .getOrNull()
}

private val collator: Collator = Collator.getInstance(Locale.ROOT).apply { strength = Collator.PRIMARY }

/** Names in natural order, ignoring case and accents: "Title 9" before "Title 10". */
val naturalOrder: Comparator<String> = Comparator { a, b ->
    val chunks = Regex("""\d+|\D+""")
    val xs = chunks.findAll(a).map { it.value }.toList()
    val ys = chunks.findAll(b).map { it.value }.toList()
    for (i in 0 until minOf(xs.size, ys.size)) {
        val x = xs[i]; val y = ys[i]
        val c = if (x[0].isDigit() && y[0].isDigit()) {
            val nx = x.trimStart('0'); val ny = y.trimStart('0')
            if (nx.length != ny.length) nx.length - ny.length else nx.compareTo(ny)
        } else collator.compare(x, y)
        if (c != 0) return@Comparator c
    }
    xs.size - ys.size
}

private val byName: Comparator<VodItem> = Comparator { a, b -> naturalOrder.compare(a.name, b.name) }

/** "name": A–Z; "added": newest first, undated titles last by name. */
fun sortVodItems(items: List<VodItem>, sort: String): List<VodItem> =
    if (sort == "added") {
        items.sortedWith { a, b ->
            val ta = parseAdded(a.added); val tb = parseAdded(b.added)
            when {
                ta == null && tb == null -> byName.compare(a, b)
                ta == null -> 1
                tb == null -> -1
                else -> tb.compareTo(ta)
            }
        }
    } else items.sortedWith(byName)

/** The titles passing every filter. [watched]: ids started or finished; [search]: part of the name. */
fun applyVodFilters(items: List<VodItem>, f: VodFilterState, watched: Set<String>, search: String, now: Long = System.currentTimeMillis()): List<VodItem> {
    val q = search.trim().lowercase()
    val since = if (f.addedDays > 0) now - f.addedDays * 24L * 60 * 60 * 1000 else null
    return items.filter { item ->
        (q.isEmpty() || item.name.lowercase().contains(q)) &&
            (f.genre.isEmpty() || f.genre in item.genres) &&
            (f.year.isEmpty() || yearMatches(item, f.year)) &&
            (f.minRating <= 0 || item.rating >= f.minRating) &&
            (since == null || (parseAdded(item.added)?.let { it >= since } ?: false)) &&
            (!f.hd || item.isHD) &&
            (!f.unwatched || item.id !in watched)
    }
}

private const val MAX_SINGLE_YEARS = 12
private fun decadeRank(d: String) = if (d == "Older") -1 else d.dropLast(1).toInt()

/** What the titles offer — a filter with nothing to pick isn't shown. */
fun filterOptions(items: List<VodItem>): FilterOptions {
    val genres = sortedSetOf<String>(collator)
    val years = mutableSetOf<Int>()
    val decades = mutableSetOf<String>()
    var hasRating = false
    var hasHD = false
    for (item in items) {
        genres.addAll(item.genres)
        decadeOf(item.year)?.let { d -> decades.add(d); yearOf(item.year)?.let(years::add) }
        if (item.rating > 0) hasRating = true
        if (item.isHD) hasHD = true
    }
    val yearChoices = if (years.size <= MAX_SINGLE_YEARS) years.sortedDescending().map { it.toString() }
                      else decades.sortedByDescending(::decadeRank)
    return FilterOptions(genres.toList(), yearChoices, hasRating, hasHD)
}
```

`data/repo/EpisodeNav.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodSeason

data class EpisodeRef(val season: VodSeason, val episode: VodEpisode)

/** The episodes before and after, and the neighbouring seasons that must be loaded to know. */
data class Neighbours(val prev: EpisodeRef?, val next: EpisodeRef?, val needs: List<String>)

/**
 * The episodes either side of the one playing, across seasons: after a
 * season's last episode comes the next season's first. A port of
 * frontend/src/lib/episodeNav.js. [seasons] are in order; [bySeason] holds the
 * seasons loaded so far.
 */
fun episodeNeighbours(seasons: List<VodSeason>, bySeason: Map<String, List<VodEpisode>>, seasonId: String, episodeId: String): Neighbours {
    val none = Neighbours(null, null, emptyList())
    val si = seasons.indexOfFirst { it.id == seasonId }
    val eps = bySeason[seasonId]
    if (si < 0 || eps == null) return none
    val ei = eps.indexOfFirst { it.episodeId == episodeId }
    if (ei < 0) return none
    val needs = mutableListOf<String>()
    fun side(offset: Int): EpisodeRef? {
        eps.getOrNull(ei + offset)?.let { return EpisodeRef(seasons[si], it) }
        val season = seasons.getOrNull(si + offset) ?: return null
        val list = bySeason[season.id] ?: run { needs.add(season.id); return null }
        val episode = (if (offset > 0) list.firstOrNull() else list.lastOrNull()) ?: return null
        return EpisodeRef(season, episode)
    }
    val prev = side(-1)
    val next = side(1)
    return Neighbours(prev, next, needs)
}

/** The show's very last episode — only once this episode is found and nothing follows (finishing it completes the show on My List). */
fun isLastEpisode(seasons: List<VodSeason>, bySeason: Map<String, List<VodEpisode>>, seasonId: String, episodeId: String): Boolean {
    val found = seasons.any { it.id == seasonId } && bySeason[seasonId]?.any { it.episodeId == episodeId } == true
    val n = episodeNeighbours(seasons, bySeason, seasonId, episodeId)
    return found && n.next == null && n.needs.isEmpty()
}
```

`data/repo/RequestOrder.kt`:
```kotlin
package com.stalkerweb.android.data.repo

/**
 * Answers can arrive out of order — a progress save sent before a My List
 * change can answer after it, with the list as it was. Each request is
 * numbered when sent ([next]); its answer is used ([accept]) only if nothing
 * newer has been answered, nor changed here, since. As in the web's vodProgress.js.
 */
class RequestOrder {
    private var sent = 0
    private var answered = 0
    private var changedAt = 0

    @Synchronized fun next(local: Boolean): Int {
        val n = ++sent
        if (local) changedAt = n
        return n
    }

    @Synchronized fun accept(n: Int): Boolean {
        if (n <= answered || n < changedAt) return false
        answered = n
        return true
    }
}
```

`data/repo/WatchRules.kt`:
```kotlin
package com.stalkerweb.android.data.repo

/** The server's watch rules (backend viewers/WatchStore.js). */
object WatchRules {
    const val RESUME_MIN_SECS = 30.0    // less is "only just started"
    const val DONE_FRACTION = 0.95      // more is finished

    /** Where to pick up a saved position, or null to start from the top. */
    fun resumeAt(position: Double, duration: Double): Double? =
        if (duration > 0 && position >= RESUME_MIN_SECS && position < duration * DONE_FRACTION) position else null

    /** A movie's id, or "id:season:episode" — so each episode has its own resume point. */
    fun makeKey(videoId: String, seasonId: String = "", episodeId: String = ""): String =
        listOf(videoId, seasonId, episodeId).filter { it.isNotEmpty() }.joinToString(":")
}
```

`data/repo/PlayerParams.kt`:
```kotlin
package com.stalkerweb.android.data.repo

import java.net.URLDecoder
import java.net.URLEncoder

/**
 * What the VOD player plays, in the web player's link format — history and
 * My List entries carry it, so a title started on the TV resumes on the web
 * and the other way round. Written exactly as the web's buildPlayerParams
 * (frontend/src/pages/VodPage.jsx): form-encoded, with the poster,
 * description, director and actors encodeURIComponent'ed inside that.
 * [screenshotUrl] is relative to the server ("/api/logos/render?url=…").
 */
data class PlayerParams(
    val videoId: String,
    val title: String = "",
    val cmd: String = "",
    val series: String = "0",
    val seasonId: String = "",
    val episodeId: String = "",
    val episodeTitle: String = "",
    val year: String = "",
    val durationMin: Int = 0,
    val isHD: Boolean = false,
    val screenshotUrl: String = "",
    val description: String = "",
    val director: String = "",
    val actors: String = "",
) {
    val isEpisode: Boolean get() = seasonId.isNotEmpty() || episodeId.isNotEmpty()
    val key: String get() = WatchRules.makeKey(videoId, seasonId, episodeId)

    fun toQuery(): String = buildList {
        add("videoId" to videoId); add("title" to title); add("cmd" to cmd); add("series" to series)
        if (seasonId.isNotEmpty()) add("seasonId" to seasonId)
        if (episodeId.isNotEmpty()) add("episodeId" to episodeId)
        if (episodeTitle.isNotEmpty()) add("episodeTitle" to episodeTitle)
        if (year.isNotEmpty()) add("year" to year)
        if (durationMin > 0) add("durationMin" to durationMin.toString())
        if (isHD) add("isHD" to "true")
        if (screenshotUrl.isNotEmpty()) add("screenshotUrl" to encodeURIComponent(screenshotUrl))
        if (description.isNotEmpty()) add("description" to encodeURIComponent(description))
        if (director.isNotEmpty()) add("director" to encodeURIComponent(director))
        if (actors.isNotEmpty()) add("actors" to encodeURIComponent(actors))
    }.joinToString("&") { (k, v) -> "$k=${formEncode(v)}" }

    companion object {
        fun parse(query: String): PlayerParams {
            val q = query.removePrefix("?").split("&").filter { it.isNotEmpty() }.associate { part ->
                val i = part.indexOf('=')
                if (i < 0) formDecode(part) to "" else formDecode(part.substring(0, i)) to formDecode(part.substring(i + 1))
            }
            fun s(k: String) = q[k].orEmpty()
            fun inner(k: String) = decodeURIComponent(s(k))
            return PlayerParams(
                videoId = s("videoId"), title = s("title"), cmd = s("cmd"), series = q["series"] ?: "0",
                seasonId = s("seasonId"), episodeId = s("episodeId"), episodeTitle = s("episodeTitle"),
                year = s("year"), durationMin = s("durationMin").toIntOrNull() ?: 0, isHD = s("isHD") == "true",
                screenshotUrl = inner("screenshotUrl"), description = inner("description"),
                director = inner("director"), actors = inner("actors"),
            )
        }

        // URLSearchParams' form encoding — the same as URLEncoder (space → "+").
        private fun formEncode(s: String): String = URLEncoder.encode(s, "UTF-8")
        private fun formDecode(s: String): String = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)

        // JavaScript's encodeURIComponent: like URLEncoder, but "%20" for space and !'()~ left as they are.
        fun encodeURIComponent(s: String): String = URLEncoder.encode(s, "UTF-8")
            .replace("+", "%20").replace("%21", "!").replace("%27", "'")
            .replace("%28", "(").replace("%29", ")").replace("%7E", "~")

        // decodeURIComponent: "+" is a plus, not a space. An undecodable value stays as it is.
        fun decodeURIComponent(s: String): String =
            runCatching { URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") }.getOrDefault(s)
    }
}
```

- [ ] **Step 5: Push and confirm the tests pass**

```bash
git add android/app/src
git commit -m "feat(android): VOD filters, episode order, request order, player link and watch rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```
Expected: `build-apk` passes. The log lists `VodFiltersTest` (7), `EpisodeNavTest` (5), `RequestOrderTest` (2), `PlayerParamsTest` (3) and `WatchRulesTest` (2), all PASSED, for 51 in total.

---

### Task 2: Watch API and `WatchRepository`

**Files:**
- Create: `data/api/WatchModels.kt`, `data/repo/WatchRepository.kt`
- Modify: `data/api/StalkerApi.kt`, `data/repo/VodRepository.kt`, `data/repo/MediaLinks.kt`, `data/repo/AppContainer.kt`, `data/prefs/AppPrefs.kt`

**Interfaces:**
- Consumes: `RequestOrder` (Task 1), `ApiProvider`, `MediaLinks`, `ViewerRepository.changes`
- Produces:
  - `WatchRepository`:
    - `state: StateFlow<WatchState>`
    - `load()`
    - `saveProgress(SaveWatchRequest)`
    - `removeFromHistory(id)`, `clearHistory()`
    - `toggleMyList(item: VodItem)`, `setCompleted(id, completed)`
    - `isInMyList(id)`, `progressFor(key)`, `watchedIds()`
  - `VodRepository`:
    - `getVodItems(type, category, page, search, sort)`
    - `getListing(type, category, from): ListingResponse`
  - `MediaLinks.relativeImage(url)`
  - `AppPrefs.vodSort`

- [ ] **Step 1: Watch models**

`data/api/WatchModels.kt`:
```kotlin
package com.stalkerweb.android.data.api

import com.squareup.moshi.JsonClass

// What a viewer watched on the VOD pages, per portal — backend viewers/WatchStore.js.
// Every /api/vod/watch call answers with the whole state.

@JsonClass(generateAdapter = false)
data class ProgressEntry(
    val key: String,
    val title: String = "",
    val episodeTitle: String = "",
    val screenshotUrl: String = "",
    val params: String = "",
    val position: Double = 0.0,
    val duration: Double = 0.0,
    val updatedAt: Long = 0,
)

@JsonClass(generateAdapter = false)
data class HistoryEntry(
    val id: String,
    val key: String = "",
    val title: String = "",
    val episodeTitle: String = "",
    val screenshotUrl: String = "",
    val params: String = "",
    val position: Double = 0.0,
    val duration: Double = 0.0,
    val finished: Boolean = false,
    val updatedAt: Long = 0,
)

@JsonClass(generateAdapter = false)
data class ListEntry(
    val id: String,
    val item: VodItem,
    val addedAt: Long = 0,
    val completedAt: Long? = null,
)

@JsonClass(generateAdapter = false)
data class WatchState(
    val progress: List<ProgressEntry> = emptyList(),
    val history: List<HistoryEntry> = emptyList(),
    val watched: List<String> = emptyList(),
    val list: List<ListEntry> = emptyList(),
)

/** A position reached; [lastEpisode]: finishing it completes the show on My List. */
@JsonClass(generateAdapter = false)
data class SaveWatchRequest(
    val key: String,
    val title: String,
    val episodeTitle: String,
    val screenshotUrl: String,
    val params: String,
    val position: Double,
    val duration: Double,
    val lastEpisode: Boolean,
)

@JsonClass(generateAdapter = false)
data class CompletedRequest(val completed: Boolean)

/** A category's whole listing, as read so far (backend routes/vod.js /listing). */
@JsonClass(generateAdapter = false)
data class ListingResponse(
    val items: List<VodItem> = emptyList(),
    val loaded: Int = 0,
    val total: Int = 0,
    val complete: Boolean = false,
    val partial: Boolean = false,
    val error: String? = null,
)
```

- [ ] **Step 2: API routes**

In `StalkerApi.kt`:
- Replace `getVodItems` with:
  ```kotlin
      @GET("api/vod/items")
      suspend fun getVodItems(
          @Query("type") type: String,
          @Query("category") category: String,
          @Query("page") page: Int = 1,
          @Query("search") search: String = "",
          @Query("sort") sort: String = "name",
      ): VodItemsResponse

      @GET("api/vod/listing")
      suspend fun getVodListing(
          @Query("type") type: String,
          @Query("category") category: String,
          @Query("from") from: Int = 0,
      ): ListingResponse
  ```
- Before the `companion object`, add:
  ```kotlin
      // ── What the viewer watched (per viewer and portal) ────────────────────────
      @GET("api/vod/watch")
      suspend fun getWatch(): WatchState

      @PUT("api/vod/watch")
      suspend fun saveWatch(@Body body: SaveWatchRequest): WatchState

      @DELETE("api/vod/watch/history/{id}")
      suspend fun removeWatchTitle(@Path("id") id: String): WatchState

      @DELETE("api/vod/watch/history")
      suspend fun clearWatchHistory(): WatchState

      @PUT("api/vod/watch/list")
      suspend fun addToWatchList(@Body item: VodItem): WatchState

      @DELETE("api/vod/watch/list/{id}")
      suspend fun removeFromWatchList(@Path("id") id: String): WatchState

      @PUT("api/vod/watch/list/{id}/completed")
      suspend fun setWatchListCompleted(@Path("id") id: String, @Body body: CompletedRequest): WatchState
  ```

- [ ] **Step 3: Repositories and prefs**

**`MediaLinks.kt`:** after `absoluteImage`, add:
```kotlin
    /** An image URL as the server's own path — what history and My List store, so the web can show it too. */
    fun relativeImage(url: String?): String {
        if (url.isNullOrBlank()) return ""
        val base = imageBase()
        return if (base.isNotEmpty() && url.startsWith(base)) url.removePrefix(base) else url
    }
```

**`VodRepository.kt`:** replace `getVodItems` and add `getListing`:
```kotlin
    suspend fun getVodItems(type: String, category: String, page: Int, search: String, sort: String = "name"): VodItemsResponse {
        val resp = apis.get().getVodItems(type, category, page, search, sort)
        return resp.copy(items = resp.items.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl)) })
    }

    /** A category's whole listing from [from] on, as read so far (for the filters and an added "All"). */
    suspend fun getListing(type: String, category: String, from: Int): ListingResponse {
        val resp = apis.get().getVodListing(type, category, from)
        return resp.copy(items = resp.items.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl)) })
    }
```
Add `import com.stalkerweb.android.data.api.ListingResponse`.

**`AppPrefs.kt`:**
- After `channelsCacheViewer`, add:
  ```kotlin
      // VOD title order: "name" (A–Z) or "added" (newest first), remembered on this device.
      var vodSort: String
          get() = prefs.getString(KEY_VOD_SORT, null) ?: "name"
          set(value) = prefs.edit().putString(KEY_VOD_SORT, value).apply()
  ```
- Add the key: `private const val KEY_VOD_SORT = "vod_sort"`.

- [ ] **Step 4: `WatchRepository.kt`**

```kotlin
package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.CompletedRequest
import com.stalkerweb.android.data.api.HistoryEntry
import com.stalkerweb.android.data.api.ListEntry
import com.stalkerweb.android.data.api.ProgressEntry
import com.stalkerweb.android.data.api.SaveWatchRequest
import com.stalkerweb.android.data.api.StalkerApi
import com.stalkerweb.android.data.api.VodItem
import com.stalkerweb.android.data.api.WatchState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * What the current viewer has watched — resume points, Recently watched, the
 * titles finished and My List — kept on the server per viewer and portal
 * (backend viewers/WatchStore.js), so it follows them to the web and other
 * devices. Mirrors the web's lib/vodProgress.js: changes show at once, and an
 * answer is used only while it's still current ([RequestOrder]).
 */
class WatchRepository(private val apis: ApiProvider, private val links: MediaLinks, viewers: ViewerRepository) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val order = RequestOrder()
    private val _state = MutableStateFlow(WatchState())
    val state: StateFlow<WatchState> = _state.asStateFlow()

    init {
        // At start and on every viewer switch: the new viewer's, never the last one's.
        scope.launch {
            viewers.changes.collect {
                order.next(local = true)   // answers for the previous viewer are stale now
                _state.value = WatchState()
                load()
            }
        }
    }

    fun load() = request(local = false) { getWatch() }

    fun saveProgress(entry: SaveWatchRequest) = request(local = false) { saveWatch(entry) }

    fun removeFromHistory(id: String) {
        val s = _state.value
        set(s.copy(history = s.history.filter { it.id != id }, progress = s.progress.filter { it.key.substringBefore(':') != id }))
        request(local = true) { removeWatchTitle(id) }
    }

    fun clearHistory() {
        set(_state.value.copy(history = emptyList()))
        request(local = true) { clearWatchHistory() }
    }

    fun isInMyList(id: String): Boolean = _state.value.list.any { it.id == id }

    /** On My List → off it; off it → on it (as a movie or show the web can show too). */
    fun toggleMyList(item: VodItem) {
        val s = _state.value
        if (isInMyList(item.id)) {
            set(s.copy(list = s.list.filter { it.id != item.id }))
            request(local = true) { removeFromWatchList(item.id) }
        } else {
            set(s.copy(list = listOf(ListEntry(item.id, item, System.currentTimeMillis(), null)) + s.list))
            val stored = item.copy(screenshotUrl = links.relativeImage(item.screenshotUrl))
            request(local = true) { addToWatchList(stored) }
        }
    }

    fun setCompleted(id: String, completed: Boolean) {
        val s = _state.value
        set(s.copy(list = s.list.map { if (it.id == id) it.copy(completedAt = if (completed) System.currentTimeMillis() else null) else it }))
        request(local = true) { setWatchListCompleted(id, CompletedRequest(completed)) }
    }

    fun progressFor(key: String): ProgressEntry? = _state.value.progress.firstOrNull { it.key == key }

    /** Ids of titles started or finished — for the "Not watched" filter. */
    fun watchedIds(): Set<String> = _state.value.let { s ->
        s.watched.toSet() + s.history.map(HistoryEntry::id) + s.progress.map { it.key.substringBefore(':') }
    }

    private fun set(next: WatchState) { _state.value = next }

    // A request whose answer (the whole state) replaces what's here when still current;
    // a failed change reloads, undoing what was shown.
    private fun request(local: Boolean, call: suspend StalkerApi.() -> WatchState) {
        val n = order.next(local)
        scope.launch {
            runCatching { apis.get().call() }
                .onSuccess { if (order.accept(n)) _state.value = it.withImages() }
                .onFailure { if (local) load() }
        }
    }

    // Images are stored as the server's own paths; shown, they need its address.
    private fun WatchState.withImages() = copy(
        progress = progress.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl).orEmpty()) },
        history = history.map { it.copy(screenshotUrl = links.absoluteImage(it.screenshotUrl).orEmpty()) },
        list = list.map { it.copy(item = it.item.copy(screenshotUrl = links.absoluteImage(it.item.screenshotUrl))) },
    )
}
```

**`AppContainer.kt`:**
- Make `links` non-private, then add after `vod`:
  ```kotlin
      val watch = WatchRepository(apis, links, viewers)
  ```
  so the declaration reads `val links = MediaLinks(prefs, apis)`.

- [ ] **Step 5: Push and confirm CI**

```bash
git add android/app/src
git commit -m "feat(android): watch state per viewer (history, resume points, My List) and whole-category listings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```
Expected: `build-apk` passes, 51 tests.

---

### Task 3: `PosterTile` — long-press bookmark, progress and Watched badge

**Files:** Modify `ui/components/PosterTile.kt`

**Interfaces:**
- Produces:
  ```kotlin
  PosterTile(title, year, posterUrl, isHD, onClick, modifier,
             bookmarked: Boolean? = null, onBookmark: (() -> Unit)? = null,
             onDownload: (() -> Unit)? = null, progress: Float? = null, watched: Boolean = false)
  ```
  Long-press, which is the remote's held OK, calls `onBookmark`.

- [ ] **Step 1: Long-press and the badges**
  - Change the column's `.clickable(onClick = onClick)` to `.combinedClickable(onClick = onClick, onLongClick = onBookmark)`.
  - Add the `@OptIn(ExperimentalFoundationApi::class)` annotation, with imports `androidx.compose.foundation.ExperimentalFoundationApi` and `androidx.compose.foundation.combinedClickable`.
  - Add the parameters `progress: Float? = null, watched: Boolean = false`.
  - Inside the poster `Box`, after the HD badge, add:
    ```kotlin
            if (watched) {
                Row(
                    Modifier.align(Alignment.TopStart).padding(4.dp)
                        .background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Icon(Icons.Default.Check, null, Modifier.size(10.dp), tint = Color.White)
                    Text("Watched", style = MaterialTheme.typography.labelSmall, color = Color.White)
                }
            } else if (progress != null && progress > 0f) {
                Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(4.dp).background(Color.Black.copy(alpha = 0.5f))) {
                    Box(Modifier.fillMaxWidth(progress.coerceIn(0f, 1f)).fillMaxSize().background(SwColors.PrimaryLight))
                }
            }
    ```
  - Add the imports `Row`, `Arrangement`, `height`, `Icons.Default.Check`.
  - Update the KDoc: "Long-press (the remote's held OK) toggles My List, so the remote reaches it — the corner bookmark is for touch."

- [ ] **Step 2: Push and confirm CI**

```bash
git add android/app/src
git commit -m "feat(android): poster tiles — long-press for My List, progress bar, Watched badge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```
Expected: `build-apk` passes.

---

### Task 4: `VodViewModel` and `VodScreen`, rewritten to the web's layout

**Files:**
- Rewrite: `ui/vod/VodViewModel.kt`, `ui/vod/VodScreen.kt`
- Modify: `MainActivity.kt` (factory and callbacks)

**Interfaces:**
- Consumes:
  - `VodRepository.getVodCategories`, `getVodItems`, `getListing`, `getVodSeasons`, `getVodEpisodes`
  - `WatchRepository`, `ViewerRepository.changes`, `AppPrefs.vodSort`
  - `applyVodFilters`, `sortVodItems`, `filterOptions`, `PlayerParams`
- Produces:
  - `VodViewModel(vod, watch, viewers, prefs)`
  - `VodScreen(viewModel, watch, onPlay: (PlayerParams) -> Unit)`

The code for both files is in the appendix at the end of this plan ("Appendix A: VodViewModel.kt" and "Appendix B: VodScreen.kt"). Copy each in full.

- [ ] **Step 1: Write `VodViewModel.kt`** from Appendix A.

- [ ] **Step 2: Write `VodScreen.kt`** from Appendix B.

- [ ] **Step 3: Wire it in `MainActivity`**
  - The factory becomes `VodViewModel(container.vod, container.watch, container.viewers, container.prefs)`.
  - Replace the `vod = { VodScreen(…) }` block with:
    ```kotlin
            vod = {
                VodScreen(
                    viewModel = vodViewModel,
                    watch = container.watch,
                    onPlay = { params -> navController.navigate(Screen.VodPlayer.go(params)) },
                )
            },
    ```
  - Task 5 changes `Screen.VodPlayer.go` to take a `PlayerParams`. Until then, push Tasks 4 and 5 together.

- [ ] **Step 4: Commit** (pushed with Task 5)

```bash
git add android/app/src
git commit -m "feat(android): VOD screen like the web — My List, Recently watched, filters, sort, All

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: VOD player — params, resume, progress, episodes, up next, My List

**Files:**
- Rewrite: `ui/vod/VodPlayerViewModel.kt`, `ui/vod/VodPlayerScreen.kt`
- Modify: `AppNavigation.kt`, `MainActivity.kt`

**Interfaces:**
- Consumes:
  - `PlayerParams`, `WatchRules`, `episodeNeighbours`, `isLastEpisode`
  - `WatchRepository`, `VodRepository`, `MediaLinks.relativeImage`
- Produces:
  - `VodPlayerViewModel(application, vod, watch, links)`
  - `VodPlayerScreen(params: PlayerParams, viewModel, onBack)`
  - `Screen.VodPlayer`: route `"vodplayer?params={params}"`, `go(params: PlayerParams)`

- [ ] **Step 1: Route**

In `AppNavigation.kt`, replace `object VodPlayer … { … }` with:
```kotlin
    object VodPlayer : Screen("vodplayer?params={params}") {
        fun go(params: com.stalkerweb.android.data.repo.PlayerParams): String =
            "vodplayer?params=${Uri.encode(params.toQuery())}"
    }
```

- [ ] **Step 2: Write `VodPlayerViewModel.kt`** from Appendix C.

- [ ] **Step 3: Write `VodPlayerScreen.kt`** from Appendix D.

- [ ] **Step 4: `MainActivity`**
  - The VodPlayer factory becomes `VodPlayerViewModel(application, container.vod, container.watch, container.links)`.
  - Replace the `composable(route = Screen.VodPlayer.route, arguments = …) { … }` block with:
    ```kotlin
            composable(
                route = Screen.VodPlayer.route,
                arguments = listOf(navArgument("params") { type = NavType.StringType; defaultValue = "" }),
            ) { backStack ->
                // Scoped to this destination so each opened title gets a fresh VM.
                val vodPlayerViewModel: VodPlayerViewModel = viewModel(factory = vodPlayerVmFactory)
                VodPlayerScreen(
                    params    = PlayerParams.parse(backStack.arguments?.getString("params") ?: ""),
                    viewModel = vodPlayerViewModel,
                    onBack    = { navController.popBackStack() },
                )
            }
    ```
  - Add `import com.stalkerweb.android.data.repo.PlayerParams`.

- [ ] **Step 5: Push Tasks 4 and 5, and confirm CI**

```bash
git add -A android
git commit -m "feat(android): VOD player — resume, shared progress, episodes, Previous/Next, up next, My List

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```
Expected: all checks pass and 51 tests are PASSED. On a compile error, read the failed log, fix the named lines, and push again.

---

## Appendix A: `ui/vod/VodViewModel.kt`

```kotlin
package com.stalkerweb.android.ui.vod

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.stalkerweb.android.data.api.VodCategory
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodItem
import com.stalkerweb.android.data.api.VodSeason
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.prefs.AppPrefs
import com.stalkerweb.android.data.repo.VodFilterState
import com.stalkerweb.android.data.repo.VodRepository
import com.stalkerweb.android.data.repo.ViewerRepository
import com.stalkerweb.android.data.repo.WatchRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

/** My List, shown as the first category (its titles come from the watch state, not the portal). */
val MY_LIST = VodCategory(id = "mylist", title = "My List")

/** The "All" the server adds when the portal's own can't be shown (backend routes/vod.js). */
private val COMBINED_ALL_IDS = setOf("movies:all", "series:all")

const val SHOW_STEP = 140

/** A category's whole listing, read a part at a time (/api/vod/listing). */
data class ListingState(
    val items: List<VodItem> = emptyList(),
    val loaded: Int = 0,
    val total: Int = 0,
    val complete: Boolean = false,
    val error: String? = null,
)

data class VodUiState(
    val type: String = "vod",                 // "vod" (Movies) | "series"
    val categories: List<VodCategory> = emptyList(),
    val selected: VodCategory? = null,
    val items: List<VodItem> = emptyList(),   // paged mode
    val page: Int = 1,
    val totalPages: Int = 1,
    val loadingCategories: Boolean = false,
    val loadingItems: Boolean = false,
    val error: String? = null,
    val search: String = "",
    val filters: VodFilterState = VodFilterState(),
    val sort: String = "name",
    val listing: ListingState = ListingState(),
    val visibleCount: Int = SHOW_STEP,
    // The seasons pop-up
    val seriesItem: VodItem? = null,
    val seasons: List<VodSeason>? = null,
    val selectedSeason: VodSeason? = null,
    val episodes: List<VodEpisode>? = null,
    val seriesLoading: Boolean = false,
) {
    val isMyList: Boolean get() = selected?.id == MY_LIST.id
    val isCombinedAll: Boolean get() = selected?.id in COMBINED_ALL_IDS
    /** The portal's own "All": the whole catalog, so it's never read whole to filter. */
    val isPortalAll: Boolean get() = selected != null && !isCombinedAll &&
        (selected.id == "*" || selected.title.trim().equals("all", ignoreCase = true))
    /** Whole-listing mode: a filter is on (not in the portal's "All"), or an added "All". */
    val filtering: Boolean get() = !isMyList && selected != null &&
        ((filters.isActive && !isPortalAll) || isCombinedAll)
    val hasMore: Boolean get() = page < totalPages
}

/**
 * The VOD page, as on the web (frontend/src/pages/VodPage.jsx): Movies and
 * Series; My List and the categories; paged titles from the portal, or — for a
 * filter or an added "All" — the whole category, filtered and sorted here.
 */
class VodViewModel(
    private val vod: VodRepository,
    private val watch: WatchRepository,
    private val viewers: ViewerRepository,
    private val prefs: AppPrefs,
) : ViewModel() {

    private val _state = MutableStateFlow(VodUiState(sort = prefs.vodSort))
    val state: StateFlow<VodUiState> = _state.asStateFlow()

    private var itemsJob: Job? = null
    private var searchJob: Job? = null
    private var listingJob: Job? = null

    init {
        // Another viewer: start again (their hidden categories differ).
        viewModelScope.launch {
            viewers.changes.drop(1).collect {
                _state.value = VodUiState(type = _state.value.type, sort = _state.value.sort)
                loadCategories()
            }
        }
    }

    fun setType(type: String) {
        if (type == _state.value.type) return
        _state.value = VodUiState(type = type, sort = _state.value.sort, search = _state.value.search)
        loadCategories()
    }

    fun loadCategories() {
        _state.value = _state.value.copy(loadingCategories = true, error = null)
        viewModelScope.launch {
            val cats = runCatching { vod.getVodCategories(_state.value.type) }.getOrDefault(emptyList())
            _state.value = _state.value.copy(categories = cats, loadingCategories = false)
            // The portal's "All" opens first; never an added one (it reads every category in full).
            val real = cats.filter { it.id !in COMBINED_ALL_IDS }
            val first = real.firstOrNull { it.id == "*" } ?: real.firstOrNull { it.title.trim().equals("all", true) } ?: real.firstOrNull() ?: cats.firstOrNull()
            first?.let(::selectCategory)
        }
    }

    fun selectCategory(cat: VodCategory) {
        _state.value = _state.value.copy(selected = cat, items = emptyList(), page = 1, totalPages = 1,
            listing = ListingState(), visibleCount = SHOW_STEP, error = null)
        refresh()
    }

    /** The search is kept across categories; paged mode asks the portal after a pause, a listing filters at once. */
    fun setSearch(q: String) {
        _state.value = _state.value.copy(search = q, visibleCount = SHOW_STEP)
        searchJob?.cancel()
        if (_state.value.filtering || _state.value.isMyList) return
        searchJob = viewModelScope.launch {
            delay(400)
            loadItems(page = 1)
        }
    }

    fun setFilters(f: VodFilterState) {
        val wasFiltering = _state.value.filtering
        _state.value = _state.value.copy(filters = f, visibleCount = SHOW_STEP)
        if (wasFiltering != _state.value.filtering) refresh()
    }

    fun setSort(sort: String) {
        if (sort == _state.value.sort) return
        prefs.vodSort = sort
        _state.value = _state.value.copy(sort = sort, visibleCount = SHOW_STEP)
        if (!_state.value.filtering && !_state.value.isMyList) loadItems(page = 1)
    }

    fun showMore() { _state.value = _state.value.copy(visibleCount = _state.value.visibleCount + SHOW_STEP) }

    fun loadMore() {
        val s = _state.value
        if (s.filtering || s.isMyList) { showMore(); return }
        if (s.hasMore && !s.loadingItems) loadItems(page = s.page + 1)
    }

    // Paged titles, or the whole listing, for what's selected now.
    private fun refresh() {
        itemsJob?.cancel(); listingJob?.cancel()
        val s = _state.value
        when {
            s.isMyList || s.selected == null -> Unit
            s.filtering -> startListing()
            else -> loadItems(page = 1)
        }
    }

    private fun loadItems(page: Int) {
        val s = _state.value
        val cat = s.selected ?: return
        if (s.isMyList || s.isCombinedAll) return
        itemsJob?.cancel()
        _state.value = s.copy(loadingItems = true, error = null, items = if (page == 1) emptyList() else s.items)
        itemsJob = viewModelScope.launch {
            runCatching { vod.getVodItems(s.type, cat.id, page, s.search.trim(), s.sort) }
                .onSuccess { r ->
                    val cur = _state.value
                    _state.value = cur.copy(
                        items = if (page == 1) r.items else (cur.items + r.items).distinctBy { it.id },
                        page = page, totalPages = r.totalPages, loadingItems = false,
                    )
                }
                .onFailure { e ->
                    if (e is CancellationException) throw e
                    _state.value = _state.value.copy(loadingItems = false, error = e.toApiError().message)
                }
        }
    }

    // Reads the whole category a part at a time until it's complete (web useCategoryListing).
    private fun startListing() {
        val s = _state.value
        val cat = s.selected ?: return
        listingJob?.cancel()
        _state.value = s.copy(listing = ListingState())
        listingJob = viewModelScope.launch {
            while (true) {
                val have = _state.value.listing.items
                val r = runCatching { vod.getListing(s.type, cat.id, have.size) }.getOrElse { e ->
                    if (e is CancellationException) throw e
                    _state.value = _state.value.copy(listing = _state.value.listing.copy(error = e.toApiError().message, complete = true))
                    return@launch
                }
                _state.value = _state.value.copy(listing = ListingState(have + r.items, r.loaded, r.total, r.complete, r.error))
                if (r.complete || r.error != null) return@launch
                delay(1200)
            }
        }
    }

    // ── The seasons pop-up ────────────────────────────────────────────────────

    fun openSeries(item: VodItem) {
        _state.value = _state.value.copy(seriesItem = item, seasons = null, selectedSeason = null, episodes = null, seriesLoading = true)
        viewModelScope.launch {
            val seasons = vod.getVodSeasons(item.id)
            _state.value = _state.value.copy(seasons = seasons, seriesLoading = false)
        }
    }

    fun openSeason(season: VodSeason) {
        val show = _state.value.seriesItem ?: return
        _state.value = _state.value.copy(selectedSeason = season, episodes = null, seriesLoading = true)
        viewModelScope.launch {
            val eps = vod.getVodEpisodes(show.id, season.id)
            _state.value = _state.value.copy(episodes = eps, seriesLoading = false)
        }
    }

    fun backToSeasons() { _state.value = _state.value.copy(selectedSeason = null, episodes = null) }

    fun closeSeries() { _state.value = _state.value.copy(seriesItem = null, seasons = null, selectedSeason = null, episodes = null) }

    fun toggleMyList(item: VodItem) = watch.toggleMyList(item)
}
```

## Appendix B: `ui/vod/VodScreen.kt`

```kotlin
package com.stalkerweb.android.ui.vod

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.stalkerweb.android.data.api.HistoryEntry
import com.stalkerweb.android.data.api.ListEntry
import com.stalkerweb.android.data.api.VodCategory
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodItem
import com.stalkerweb.android.data.api.VodSeason
import com.stalkerweb.android.data.repo.PlayerParams
import com.stalkerweb.android.data.repo.VodFilterState
import com.stalkerweb.android.data.repo.WatchRepository
import com.stalkerweb.android.data.repo.applyVodFilters
import com.stalkerweb.android.data.repo.filterOptions
import com.stalkerweb.android.data.repo.sortVodItems
import com.stalkerweb.android.ui.components.EmptyState
import com.stalkerweb.android.ui.components.Pill
import com.stalkerweb.android.ui.components.PosterTile
import com.stalkerweb.android.ui.components.SectionHeader
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV

/**
 * The VOD page, laid out as on the web: Movies / Series; My List and the
 * categories (a column on wide screens and TV, a pill row on phones); search,
 * filters and sort; Recently watched and My List rows above the titles.
 */
@Composable
fun VodScreen(viewModel: VodViewModel, watch: WatchRepository, onPlay: (PlayerParams) -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val watchState by watch.state.collectAsStateWithLifecycle()
    val isTV = rememberIsTV()
    val wide = isTV || LocalConfiguration.current.screenWidthDp >= 600
    val firstCategory = remember { FocusRequester() }

    LaunchedEffect(Unit) { if (state.categories.isEmpty()) viewModel.loadCategories() }
    LaunchedEffect(state.loadingCategories, isTV) {
        if (isTV && !state.loadingCategories && state.categories.isNotEmpty()) runCatching { firstCategory.requestFocus() }
    }

    val isSeries = state.type == "series"
    val watched = remember(watchState) { watch.watchedIds() }
    val myListIds = remember(watchState) { watchState.list.map { it.id }.toSet() }
    // This tab's My List and history: movies, or shows.
    val tabList = remember(watchState, isSeries) { watchState.list.filter { it.item.isSeries == isSeries } }
    val tabHistory = remember(watchState, isSeries) {
        watchState.history.filter { PlayerParams.parse(it.params).isEpisode == isSeries }
    }

    // The titles shown: the whole listing filtered here, or the portal's page.
    val filtered = remember(state.listing, state.filters, state.search, state.sort, watched, state.filtering) {
        if (!state.filtering) emptyList()
        else sortVodItems(applyVodFilters(state.listing.items, state.filters, watched, state.search), state.sort)
    }
    val shown = if (state.filtering) filtered.take(state.visibleCount) else state.items
    val options = remember(state.isMyList, tabList, state.filtering, state.listing.items, state.items) {
        filterOptions(when {
            state.isMyList -> tabList.map { it.item }
            state.filtering -> state.listing.items
            else -> state.items
        })
    }

    fun open(item: VodItem) {
        if (item.isSeries || item.episodes.isNotEmpty()) viewModel.openSeries(item)
        else onPlay(paramsFor(item))
    }
    fun openHistory(entry: HistoryEntry) {
        val p = PlayerParams.parse(entry.params)
        // A finished show opens its seasons; anything else resumes (or plays again).
        if (entry.finished && p.isEpisode) viewModel.openSeries(itemFrom(p, entry.screenshotUrl)) else onPlay(p)
    }

    Column(Modifier.fillMaxSize()) {
        // Movies / Series
        TabRow(selectedTabIndex = if (isSeries) 1 else 0, containerColor = SwColors.Bg) {
            Tab(selected = !isSeries, onClick = { viewModel.setType("vod") }, text = { Text("Movies") })
            Tab(selected = isSeries, onClick = { viewModel.setType("series") }, text = { Text("Series") })
        }
        // Search · count · sort
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = state.search,
                onValueChange = viewModel::setSearch,
                placeholder = { Text(if (state.isMyList) "Search in My List…" else "Search…") },
                leadingIcon = { Icon(Icons.Default.Search, null, Modifier.size(18.dp)) },
                trailingIcon = if (state.search.isNotEmpty()) ({ IconButton(onClick = { viewModel.setSearch("") }) { Icon(Icons.Default.Close, "Clear") } }) else null,
                singleLine = true,
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.weight(1f),
            )
            Pill("A–Z", state.sort == "name", { viewModel.setSort("name") })
            Pill("Newest", state.sort == "added", { viewModel.setSort("added") })
        }
        FilterBar(state.filters, options, viewModel::setFilters)

        if (wide) {
            Row(Modifier.fillMaxSize()) {
                CategoryColumn(state, tabList.count { it.completedAt == null }, firstCategory, viewModel::selectCategory)
                Box(Modifier.width(1.dp).fillMaxHeight().background(SwColors.Border))
                Content(state, shown, filtered.size, tabHistory, tabList, myListIds, watchState.progress.associateBy { it.key },
                    viewModel, watch, ::open, ::openHistory, onPlay)
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                LazyRow(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(listOf(MY_LIST) + state.categories, key = { it.id }) { cat ->
                        Pill(cat.title, cat.id == state.selected?.id, { viewModel.selectCategory(cat) },
                            leading = if (cat.id == MY_LIST.id) Icons.Default.Bookmark else null)
                    }
                }
                Content(state, shown, filtered.size, tabHistory, tabList, myListIds, watchState.progress.associateBy { it.key },
                    viewModel, watch, ::open, ::openHistory, onPlay)
            }
        }
    }

    state.seriesItem?.let { show ->
        SeriesDialog(
            show = show,
            seasons = state.seasons,
            selectedSeason = state.selectedSeason,
            episodes = state.episodes,
            loading = state.seriesLoading,
            inMyList = show.id in myListIds,
            onToggleMyList = { viewModel.toggleMyList(show) },
            onOpenSeason = viewModel::openSeason,
            onBackSeasons = viewModel::backToSeasons,
            onClose = viewModel::closeSeries,
            onPlay = { season, ep ->
                viewModel.closeSeries()
                onPlay(paramsFor(show).copy(
                    series = ep.seriesNumber.ifBlank { "0" }, seasonId = season.id, episodeId = ep.episodeId,
                    episodeTitle = ep.name.ifBlank { "Episode ${ep.seriesNumber}" },
                ))
            },
        )
    }
}

/** A movie or show as the player's link (posters stored relative by the player when it saves). */
private fun paramsFor(item: VodItem) = PlayerParams(
    videoId = item.id, title = item.name, cmd = item.cmd, year = item.year, durationMin = item.durationMin,
    isHD = item.isHD, screenshotUrl = item.screenshotUrl.orEmpty(), description = item.description,
    director = item.director, actors = item.actors,
)

/** A history entry's show, rebuilt from its player link — to open its seasons again. */
private fun itemFrom(p: PlayerParams, screenshotUrl: String) = VodItem(
    id = p.videoId, name = p.title, cmd = p.cmd, year = p.year, durationMin = p.durationMin, isHD = p.isHD,
    screenshotUrl = screenshotUrl.ifEmpty { p.screenshotUrl }, description = p.description, director = p.director,
    actors = p.actors, isSeries = true,
)

@Composable
private fun CategoryColumn(state: VodUiState, myListCount: Int, firstFocus: FocusRequester, onSelect: (VodCategory) -> Unit) {
    LazyColumn(Modifier.width(220.dp).fillMaxHeight().padding(vertical = 4.dp)) {
        val all = listOf(MY_LIST) + state.categories
        items(all, key = { it.id }) { cat ->
            val sel = cat.id == state.selected?.id
            Row(
                Modifier.fillMaxWidth()
                    .then(if (cat.id == MY_LIST.id) Modifier.focusRequester(firstFocus) else Modifier)
                    .tvFocus(RoundedCornerShape(8.dp))
                    .background(if (sel) SwColors.Surface2 else SwColors.Bg)
                    .clickable { onSelect(cat) }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (cat.id == MY_LIST.id) Icon(Icons.Default.Bookmark, null, Modifier.size(14.dp), tint = SwColors.Text)
                Text(cat.title, style = MaterialTheme.typography.bodySmall, color = if (sel) SwColors.PrimaryLight else SwColors.Text,
                    maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (cat.id == MY_LIST.id && myListCount > 0) Text(myListCount.toString(), style = MaterialTheme.typography.labelSmall, color = SwColors.Muted)
            }
        }
        if (state.loadingCategories) item { CircularProgressIndicator(Modifier.padding(16.dp).size(20.dp)) }
    }
}

/** The filter bar: a choice menu per filter the titles allow, and HD / Not watched toggles. */
@Composable
private fun FilterBar(f: VodFilterState, o: com.stalkerweb.android.data.repo.FilterOptions, onChange: (VodFilterState) -> Unit) {
    LazyRow(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (o.years.isNotEmpty()) item { ChoicePill("Any year", f.year, o.years.map { it to it }) { onChange(f.copy(year = it)) } }
        item {
            ChoicePill("Any time", if (f.addedDays > 0) f.addedDays.toString() else "",
                listOf("7" to "Last 7 days", "30" to "Last 30 days", "90" to "Last 90 days")) { onChange(f.copy(addedDays = it.toIntOrNull() ?: 0)) }
        }
        if (o.genres.isNotEmpty()) item { ChoicePill("Any genre", f.genre, o.genres.map { it to it }) { onChange(f.copy(genre = it)) } }
        if (o.hasRating) item {
            ChoicePill("Any rating", if (f.minRating > 0) f.minRating.toInt().toString() else "",
                listOf("6" to "6+", "7" to "7+", "8" to "8+")) { onChange(f.copy(minRating = it.toDoubleOrNull() ?: 0.0)) }
        }
        if (o.hasHD) item { Pill("HD", f.hd, { onChange(f.copy(hd = !f.hd)) }) }
        item { Pill("Not watched", f.unwatched, { onChange(f.copy(unwatched = !f.unwatched)) }) }
        if (f.isActive) item { Pill("Clear", false, { onChange(VodFilterState()) }, leading = Icons.Default.Close) }
    }
}

/** A pill opening a menu: [any] when nothing is chosen, else the chosen label; "" clears. */
@Composable
private fun ChoicePill(any: String, value: String, choices: List<Pair<String, String>>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Pill(choices.firstOrNull { it.first == value }?.second ?: any, value.isNotEmpty(), { open = true })
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text(any) }, onClick = { open = false; onPick("") })
            choices.forEach { (v, label) -> DropdownMenuItem(text = { Text(label) }, onClick = { open = false; onPick(v) }) }
        }
    }
}

@Composable
private fun Content(
    state: VodUiState,
    shown: List<VodItem>,
    matchCount: Int,
    history: List<HistoryEntry>,
    tabList: List<ListEntry>,
    myListIds: Set<String>,
    progress: Map<String, com.stalkerweb.android.data.api.ProgressEntry>,
    viewModel: VodViewModel,
    watch: WatchRepository,
    open: (VodItem) -> Unit,
    openHistory: (HistoryEntry) -> Unit,
    onPlay: (PlayerParams) -> Unit,
) {
    val isTV = rememberIsTV()
    val gridState = rememberLazyGridState()
    val nearEnd by remember { derivedStateOf {
        val last = gridState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
        last >= gridState.layoutInfo.totalItemsCount - 6
    } }
    LaunchedEffect(nearEnd, state.page, state.visibleCount) { if (nearEnd && !state.isMyList) viewModel.loadMore() }
    val browsing = !state.isMyList && !state.filters.isActive && state.search.isBlank()

    LazyVerticalGrid(
        state = gridState,
        columns = GridCells.Adaptive(if (isTV) 180.dp else 140.dp),
        contentPadding = PaddingValues(12.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        if (browsing && history.isNotEmpty()) {
            full { HistoryRow(history, progress, openHistory, watch) }
        }
        if (browsing) {
            val toWatch = tabList.filter { it.completedAt == null }
            if (toWatch.isNotEmpty()) full { MyListRow(toWatch, myListIds, open, viewModel::toggleMyList) { viewModel.selectCategory(MY_LIST) } }
        }

        when {
            state.isMyList -> myListSection(state, tabList, myListIds, open, viewModel, watch)
            else -> {
                if (state.filtering) full {
                    val l = state.listing
                    Text(
                        when {
                            l.error != null -> l.error
                            !l.complete -> "Reading titles… ${l.loaded}${if (l.total > 0) " of ${l.total}" else ""}"
                            else -> "$matchCount of ${l.loaded} titles"
                        },
                        style = MaterialTheme.typography.labelMedium,
                        color = if (l.error != null) SwColors.Live else SwColors.Muted,
                    )
                }
                items(shown, key = { it.id }) { item ->
                    PosterTile(
                        title = item.name, year = item.year, posterUrl = item.screenshotUrl, isHD = item.isHD,
                        onClick = { open(item) },
                        bookmarked = item.id in myListIds, onBookmark = { viewModel.toggleMyList(item) },
                    )
                }
                if (shown.isEmpty()) full {
                    when {
                        state.error != null -> Text(state.error, color = SwColors.Live)
                        state.loadingItems || (state.filtering && !state.listing.complete) -> Box(Modifier.fillMaxWidth().padding(32.dp), Alignment.Center) { CircularProgressIndicator() }
                        state.selected != null -> EmptyState(Icons.Default.Movie, if (state.filters.isActive || state.search.isNotBlank()) "No titles match." else "No titles in this category.")
                    }
                }
                if (state.loadingItems && shown.isNotEmpty()) full { Box(Modifier.fillMaxWidth().padding(16.dp), Alignment.Center) { CircularProgressIndicator(Modifier.size(22.dp)) } }
            }
        }
    }
}

private fun LazyGridScope.full(content: @Composable () -> Unit) = item(span = { GridItemSpan(maxLineSpan) }) { content() }

@Composable
private fun HistoryRow(entries: List<HistoryEntry>, progress: Map<String, com.stalkerweb.android.data.api.ProgressEntry>,
                       onOpen: (HistoryEntry) -> Unit, watch: WatchRepository) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionHeader(Icons.Default.History, "Recently watched", entries.size)
            TextButton(onClick = { watch.clearHistory() }) { Text("Clear", color = SwColors.Muted) }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp), contentPadding = PaddingValues(vertical = 4.dp, horizontal = 2.dp)) {
            items(entries, key = { it.id }) { e ->
                val p = progress[e.key]
                val frac = if (!e.finished && e.duration > 0) ((p?.position ?: e.position) / e.duration).toFloat() else null
                Box(Modifier.width(150.dp)) {
                    PosterTile(
                        title = e.title, year = e.episodeTitle, posterUrl = e.screenshotUrl.ifEmpty { null }, isHD = false,
                        onClick = { onOpen(e) }, progress = frac, watched = e.finished,
                    )
                    IconButton(onClick = { watch.removeFromHistory(e.id) }, modifier = Modifier.align(Alignment.TopEnd).size(32.dp)) {
                        Icon(Icons.Default.Close, "Remove ${e.title} from Recently watched", Modifier.size(16.dp), tint = SwColors.Muted)
                    }
                }
            }
        }
    }
}

@Composable
private fun MyListRow(entries: List<ListEntry>, myListIds: Set<String>, onOpen: (VodItem) -> Unit, onToggle: (VodItem) -> Unit, onSeeAll: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionHeader(Icons.Default.Bookmark, "My List", entries.size)
            TextButton(onClick = onSeeAll) { Text("See all", color = SwColors.Muted) }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp), contentPadding = PaddingValues(vertical = 4.dp, horizontal = 2.dp)) {
            items(entries, key = { it.id }) { e ->
                Box(Modifier.width(150.dp)) {
                    PosterTile(e.item.name, e.item.year, e.item.screenshotUrl, e.item.isHD, { onOpen(e.item) },
                        bookmarked = e.id in myListIds, onBookmark = { onToggle(e.item) })
                }
            }
        }
    }
}

/** My List as a category: To watch, then Completed — searched, filtered and sorted ("Newest" = added last). */
private fun LazyGridScope.myListSection(
    state: VodUiState, tabList: List<ListEntry>, myListIds: Set<String>, open: (VodItem) -> Unit, viewModel: VodViewModel, watch: WatchRepository,
) {
    if (tabList.isEmpty()) {
        full { EmptyState(Icons.Default.BookmarkBorder, "No ${if (state.type == "series") "shows" else "movies"} on My List yet.", "Long-press (or hold OK on) any title to save it for later.") }
        return
    }
    fun section(done: Boolean): List<ListEntry> {
        val entries = tabList.filter { (it.completedAt != null) == done }
        val kept = applyVodFilters(entries.map { it.item }, state.filters, watch.watchedIds(), state.search).map { it.id }.toSet()
        val shown = entries.filter { it.id in kept }
        return if (state.sort == "added") shown else sortVodItems(shown.map { it.item }, "name").mapNotNull { i -> shown.firstOrNull { it.id == i.id } }
    }
    val toWatch = section(false)
    val completed = section(true)
    full { SectionHeader(Icons.Default.Bookmark, "To watch", toWatch.size) }
    if (toWatch.isEmpty()) full { Text(if (completed.isNotEmpty()) "Nothing here — all watched." else "Nothing here.", color = SwColors.Muted) }
    items(toWatch, key = { "w" + it.id }) { e -> ListTile(e, false, myListIds, open, viewModel, watch) }
    if (completed.isNotEmpty()) {
        full { SectionHeader(Icons.Default.Check, "Completed", completed.size) }
        items(completed, key = { "c" + it.id }) { e -> ListTile(e, true, myListIds, open, viewModel, watch) }
    }
}

@Composable
private fun ListTile(e: ListEntry, done: Boolean, myListIds: Set<String>, open: (VodItem) -> Unit, viewModel: VodViewModel, watch: WatchRepository) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        PosterTile(e.item.name, e.item.year, e.item.screenshotUrl, e.item.isHD, { open(e.item) },
            bookmarked = e.id in myListIds, onBookmark = { viewModel.toggleMyList(e.item) })
        TextButton(onClick = { watch.setCompleted(e.id, !done) }, modifier = Modifier.tvFocus(RoundedCornerShape(8.dp))) {
            Icon(if (done) Icons.Default.Replay else Icons.Default.Check, null, Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text(if (done) "Back to To watch" else "Mark completed", style = MaterialTheme.typography.labelSmall)
        }
    }
}

/** A show's seasons and episodes (in order), with My List; a full dialog on TV and phones alike. */
@Composable
private fun SeriesDialog(
    show: VodItem, seasons: List<VodSeason>?, selectedSeason: VodSeason?, episodes: List<VodEpisode>?, loading: Boolean,
    inMyList: Boolean, onToggleMyList: () -> Unit, onOpenSeason: (VodSeason) -> Unit, onBackSeasons: () -> Unit,
    onClose: () -> Unit, onPlay: (VodSeason, VodEpisode) -> Unit,
) {
    val firstFocus = remember { FocusRequester() }
    Dialog(onDismissRequest = { if (selectedSeason != null) onBackSeasons() else onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(color = SwColors.Surface, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth(0.92f).fillMaxHeight(0.85f)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (selectedSeason != null) IconButton(onClick = onBackSeasons) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Seasons") }
                    Text(selectedSeason?.let { "${show.name} · ${it.name.ifBlank { "Season ${it.seasonNumber}" }}" } ?: show.name,
                        style = MaterialTheme.typography.titleMedium, color = SwColors.Text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Pill(if (inMyList) "On My List" else "My List", inMyList, onToggleMyList, leading = if (inMyList) Icons.Default.Bookmark else Icons.Default.BookmarkBorder)
                    IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close") }
                }
                HorizontalDivider(color = SwColors.Border)
                when {
                    loading -> Box(Modifier.fillMaxWidth().padding(32.dp), Alignment.Center) { CircularProgressIndicator() }
                    selectedSeason == null -> LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        val list = seasons.orEmpty()
                        if (list.isEmpty()) item { Text("No seasons found.", color = SwColors.Muted) }
                        items(list, key = { it.id }) { s ->
                            Row(
                                Modifier.fillMaxWidth()
                                    .then(if (s.id == list.first().id) Modifier.focusRequester(firstFocus) else Modifier)
                                    .tvFocus(RoundedCornerShape(8.dp)).clickable { onOpenSeason(s) }.padding(12.dp),
                            ) { Text(s.name.ifBlank { "Season ${s.seasonNumber}" }, color = SwColors.Text) }
                        }
                    }
                    else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        val list = episodes.orEmpty()
                        if (list.isEmpty()) item { Text("No episodes found.", color = SwColors.Muted) }
                        items(list, key = { it.episodeId }) { ep ->
                            Row(
                                Modifier.fillMaxWidth()
                                    .then(if (ep.episodeId == list.first().episodeId) Modifier.focusRequester(firstFocus) else Modifier)
                                    .tvFocus(RoundedCornerShape(8.dp)).clickable { onPlay(selectedSeason, ep) }.padding(12.dp),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                Text(ep.seriesNumber, color = SwColors.Muted, modifier = Modifier.width(32.dp))
                                Text(ep.name.ifBlank { "Episode ${ep.seriesNumber}" }, color = SwColors.Text)
                            }
                        }
                    }
                }
            }
        }
    }
    LaunchedEffect(seasons, episodes, selectedSeason) { runCatching { firstFocus.requestFocus() } }
}
```

## Appendix C: `ui/vod/VodPlayerViewModel.kt`

```kotlin
package com.stalkerweb.android.ui.vod

import android.app.Application
import android.content.ComponentName
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.stalkerweb.android.data.api.SaveWatchRequest
import com.stalkerweb.android.data.api.VodEpisode
import com.stalkerweb.android.data.api.VodItem
import com.stalkerweb.android.data.api.VodSeason
import com.stalkerweb.android.data.api.toApiError
import com.stalkerweb.android.data.repo.EpisodeRef
import com.stalkerweb.android.data.repo.MediaLinks
import com.stalkerweb.android.data.repo.Neighbours
import com.stalkerweb.android.data.repo.PlayerParams
import com.stalkerweb.android.data.repo.VodRepository
import com.stalkerweb.android.data.repo.WatchRepository
import com.stalkerweb.android.data.repo.WatchRules
import com.stalkerweb.android.data.repo.episodeNeighbours
import com.stalkerweb.android.data.repo.isLastEpisode
import com.stalkerweb.android.service.PlaybackService
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class VodPlayerState(
    val params: PlayerParams? = null,
    val loading: Boolean = true,
    val error: String? = null,
    val resumedFrom: Double = 0.0,                    // > 0: the "Resumed from" banner
    val seasons: List<VodSeason>? = null,             // a show's seasons, in order (null while loading)
    val episodes: Map<String, List<VodEpisode>> = emptyMap(),
    val upNext: EpisodeRef? = null,                   // after an episode ends
) {
    val neighbours: Neighbours get() {
        val p = params ?: return Neighbours(null, null, emptyList())
        return if (seasons == null) Neighbours(null, null, emptyList())
               else episodeNeighbours(seasons, episodes, p.seasonId, p.episodeId)
    }
}

/**
 * The VOD player (the web's VodPlayerPage): plays [PlayerParams], resumes where
 * the viewer left off, saves the position (shared with the web), and for a
 * show offers its episodes, Previous / Next and an "Up next" after the end.
 */
@OptIn(UnstableApi::class)
class VodPlayerViewModel(
    application: Application,
    private val vod: VodRepository,
    private val watch: WatchRepository,
    private val links: MediaLinks,
) : AndroidViewModel(application) {

    /** The viewer's watch state — the top bar's My List button reads it. */
    val watchState = watch.state

    private val _player = MutableStateFlow<Player?>(null)
    val player: StateFlow<Player?> = _player.asStateFlow()

    private val _state = MutableStateFlow(VodPlayerState())
    val state: StateFlow<VodPlayerState> = _state.asStateFlow()

    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var pendingPlay: (() -> Unit)? = null
    private var started = false
    private var saver: Job? = null

    // Which title the player's media (and so its duration and position) belongs
    // to. Switching episode in place plays the old one until the new stream
    // loads: resuming and saving wait for the new one (web v0.4.28).
    private var streamKey: String? = null
    private var mediaKey: String? = null
    private var resumedKey: String? = null

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            val p = _player.value ?: return
            if (playbackState == Player.STATE_READY && mediaKey != streamKey) {
                mediaKey = streamKey
                resume(p)
            }
            if (playbackState == Player.STATE_ENDED) {
                persist()
                _state.value.neighbours.next?.let { _state.value = _state.value.copy(upNext = it) }
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (!isPlaying) persist()
        }
    }

    fun init(params: PlayerParams) {
        if (started) return
        started = true
        _state.value = VodPlayerState(params = params)
        if (params.isEpisode) loadSeasons(params)

        val app = getApplication<Application>()
        val token = SessionToken(app, ComponentName(app, PlaybackService::class.java))
        val future = MediaController.Builder(app, token).buildAsync()
        controllerFuture = future
        future.addListener({
            runCatching { future.get() }.getOrNull()?.let { controller ->
                controller.addListener(listener)
                _player.value = controller
                pendingPlay?.invoke()
                pendingPlay = null
            }
        }, MoreExecutors.directExecutor())

        load(params)
        // Every 10 s while playing (as the web does).
        saver = viewModelScope.launch {
            while (isActive) {
                delay(10_000)
                if (_player.value?.isPlaying == true) persist()
            }
        }
    }

    private fun load(params: PlayerParams) {
        streamKey = params.key
        _state.value = _state.value.copy(params = params, loading = true, error = null, resumedFrom = 0.0, upNext = null)
        viewModelScope.launch {
            runCatching { vod.resolveVodStreamUrl(params.videoId, params.cmd, params.series, params.seasonId, params.episodeId) }
                .onSuccess { url ->
                    val play = { startPlayback(url, params) }
                    if (_player.value != null) play() else pendingPlay = play
                }
                .onFailure { _state.value = _state.value.copy(loading = false, error = it.toApiError().message ?: "Could not load video") }
        }
    }

    private fun startPlayback(url: String, params: PlayerParams) {
        val p = _player.value ?: return
        val title = if (params.episodeTitle.isNotEmpty()) "${params.title} · ${params.episodeTitle}" else params.title
        val builder = MediaItem.Builder().setUri(url).setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
        if (url.substringBefore('?').endsWith(".m3u8", ignoreCase = true)) builder.setMimeType(MimeTypes.APPLICATION_M3U8)
        runCatching {
            p.setMediaItem(builder.build())
            p.prepare()
            p.playWhenReady = true
        }.onFailure { _state.value = _state.value.copy(error = it.message ?: "Playback error") }
        _state.value = _state.value.copy(loading = false)
    }

    // Where the viewer left off, once this title's media is ready (30 s … 95%).
    private fun resume(p: Player) {
        val key = streamKey ?: return
        if (resumedKey == key) return
        resumedKey = key
        val duration = p.duration.takeIf { it > 0 }?.div(1000.0) ?: return
        val saved = watch.progressFor(key) ?: return
        val at = WatchRules.resumeAt(saved.position, duration) ?: return
        p.seekTo((at * 1000).toLong())
        _state.value = _state.value.copy(resumedFrom = at)
    }

    fun startOver() {
        _player.value?.seekTo(0)
        _state.value = _state.value.copy(resumedFrom = 0.0)
    }

    fun dismissResumed() { _state.value = _state.value.copy(resumedFrom = 0.0) }

    /** Saves the position — only for the media actually playing, never the next episode's key. */
    private fun persist() {
        val p = _player.value ?: return
        val params = _state.value.params ?: return
        if (mediaKey == null || mediaKey != params.key) return
        val duration = p.duration.takeIf { it > 0 }?.div(1000.0) ?: return
        val s = _state.value
        val last = params.isEpisode && s.seasons != null && isLastEpisode(s.seasons, s.episodes, params.seasonId, params.episodeId)
        val stored = params.copy(screenshotUrl = links.relativeImage(params.screenshotUrl))
        watch.saveProgress(SaveWatchRequest(
            key = params.key,
            title = params.title,
            episodeTitle = params.episodeTitle,
            screenshotUrl = stored.screenshotUrl,
            params = stored.toQuery(),
            position = p.currentPosition / 1000.0,
            duration = duration,
            lastEpisode = last,
        ))
    }

    // ── A show's episodes ─────────────────────────────────────────────────────

    private fun loadSeasons(params: PlayerParams) {
        viewModelScope.launch {
            val seasons = vod.getVodSeasons(params.videoId)
            _state.value = _state.value.copy(seasons = seasons)
            loadSeason(params.seasonId)
        }
    }

    /** Loads a season's episodes (once), then any neighbouring season needed for Previous / Next. */
    fun loadSeason(seasonId: String) {
        val params = _state.value.params ?: return
        if (seasonId.isEmpty() || _state.value.episodes.containsKey(seasonId)) return
        viewModelScope.launch {
            val eps = vod.getVodEpisodes(params.videoId, seasonId)
            _state.value = _state.value.copy(episodes = _state.value.episodes + (seasonId to eps))
            _state.value.neighbours.needs.forEach(::loadSeason)
        }
    }

    /** Another episode of the same show, in place. */
    fun playEpisode(season: VodSeason, episode: VodEpisode) {
        val params = _state.value.params ?: return
        persist()
        mediaKey = null
        load(params.copy(
            series = episode.seriesNumber.ifBlank { "0" }, seasonId = season.id, episodeId = episode.episodeId,
            episodeTitle = episode.name.ifBlank { "Episode ${episode.seriesNumber}" },
        ))
        loadSeason(season.id)
    }

    fun playNext() { _state.value.neighbours.next?.let { playEpisode(it.season, it.episode) } }
    fun playPrevious() { _state.value.neighbours.prev?.let { playEpisode(it.season, it.episode) } }
    fun cancelUpNext() { _state.value = _state.value.copy(upNext = null) }

    // ── My List ───────────────────────────────────────────────────────────────

    /** This movie or show, as My List keeps it. */
    fun myListItem(): VodItem? = _state.value.params?.let { p ->
        VodItem(
            id = p.videoId, name = p.title, cmd = if (p.isEpisode) "" else p.cmd, year = p.year, durationMin = p.durationMin,
            isHD = p.isHD, isSeries = p.isEpisode, screenshotUrl = links.absoluteImage(p.screenshotUrl),
            description = p.description, director = p.director, actors = p.actors,
        )
    }

    fun toggleMyList() { myListItem()?.let(watch::toggleMyList) }

    override fun onCleared() {
        persist()
        saver?.cancel()
        _player.value?.removeListener(listener)
        _player.value?.pause()
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.onCleared()
    }
}
```

## Appendix D: `ui/vod/VodPlayerScreen.kt`

```kotlin
package com.stalkerweb.android.ui.vod

import android.app.Activity
import android.view.View
import android.view.WindowManager
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.stalkerweb.android.data.repo.PlayerParams
import com.stalkerweb.android.ui.components.Pill
import com.stalkerweb.android.ui.components.tvFocus
import com.stalkerweb.android.ui.theme.SwColors
import com.stalkerweb.android.ui.utils.rememberIsTV
import kotlinx.coroutines.delay

private fun clock(secs: Double): String {
    val s = secs.toLong()
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s % 3600 / 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

/**
 * The VOD player (the web's VodPlayerPage): Media3's own controls (seek bar,
 * play/pause; the remote seeks with Left/Right), with a top bar shown alongside
 * them — Back, the title, My List, and for a show Episodes and Previous / Next —
 * a "Resumed from" banner, the episodes panel, and "Up next" after an episode.
 */
@OptIn(UnstableApi::class)
@Composable
fun VodPlayerScreen(params: PlayerParams, viewModel: VodPlayerViewModel, onBack: () -> Unit) {
    val activity = LocalContext.current as? Activity
    val player by viewModel.player.collectAsStateWithLifecycle()
    val state by viewModel.state.collectAsStateWithLifecycle()
    val isTV = rememberIsTV()
    val wide = isTV || LocalConfiguration.current.screenWidthDp >= 600
    var controlsVisible by remember { mutableStateOf(true) }
    var panelOpen by remember { mutableStateOf(false) }
    val p = state.params ?: params
    val watchState by viewModel.watchState.collectAsStateWithLifecycle()
    val inMyList = watchState.list.any { it.id == p.videoId }

    LaunchedEffect(Unit) { viewModel.init(params) }
    DisposableEffect(activity) {
        activity?.window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { activity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }
    LaunchedEffect(state.resumedFrom) { if (state.resumedFrom > 0) { delay(8_000); viewModel.dismissResumed() } }

    Box(
        Modifier.fillMaxSize().background(Color.Black).onPreviewKeyEvent { e ->
            if (e.type != KeyEventType.KeyDown || !p.isEpisode) return@onPreviewKeyEvent false
            when (e.key) {
                Key.MediaNext, Key.ChannelUp -> { viewModel.playNext(); true }
                Key.MediaPrevious, Key.ChannelDown -> { viewModel.playPrevious(); true }
                else -> false
            }
        },
    ) {
        if (player != null) {
            AndroidView(
                factory = { ctx ->
                    PlayerView(ctx).apply {
                        useController = true
                        resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                        setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { v -> controlsVisible = v == View.VISIBLE })
                    }
                },
                update = { it.player = player as Player? },
                modifier = Modifier.fillMaxSize(),
            )
        }

        if (state.loading && state.error == null) CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)

        state.error?.let { msg ->
            Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Default.ErrorOutline, null, tint = SwColors.Live, modifier = Modifier.size(36.dp))
                Text(msg, color = Color.White)
            }
        }

        // Top bar, shown with the player's controls.
        if (controlsVisible || state.error != null) {
            Row(
                Modifier.align(Alignment.TopStart).fillMaxWidth().background(Color.Black.copy(alpha = 0.55f)).statusBarsPadding().padding(4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White) }
                Column(Modifier.weight(1f)) {
                    Text(p.title, color = Color.White, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (p.episodeTitle.isNotEmpty()) Text(p.episodeTitle, color = SwColors.Muted, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (p.isEpisode) {
                    IconButton(onClick = viewModel::playPrevious, enabled = state.neighbours.prev != null) { Icon(Icons.Default.SkipPrevious, "Previous episode", tint = Color.White) }
                    IconButton(onClick = viewModel::playNext, enabled = state.neighbours.next != null) { Icon(Icons.Default.SkipNext, "Next episode", tint = Color.White) }
                    IconButton(onClick = { panelOpen = !panelOpen }) { Icon(Icons.AutoMirrored.Filled.List, "Episodes", tint = Color.White) }
                }
                IconButton(onClick = viewModel::toggleMyList) {
                    Icon(if (inMyList) Icons.Default.Bookmark else Icons.Default.BookmarkBorder,
                        if (inMyList) "Remove from My List" else "Add to My List", tint = Color.White)
                }
            }
        }

        // "Resumed from 12:34 · Start over"
        if (state.resumedFrom > 0 && state.error == null) {
            Surface(color = Color.Black.copy(alpha = 0.75f), shape = RoundedCornerShape(50),
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 72.dp)) {
                Row(Modifier.padding(horizontal = 14.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Resumed from ${clock(state.resumedFrom)}", color = Color.White, style = MaterialTheme.typography.labelMedium)
                    TextButton(onClick = viewModel::startOver) { Text("Start over") }
                    IconButton(onClick = viewModel::dismissResumed, modifier = Modifier.size(28.dp)) { Icon(Icons.Default.Close, "Dismiss", tint = Color.White, modifier = Modifier.size(14.dp)) }
                }
            }
        }

        // Episodes: a side panel on wide screens and TV, a bottom panel on phones.
        if (panelOpen && p.isEpisode) {
            EpisodesPanel(
                state = state, current = p, wide = wide,
                onPick = { season, ep -> viewModel.playEpisode(season, ep) },
                onSeason = viewModel::loadSeason,
                onClose = { panelOpen = false },
                modifier = if (wide) Modifier.align(Alignment.CenterEnd).width(340.dp).fillMaxHeight()
                           else Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.6f),
            )
        }

        state.upNext?.let { next ->
            UpNextCard(
                title = next.episode.name.ifBlank { "Episode ${next.episode.seriesNumber}" },
                onPlay = viewModel::playNext,
                onCancel = viewModel::cancelUpNext,
                modifier = Modifier.align(Alignment.BottomEnd).padding(24.dp),
            )
        }
    }
}

@Composable
private fun EpisodesPanel(
    state: VodPlayerState, current: PlayerParams, wide: Boolean,
    onPick: (com.stalkerweb.android.data.api.VodSeason, com.stalkerweb.android.data.api.VodEpisode) -> Unit,
    onSeason: (String) -> Unit, onClose: () -> Unit, modifier: Modifier,
) {
    var seasonId by remember(current.seasonId) { mutableStateOf(current.seasonId) }
    LaunchedEffect(seasonId) { onSeason(seasonId) }
    val currentFocus = remember { FocusRequester() }
    Surface(color = SwColors.Surface.copy(alpha = 0.96f), shape = RoundedCornerShape(if (wide) 0.dp else 12.dp), modifier = modifier) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Episodes", style = MaterialTheme.typography.titleSmall, color = SwColors.Text, modifier = Modifier.weight(1f))
                IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close episodes") }
            }
            val seasons = state.seasons.orEmpty()
            if (seasons.size > 1) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(seasons, key = { it.id }) { s ->
                        Pill(s.name.ifBlank { "Season ${s.seasonNumber}" }, s.id == seasonId, { seasonId = s.id })
                    }
                }
            }
            val season = seasons.firstOrNull { it.id == seasonId }
            val eps = state.episodes[seasonId]
            when {
                state.seasons == null || eps == null -> CircularProgressIndicator(Modifier.size(22.dp))
                eps.isEmpty() -> Text("No episodes.", color = SwColors.Muted)
                else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    items(eps, key = { it.episodeId }) { ep ->
                        val playing = ep.episodeId == current.episodeId && seasonId == current.seasonId
                        Row(
                            Modifier.fillMaxWidth()
                                .then(if (playing) Modifier.focusRequester(currentFocus) else Modifier)
                                .tvFocus(RoundedCornerShape(8.dp))
                                .background(if (playing) SwColors.Surface3 else Color.Transparent, RoundedCornerShape(8.dp))
                                .clickable(enabled = season != null) { season?.let { onPick(it, ep) } }
                                .padding(10.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Text(ep.seriesNumber, color = SwColors.Muted, modifier = Modifier.width(28.dp))
                            Text(ep.name.ifBlank { "Episode ${ep.seriesNumber}" }, color = if (playing) SwColors.PrimaryLight else SwColors.Text,
                                maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
    LaunchedEffect(state.episodes[seasonId]) { runCatching { currentFocus.requestFocus() } }
}

/** "Up next" after an episode: plays the next one in 10 s unless cancelled. */
@Composable
private fun UpNextCard(title: String, onPlay: () -> Unit, onCancel: () -> Unit, modifier: Modifier) {
    var left by remember { mutableIntStateOf(10) }
    val playFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        runCatching { playFocus.requestFocus() }
        while (left > 0) { delay(1_000); left -= 1 }
        onPlay()
    }
    Surface(color = SwColors.Surface, shape = RoundedCornerShape(12.dp), modifier = modifier.width(300.dp)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Up next in $left s", style = MaterialTheme.typography.labelMedium, color = SwColors.Muted)
            Text(title, style = MaterialTheme.typography.titleSmall, color = SwColors.Text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onPlay, modifier = Modifier.focusRequester(playFocus)) { Text("Play now") }
                OutlinedButton(onClick = onCancel) { Text("Cancel") }
            }
        }
    }
}
```
