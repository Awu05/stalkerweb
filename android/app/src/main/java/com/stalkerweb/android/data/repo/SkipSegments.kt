package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.SkipResponse

// Skip intro / recap / credits — the web's lib/skipSegments.js.

/** The part playing: what kind, the button's words, and where a skip lands (seconds). */
data class SkipNow(val kind: String, val label: String, val to: Double)

// Not in a part's last second: the skip would land where it already is.
private const val TAIL_SECS = 1.0

/** The part playing at [t] seconds, or null. */
fun skipAt(parts: SkipResponse?, t: Double): SkipNow? {
    if (parts == null) return null
    listOf(
        Triple("recap", "Skip recap", parts.recap),
        Triple("intro", "Skip intro", parts.intro),
        Triple("outro", "Skip credits", parts.outro),
    ).forEach { (kind, label, p) ->
        if (p != null && p.end > p.start && t >= p.start && t < p.end - TAIL_SECS) return SkipNow(kind, label, p.end)
    }
    return null
}

/**
 * Where auto-skip jumps to at [t], or null: intros and recaps only (credits are
 * left to the viewer), each once — [done] holds the kinds already skipped.
 */
fun autoSkipTo(parts: SkipResponse?, t: Double, done: Set<String>): SkipNow? =
    skipAt(parts, t)?.takeIf { it.kind != "outro" && it.kind !in done }
