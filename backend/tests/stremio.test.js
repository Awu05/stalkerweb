import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import express from 'express'
import stremioModule from '../routes/stremio.js'
import XtreamIdStore from '../lib/XtreamIdStore.js'
import { createViewerContext } from '../lib/viewerContext.js'

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
  5: [title('100', 'Heat', { year: '1995', screenshotUri: 'http://p/heat.jpg', cmd: '/media/100.mpg', description: 'Robbers' }),
    ...Array.from({ length: 249 }, (_, i) => title(String(5000 + i), `Action ${i}`))],
  6: [title('200', 'Bluey', { isSeries: true, added: '2024-01-02 00:00:00' })],
}

let portal, calls, seriesRejects, reconnects, channelList
const tag = () => crypto.createHash('sha1').update(portal).digest('hex').slice(0, 8)

describe('Stremio addon', () => {
  let server, base, appState

  beforeAll(async () => {
    const full = new Map()
    const vodManager = {
      getCategories: async (type) => {
        calls.push(`categories:${type}`)
        if (type === 'vod') return vodCategories
        if (seriesRejects) throw new Error('no series module')
        return []
      },
      getAllItems: async (type, id) => { calls.push(`all:${id}`); const items = vodItems[id] ?? []; full.set(`${portal}|${type}:${id}`, items); return items },
      peekAllItems: (type, id) => full.get(`${portal}|${type}:${id}`),
      getRange: async (type, id, start, count) => { calls.push(`range:${id}:${start}`); return { items: (vodItems[id] ?? []).slice(start, start + count), total: (vodItems[id] ?? []).length } },
      getItems: async ({ search }) => ({ items: Object.values(vodItems).flat().filter((i) => i.name.toLowerCase().includes(search.toLowerCase())).map((i) => ({ ...i, categoryId: i.isSeries ? '6' : '5' })) }),
      getSeasons: async () => [{ id: 's1', name: 'Season 1', seasonNumber: '1', screenshotUri: null }],
      getEpisodes: async () => [
        { episodeId: 'e1', seriesNumber: '1', name: 'Magic Xylophone', screenshotUri: null },
        { episodeId: 'e2', seriesNumber: '2', name: 'Hospital', screenshotUri: null },
      ],
      resolveScreenshot: (uri) => `/api/logos/render?url=${encodeURIComponent(uri)}`,
    }
    const channelManager = {
      getChannels: () => channelList,
      getGroups: () => groups,
      getChannel: (id) => channelList.find((c) => c.uniqueId === String(id)) ?? null,
      waitForChannel: async (id) => channels.find((c) => c.uniqueId === String(id)) ?? null, // as if loading finished
    }
    appState = {
      client: { getBasePath: () => portal },
      sessionManager: { isAuthenticated: () => true },
      channelManager,
      vodManager,
      getExportFilter: () => ({ keep: (c) => c.genreId !== '3' }),
      getShowAdult: () => false,
      ensureSession: async () => { reconnects++; appState.channelManager = channelManager; appState.vodManager = vodManager },
    }
    const app = express()
    // Viewers as the server resolves them (lib/viewerContext.js): /v/<id>/… links.
    const people = [{ id: 'view_def', name: 'Default' }, { id: 'view_andy', name: 'Andy' }]
    app.use(createViewerContext({
      get: (id) => people.find((v) => v.id === id) ?? null,
      getDefault: () => people[0],
      findByName: () => null,
    }).middleware)
    app.use('/stremio', stremioModule(appState, { idStore: new XtreamIdStore(null), version: '1.2.3' }))
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server?.close())

  let seq = 0
  beforeEach(() => {
    portal = `http://portal-${++seq}/c/`
    calls = []
    seriesRejects = false
    reconnects = 0
    channelList = channels
    // A fresh connection each test (the real app builds a new VodManager).
    if (appState) { appState.vodManager._noSeriesUntil = 0; appState.vodManager._lastSeries = null }
  })

  const get = async (path) => (await fetch(`${base}/stremio${path}`)).json()

  it('describes one catalog per kind, with the categories as genres', async () => {
    const m = await get('/manifest.json')
    expect(m).toMatchObject({ id: 'com.stalkerweb.addon', types: ['tv', 'movie', 'series'], idPrefixes: ['sw:'] })
    expect(m.version).toMatch(/^1\.2\.\d+$/)
    const genreOf = (type) => m.catalogs.find((c) => c.type === type).extra.find((e) => e.name === 'genre')
    expect(genreOf('tv').options).toEqual(['News', 'Kids & Family'])       // the hidden one is left out
    // No series section: "Shows" is named for shows, so it is a series
    // category (lib/seriesCategories.js) with a home board of its own.
    expect(genreOf('movie').options).toEqual(['Action'])                     // no "All"
    expect(genreOf('series')).toMatchObject({ options: ['Shows'], isRequired: false })
    expect(genreOf('movie').isRequired).toBe(false)
  })

  it("never hands one viewer the movie categories another viewer hid", async () => {
    const movieGenres = (m) => m.catalogs.find((c) => c.type === 'movie').extra.find((e) => e.name === 'genre').options
    expect(movieGenres(await get('/manifest.json'))).toContain('Action')
    appState.getHiddenVodCategories = () => new Set(['ACTION'])
    try {
      expect(movieGenres(await get('/manifest.json'))).not.toContain('Action')
    } finally {
      delete appState.getHiddenVodCategories
    }
  })

  it("gives each viewer's link its own addon id and name, so several can be installed", async () => {
    const viaLink = async (id) => (await fetch(`${base}/v/${id}/stremio/manifest.json`)).json()
    expect(await viaLink('view_andy')).toMatchObject({ id: 'com.stalkerweb.addon.view_andy', name: 'StalkerWeb (Andy)' })
    expect((await get('/manifest.json')).id).toBe('com.stalkerweb.addon')
  })

  it("keeps an addon's identity when its viewer becomes the default", async () => {
    // Deleting the default viewer makes another one the default; that viewer's
    // installed /v/<id> link must keep its own id, never take the plain one.
    expect((await (await fetch(`${base}/v/view_def/stremio/manifest.json`)).json()).id).toBe('com.stalkerweb.addon.view_def')
  })

  it('never hands one viewer the genres another viewer\'s filters allow', async () => {
    const tvGenres = (m) => m.catalogs.find((c) => c.type === 'tv').extra.find((e) => e.name === 'genre').options
    const own = appState.getExportFilter
    appState.getExportFilter = () => ({ keep: () => true, key: 'shows-everything' })
    try {
      expect(tvGenres(await get('/manifest.json'))).toContain('Adult')
    } finally {
      appState.getExportFilter = own
    }
    expect(tvGenres(await get('/manifest.json'))).not.toContain('Adult')
  })

  it('changes the manifest version when the categories change', async () => {
    const a = (await get('/manifest.json')).version
    portal = `${portal}other/`
    const b = (await get('/manifest.json')).version
    expect(b).not.toBe(a)
  })

  it('asks the portal for its series section once, not on every request', async () => {
    seriesRejects = true
    await get('/manifest.json')
    await get('/catalog/tv/sw-live.json')
    await get('/catalog/movie/sw-movies/genre=Action.json')
    await get('/manifest.json')
    expect(calls.filter((c) => c === 'categories:series')).toHaveLength(1)
  })

  it('lists live channels of a genre, 100 per page, with logos served through StalkerWeb', async () => {
    const genre = encodeURIComponent('Kids & Family')
    const page1 = await get(`/catalog/tv/sw-live/genre=${genre}.json`)
    const page2 = await get(`/catalog/tv/sw-live/genre=${genre}&skip=100.json`)
    expect(page1.metas).toHaveLength(100)
    expect(page1.metas[0]).toMatchObject({
      id: `sw:live:${tag()}:11`, type: 'tv', name: 'Cartoon Network', posterShape: 'square',
      poster: `${base}/api/logos/render?url=${encodeURIComponent('http://logos/11.png')}`,
    })
    expect(page2.metas).toHaveLength(51)
  })

  it('matches a genre whatever its case', async () => {
    expect((await get('/catalog/tv/sw-live/genre=news.json')).metas.map((x) => x.name)).toEqual(['CNN'])
  })

  it('searches live channels by name', async () => {
    const { metas } = await get('/catalog/tv/sw-live/search=cnn.json')
    expect(metas.map((x) => x.name)).toEqual(['CNN'])
  })

  it('reads only the pages a screen needs when the category is not cached yet', async () => {
    const first = await get('/catalog/movie/sw-movies/genre=Action.json')
    expect(first.metas).toHaveLength(100)
    expect(first.metas[0]).toMatchObject({
      id: `sw:movie:${tag()}:100`, name: 'Heat', releaseInfo: '1995',
      poster: `${base}/api/logos/render?url=${encodeURIComponent('http://p/heat.jpg')}`,
    })
    expect(calls).toContain('range:5:0')
    expect(calls).toContain('all:5')                 // the rest is read in the background

    calls = []
    const third = await get('/catalog/movie/sw-movies/genre=Action&skip=200.json')
    expect(third.metas).toHaveLength(50)
    expect(calls.filter((c) => c.startsWith('range'))).toEqual([]) // served from the full listing
  })

  it('uses the first category on the home board, and nothing for an unknown genre', async () => {
    expect((await get('/catalog/movie/sw-movies.json')).metas[0].name).toBe('Heat')
    expect((await get('/catalog/movie/sw-movies/genre=Nope.json')).metas).toEqual([])
  })

  it('searches movies and shows through the portal', async () => {
    expect((await get('/catalog/movie/sw-movies/search=heat.json')).metas.map((x) => x.id)).toEqual([`sw:movie:${tag()}:100`])
    expect((await get('/catalog/series/sw-series/search=blu.json')).metas.map((x) => x.id)).toEqual([`sw:series:${tag()}:200`])
  })

  it('gives a show its episodes, and plays one', async () => {
    await get('/catalog/series/sw-series/genre=Shows.json')
    const { meta } = await get(`/meta/series/sw:series:${tag()}:200.json`)
    expect(meta).toMatchObject({ type: 'series', name: 'Bluey' })
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
    expect((await get(`/stream/tv/sw:live:${tag()}:10.json`)).streams[0].url).toBe(`${base}/proxy/stream/10`)
    expect((await get(`/stream/movie/sw:movie:${tag()}:100.json`)).streams[0]).toMatchObject({
      url: `${base}/proxy/vod/stream?videoId=100&cmd=%2Fmedia%2F100.mpg`, title: 'Heat',
    })
  })

  it('waits for a live channel while the channel list is still loading', async () => {
    channelList = []   // just restarted: nothing listed yet
    expect((await get(`/stream/tv/sw:live:${tag()}:10.json`)).streams[0].url).toBe(`${base}/proxy/stream/10`)
  })

  it("won't play a saved item from another portal", async () => {
    const saved = `sw:movie:${tag()}:100`
    portal = `${portal}switched/`
    expect((await get(`/stream/movie/${saved}.json`)).streams).toEqual([])
    expect((await get(`/meta/movie/${saved}.json`)).meta.name).toBe('From another portal')
  })

  it('reconnects to the portal after an idle disconnect', async () => {
    const { channelManager } = appState
    appState.channelManager = null
    appState.vodManager = null
    const { metas } = await get('/catalog/tv/sw-live/genre=News.json')
    expect(reconnects).toBe(1)
    expect(metas.map((x) => x.name)).toEqual(['CNN'])
    appState.channelManager = channelManager
  })

  it('answers unknown ids and catalogs with nothing', async () => {
    expect((await get('/stream/series/sw:ep:99999.json')).streams).toEqual([])
    expect((await get('/stream/tv/tt0111161.json')).streams).toEqual([])
    expect((await fetch(`${base}/stremio/catalog/movie/other.json`)).status).toBe(404)
  })
})
