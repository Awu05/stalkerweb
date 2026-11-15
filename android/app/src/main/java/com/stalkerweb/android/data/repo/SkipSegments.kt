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
 * When the next episode plays by itself, during the credits and after the end
 * (the viewer's nextEpisodeDelay; the web's NEXT_EPISODE_DELAY_CHOICES): after
 * this many seconds, 0 at once, -1 not by itself.
 */
val NEXT_EPISODE_DELAYS = listOf(0 to "Immediately", 3 to "After 3 s", 5 to "After 5 s", 10 to "After 10 s", 15 to "After 15 s", -1 to "Off")
const val DEFAULT_NEXT_EPISODE_DELAY = 5

/** The viewer's choice (5 s from an older server, or an odd value). */
fun nextEpisodeDelayOf(secs: Int?): Int = if (NEXT_EPISODE_DELAYS.any { it.first == secs }) secs!! else DEFAULT_NEXT_EPISODE_DELAY

/** A countdown as it stands: whole seconds [left], and how far it has gone (0–1). */
data class CountdownNow(val left: Int, val filled: Float)

/**
 * "Next episode"'s countdown, from how long it has shown while playing (the
 * web's useCountdown): where it stands, or null when not counting. Hidden, it
 * starts from the top next time; stopped, never again for that episode.
 */
class NextCountdown {
    private var key: String? = null
    private var stoppedFor: String? = null
    private var playedMs = 0L
    private var lastAt: Long? = null

    /** [secs] long (0: at 0 straight away). */
    fun update(key: String, showing: Boolean, playing: Boolean, nowMs: Long, secs: Int = DEFAULT_NEXT_EPISODE_DELAY): CountdownNow? {
        if (key != this.key) { this.key = key; playedMs = 0; lastAt = null }
        if (!showing || key == stoppedFor) { playedMs = 0; lastAt = null; return null }
        lastAt?.let { if (playing) playedMs += nowMs - it }
        lastAt = if (playing) nowMs else null
        if (secs <= 0) return CountdownNow(0, 1f)
        return CountdownNow((secs - (playedMs / 1000).toInt()).coerceAtLeast(0), (playedMs / (secs * 1000f)).coerceIn(0f, 1f))
    }

    /** Not checked for a while (casting, a reload): that time isn't counted. */
    fun hold() { lastAt = null }

    /** Stopped for the episode it last counted for. */
    fun stop() { stoppedFor = key }
}

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
    return inCredits(parts, t)
}

/**
 * Whether [t] is in the credits (their times known, skipping not off): where
 * "Next episode" counts down to playing it by itself. Elsewhere the episode
 * plays to its end, and the Up next card follows.
 */
fun inCredits(parts: SkipResponse?, t: Double): Boolean = skipAt(parts, t)?.kind == "outro"

// A resume passes through the first seconds on its way to where it lands.
private const val ARM_SECS = 5.0

/**
 * Whether [t] is before the credits, past the first seconds: an episode seen
 * playing there is one watched into its credits, so their countdown is for it
 * — not for one opened (or resumed) in them, for a scene after them.
 */
fun beforeCredits(parts: SkipResponse?, t: Double): Boolean {
    val o = parts?.outro ?: return false
    return !t.isNaN() && t >= ARM_SECS && t < o.start
}
