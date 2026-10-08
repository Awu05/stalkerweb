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
    { start_timestamp: t + 1800, stop_timestamp: t + 3600, name: 'Weather' },
  ],
}

describe('guide categories', () => {
  const categoriesOf = (xml, title) => {
    const prog = xml.split('<programme ').find((p) => p.includes(`<title lang="en">${title}</title>`))
    return [...prog.matchAll(/<category lang="en">([^<]*)<\/category>/g)].map((m) => m[1])
  }

  it('adds the standard word Jellyfin sorts by next to the portal genre', () => {
    const xml = buildGuideXml({
      channels: [
        { uniqueId: '1', channelId: 1, name: 'Cartoon Network', genreId: '7', iconPath: '' },
        { uniqueId: '2', channelId: 2, name: 'Fox Sports 1',   genreId: '8', iconPath: '' },
        { uniqueId: '3', channelId: 3, name: 'Cooking',        genreId: '9', iconPath: '' },
      ],
      groups: [{ id: '7', name: 'ENGLISH | KIDS' }, { id: '8', name: 'USA' }, { id: '9', name: 'Lifestyle' }],
      epgData: {
        1: [{ start_timestamp: t, stop_timestamp: t + 1800, name: 'Gumball' }],
        2: [{ start_timestamp: t, stop_timestamp: t + 1800, name: 'Game Day' }],
        3: [{ start_timestamp: t, stop_timestamp: t + 1800, name: 'Bake Off', category: 'Movies' }],
      },
      now,
    }).xml

    expect(categoriesOf(xml, 'Gumball')).toEqual(['ENGLISH | KIDS', 'Kids'])
    expect(categoriesOf(xml, 'Game Day')).toEqual(['USA', 'Sports'])        // from the channel name
    expect(categoriesOf(xml, 'Bake Off')).toEqual(['Lifestyle', 'Movies', 'Movie']) // portal's own category
  })

  it('adds nothing when no rule applies, and never repeats a category', () => {
    const xml = buildGuideXml({
      channels: [{ uniqueId: '1', channelId: 1, name: 'Daily', genreId: '1', iconPath: '' }],
      groups: [{ id: '1', name: 'News' }],
      epgData: { 1: [{ start_timestamp: t, stop_timestamp: t + 1800, name: 'Morning', category: 'news' }] },
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

  it('honours ?filler=none', async () => {
    const xml = (await get(`${base}?filler=none`)).body.toString()
    expect(count(xml, 'programme')).toBe(2)
  })
})
