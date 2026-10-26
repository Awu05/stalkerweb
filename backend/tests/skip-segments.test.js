import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import { SkipSegments, cleanTitle, pickImdb, segmentsOf } from '../lib/skipSegments.js'
import ViewersManager from '../viewers/ViewersManager.js'
import { createViewerContext } from '../lib/viewerContext.js'
import vodModule from '../routes/vod.js'

// IMDb's suggestions for "breaking bad", as its search answers (trimmed).
const BREAKING_BAD = [
  { id: 'tt0903747', l: 'Breaking Bad', q: 'TV series', qid: 'tvSeries', y: 2008, yr: '2008-2013' },
  { id: 'in0000274', l: 'Breaking Bad', s: 'Franchise' },
  { id: 'tt9243946', l: 'El Camino: A Breaking Bad Movie', qid: 'movie', y: 2019 },
]
const INTRO = { intro: { start_sec: 314.5, end_sec: 331 }, recap: null, outro: { start_sec: 2843, end_sec: 2901 }, post_credits: null }

// A fetch that answers from a table of URL patterns, counting each call.
function fakeFetch(routes) {
  const calls = []
  const fn = async (url) => {
    calls.push(url)
    for (const [re, answer] of routes) {
      if (!re.test(url)) continue
      if (answer instanceof Error) throw answer
      const { status = 200, body } = typeof answer === 'function' ? answer(url) : answer
      return { status, ok: status >= 200 && status < 300, json: async () => body }
    }
    return { status: 404, ok: false, json: async () => ({}) }
  }
  fn.calls = calls
  return fn
}

describe('cleanTitle', () => {
  it('takes provider tags, quality marks, the season and the year off a name', () => {
    expect(cleanTitle('EN - Breaking Bad (2008) S02 [4K]')).toEqual({ title: 'Breaking Bad', year: '2008', season: '2' })
    expect(cleanTitle('|UK| The Office Season 3')).toEqual({ title: 'The Office', year: '', season: '3' })
    expect(cleanTitle('Dune 2021 4K')).toEqual({ title: 'Dune', year: '2021', season: '' })
    expect(cleanTitle('[MULTI-SUB] Shogun')).toEqual({ title: 'Shogun', year: '', season: '' })
  })

  it("keeps what belongs to the name: a colon, a future year, a year that is the name", () => {
    expect(cleanTitle('CSI: Miami').title).toBe('CSI: Miami')
    expect(cleanTitle('Blade Runner 2049')).toEqual({ title: 'Blade Runner 2049', year: '', season: '' })
    expect(cleanTitle('1917').title).toBe('1917')
  })
})

describe('pickImdb', () => {
  it('picks the series of that name and years, not the franchise or the film', () => {
    expect(pickImdb(BREAKING_BAD, { title: 'Breaking Bad', year: '2010', isMovie: false })).toEqual({ id: 'tt0903747', title: 'Breaking Bad', year: '2008' })
    expect(pickImdb(BREAKING_BAD, { title: 'El Camino', year: '2019', isMovie: true })?.id).toBe('tt9243946')
  })

  it("finds nothing when neither the name nor the year agrees, or none is of the right kind", () => {
    expect(pickImdb(BREAKING_BAD, { title: 'Something Else', year: '1990', isMovie: false })).toBe(null)
    expect(pickImdb([BREAKING_BAD[1]], { title: 'Breaking Bad', year: '', isMovie: false })).toBe(null)
    expect(pickImdb(undefined, { title: 'X', isMovie: false })).toBe(null)
  })
})

describe('segmentsOf', () => {
  it('reads seconds, and drops parts that make no sense', () => {
    expect(segmentsOf(INTRO)).toEqual({ intro: { start: 314.5, end: 331 }, recap: null, outro: { start: 2843, end: 2901 } })
    expect(segmentsOf({ intro: { start_sec: 50, end_sec: 10 } }).intro).toBe(null)
    expect(segmentsOf(null)).toEqual({ intro: null, recap: null, outro: null })
  })
})

