import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
const items = {
  5: [{ id: '100', name: 'Heat', year: '1995', added: '2024-01-02 00:00:00', screenshotUri: 'http://p/heat.jpg', cmd: '/media/100.mpg', isSeries: false, episodes: [], description: 'Robbers', categoryId: '5' }],
  6: [
    { id: '200', name: 'Bluey', year: '2018', added: '', screenshotUri: null, cmd: '', isSeries: true, episodes: [], description: '', categoryId: '6' },
    { id: '201', name: 'Old Show', year: '', added: '', screenshotUri: null, cmd: '', isSeries: true, episodes: ['1', '2'], description: '', categoryId: '6' },
  ],
}

describe('Xtream API', () => {
  let server, base
  const played = []
  const listed = []

  beforeAll(async () => {
    const proxyRouter = express.Router()
    proxyRouter.get(/.*/, (req, res) => { played.push({ path: req.path, query: { ...req.query } }); res.send('ok') })
    const m3uRouter = express.Router()
    m3uRouter.get('/', (req, res) => res.send(`m3u ${req.query.prefix ?? ''}`))

    const appState = {
      channelManager: {
        getChannels: () => channels,
        getGroups: () => groups,
        getChannel: (id) => channels.find((c) => c.uniqueId === String(id)) ?? null,
      },
      vodManager: {
        getCategories: async (type) => (type === 'vod' ? vodCategories : []),
        getAllItems: async (type, id) => { listed.push(`${type}:${id}`); return items[id] ?? [] },
        getSeasons: async (id) => (id === '200' ? [{ id: 's1', name: 'Season 1', seasonNumber: '1', screenshotUri: null }] : []),
        getEpisodes: async () => [
          { episodeId: 'e1', seriesNumber: '1', name: 'Magic Xylophone', screenshotUri: null },
          { episodeId: 'e2', seriesNumber: '2', name: 'Hospital', screenshotUri: null },
        ],
        resolveScreenshot: (uri) => `/api/logos/render?url=${encodeURIComponent(uri)}`,
      },
      getExportFilter: () => ({ keep: (c) => c.genreId !== '3' }),
      getShowAdult: () => false,
    }

    const app = express()
    app.use(xtreamModule(appState, { proxyRouter, m3uRouter, idStore: new XtreamIdStore(null) }))
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server?.close())

  const api = async (query) => (await fetch(`${base}/player_api.php?username=u&password=p&${query}`)).json()

  it('answers the login call with an active account and this server', async () => {
    const r = await api('')
    expect(r.user_info.auth).toBe(1)
    expect(r.user_info.status).toBe('Active')
    expect(r.server_info.url).toBe('127.0.0.1')
    expect(r.server_info.port).toBe(String(server.address().port))
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

  it('falls back to the movie categories for series when the portal has no series section', async () => {
    expect((await api('action=get_series_categories')).map((c) => c.category_name)).toEqual(['Action', 'Shows'])
    const shows = await api('action=get_series&category_id=6')
    expect(shows.map((s) => [s.name, s.series_id])).toEqual([['Bluey', 200], ['Old Show', 201]])
  })

  it('lists seasons and episodes, and plays an episode by its id', async () => {
    const info = await api('action=get_series_info&series_id=200')
    expect(info.seasons).toEqual([expect.objectContaining({ season_number: 1, name: 'Season 1', episode_count: 2 })])
    const [ep1, ep2] = info.episodes['1']
    expect(ep1).toMatchObject({ episode_num: 1, title: 'Magic Xylophone', season: 1 })
    expect(ep2.id).not.toBe(ep1.id)

    played.length = 0
    await fetch(`${base}/series/u/p/${ep2.id}.mp4`)
    expect(played).toEqual([{ path: '/vod/stream', query: { videoId: '200', series: '2', seasonId: 's1', episodeId: 'e2' } }])
  })

  it('numbers episodes listed on the title itself when the show has no seasons', async () => {
    await api('action=get_series&category_id=6') // indexes the show
    const info = await api('action=get_series_info&series_id=201')
    expect(info.episodes['1'].map((e) => e.episode_num)).toEqual([1, 2])

    played.length = 0
    await fetch(`${base}/series/u/p/${info.episodes['1'][1].id}.mp4`)
    expect(played[0].query).toEqual({ videoId: '201', series: '2' })
  })

  it('hands live and movie streams to the proxy', async () => {
    played.length = 0
    await fetch(`${base}/live/u/p/10.ts`)
    await fetch(`${base}/u/p/-42.m3u8`)
    await fetch(`${base}/movie/u/p/100.mp4`)
    expect(played).toEqual([
      { path: '/stream/10', query: {} },
      { path: '/stream/-42', query: {} },
      { path: '/vod/stream', query: { videoId: '100', cmd: '/media/100.mpg' } },
    ])
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
    const ref = { showId: '1', seasonId: '2', episodeId: '3', series: 4 }
    const id = store.idFor(ref)
    expect(store.idFor({ ...ref })).toBe(id)
    expect(store.idFor({ ...ref, series: 5 })).not.toBe(id)
    expect(store.get(id)).toEqual(ref)
    expect(store.get(12345)).toBeNull()
  })
})
