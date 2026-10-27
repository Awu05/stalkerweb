import { describe, it, expect } from 'vitest'
import { baseLanguage, languageName, byLanguage, startingChoice, clampDelay, delayLabel, subtitleFileUrl } from './subtitles'

const online = [
  { fileId: '1', language: 'en', downloads: 900, machine: false },
  { fileId: '2', language: 'en', downloads: 10, machine: false },
  { fileId: '3', language: 'es', downloads: 50, machine: true },
  { fileId: '4', language: 'es', downloads: 5, machine: false },
]

describe('languageName', () => {
  it('names a language from its code', () => {
    expect(languageName('en')).toBe('English')
    expect(languageName('pt-BR')).toMatch(/Portuguese/)
    expect(languageName('')).toBe('Unknown language')
  })
})

describe('baseLanguage', () => {
  it('matches three-letter and regional codes to two letters', () => {
    expect(baseLanguage('eng')).toBe('en')
    expect(baseLanguage('spa')).toBe('es')
    expect(baseLanguage('pt-BR')).toBe('pt')
    expect(baseLanguage('xx')).toBe('xx')
  })
})

describe('byLanguage', () => {
  it('groups the online subtitles by language, in the order given', () => {
    const g = byLanguage(online)
    expect(g.map((x) => x.language)).toEqual(['en', 'es'])
    expect(g[0].items.map((x) => x.fileId)).toEqual(['1', '2'])
  })
})

describe('startingChoice', () => {
  const embedded = [{ id: 0, language: 'fre' }, { id: 1, language: 'eng' }, { id: 2, language: 'spa' }]

  it("prefers the video's own subtitles in the language picked last", () => {
    expect(startingChoice({ kind: 'online', language: 'en' }, embedded, online)).toEqual({ kind: 'embedded', id: 1 })
  })

  it("falls back to OpenSubtitles' in that language, people-made first", () => {
    expect(startingChoice({ kind: 'online', language: 'es' }, [], online)).toEqual({ kind: 'online', id: '4' })
    expect(startingChoice({ kind: 'online', language: 'es' }, embedded, online)).toEqual({ kind: 'embedded', id: 2 })
  })

  it('starts with none when they were off, or none is in that language', () => {
    expect(startingChoice({ kind: 'off', language: '' }, embedded, online)).toBe(null)
    expect(startingChoice({ kind: 'online', language: 'de' }, embedded, online)).toBe(null)
  })
})

describe('the delay', () => {
  it('moves in half seconds, within a minute either way', () => {
    expect(clampDelay(1.3)).toBe(1.5)
    expect(clampDelay(-200)).toBe(-60)
    expect(delayLabel(1.5)).toBe('+1.5 s')
    expect(delayLabel(-0.5)).toBe('−0.5 s')
    expect(delayLabel(0)).toBe('0 s')
  })

  it('goes to the server with the file', () => {
    expect(subtitleFileUrl('222', 0)).toBe('/api/vod/subtitles/file/222.vtt')
    expect(subtitleFileUrl('222', -1.5)).toBe('/api/vod/subtitles/file/222.vtt?offset=-1.5')
  })
})
