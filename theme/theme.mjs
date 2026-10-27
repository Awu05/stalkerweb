// The theme (tokens.json) and the arithmetic of reading it: contrast ratios
// (WCAG 2.1) and the colour to put on a fill. Used by build.mjs and the tests.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const tokens = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'tokens.json'), 'utf8'))

/** What each kind of pair needs: 4.5:1 for text, 3:1 for icons and other marks (WCAG AA). */
export const MIN_CONTRAST = { text: 4.5, mark: 3 }

function channels(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`theme: contrast needs a #rrggbb colour, not ${hex}`)
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
}

/** A colour's relative luminance (WCAG 2.1). */
export function luminance(hex) {
  const [r, g, b] = channels(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The contrast ratio of two colours, 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The colour a viewer's initials go in on their avatar colour: white while it
 * reads (3:1 — initials are a short, bold mark), else the theme's near-black.
 */
export function onColorFor(fill) {
  return contrast('#ffffff', fill) >= MIN_CONTRAST.mark ? '#ffffff' : tokens.color.bg
}
