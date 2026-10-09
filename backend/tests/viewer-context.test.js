import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { createViewerContext } from '../lib/viewerContext.js'

const all = [
  { id: 'view_def', name: 'Default' },
  { id: 'view_andy', name: 'Andy' },
  { id: 'view_sam', name: 'Sam' },
]
const store = {
  get: (id) => all.find((v) => v.id === id) ?? null,
  getDefault: () => all[0],
  findByName: (n) => all.find((v) => v.id === String(n).toLowerCase() || v.name.toLowerCase() === String(n).toLowerCase()) ?? null,
}

describe('viewer context', () => {
  let server, base
  beforeAll(async () => {
    const ctx = createViewerContext(store)
    const app = express()
    app.use(express.json())
    app.use(ctx.middleware)
    const answer = async (req, res) => {
      await new Promise((r) => setTimeout(r, 5))
      res.json({ req: req.viewer.id, current: ctx.current()?.id, path: req.path })
    }
    app.get('/player_api.php', answer)
    app.get('/{*rest}', answer)
    await new Promise((r) => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server.close())

  const ask = async (path, headers = {}) => (await fetch(base + path, { headers })).json()

  it('uses the default viewer when none is named', async () => {
    expect(await ask('/api/m3u')).toEqual({ req: 'view_def', current: 'view_def', path: '/api/m3u' })
  })

  it('reads the X-Viewer header, and keeps it across await', async () => {
    expect(await ask('/api/favorites', { 'X-Viewer': 'view_andy' })).toMatchObject({ req: 'view_andy', current: 'view_andy' })
  })

  it('reads ?viewer=', async () => {
    expect(await ask('/api/m3u?viewer=view_sam')).toMatchObject({ req: 'view_sam', current: 'view_sam' })
  })

  it('reads a /v/<id>/ path segment and strips it before routing', async () => {
    expect(await ask('/v/view_andy/stremio/manifest.json')).toEqual({ req: 'view_andy', current: 'view_andy', path: '/stremio/manifest.json' })
  })

  it('matches an Xtream username to a viewer name, ignoring case', async () => {
    expect(await ask('/player_api.php?username=sam&password=x')).toMatchObject({ req: 'view_sam' })
    expect(await ask('/player_api.php?username=anyone&password=x')).toMatchObject({ req: 'view_def' })
  })

  it('prefers the header over the query and the path', async () => {
    expect(await ask('/v/view_sam/api/m3u?viewer=view_sam', { 'X-Viewer': 'view_andy' })).toMatchObject({ req: 'view_andy' })
  })

  it('falls back to the default for an unknown or deleted viewer', async () => {
    expect(await ask('/api/m3u?viewer=view_gone')).toMatchObject({ req: 'view_def' })
    expect(await ask('/v/view_gone/stremio/manifest.json')).toMatchObject({ req: 'view_def', path: '/stremio/manifest.json' })
    expect(await ask('/api/favorites', { 'X-Viewer': 'view_gone' })).toMatchObject({ req: 'view_def' })
  })
})
