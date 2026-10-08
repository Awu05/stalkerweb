import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import xspfModule from '../routes/xspf.js'

const { buildXspf } = xspfModule

const groups = [{ id: '1', name: 'News' }, { id: '2', name: 'Kids & Family' }]
const ch = (uniqueId, name, number, genreId) => ({ uniqueId, name, number, genreId, iconPath: '' })
const channels = [
  ch('a', 'Cartoons <HD>', 1, '2'),
  ch('b', 'CNN', 2, '1'),
  ch('c', 'Mystery', 3, '999'),
  ch('d', 'BBC News', 4, '1'),
]

// Track ids listed under each <vlc:node title="…">.
const folders = (xml) => Object.fromEntries(
  [...xml.matchAll(/<vlc:node title="([^"]*)">([\s\S]*?)<\/vlc:node>/g)]
    .map(([, title, body]) => [title, [...body.matchAll(/tid="(\d+)"/g)].map((m) => Number(m[1]))])
)
const trackTitles = (xml) => [...xml.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]).slice(1)

describe('buildXspf', () => {
  const xml = buildXspf(channels, groups, 'http://host:8983')

  it('puts each category in its own VLC folder, in genre order', () => {
    expect(Object.keys(folders(xml))).toEqual(['News', 'Kids &amp; Family', 'Other'])
  })

  it('places every track in exactly one folder', () => {
    const ids = Object.values(folders(xml)).flat().sort((a, b) => a - b)
    expect(ids).toEqual([0, 1, 2, 3])
    // Folder membership matches the track behind each id.
    const titles = trackTitles(xml)
    expect(folders(xml).News.map((i) => titles[i])).toEqual(['CNN', 'BBC News'])
  })

  it('points each track at the stream proxy and escapes XML', () => {
    expect(xml).toContain('<location>http://host:8983/proxy/stream/a</location>')
    expect(xml).toContain('<title>Cartoons &lt;HD&gt;</title>')
    expect(xml).not.toContain('<HD>')
  })
})

describe('GET /api/xspf', () => {
  let server, base
  beforeAll(async () => {
    const app = express()
    app.use('/api/xspf', xspfModule({ channelManager: { getChannels: () => channels, getGroups: () => groups } }, null))
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server?.close())

  it('serves an XSPF download', async () => {
    const res = await fetch(`${base}/api/xspf`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/xspf+xml')
    expect(res.headers.get('content-disposition')).toContain('stalkerweb.xspf')
    expect(await res.text()).toContain('xmlns:vlc="http://www.videolan.org/vlc/playlist/ns/0/"')
  })
})
