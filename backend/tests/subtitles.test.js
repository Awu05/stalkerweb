import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import { Subtitles, toWebVtt, resultsOf } from '../lib/subtitles.js'
import { SkipSegments } from '../lib/skipSegments.js'
import ViewersManager from '../viewers/ViewersManager.js'
import { createViewerContext } from '../lib/viewerContext.js'
import vodModule from '../routes/vod.js'

const SRT = '1\r\n00:00:01,500 --> 00:00:03,000\r\n{\\an8}Hello\r\n\r\n2\r\n00:01:02,000 --> 00:01:04,250\r\nTwo\nlines\r\n'
const SEARCH = {
  data: [
    { attributes: { language: 'en', download_count: 10, release: 'Breaking.Bad.S01E02.WEB', files: [{ file_id: 111, file_name: 'a.srt' }] } },
    { attributes: { language: 'en', download_count: 900, release: 'Breaking.Bad.S01E02.BluRay', hearing_impaired: true, files: [{ file_id: 222 }] } },
    { attributes: { language: 'es', download_count: 50, release: 'es', machine_translated: true, files: [{ file_id: 333 }] } },
    { attributes: { language: 'en', files: [] } },
  ],
}

// A fetch that answers from a table of URL patterns, recording each call.
function fakeFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url, init })
    for (const [re, answer] of routes) {
      if (!re.test(url)) continue
      const { status = 200, body, text } = typeof answer === 'function' ? answer(url, init) : answer
      return { status, ok: status < 300, json: async () => body, text: async () => text ?? JSON.stringify(body) }
    }
    return { status: 404, ok: false, json: async () => ({}), text: async () => '' }
  }
  fn.calls = calls
  return fn
}

describe('toWebVtt', () => {
  it('turns SRT into WebVTT, without ASS tags', () => {
    expect(toWebVtt(SRT)).toBe('WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nHello\n\n00:01:02.000 --> 00:01:04.250\nTwo\nlines\n')
  })

  it('moves every cue by the delay, dropping those moved before the start', () => {
    expect(toWebVtt(SRT, 2.5)).toContain('00:00:04.000 --> 00:00:05.500')
    const earlier = toWebVtt(SRT, -10)
    expect(earlier).not.toContain('Hello')
    expect(earlier).toContain('00:00:52.000 --> 00:00:54.250')
  })
})

describe('resultsOf', () => {
  it('lists each file once, by language, people-made and most downloaded first', () => {
    expect(resultsOf(SEARCH).map((r) => r.fileId)).toEqual(['222', '111', '333'])
    expect(resultsOf(SEARCH)[0]).toEqual({ fileId: '222', language: 'en', label: 'Breaking.Bad.S01E02.BluRay', downloads: 900, hearingImpaired: true, machine: false })
  })
})

