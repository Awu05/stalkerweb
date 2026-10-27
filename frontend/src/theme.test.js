// The theme (theme/tokens.json): its generated files up to date, every pair it
// lists readable, and the website keeping to it — no colours of its own, and
// a fill always with its own text colour. See theme/build.mjs.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokens, contrast, MIN_CONTRAST, onColorFor } from '../../theme/theme.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')

describe('the theme', () => {
  it('has its generated files up to date (run `node theme/build.mjs` after changing tokens.json)', () => {
    expect(() => execFileSync(globalThis.process.execPath, [path.join(repo, 'theme', 'build.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow()
  })

  it('makes every pair it lists readable (WCAG AA)', () => {
    const unreadable = tokens.pairs
      .map((p) => ({ ...p, ratio: contrast(tokens.color[p.fg], tokens.color[p.bg]) }))
      .filter((p) => !(p.ratio >= MIN_CONTRAST[p.use]))
      .map((p) => `${p.fg} on ${p.bg}: ${p.ratio.toFixed(2)}:1 (needs ${MIN_CONTRAST[p.use]}:1)`)
    expect(unreadable).toEqual([])
  })

  it("gives every fill its readable on-colour", () => {
    for (const [name, value] of Object.entries(tokens.color)) {
      if (!name.startsWith('on-')) continue
      const fill = name.slice(3) === 'live' ? 'live-fill' : name.slice(3)
      expect(tokens.pairs.some((p) => p.fg === name && p.bg === fill), `${name} on ${fill} is listed in pairs`).toBe(true)
      expect(contrast(value, tokens.color[fill])).toBeGreaterThanOrEqual(MIN_CONTRAST.text)
    }
  })

  it("puts readable initials on every viewer colour", () => {
    for (const c of tokens.viewers) expect(contrast(onColorFor(c), c)).toBeGreaterThanOrEqual(MIN_CONTRAST.mark)
  })
})

// ── The website keeps to it ──────────────────────────────────────────────────

const SKIP = /(\.test\.|\.generated\.)/
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(jsx?|css)$/.test(e.name) && !SKIP.test(e.name) ? [p] : []
  })
}

// The quoted strings of a line: class names, styles.
const strings = (line) => [...line.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2])

// Fills a light text can't go on, and the fills that have an on-colour — as
// classes of their own (not hover:…, which swaps the pair together).
const LIGHT_FILL = /(?:^|\s)(?:bg-\[var\(--color-(?:primary|primary-hover|primary-light|text|success|warning)\)\]|bg-white|btn-gradient|fill-(?:primary|success|warning))(?![\w/-])/
const LIGHT_TEXT = /(?:^|\s)text-(?:white|\[var\(--color-(?:text|primary|primary-light)\)\])(?![\w/-])/
const SOLID_FILL = /(?:^|\s)bg-\[var\(--color-(primary|live|live-fill|success|warning)\)\](?!\/)/
const TEXT_COLOUR = /(?:^|\s)text-(?:white|black|\[(?:var\(--color-[\w-]+\)|#[0-9a-f]+)\]|[a-z]+-\d{2,3})(?![\w/-])/

// What's wrong with one line of a file (`rel` its path under src).
function lineProblems(rel, line, at = rel) {
  const found = []
  // index.css holds the effects built from the theme's colours (glass, glows): its own rgba() values only.
  if (rel !== 'index.css' && /#[0-9a-f]{3,8}\b/i.test(line.replace(/\/\/.*$|\{\/\*.*\*\/\}/g, ''))) found.push(`${at}: a colour of its own — use the theme's`)
  if (rel === 'index.css' && /#[0-9a-f]{3,8}\b/i.test(line)) found.push(`${at}: a hex colour — put it in theme/tokens.json`)
  // A theme colour that isn't one (misspelt, or gone from tokens.json) is no colour at all.
  for (const m of line.matchAll(/--color-([a-z0-9-]+)/g)) {
    if (!(m[1] in tokens.color)) found.push(`${at}: --color-${m[1]} isn't in theme/tokens.json`)
  }
  for (const s of strings(line)) {
    if (LIGHT_FILL.test(s) && LIGHT_TEXT.test(s)) found.push(`${at}: light text on a light fill — "${s.trim().slice(0, 90)}"`)
    const fill = SOLID_FILL.exec(s)?.[1]
    if (fill && TEXT_COLOUR.test(s)) found.push(`${at}: a fill with a text colour of its own — use fill-${fill.replace('-fill', '')}: "${s.trim().slice(0, 90)}"`)
  }
  return found
}

function problems() {
  const found = []
  for (const file of sources(here)) {
    const rel = path.relative(here, file).replace(/\\/g, '/')
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => found.push(...lineProblems(rel, line, `${rel}:${i + 1}`)))
  }
  return found
}

describe('the theme check', () => {
  it('catches the Save button that was white on white, and its kind', () => {
    const bad = [
      'className="px-4 py-2 rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-white text-sm font-medium"',
      "default:  'btn-gradient text-white hover:brightness-110',",
      "danger:   'bg-[var(--color-live)] text-white',",
      'className="bg-[var(--color-success)] text-[#0b1a14]"',
      'className="hover:bg-[var(--color-hover)]"',
      "style={{ color: '#3c3c44' }}",
    ]
    for (const line of bad) expect(lineProblems('x.jsx', line), line).not.toEqual([])
  })

  it('lets the right ways through', () => {
    const good = [
      'className="fill-primary px-4 py-2 hover:bg-[var(--color-primary-hover)]"',
      'className="bg-black/75 hover:bg-white hover:text-black text-white"',
      'className="bg-[var(--color-primary)]/15 text-[var(--color-primary-light)]"',
      'className="h-full rounded-full bg-[var(--color-primary)]"',
    ]
    for (const line of good) expect(lineProblems('x.jsx', line), line).toEqual([])
  })
})

describe('the website', () => {
  it("uses only the theme's colours, each fill with its own text colour (the fill-… classes)", () => {
    expect(problems()).toEqual([])
  })
})
