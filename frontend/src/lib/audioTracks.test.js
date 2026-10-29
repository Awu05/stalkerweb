import { describe, it, expect } from 'vitest'
import { sameLanguage, channelsLabel, audioTrackLabels, preferredAudioTrack, audioLanguageOptions } from './audioTracks'

describe('sameLanguage', () => {
  it('matches two- and three-letter codes and regions by their language', () => {
    expect(sameLanguage('eng', 'en')).toBe(true)
    expect(sameLanguage('en-US', 'en')).toBe(true)
    expect(sameLanguage('ger', 'deu')).toBe(true)
    expect(sameLanguage('per', 'fa')).toBe(true)
    expect(sameLanguage('ukr', 'uk')).toBe(true)
    expect(sameLanguage('spa', 'en')).toBe(false)
    expect(sameLanguage('', 'en')).toBe(false)
    expect(sameLanguage('und', '')).toBe(false)
  })
})

describe('channelsLabel', () => {
  it('names the usual layouts', () => {
    expect(channelsLabel('6')).toBe('5.1')
    expect(channelsLabel(2)).toBe('Stereo')
    expect(channelsLabel('8')).toBe('7.1')
    expect(channelsLabel('')).toBe('')
  })
})

describe('audioTrackLabels', () => {
  it('names a track by its language', () => {
    expect(audioTrackLabels([{ id: 0, lang: 'eng' }, { id: 1, lang: 'spa' }]).map((t) => t.label)).toEqual(['English', 'Spanish'])
  })

  it('tells apart two in the same language by name, then channels, then number', () => {
    const labels = audioTrackLabels([
      { id: 0, lang: 'en', name: 'Commentary' },
      { id: 1, lang: 'en', channels: '6' },
      { id: 2, lang: 'en' },
      { id: 3, lang: 'fr' },
    ]).map((t) => t.label)
    expect(labels).toEqual(['English · Commentary', 'English · 5.1', 'English · Track 3', 'French'])
  })

  it('falls back to the track name, then its number, without a language', () => {
    expect(audioTrackLabels([{ id: 0, name: 'Main' }, { id: 1 }]).map((t) => t.label)).toEqual(['Main', 'Audio 2'])
  })
})

describe('preferredAudioTrack', () => {
  const tracks = [{ id: 0, lang: 'rus' }, { id: 1, lang: 'eng' }, { id: 2, lang: 'en' }]
  it('is the first track in the preferred language', () => {
    expect(preferredAudioTrack(tracks, 'en')).toBe(1)
  })
  it('is none without one in it, or without a preference', () => {
    expect(preferredAudioTrack(tracks, 'fr')).toBe(null)
    expect(preferredAudioTrack(tracks, '')).toBe(null)
  })
})

describe('audioLanguageOptions', () => {
  it('starts with the stream default, then languages by name as two-letter codes', () => {
    const opts = audioLanguageOptions()
    expect(opts[0]).toEqual({ code: '', name: 'Stream default' })
    expect(opts.find((o) => o.code === 'en').name).toBe('English')
    expect(opts.every((o, i) => i < 2 || o.name.localeCompare(opts[i - 1].name) >= 0)).toBe(true)
    expect(opts.slice(1).every((o) => /^[a-z]{2}$/.test(o.code))).toBe(true)
  })
})
