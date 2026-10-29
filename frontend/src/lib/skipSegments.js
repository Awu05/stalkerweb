/**
 * Skip intro / recap / credits (the server's lib/skipSegments.js finds the
 * times; components/SkipControls.jsx shows the button). The apps'
 * SkipSegments.kt says the same.
 */

const LABELS = { intro: 'Skip intro', recap: 'Skip recap', outro: 'Skip credits' }
// Not in a part's last second: the skip would land where it already is.
const TAIL_SECS = 1
// The "Next episode" prompt shows this close to the end, credits times or not.
export const NEXT_PROMPT_SECS = 30
const SKIP_MODES = ['off', 'button', 'auto']
/** The intro-skipping choices, as the gear and Settings name them. */
export const SKIP_MODE_CHOICES = [
  { id: 'off', label: 'Off' },
  { id: 'button', label: 'Show a Skip button' },
  { id: 'auto', label: 'Skip automatically' },
]

/**
 * The viewer's intro skipping, from the server's answer: 'off' (no Skip
 * buttons), 'button' (a Skip button) or 'auto' (intros and recaps skipped by
 * themselves). An older server sends only autoSkip.
 */
export function skipModeOf(found) {
  if (SKIP_MODES.includes(found?.skipMode)) return found.skipMode
  return found?.autoSkip === true ? 'auto' : 'button'
}

/**
 * The part playing at `t`: { kind, label, to } (`to` where a skip lands), or
 * null. `parts` is the server's answer ({ intro, recap, outro }, each
 * { start, end } or null, and the viewer's skipMode). Nothing with skipping off.
 */
export function skipAt(parts, t) {
  if (!parts || !Number.isFinite(t) || skipModeOf(parts) === 'off') return null
  for (const kind of ['recap', 'intro', 'outro']) {
    const p = parts[kind]
    if (p && t >= p.start && t < p.end - TAIL_SECS) return { kind, label: LABELS[kind], to: p.end }
  }
  return null
}

/**
 * Where auto-skip jumps to at `t`, or null: intros and recaps only (credits
 * are left to the viewer), each once — `done` holds the kinds already
 * skipped, so going back to watch one isn't undone.
 */
export function autoSkipTo(parts, t, done) {
  if (skipModeOf(parts) !== 'auto') return null
  const s = skipAt(parts, t)
  if (!s || s.kind === 'outro' || done.has(s.kind)) return null
  return s.to
}

/**
 * Whether the "Next episode" button shows at `t` of a `duration`-second video:
 * with a next episode (`hasNext`), in its last NEXT_PROMPT_SECS — whatever the
 * intro skipping, and with no credits times at all — and during the credits
 * (the Skip credits button's place, so not with skipping off).
 */
export function nextPromptAt(parts, t, duration, hasNext) {
  if (!hasNext || !Number.isFinite(t)) return false
  if (Number.isFinite(duration) && duration > 0 && duration - t <= NEXT_PROMPT_SECS) return true
  return skipAt(parts, t)?.kind === 'outro'
}

/** "Breaking Bad (2008)" — what the show was matched to, for the side panel. */
export function matchLabel(m) {
  if (!m?.title) return ''
  return m.year ? `${m.title} (${m.year})` : m.title
}
