import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import zlib from 'node:zlib'
import http from 'node:http'
import express from 'express'
import xmltvModule from '../routes/xmltv.js'

const { buildGuideXml } = xmltvModule
const count = (xml, tag) => (xml.match(new RegExp(`<${tag} `, 'g')) || []).length

const groups = [{ id: '1', name: 'News' }]
const channels = [
  { uniqueId: '10', channelId: 10, name: 'With EPG', genreId: '1', iconPath: '' },
  { uniqueId: '20', channelId: 20, name: 'No EPG',   genreId: '1', iconPath: '' },
]
const now = new Date('2026-10-08T13:20:00Z')
const t = Math.floor(now.getTime() / 1000)
const epgData = {
  10: [
    { start_timestamp: t, stop_timestamp: t + 1800, name: 'Headlines & More', descr: 'x' },
    { start_timestamp: t + 1800, stop_timestamp: t + 3600, name: 'Weather', category: 'Local Sports Desk' },
  ],
}

describe('guide categories', () => {
  const categoriesOf = (xml, title) => {
    const prog = xml.split('<programme ').find((p) => p.includes(`<title lang="en">${title}</title>`))
    return [...prog.matchAll(/<category lang="en">([^<]*)<\/category>/g)].map((m) => m[1])
  }

  const prog = (name, extra = {}) => [{ start_timestamp: t, stop_timestamp: t + 1800, name, ...extra }]
  const build = (opts = {}) => buildGuideXml({
    channels: [
      { uniqueId: '1', channelId: 1, name: 'Cartoon Network', genreId: '7', iconPath: '' },
      { uniqueId: '2', channelId: 2, name: 'ESPN',            genreId: '8', iconPath: '' },
      { uniqueId: '3', channelId: 3, name: 'HBO',             genreId: '8', iconPath: '' },
      { uniqueId: '4', channelId: 4, name: 'Hentai Toons',    genreId: '9', iconPath: '' },
      { uniqueId: '5', channelId: 5, name: 'Kids Placeholder', genreId: '7', iconPath: '' },
      { uniqueId: '6', channelId: 6, name: 'Loose',           genreId: '404', genre: 'UK | NEWS', iconPath: '' },
    ],
    groups: [{ id: '7', name: 'ENGLISH | KIDS' }, { id: '8', name: 'USA' }, { id: '9', name: 'XXX | KIDS' }],
    epgData: {
      1: prog('Gumball'),
      2: prog('Game Day'),
      3: prog('The Last of Us', { category: 'Drama' }),
      4: prog('Late Show'),
      6: prog('Headlines'),
    },
    now,
    ...opts,
  }).xml

  it('adds the standard word Jellyfin sorts by next to the portal genre', () => {
    expect(categoriesOf(build(), 'Gumball')).toEqual(['ENGLISH | KIDS', 'Kids'])
  })

  it('adds nothing when the genre says nothing — channel names are not used', () => {
    expect(categoriesOf(build(), 'Game Day')).toEqual(['USA'])
  })

  it("lets the portal's own programme category decide", () => {
    // HBO in genre USA, programme marked Drama: no guess of Movie.
    expect(categoriesOf(build(), 'The Last of Us')).toEqual(['USA', 'Drama'])
    const xml = buildGuideXml({
      channels: [{ uniqueId: '1', channelId: 1, name: 'Mixed', genreId: '1', iconPath: '' }],
      groups: [{ id: '1', name: 'ENGLISH | KIDS' }],
      epgData: { 1: prog('Feature', { category: 'Movie' }) },
      now,
    }).xml
    expect(categoriesOf(xml, 'Feature')).toEqual(['ENGLISH | KIDS', 'Movie'])  // not also Kids
  })

  it('never tags adult channels', () => {
    expect(categoriesOf(build(), 'Late Show')).toEqual(['XXX | KIDS'])
  })

  it('leaves filler blocks with only the genre name', () => {
    expect(categoriesOf(build(), 'Kids Placeholder')).toEqual(['ENGLISH | KIDS'])
  })

  it("uses the channel's parsed genre when its genre id is unknown", () => {
    expect(categoriesOf(build(), 'Headlines')).toEqual(['UK | NEWS', 'News'])
  })

  it('adds no standard words with categories: false (?categories=none)', () => {
    expect(categoriesOf(build({ categories: false }), 'Gumball')).toEqual(['ENGLISH | KIDS'])
  })

  it('never repeats a category', () => {
    const xml = buildGuideXml({
      channels: [{ uniqueId: '1', channelId: 1, name: 'Daily', genreId: '1', iconPath: '' }],
      groups: [{ id: '1', name: 'News' }],
      epgData: { 1: prog('Morning', { category: 'news' }) },
      now,
    }).xml
    expect(categoriesOf(xml, 'Morning')).toEqual(['News'])
  })
})

