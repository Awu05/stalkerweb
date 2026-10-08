import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import xtreamModule from '../routes/xtream.js'
import XtreamIdStore from '../lib/XtreamIdStore.js'

const groups = [{ id: '1', name: 'News' }, { id: '2', name: 'Sports' }, { id: '3', name: 'Adult' }]
const ch = (uniqueId, name, number, genreId) =>
  ({ uniqueId, name, number, genreId, genre: null, iconPath: '', channelId: Number(uniqueId) })
const channels = [
  ch('10', 'ESPN', 1, '2'),
  ch('11', 'CNN', 2, '1'),
  ch('12', 'Hidden', 3, '3'),
  ch('13', 'Orphan', 4, ''),
]

const vodCategories = [
  { id: '*', title: 'All' },
  { id: '5', title: 'Action' },
  { id: '6', title: 'Shows' },
  { id: '7', title: 'XXX Adult' },
]
const title = (id, name, extra = {}) =>
  ({ id, name, year: '', added: '', screenshotUri: null, cmd: '', isSeries: false, episodes: [], description: '', ...extra })
const vodItems = {
  5: [title('100', 'Heat', { year: '1995', added: '2024-01-02 00:00:00', screenshotUri: 'http://p/heat.jpg', cmd: '/media/100.mpg', description: 'Robbers', categoryId: '5' })],
  6: [
    title('200', 'Bluey', { isSeries: true, categoryId: '6' }),
    title('201', 'Old Show', { isSeries: true, episodes: ['1', '2'], categoryId: '6' }),
  ],
}
// A portal with its own series section, where show 100 shares movie 100's id.
const seriesCategories = [{ id: '9', title: 'Cartoons' }]
const seriesItems = { 9: [title('100', 'Show One Hundred', { categoryId: '9' })] }

let portal, seriesMode, seasonCalls
const fakeVodManager = () => {
  const cache = new Map()
  return {
    getCategories: async (type) => {
      if (type === 'vod') return vodCategories
      if (seriesMode === 'reject') throw new Error('Portal error: no series module')
      return seriesMode === 'own' ? seriesCategories : []
    },
    getAllItems: async (type, id) => {
      const items = (type === 'series' ? seriesItems : vodItems)[id] ?? []
      cache.set(`${type}:${id}`, items)
      return items
    },
    peekAllItems: (type, id) => cache.get(`${type}:${id}`),
    getSeasons: async (id) => { seasonCalls++; return id === '200' ? [{ id: 's1', name: 'Season 1', seasonNumber: '1', screenshotUri: 'http://p/s1.jpg' }] : [] },
    getEpisodes: async () => [
      { episodeId: 'e1', seriesNumber: '1', name: 'Magic Xylophone', screenshotUri: null },
      { episodeId: 'e2', seriesNumber: '2', name: 'Hospital', screenshotUri: null },
    ],
    resolveScreenshot: (uri) => `/api/logos/render?url=${encodeURIComponent(uri)}`,
  }
}

