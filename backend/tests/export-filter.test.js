import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { buildExportFilter } from '../lib/exportFilter.js'
import m3uModule from '../routes/m3u.js'
import xmltvModule from '../routes/xmltv.js'
import xspfModule from '../routes/xspf.js'

const ch = (uniqueId, name, genre) => ({ uniqueId, name, number: Number(uniqueId), genre, genreId: genre, iconPath: '' })
const channels = [
  ch('1', 'CNN',          'ENGLISH | NEWS'),
  ch('2', 'Cartoons',     'ENGLISH | KIDS'),
  ch('3', 'Zee',          'HINDI | ENTERTAINMENT'),
  ch('4', 'Late Night',   'FOR ADULTS'),
  ch('5', 'Sexy Movies',  'ENGLISH | MOVIES'),
  ch('6', 'No Genre',     ''),
]
const groups = [...new Set(channels.map((c) => c.genre).filter(Boolean))].map((g) => ({ id: g, name: g }))
const ids = (list) => list.map((c) => c.uniqueId)

describe('buildExportFilter', () => {
  it('drops hidden genres, hidden languages and adult channels; keeps genre-less ones', () => {
    const { keep } = buildExportFilter({
      profile: { disabledGenres: ['ENGLISH | KIDS'], disabledLanguages: ['HINDI'] },
      showAdult: false,
    })
    expect(ids(channels.filter(keep))).toEqual(['1', '6'])
  })

  it('keeps adult channels when Show Adult Content is on', () => {
    const { keep } = buildExportFilter({ profile: null, showAdult: true })
    expect(ids(channels.filter(keep))).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('gives a different key whenever the filter changes', () => {
    const a = buildExportFilter({ profile: { disabledGenres: ['X'] } }).key
    const b = buildExportFilter({ profile: { disabledGenres: ['Y'] } }).key
    const c = buildExportFilter({ profile: { disabledGenres: ['X'] } }).key
    expect(a).not.toBe(b)
    expect(a).toBe(c)
  })
})

describe('export routes', () => {
  let server, base
  let profile = { disabledGenres: ['ENGLISH | KIDS'], disabledLanguages: ['HINDI'] }

  beforeAll(async () => {
    const appState = {
      channelManager: { getChannels: () => channels, getGroups: () => groups },
      guideManager: { loadGuide: async () => ({}) },
      getExportFilter: () => buildExportFilter({ profile, showAdult: false }),
    }
    const app = express()
    app.use('/api/m3u', m3uModule(appState, null))
    app.use('/api/xmltv', xmltvModule(appState))
    app.use('/api/xspf', xspfModule(appState, null))
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server?.close())

  const get = (path) => fetch(`${base}${path}`).then((r) => r.text())
  const streamIds = (text) => [...text.matchAll(/\/proxy\/stream\/(\w+)/g)].map((m) => m[1]).sort()
  const guideIds  = (xml) => [...xml.matchAll(/<channel id="(\w+)">/g)].map((m) => m[1]).sort()

  it('M3U and VLC playlist leave out hidden and adult channels', async () => {
    expect(streamIds(await get('/api/m3u'))).toEqual(['1', '6'])
    expect(streamIds(await get('/api/xspf'))).toEqual(['1', '6'])
  })

  it('XMLTV guide lists the same channels as the M3U', async () => {
    expect(guideIds(await get('/api/xmltv'))).toEqual(['1', '6'])
  })

  it('?all=1 returns every channel', async () => {
    expect(streamIds(await get('/api/m3u?all=1'))).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(guideIds(await get('/api/xmltv?all=1'))).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('XMLTV picks up a filter change instead of serving the cached guide', async () => {
    expect(guideIds(await get('/api/xmltv'))).toEqual(['1', '6'])
    profile = { disabledGenres: [], disabledLanguages: [] }
    expect(guideIds(await get('/api/xmltv'))).toEqual(['1', '2', '3', '6'])
  })
})
