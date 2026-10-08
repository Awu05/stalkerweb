import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import m3uModule from '../routes/m3u.js'

const { groupChannels } = m3uModule

const groups = [
  { id: '1', name: 'News' },
  { id: '2', name: 'Sports' },
]
const ch = (uniqueId, name, number, genreId, genre = null) =>
  ({ uniqueId, name, number, genreId, genre, iconPath: '' })

describe('groupChannels', () => {
  it('keeps each category together, in genre order, by channel number', () => {
    const channels = [
      ch('a', 'Sports 1', 1, '2'),
      ch('b', 'News 1',   2, '1'),
      ch('c', 'Sports 2', 3, '2'),
      ch('d', 'News 2',   4, '1'),
    ]
    const out = groupChannels(channels, groups).map((x) => `${x.group}:${x.ch.uniqueId}`)
    expect(out).toEqual(['News:b', 'News:d', 'Sports:a', 'Sports:c'])
  })

  it('falls back to the parsed genre name, then "Other" — never an empty group', () => {
    const channels = [
      ch('x', 'Mystery', 9, '999'),            // unknown id, no name
      ch('y', 'Movie',   8, '777', 'Movies'),  // unknown id, but parsed name
      ch('z', 'News 1',  1, '1'),
    ]
    const out = groupChannels(channels, groups)
    expect(out.map((x) => x.group)).toEqual(['News', 'Movies', 'Other'])
  })
})

describe('GET /api/m3u', () => {
  let server, base

  beforeAll(async () => {
    const appState = {
      channelManager: {
        getGroups: () => groups,
        getChannels: () => [
          ch('a', 'Sports "Live"', 1, '2'),
          ch('b', 'News, Today',   2, '1'),
        ],
      },
    }
    const app = express()
    app.use('/api/m3u', m3uModule(appState, null))
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server?.close())

  it('writes grouped entries with group-title and #EXTGRP', async () => {
    const body = await (await fetch(`${base}/api/m3u`)).text()
    const lines = body.trim().split('\n')

    expect(lines[0]).toBe('#EXTM3U x-tvg-url=""')
    // News first (genre order), even though Sports has the lower channel number.
    expect(lines[1]).toContain('group-title="News"')
    expect(lines[2]).toBe('#EXTGRP:News')
    expect(lines[3]).toBe(`${base}/proxy/stream/b`)
    expect(lines[4]).toContain('group-title="Sports"')
    expect(lines[5]).toBe('#EXTGRP:Sports')
    // A quote in a name must not end the attribute early.
    expect(lines[4]).toContain(`tvg-name="Sports 'Live'"`)
  })
})
