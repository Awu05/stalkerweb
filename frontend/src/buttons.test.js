// Every button that shows only an icon has a name — its tooltip
// (components/TooltipLayer.jsx) and what a screen reader says. A button
// showing text of its own needs none.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.jsx$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : []
  })
}

// The end (">") of a JSX tag whose name starts at `i`: past {…} and quoted values.
function tagEnd(s, i) {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === '"' || c === "'" || c === '`') {
      const close = s.indexOf(c, j + 1)
      if (close < 0) return -1
      j = close
    } else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return j
  }
  return -1
}

// Where a tag was, in an expression: a character JSX never has.
const MARK = String.fromCharCode(0xe000)

// <Tag, </Tag or <> (a fragment).
const isTagStart = (s, i) => s[i] === '<' && /[A-Za-z/>]/.test(s[i + 1] || '')
const tagEndAt = (s, i) => (s[i + 1] === '>' ? i + 1 : tagEnd(s, i + 1))

// JSX with its tags (and their attributes) taken out, each left as `mark`.
function removeTags(s, mark = ' ') {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (isTagStart(s, i)) {
      const end = tagEndAt(s, i)
      if (end < 0) break
      out += mark
      i = end
    } else out += s[i]
  }
  return out
}

// A stretch of JSX's top-level {…} expressions, and the text outside them
// (tags skipped whole, so their attributes' {…} aren't counted).
function split(content) {
  const exprs = []
  let outside = ''
  for (let i = 0; i < content.length; i++) {
    if (isTagStart(content, i)) {
      const end = tagEndAt(content, i)
      if (end < 0) break
      i = end
      continue
    }
    if (content[i] !== '{') { outside += content[i]; continue }
    let depth = 0
    let j = i
    for (; j < content.length; j++) {
      const c = content[j]
      if (c === '"' || c === "'" || c === '`') { const close = content.indexOf(c, j + 1); if (close < 0) break; j = close; continue }
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) break
    }
    exprs.push(content.slice(i + 1, j))
    i = j
  }
  return { exprs, outside }
}

/**
 * Whether a button's content shows text: words outside any {…}, or an
 * expression that's text — a string, or a value ({label}) — rather than only
 * icons ({playing ? <Pause /> : <Play />}).
 */
function showsText(content) {
  const { exprs, outside } = split(content)
  if (/[\p{L}\p{N}]/u.test(outside)) return true
  return exprs.some((e) => {
    if (/^\s*\/\*[\s\S]*\*\/\s*$/.test(e)) return false   // a comment
    const marked = removeTags(e, MARK)
    if (marked === e) return e.trim() !== ''   // a value: {label}
    // Tags in it: text between two of them ({x && <><Icon /> Mark completed</>}), or a string.
    if (marked.split(MARK).slice(1, -1).some((t) => /[\p{L}\p{N}]/u.test(t))) return true
    return /(['"`])[^'"`]*[\p{L}\p{N}][^'"`]*\1/u.test(marked.split(MARK).join(' '))
  })
}

const NAMED = /\b(?:aria-label|title|data-tip)\s*=|\{\s*\.\.\./

function unnamedIconButtons() {
  const found = []
  for (const file of sources(here)) {
    const rel = path.relative(here, file).replace(/\\/g, '/')
    const s = fs.readFileSync(file, 'utf8')
    for (const m of s.matchAll(/<(button|Button)\b/g)) {
      const end = tagEnd(s, m.index + m[0].length)
      if (end < 0) continue
      const attrs = s.slice(m.index, end)
      if (attrs.endsWith('/')) continue   // <Button … /> — its content comes from elsewhere
      const close = s.indexOf(`</${m[1]}>`, end)
      if (close < 0) continue
      const content = s.slice(end + 1, close)
      if (NAMED.test(attrs) || showsText(content)) continue
      found.push(`${rel}:${s.slice(0, m.index).split('\n').length}`)
    }
  }
  return found
}

describe('the check', () => {
  it('tells an icon-only button from one that shows text', () => {
    expect(showsText('<Play size={18} />')).toBe(false)
    expect(showsText('{playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} />}')).toBe(false)
    expect(showsText('<ArrowLeft size={18} /> Back')).toBe(true)
    expect(showsText("{busy ? 'Saving…' : 'Save'}")).toBe(true)
    expect(showsText('<Icon size={16} /> {label}')).toBe(true)
    expect(showsText('{done ? <><RotateCcw size={11} /> Back to To watch</> : <><Check size={11} /> Mark completed</>}')).toBe(true)
    expect(showsText('{isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}')).toBe(false)
  })
})

describe('the website', () => {
  it('names every button that shows only an icon (aria-label or title)', () => {
    expect(unnamedIconButtons()).toEqual([])
  })
})
