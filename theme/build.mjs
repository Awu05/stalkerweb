#!/usr/bin/env node
// The theme (theme/tokens.json) written out for each part of StalkerWeb:
//   frontend/src/theme.generated.css            the website's CSS variables (Tailwind @theme)
//   frontend/src/lib/theme.generated.js          the website's viewer colours, with their initials colour
//   android/.../ui/theme/Tokens.kt               the apps' SwColors, radii and viewer colours
//   backend/viewers/viewerColors.json            the viewer colours the server hands out
//
//   node theme/build.mjs           write them
//   node theme/build.mjs --check   exit 1 if any differs from tokens.json (the tests run this)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokens, onColorFor } from './theme.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const HEADER = 'Generated from theme/tokens.json by theme/build.mjs — do not edit; change tokens.json and run `node theme/build.mjs`.'

// "surface-2" → "Surface2", "on-primary" → "OnPrimary".
const kotlinName = (k) => k.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('')

// "#e8e8ec" → 0xFFE8E8EC; "rgba(232, 232, 236, 0.35)" → 0x59E8E8EC.
function argb(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) return `0xFF${hex[1].toUpperCase()}`
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i.exec(value)
  if (!m) throw new Error(`theme: can't read the colour ${value}`)
  const h = (n) => Number(n).toString(16).padStart(2, '0').toUpperCase()
  return `0x${h(Math.round(Number(m[4]) * 255))}${h(m[1])}${h(m[2])}${h(m[3])}`
}

function css() {
  const lines = [`/* ${HEADER} */`, '@theme {']
  for (const [k, v] of Object.entries(tokens.color)) lines.push(`  --color-${k}: ${v};`)
  for (const [k, v] of Object.entries(tokens.radius)) lines.push(`  --radius-${k}: ${v}px;`)
  lines.push('}', '')
  // The viewer colours, each with the colour its initials go in.
  lines.push(':root {')
  tokens.viewers.forEach((c, i) => {
    lines.push(`  --viewer-${i}: ${c};`, `  --on-viewer-${i}: ${onColorFor(c)};`)
  })
  lines.push('}', '')
  return lines.join('\n')
}

function kotlin() {
  const w = Math.max(...Object.keys(tokens.color).map((k) => kotlinName(k).length))
  const colors = Object.entries(tokens.color).map(([k, v]) => `    val ${kotlinName(k).padEnd(w)} = Color(${argb(v)})`)
  const viewers = tokens.viewers.map((c) => `    ViewerColor("${c}", Color(${argb(c)}), Color(${argb(onColorFor(c))})),`)
  return `// ${HEADER}
package com.stalkerweb.android.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** The theme's colours (the website's --color-… by the same names). Each fill has its On… colour. */
object SwColors {
${colors.join('\n')}
}

/** The theme's corner radii (the website's --radius-…). */
object SwRadius {
${Object.entries(tokens.radius).map(([k, v]) => `    val ${kotlinName(k)} = ${v}.dp`).join('\n')}
}

/** A colour a viewer can pick for their avatar, and the colour its initials go in. */
data class ViewerColor(val hex: String, val color: Color, val on: Color)

/** The viewer colours, in order (the first is the Default viewer's). */
val VIEWER_COLORS: List<ViewerColor> = listOf(
${viewers.join('\n')}
)
`
}

const webJs = () => `// ${HEADER}

/** The viewer colours, in order (the first is the Default viewer's). */
export const VIEWER_COLORS = ${JSON.stringify(tokens.viewers)}

// Each viewer colour's initials colour.
const INITIALS = ${JSON.stringify(Object.fromEntries(tokens.viewers.map((c) => [c, onColorFor(c)])))}

/** The colour a viewer's initials go in on their avatar colour (white on one not in the list). */
export function viewerInitialsColor(color) {
  return INITIALS[String(color || '').toLowerCase()] ?? '#ffffff'
}
`

const backendViewers = () => `${JSON.stringify({ $comment: HEADER, colors: tokens.viewers }, null, 2)}\n`

const OUTPUTS = [
  ['frontend/src/theme.generated.css', css],
  ['frontend/src/lib/theme.generated.js', webJs],
  ['android/app/src/main/java/com/stalkerweb/android/ui/theme/Tokens.kt', kotlin],
  ['backend/viewers/viewerColors.json', backendViewers],
]

const check = process.argv.includes('--check')
let stale = []
for (const [rel, make] of OUTPUTS) {
  const file = path.join(root, rel)
  const want = make()
  const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null
  if (have === want) continue
  if (check) stale.push(rel)
  else { fs.writeFileSync(file, want); console.log(`theme: wrote ${rel}`) }
}
if (check && stale.length) {
  console.error(`theme: out of date with theme/tokens.json: ${stale.join(', ')} — run \`node theme/build.mjs\``)
  process.exit(1)
}
