/**
 * Skip intro / recap / credits (the server's lib/skipSegments.js finds the
 * times; components/SkipControls.jsx shows the button). The apps'
 * SkipSegments.kt says the same.
 */

const LABELS = { intro: 'Skip intro', recap: 'Skip recap', outro: 'Skip credits' }
// Not in a part's last second: the skip would land where it already is.
const TAIL_SECS = 1

/**
 * The part playing at `t`: { kind, label, to } (`to` where a skip lands), or
 * null. `parts` is the server's answer ({ intro, recap, outro }, each
 * { start, end } or null).
 */
export function skipAt(parts, t) {
  if (!parts || !Number.isFinite(t)) return null
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
  const s = skipAt(parts, t)
  if (!s || s.kind === 'outro' || done.has(s.kind)) return null
  return s.to
}

/** "Breaking Bad (2008)" — what the show was matched to, for the side panel. */
export function matchLabel(m) {
  if (!m?.title) return ''
  return m.year ? `${m.title} (${m.year})` : m.title
}