describe('buildGuideXml', () => {
  it('keeps every real EPG programme', () => {
    const { xml, realEpgCount } = buildGuideXml({ channels, groups, epgData, now })
    expect(realEpgCount).toBe(1)
    expect(xml).toContain('<title lang="en">Headlines &amp; More</title>')
    expect(xml).toContain('<title lang="en">Weather</title>')
  })

  it('fills channels without EPG with coarse 6-hour blocks over 7 days', () => {
    const { xml } = buildGuideXml({ channels, groups, epgData, now })
    // 2 real + 7 days × 4 blocks for the channel with no EPG.
    expect(count(xml, 'programme')).toBe(2 + 28)
    // Blocks are aligned to a 6-hour UTC boundary, not to "now".
    expect(xml).toContain('<programme start="20261008120000 +0000" stop="20261008180000 +0000" channel="20">')
  })

  it('omits filler entirely with filler=false', () => {
    const { xml, syntheticCount } = buildGuideXml({ channels, groups, epgData, filler: false, now })
    expect(syntheticCount).toBe(0)
    expect(count(xml, 'programme')).toBe(2)
    expect(count(xml, 'channel')).toBe(2) // channels are still listed
  })
})

describe('GET /api/xmltv', () => {
  let server, base

  beforeAll(async () => {
    const appState = {
      channelManager: { getChannels: () => channels, getGroups: () => groups },
      guideManager: { loadGuide: async () => epgData },
    }
    const app = express()
    app.use('/api/xmltv', xmltvModule(appState))
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    base = `http://127.0.0.1:${server.address().port}/api/xmltv`
  })
  afterAll(() => server?.close())

  // Raw request so we can see the encoding on the wire (fetch would decode it).
  const get = (url, headers = {}) => new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })

  it('sends gzip when the client accepts it', async () => {
    const { res, body } = await get(base, { 'Accept-Encoding': 'gzip, deflate' })
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers.vary).toMatch(/Accept-Encoding/)
    expect(zlib.gunzipSync(body).toString()).toContain('<tv ')
  })

  it('sends plain XML when the client does not accept gzip', async () => {
    const { res, body } = await get(base)
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(body.toString()).toContain('<tv ')
  })

  it('serves identical output from cache on repeat requests', async () => {
    const a = (await get(base)).body.toString()
    const b = (await get(base)).body.toString()
    expect(b).toBe(a)
  })

  it('honours ?categories=none, cached separately from the tagged feed', async () => {
    // "Weather" carries the portal category "Local Sports Desk" → Sports.
    const sports = '<category lang="en">Sports</category>'
    expect((await get(base)).body.toString()).toContain(sports)
    expect((await get(`${base}?categories=none`)).body.toString()).not.toContain(sports)
    expect((await get(base)).body.toString()).toContain(sports)
  })

  it('honours ?filler=none', async () => {
    const xml = (await get(`${base}?filler=none`)).body.toString()
    expect(count(xml, 'programme')).toBe(2)
  })
})
