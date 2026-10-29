package com.stalkerweb.android.data.repo

import com.stalkerweb.android.data.api.SkipResponse

// Skip intro / recap / credits — the web's lib/skipSegments.js.

/** The part playing: what kind, the button's words, and where a skip lands (seconds). */
data class SkipNow(val kind: String, val label: String, val to: Double)

// Not in a part's last second: the skip would land where it already is.
private const val TAIL_SECS = 1.0

/** The "Next episode" button shows this close to the end, credits times or not. */
const val NEXT_PROMPT_SECS = 30.0

/**
 * Intro skipping, as the gear and Settings offer it: no Skip buttons ("off"),
 * a Skip button ("button"), or intros and recaps skipped by themselves ("auto").
 */
val SKIP_MODES = listOf("off" to "Off", "button" to "Show a Skip button", "auto" to "Skip automatically")

/** The viewer's skip mode — from an older server, only its autoSkip (true = "auto"). */
fun skipModeOf(skipMode: String?, autoSkip: Boolean): String = when {
    skipMode != null && SKIP_MODES.any { it.first == skipMode } -> skipMode
    autoSkip -> "auto"
    else -> "button"
}

private val SkipResponse.mode get() = skipModeOf(skipMode, autoSkip)

/** The part playing at [t] seconds, or null. Nothing with skipping off. */
fun skipAt(parts: SkipResponse?, t: Double): SkipNow? {
    if (parts == null || parts.mode == "off") return null
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
    if (parts?.mode != "auto") null else skipAt(parts, t)?.takeIf { it.kind != "outro" && it.kind !in done }

/**
 * Whether the "Next episode" button shows at [t] of a [duration]-second video:
 * with a next episode, in its last [NEXT_PROMPT_SECS] — whatever the intro
 * skipping, and with no credits times at all — and during the credits (the
 * Skip credits button's place, so not with skipping off).
 */
fun nextPromptAt(parts: SkipResponse?, t: Double, duration: Double, hasNext: Boolean): Boolean {
    if (!hasNext || t.isNaN()) return false
    if (duration > 0 && duration - t <= NEXT_PROMPT_SECS) return true
    return skipAt(parts, t)?.kind == "outro"
}