describe('SkipSegments.lookup', () => {
  const routes = () => [
    [/media-imdb\.com\/suggestion\/b\/breaking%20bad\.json$/, { body: { d: BREAKING_BAD } }],
    [/introdb\.app\/segments\?imdb_id=tt0903747&season=1&episode=2$/, { body: INTRO }],
  ]

  it("finds the show on IMDb, then the episode's parts on IntroDB", async () => {
    const fetch = fakeFetch(routes())
    const skip = new SkipSegments(null, { fetch })
    const got = await skip.lookup({ portal: 'p', videoId: '7', name: 'EN - Breaking Bad', year: '2008', season: '1', episode: '2' })
    expect(got).toEqual({
      imdbId: 'tt0903747', match: { title: 'Breaking Bad', year: '2008', set: false, off: false },
      intro: { start: 314.5, end: 331 }, recap: null, outro: { start: 2843, end: 2901 },
    })
    // Asked again: from what's kept, not the sites.
    await skip.lookup({ portal: 'p', videoId: '7', name: 'EN - Breaking Bad', year: '2008', season: '1', episode: '2' })
    expect(fetch.calls).toHaveLength(2)
  })

  it('takes the season from the name when the portal gives none', async () => {
    const fetch = fakeFetch([[/suggestion/, { body: { d: BREAKING_BAD } }], [/season=3&episode=4$/, { body: INTRO }]])
    const got = await new SkipSegments(null, { fetch }).lookup({ videoId: '7', name: 'Breaking Bad S03', episode: '4' })
    expect(got.intro).toEqual({ start: 314.5, end: 331 })
  })

  it('asks for a movie as a movie', async () => {
    const fetch = fakeFetch([[/suggestion/, { body: { d: BREAKING_BAD } }], [/imdb_id=tt9243946&is_movie=true$/, { body: { outro: { start_sec: 5400, end_sec: 5700 } } }]])
    const got = await new SkipSegments(null, { fetch }).lookup({ videoId: '9', name: 'El Camino', year: '2019', isMovie: true })
    expect(got.outro).toEqual({ start: 5400, end: 5700 })
  })

  it('gives nothing to skip, and does not throw, when a site is down', async () => {
    const fetch = fakeFetch([[/suggestion/, new Error('ECONNRESET')]])
    const got = await new SkipSegments(null, { fetch }).lookup({ videoId: '7', name: 'Breaking Bad', season: '1', episode: '2' })
    expect(got).toMatchObject({ imdbId: null, intro: null, recap: null, outro: null })
  })

  it('remembers the match on disk, and uses a match set by hand, or none when off', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-skip-'))
    const file = path.join(dir, 'skip-matches.json')
    try {
      const fetch = fakeFetch([...routes(), [/introdb\.app\/segments\?imdb_id=tt1234567/, { body: { intro: { start_sec: 0, end_sec: 30 } } }]])
      const skip = new SkipSegments(file, { fetch })
      expect(() => skip.setMatch('p', '7', 'not an id')).toThrow(/IMDb id/)
      expect(skip.setMatch('p', '7', 'https://www.imdb.com/title/tt1234567/')).toMatchObject({ imdbId: 'tt1234567', set: true, off: false })
      skip.flush()
      const again = new SkipSegments(file, { fetch })
      expect((await again.lookup({ portal: 'p', videoId: '7', name: 'Breaking Bad', season: '1', episode: '2' })).intro).toEqual({ start: 0, end: 30 })
      expect(fetch.calls.some((u) => u.includes('suggestion'))).toBe(false)

      again.setMatch('p', '7', 'off')
      expect(await again.lookup({ portal: 'p', videoId: '7', name: 'Breaking Bad', season: '1', episode: '2' })).toMatchObject({ imdbId: null, match: { off: true }, intro: null })

      again.setMatch('p', '7', null)   // back to finding it by name
      expect((await again.lookup({ portal: 'p', videoId: '7', name: 'Breaking Bad', season: '1', episode: '2' })).imdbId).toBe('tt0903747')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('needs an episode number for an episode', async () => {
    const fetch = fakeFetch(routes())
    expect((await new SkipSegments(null, { fetch }).lookup({ videoId: '7', name: 'Breaking Bad' })).imdbId).toBe(null)
    expect(fetch.calls).toEqual([])
  })
})

describe('/api/vod/skip', () => {
  let server, base, dir, andy
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-skip-routes-'))
    const viewers = new ViewersManager(dir)
    viewers.ensureInitialized({})
    andy = viewers.create({ name: 'Andy' }).id
    viewers.setFilters(andy, { autoSkip: true })
    const fetch = fakeFetch([
      [/suggestion/, { body: { d: BREAKING_BAD } }],
      [/introdb\.app/, { body: INTRO }],
    ])
    const appState = { client: { getBasePath: () => 'http://portal/c/' }, sessionManager: { isAuthenticated: () => true } }
    const app = express()
    app.use(express.json())
    app.use(createViewerContext(viewers).middleware)
    app.use('/api/vod', vodModule(appState, { downloadDir: dir }, { skipSegments: new SkipSegments(null, { fetch }) }))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}/api/vod/skip`
  })
  afterAll(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  const call = async (method, p, body, viewer) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(viewer ? { 'X-Viewer': viewer } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: await r.json() }
  }

  it("answers with the episode's parts and the viewer's auto-skip choice", async () => {
    const q = '?videoId=7&name=Breaking%20Bad&season=1&episode=2'
    expect((await call('GET', q, null, andy)).body).toMatchObject({ imdbId: 'tt0903747', intro: { start: 314.5, end: 331 }, autoSkip: true })
    expect((await call('GET', q)).body.autoSkip).toBe(false)
  })

  it('sets a show\'s match by hand, and refuses what is not an IMDb id', async () => {
    expect((await call('PUT', '/match/7', { imdbId: 'off' }, andy)).body).toMatchObject({ off: true })
    expect((await call('PUT', '/match/7', { imdbId: 'nope' }, andy)).status).toBe(400)
    expect((await call('PUT', '/match/7', { imdbId: null }, andy)).body).toBe(null)
  })
})