describe('Xtream API', () => {
  let server, base, appState
  const played = []

  beforeAll(async () => {
    const proxyRouter = express.Router()
    proxyRouter.get(/.*/, (req, res) => { played.push({ path: req.path, query: { ...req.query } }); res.send('ok') })
    const m3uRouter = express.Router()
    m3uRouter.get('/', (req, res) => res.send(`m3u ${req.query.prefix ?? ''}`))

    appState = {
      client: { getBasePath: () => portal },
      channelManager: {
        getChannels: () => channels,
        getGroups: () => groups,
        getChannel: (id) => channels.find((c) => c.uniqueId === String(id)) ?? null,
      },
      vodManager: fakeVodManager(),
      getExportFilter: () => ({ keep: (c) => c.genreId !== '3' }),
      getShowAdult: () => false,
    }

    const app = express()
    app.use(xtreamModule(appState, { proxyRouter, m3uRouter, idStore: new XtreamIdStore(null), allTitlesWaitMs: 50 }))
    app.use((_req, res) => res.status(404).send('not found'))
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server?.close())
  // A fresh portal per test, so titles and seasons cached by one test (they
  // are per portal) don't leak into the next.
  let portalSeq = 0
  beforeEach(() => {
    portal = `http://portal-${++portalSeq}/c/`
    seriesMode = 'none'
    seasonCalls = 0
    played.length = 0
  })

  const api = async (query) => (await fetch(`${base}/player_api.php?username=u&password=p&${query}`)).json()

  it('answers the login call with an active account and this server', async () => {
    const r = await api('')
    expect(r.user_info.auth).toBe(1)
    expect(r.user_info.status).toBe('Active')
    expect(r.server_info.url).toBe('127.0.0.1')
    expect(r.server_info.port).toBe(String(server.address().port))
  })

  it('reports the port of an IPv6 host', async () => {
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/player_api.php?username=u&password=p', headers: { Host: '[::1]:8983' } }, (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => resolve(JSON.parse(data)))
      }).on('error', reject)
    })
    expect(body.server_info.port).toBe('8983')
  })

  it('lists live categories and channels, leaving out filtered ones', async () => {
    const cats = await api('action=get_live_categories')
    expect(cats.map((c) => c.category_name)).toEqual(['News', 'Sports', 'Other'])
    expect(cats[0].category_id).toBe('1')
    expect(Number(cats[2].category_id)).toBeGreaterThanOrEqual(900000) // no portal id

    const sports = await api('action=get_live_streams&category_id=2')
    expect(sports).toHaveLength(1)
    expect(sports[0]).toMatchObject({ name: 'ESPN', stream_id: 10, epg_channel_id: '10', category_id: '2' })

    const all = await api('action=get_live_streams')
    expect(all.map((s) => s.name)).toEqual(['CNN', 'ESPN', 'Orphan'])
  })

  it('lists movie categories without the "All" and adult ones, and movies without shows', async () => {
    const cats = await api('action=get_vod_categories')
    expect(cats.map((c) => c.category_name)).toEqual(['Action', 'Shows'])

    const movies = await api('action=get_vod_streams&category_id=5')
    expect(movies).toEqual([expect.objectContaining({
      name: 'Heat', stream_id: 100, category_id: '5', container_extension: 'mp4', added: String(Date.parse('2024-01-02 00:00:00') / 1000),
    })])
    expect(movies[0].stream_icon).toBe(`${base}/api/logos/render?url=${encodeURIComponent('http://p/heat.jpg')}`)
    expect(await api('action=get_vod_streams&category_id=6')).toEqual([])

    const info = await api('action=get_vod_info&vod_id=100')
    expect(info.info.plot).toBe('Robbers')
    expect(info.movie_data.stream_id).toBe(100)
  })

  it('lists every movie without a category_id', async () => {
    const all = await api('action=get_vod_streams')
    expect(all.map((m) => m.name)).toEqual(['Heat'])
  })

  it('falls back to the movie categories for series when the portal has no series section', async () => {
    expect((await api('action=get_series_categories')).map((c) => c.category_name)).toEqual(['Action', 'Shows'])
    const shows = await api('action=get_series&category_id=6')
    expect(shows.map((s) => [s.name, s.series_id])).toEqual([['Bluey', 200], ['Old Show', 201]])
  })

  it('also falls back when the portal rejects the series section', async () => {
    seriesMode = 'reject'
    const cats = await (await fetch(`${base}/player_api.php?action=get_series_categories`)).json()
    expect(cats.map((c) => c.category_name)).toEqual(['Action', 'Shows'])
  })

  it('keeps a movie and a show with the same id apart', async () => {
    seriesMode = 'own'
    await api('action=get_vod_streams&category_id=5')
    await api('action=get_series&category_id=9')

    expect((await api('action=get_vod_info&vod_id=100')).info.name).toBe('Heat')
    await fetch(`${base}/movie/u/p/100.mp4`)
    expect(played[0].query).toEqual({ videoId: '100', cmd: '/media/100.mpg' })
    expect((await api('action=get_series_info&series_id=100')).info.name).toBe('Show One Hundred')
  })

  it('lists seasons and episodes, and plays an episode by its id', async () => {
    const info = await api('action=get_series_info&series_id=200')
    expect(info.seasons).toEqual([expect.objectContaining({ season_number: 1, name: 'Season 1', episode_count: 2 })])
    const [ep1, ep2] = info.episodes['1']
    expect(ep1).toMatchObject({ episode_num: 1, title: 'Magic Xylophone', season: 1 })
    expect(ep2.id).not.toBe(ep1.id)

    await fetch(`${base}/series/u/p/${ep2.id}.mp4`)
    expect(played).toEqual([{ path: '/vod/stream', query: { videoId: '200', series: '2', seasonId: 's1', episodeId: 'e2' } }])
  })

  it('caches a show\'s seasons but builds image URLs for each caller', async () => {
    await api('action=get_series_info&series_id=200')
    const other = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/player_api.php?action=get_series_info&series_id=200', headers: { Host: 'tv.example:9000' } }, (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => resolve(JSON.parse(data)))
      }).on('error', reject)
    })
    expect(seasonCalls).toBe(1)
    expect(other.seasons[0].cover.startsWith('http://tv.example:9000/')).toBe(true)
  })

  it('numbers episodes listed on the title itself, even if the show was opened before it was listed', async () => {
    // Right after a restart: the player opens the show before any listing.
    expect((await api('action=get_series_info&series_id=201')).episodes).toEqual({})

    await api('action=get_series&category_id=6') // indexes the show
    const info = await api('action=get_series_info&series_id=201')
    expect(info.episodes['1'].map((e) => e.episode_num)).toEqual([1, 2])

    await fetch(`${base}/series/u/p/${info.episodes['1'][1].id}.mp4`)
    expect(played[0].query).toEqual({ videoId: '201', series: '2' })
  })

  it('forgets one portal\'s titles and episodes when another is connected', async () => {
    await api('action=get_vod_streams&category_id=5')
    const ep = (await api('action=get_series_info&series_id=200')).episodes['1'][0]

    portal = 'http://portal-other/c/'
    expect((await api('action=get_vod_info&vod_id=100')).info.name).toBe('')
    expect((await fetch(`${base}/series/u/p/${ep.id}.mp4`)).status).toBe(404)

    await fetch(`${base}/movie/u/p/100.mp4`)
    expect(played).toEqual([{ path: '/vod/stream', query: { videoId: '100' } }]) // no portal-A cmd
  })

  it('hands live and movie streams to the proxy', async () => {
    await api('action=get_vod_streams&category_id=5')
    await fetch(`${base}/live/u/p/10.ts`)
    await fetch(`${base}/live/u/p/-42.m3u8`)
    await fetch(`${base}/movie/u/p/100.mp4`)
    expect(played).toEqual([
      { path: '/stream/10', query: {} },
      { path: '/stream/-42', query: {} },
      { path: '/vod/stream', query: { videoId: '100', cmd: '/media/100.mpg' } },
    ])
  })

  it('does not treat a stray three-part URL as a stream', async () => {
    expect((await fetch(`${base}/foo/bar/16801`)).status).toBe(404)
    expect(played).toEqual([])
  })

  it('serves the M3U through get.php with its query', async () => {
    expect(await (await fetch(`${base}/get.php?username=u&password=p&prefix=1`)).text()).toBe('m3u 1')
  })

  it('rejects an unknown episode id', async () => {
    expect((await fetch(`${base}/series/u/p/99999.mp4`)).status).toBe(404)
  })
})

describe('XtreamIdStore', () => {
  it('gives an episode the same id every time and maps it back', () => {
    const store = new XtreamIdStore(null)
    const ref = { portal: 'http://a/', showId: '1', seasonId: '2', episodeId: '3', series: 4 }
    const id = store.idFor(ref)
    expect(store.idFor({ ...ref })).toBe(id)
    expect(store.idFor({ ...ref, series: 5 })).not.toBe(id)
    expect(store.idFor({ ...ref, portal: 'http://b/' })).not.toBe(id)
    expect(store.get(id)).toEqual(ref)
    expect(store.get(12345)).toBeNull()
  })

  it('writes new ids on flush, so a restart keeps them', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xtream-ids-')), 'ids.json')
    const store = new XtreamIdStore(file)
    const id = store.idFor({ portal: 'p', showId: '7' })
    store.flush()   // what shutdown calls, before the 1s save timer fires

    const reloaded = new XtreamIdStore(file)
    expect(reloaded.get(id)).toMatchObject({ portal: 'p', showId: '7' })
    expect(reloaded.idFor({ portal: 'p', showId: '8' })).toBe(id + 1)
  })
})
