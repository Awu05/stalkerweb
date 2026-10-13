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

data class FilterOptions(
    val genres: List<String>,
    val years: List<String>,
    val hasRating: Boolean,
    val hasHD: Boolean,
    val hasAdded: Boolean = false,   // some titles carry a date added
) {
    /**
     * Also offers the filters that are on, with their choice — while a listing is
     * still being read, or in a category without that value, a filter in use
     * mustn't vanish from the bar (only "Clear" could turn it off then).
     */
    fun withChosen(f: VodFilterState) = copy(
        genres = if (f.genre.isNotEmpty() && f.genre !in genres) genres + f.genre else genres,
        years = if (f.year.isNotEmpty() && f.year !in years) years + f.year else years,
        hasRating = hasRating || f.minRating > 0,
        hasHD = hasHD || f.hd,
        hasAdded = hasAdded || f.addedDays > 0,
    )
}

/** Titles shown a step at a time while filtering (as the web's VOD page). */
const val SHOW_STEP = 140

/** How many to show after "more": another step, unless all [total] are shown already. */
fun nextVisibleCount(current: Int, total: Int): Int = if (current < total) current + SHOW_STEP else current

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
    val genres = linkedSetOf<String>()   // as spelled: the filter matches genres exactly
    val years = mutableSetOf<Int>()
    val decades = mutableSetOf<String>()
    var hasRating = false
    var hasHD = false
    var hasAdded = false
    for (item in items) {
        genres.addAll(item.genres)
        decadeOf(item.year)?.let { d -> decades.add(d); yearOf(item.year)?.let(years::add) }
        if (item.rating > 0) hasRating = true
        if (item.isHD) hasHD = true
        if (!hasAdded && parseAdded(item.added) != null) hasAdded = true
    }
    val yearChoices = if (years.size <= MAX_SINGLE_YEARS) years.sortedDescending().map { it.toString() }
                      else decades.sortedByDescending(::decadeRank)
    return FilterOptions(genres.sortedWith(collator), yearChoices, hasRating, hasHD, hasAdded)
}
