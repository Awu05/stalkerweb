import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import stremioModule from '../routes/stremio.js'
import XtreamIdStore from '../lib/XtreamIdStore.js'

const groups = [{ id: '1', name: 'News' }, { id: '2', name: 'Kids & Family' }, { id: '3', name: 'Adult' }]
const ch = (uniqueId, name, number, genreId) =>
  ({ uniqueId, name, number, genreId, genre: null, iconPath: `http://logos/${uniqueId}.png`, channelId: Number(uniqueId) })
const channels = [
  ch('10', 'CNN', 1, '1'),
  ch('11', 'Cartoon Network', 2, '2'),
  ch('12', 'Hidden', 3, '3'),
  ...Array.from({ length: 150 }, (_, i) => ch(String(1000 + i), `Kids ${i}`, 10 + i, '2')),
]

const title = (id, name, extra = {}) =>
  ({ id, name, year: '', added: '', screenshotUri: null, cmd: '', isSeries: false, episodes: [], description: '', ...extra })
const vodCategories = [{ id: '*', title: 'All' }, { id: '5', title: 'Action' }, { id: '6', title: 'Shows' }]
const vodItems = {
  5: [title('100', 'Heat', { year: '1995', screenshotUri: 'http://p/heat.jpg', cmd: '/media/100.mpg', description: 'Robbers' })],
  6: [title('200', 'Bluey', { isSeries: true, added: '2024-01-02 00:00:00' })],
}

let portal
describe('Stremio addon', () => {
  let server, base

  beforeAll(async () => {
    const cache = new Map()
    const appState = {
      client: { getBasePath: () => portal },
      channelManager: {
        getChannels: () => channels,
        getGroups: () => groups,
        getChannel: (id) => channels.find((c) => c.uniqueId === String(id)) ?? null,
      },
      vodManager: {
        getCategories: async (type) => (type === 'vod' ? vodCategories : []),
        getAllItems: async (type, id) => { const items = vodItems[id] ?? []; cache.set(`${type}:${id}`, items); return items },
        peekAllItems: (type, id) => cache.get(`${type}:${id}`),
        getItems: async ({ search }) => ({ items: Object.values(vodItems).flat().filter((i) => i.name.toLowerCase().includes(search.toLowerCase())).map((i) => ({ ...i, categoryId: i.isSeries ? '6' : '5' })) }),
        getSeasons: async () => [{ id: 's1', name: 'Season 1', seasonNumber: '1', screenshotUri: null }],
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
    app.use('/stremio', stremioModule(appState, { idStore: new XtreamIdStore(null), version: '1.2.3' }))
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server?.close())

  let seq = 0
  beforeEach(() => { portal = `http://portal-${++seq}/c/` })

  const get = async (path) => (await fetch(`${base}/stremio${path}`)).json()

  it('describes one catalog per kind, with the categories as genres', async () => {
    const m = await get('/manifest.json')
    expect(m).toMatchObject({ id: 'com.stalkerweb.addon', version: '1.2.3', types: ['tv', 'movie', 'series'], idPrefixes: ['sw:'] })
    const genresOf = (type) => m.catalogs.find((c) => c.type === type).extra.find((e) => e.name === 'genre').options
    expect(genresOf('tv')).toEqual(['News', 'Kids & Family'])       // the hidden one is left out
    expect(genresOf('movie')).toEqual(['Action', 'Shows'])          // no "All"
    expect(genresOf('series')).toEqual(['Action', 'Shows'])         // no series section → movie categories
  })

  it('lists live channels of a genre, 100 per page', async () => {
    const genre = encodeURIComponent('Kids & Family')
    const page1 = await get(`/catalog/tv/sw-live/genre=${genre}.json`)
    const page2 = await get(`/catalog/tv/sw-live/genre=${genre}&skip=100.json`)
    expect(page1.metas).toHaveLength(100)
    expect(page1.metas[0]).toMatchObject({ id: 'sw:live:11', type: 'tv', name: 'Cartoon Network', posterShape: 'square', poster: 'http://logos/11.png' })
    expect(page2.metas).toHaveLength(51)
  })

  it('searches live channels by name', async () => {
    const { metas } = await get('/catalog/tv/sw-live/search=cnn.json')
    expect(metas.map((x) => x.name)).toEqual(['CNN'])
  })

  it('lists a movie category, and the first category with no genre chosen', async () => {
    const action = await get('/catalog/movie/sw-movies/genre=Action.json')
    expect(action.metas).toEqual([expect.objectContaining({
      id: 'sw:movie:100', type: 'movie', name: 'Heat', releaseInfo: '1995',
      poster: `${base}/api/logos/render?url=${encodeURIComponent('http://p/heat.jpg')}`,
    })])
    expect((await get('/catalog/movie/sw-movies.json')).metas.map((x) => x.name)).toEqual(['Heat'])
    expect((await get('/catalog/movie/sw-movies/genre=Nope.json')).metas).toEqual([])
  })

  it('searches movies and shows through the portal', async () => {
    expect((await get('/catalog/movie/sw-movies/search=heat.json')).metas.map((x) => x.id)).toEqual(['sw:movie:100'])
    expect((await get('/catalog/series/sw-series/search=blu.json')).metas.map((x) => x.id)).toEqual(['sw:series:200'])
  })

  it('gives a show its episodes, and plays one', async () => {
    await get('/catalog/series/sw-series/genre=Shows.json')
    const { meta } = await get('/meta/series/sw:series:200.json')
    expect(meta).toMatchObject({ id: 'sw:series:200', type: 'series', name: 'Bluey' })
    expect(meta.videos.map((v) => [v.season, v.episode, v.title])).toEqual([[1, 1, 'Magic Xylophone'], [1, 2, 'Hospital']])
    expect(meta.videos[0].released).toBe(new Date(Date.parse('2024-01-02 00:00:00')).toISOString())

    const { streams } = await get(`/stream/series/${meta.videos[1].id}.json`)
    expect(streams).toEqual([expect.objectContaining({
      url: `${base}/proxy/vod/stream?videoId=200&series=2&seasonId=s1&episodeId=e2`,
      behaviorHints: { notWebReady: true },
    })])
  })

  it('plays live channels and movies through the proxy', async () => {
    await get('/catalog/movie/sw-movies/genre=Action.json')
    expect((await get('/stream/tv/sw:live:10.json')).streams[0].url).toBe(`${base}/proxy/stream/10`)
    expect((await get('/stream/movie/sw:movie:100.json')).streams[0]).toMatchObject({
      url: `${base}/proxy/vod/stream?videoId=100&cmd=%2Fmedia%2F100.mpg`, title: 'Heat',
    })
  })

  it('answers unknown ids and catalogs with nothing', async () => {
    expect((await get('/stream/series/sw:ep:99999.json')).streams).toEqual([])
    expect((await get('/stream/tv/tt0111161.json')).streams).toEqual([])
    expect((await fetch(`${base}/stremio/catalog/movie/other.json`)).status).toBe(404)
  })
})