describe('Subtitles', () => {
  const settings = (s = {}) => () => ({ apiKey: 'KEY', username: '', password: '', languages: 'es, en', ...s })

  it("searches an episode by its show's IMDb id, in the languages set", async () => {
    const fetch = fakeFetch([[/\/subtitles\?/, { body: SEARCH }]])
    const subs = new Subtitles(null, { settings: settings(), fetch })
    expect(await subs.search({ imdbId: 'tt0903747', season: 1, episode: 2 })).toHaveLength(3)
    expect(fetch.calls[0].url).toBe('https://api.opensubtitles.com/api/v1/subtitles?parent_imdb_id=903747&season_number=1&episode_number=2&languages=en%2Ces')
    expect(fetch.calls[0].init.headers['Api-Key']).toBe('KEY')
  })

  it('offers nothing without an API key', async () => {
    const fetch = fakeFetch([])
    const subs = new Subtitles(null, { settings: settings({ apiKey: '' }), fetch })
    expect(subs.configured()).toBe(false)
    expect(await subs.search({ imdbId: 'tt1', isMovie: true })).toEqual([])
    expect(fetch.calls).toEqual([])
  })

  it('downloads a file once (logged in when an account is set), then serves it with any delay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-subs-'))
    try {
      const fetch = fakeFetch([
        [/\/login$/, { body: { token: 'TOK', base_url: 'vip-api.opensubtitles.com' } }],
        [/vip-api\.opensubtitles\.com\/api\/v1\/download$/, { body: { link: 'https://dl.example/f.srt', remaining: 19 } }],
        [/dl\.example/, { text: SRT }],
      ])
      const subs = new Subtitles(dir, { settings: settings({ username: 'me', password: 'pw' }), fetch })
      expect(await subs.webVtt('222')).toContain('Hello')
      expect(fetch.calls.find((c) => c.url.endsWith('/download')).init.headers.Authorization).toBe('Bearer TOK')
      expect(await subs.webVtt('222', 1)).toContain('00:00:02.500')
      expect(fetch.calls.filter((c) => c.url.endsWith('/download'))).toHaveLength(1)
      // Kept on disk: a restart doesn't download it again.
      expect(await new Subtitles(dir, { settings: settings(), fetch: fakeFetch([]) }).webVtt('222')).toContain('Hello')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("says why, when OpenSubtitles won't give the file", async () => {
    const fetch = fakeFetch([[/\/download$/, { status: 406, body: { message: 'You have downloaded your allowed 5 subtitles for 24h' } }]])
    await expect(new Subtitles(null, { settings: settings(), fetch }).webVtt('9')).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/allowed 5/) })
  })

  it('refuses a file id that is not a number', async () => {
    await expect(new Subtitles(null, { settings: settings(), fetch: fakeFetch([]) }).webVtt('../x')).rejects.toMatchObject({ status: 404 })
  })
})

describe('/api/vod/subtitles', () => {
  let server, base, dir
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-subs-routes-'))
    const viewers = new ViewersManager(dir)
    viewers.ensureInitialized({})
    const fetch = fakeFetch([
      [/suggestion/, { body: { d: [{ id: 'tt0903747', l: 'Breaking Bad', qid: 'tvSeries', y: 2008, yr: '2008-2013' }] } }],
      [/\/subtitles\?/, { body: SEARCH }],
      [/\/download$/, { body: { link: 'https://dl.example/f.srt' } }],
      [/dl\.example/, { text: SRT }],
    ])
    const appState = { client: { getBasePath: () => 'http://portal/c/' }, sessionManager: { isAuthenticated: () => true } }
    const app = express()
    app.use(express.json())
    app.use(createViewerContext(viewers).middleware)
    app.use('/api/vod', vodModule(appState, { downloadDir: dir }, {
      skipSegments: new SkipSegments(null, { fetch }),
      subtitles: new Subtitles(null, { settings: () => ({ apiKey: 'KEY', languages: 'en' }), fetch }),
    }))
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}/api/vod/subtitles`
  })
  afterAll(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  it("lists an episode's subtitles, found through its show's IMDb match", async () => {
    const r = await (await fetch(`${base}?videoId=7&name=Breaking%20Bad&season=1&episode=2`)).json()
    expect(r).toMatchObject({ configured: true, imdbId: 'tt0903747' })
    expect(r.results.map((x) => x.fileId)).toEqual(['222', '111', '333'])
  })

  it("says so when the episode's season isn't known", async () => {
    const r = await (await fetch(`${base}?videoId=7&name=Breaking%20Bad&episode=2`)).json()
    expect(r).toMatchObject({ results: [], error: expect.stringMatching(/season/) })
  })

  it('serves a file as WebVTT, with the delay asked for', async () => {
    const r = await fetch(`${base}/file/222.vtt?offset=1`)
    expect(r.headers.get('content-type')).toMatch(/text\/vtt/)
    expect(await r.text()).toContain('00:00:02.500 --> 00:00:04.000')
    expect((await fetch(`${base}/file/abc.vtt`)).status).toBe(404)
  })
})
