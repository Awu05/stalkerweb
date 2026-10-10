import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WatchStore from '../viewers/WatchStore.js'

const P = 'http://portal/c/'
let dir, store
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-watch-')); store = new WatchStore(dir) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const play = (key, position, duration = 6000, extra = {}) =>
  store.record('view_a', P, { key, title: `Title ${key}`, screenshotUrl: '', params: `videoId=${key}`, position, duration, ...extra })

describe('WatchStore', () => {
  it('keeps a resume point and a history entry for a title being watched', () => {
    const w = play('100', 600)
    expect(w.progress.map((e) => e.key)).toEqual(['100'])
    expect(w.history).toEqual([expect.objectContaining({ id: '100', key: '100', position: 600, finished: false })])
    expect(w.watched).toEqual([])
  })

  it('lists a show once, with the episode watched last', () => {
    play('200:s1:e1', 300)
    const w = play('200:s1:e2', 400, 6000, { episodeTitle: 'S1 · E2' })
    expect(w.history).toHaveLength(1)
    expect(w.history[0]).toMatchObject({ id: '200', key: '200:s1:e2', episodeTitle: 'S1 · E2' })
    expect(w.progress.map((e) => e.key)).toEqual(['200:s1:e2', '200:s1:e1'])   // each episode resumes on its own
  })

  it('keeps a finished title in the history, marked watched, without a resume point', () => {
    play('100', 600)
    const w = play('100', 5900)
    expect(w.progress).toEqual([])
    expect(w.history[0]).toMatchObject({ id: '100', finished: true })
    expect(w.watched).toEqual(['100'])
  })

  it('ignores a title only just started', () => {
    const w = play('300', 5)
    expect(w).toEqual({ progress: [], history: [], watched: [], list: [] })
  })

  it('keeps the newest 20 in the history', () => {
    for (let i = 1; i <= 25; i++) play(String(i), 600)
    const w = store.get('view_a', P)
    expect(w.history).toHaveLength(20)
    expect(w.history[0].id).toBe('25')
  })

  it('keeps viewers and portals apart', () => {
    play('100', 600)
    expect(store.get('view_b', P).history).toEqual([])
    expect(store.get('view_a', 'http://other/c/').history).toEqual([])
  })

  it('removes a title, or clears the history but remembers what was watched', () => {
    play('100', 5900)
    play('200', 600)
    expect(store.removeTitle('view_a', P, '200').history.map((e) => e.id)).toEqual(['100'])
    expect(store.get('view_a', P).progress).toEqual([])
    const w = store.clearHistory('view_a', P)
    expect(w.history).toEqual([])
    expect(w.watched).toEqual(['100'])
  })

  it('takes in the old shared progress list once, for the default viewer', () => {
    fs.writeFileSync(path.join(dir, 'vod-progress.json'), JSON.stringify([
      { key: '100', title: 'Heat', position: 600, duration: 6000, portal: P, params: 'videoId=100', updatedAt: 5 },
    ]))
    const fresh = new WatchStore(dir)
    expect(fresh.importLegacy('view_def')).toBe(true)
    expect(fresh.get('view_def', P).history[0]).toMatchObject({ id: '100', title: 'Heat' })
    expect(fresh.importLegacy('view_def')).toBe(false)
  })

  it('gives old entries saved with no portal to the first portal the viewer uses', () => {
    fs.writeFileSync(path.join(dir, 'vod-progress.json'), JSON.stringify([
      { key: '100', title: 'Heat', position: 600, duration: 6000, params: 'videoId=100', updatedAt: 5 },
    ]))
    const fresh = new WatchStore(dir)
    fresh.importLegacy('view_def')
    expect(fresh.get('view_def', P).history.map((e) => e.id)).toEqual(['100'])
    expect(fresh.get('view_def', P).progress[0]).toMatchObject({ key: '100', position: 600 })
    // moved for good: on disk, and not handed to another portal as well
    expect(new WatchStore(dir).get('view_def', 'http://other/c/').history).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'watch.json'), 'utf8')).view_def['']).toBeUndefined()
  })

  it('survives a restart', () => {
    play('100', 600)
    expect(new WatchStore(dir).get('view_a', P).history[0].id).toBe('100')
  })
})

describe('My List', () => {
  const heat = { id: '100', name: 'Heat', year: '1995', isSeries: false }
  const show = { id: '200', name: 'Bluey', isSeries: true }

  it('adds a title once, newest first, and removes it', () => {
    store.addToList('view_a', P, heat)
    store.addToList('view_a', P, show)
    const w = store.addToList('view_a', P, heat)
    expect(w.list.map((e) => e.id)).toEqual(['200', '100'])
    expect(w.list[1]).toMatchObject({ id: '100', item: { name: 'Heat', year: '1995' }, completedAt: null })
    expect(store.removeFromList('view_a', P, '200').list.map((e) => e.id)).toEqual(['100'])
  })

  it('moves a movie to Completed when it is finished, and keeps it', () => {
    store.addToList('view_a', P, heat)
    play('100', 600)
    expect(store.get('view_a', P).list[0].completedAt).toBe(null)
    const w = play('100', 5900)
    expect(w.list[0].completedAt).toEqual(expect.any(Number))
  })

  it('moves a show to Completed only after its last episode', () => {
    store.addToList('view_a', P, show)
    expect(play('200:s1:e1', 5900).list[0].completedAt).toBe(null)
    expect(play('200:s2:e9', 5900, 6000, { lastEpisode: true }).list[0].completedAt).toEqual(expect.any(Number))
  })

  it('can be moved between To watch and Completed by hand', () => {
    store.addToList('view_a', P, heat)
    expect(store.setListCompleted('view_a', P, '100', true).list[0].completedAt).toEqual(expect.any(Number))
    expect(store.setListCompleted('view_a', P, '100', false).list[0].completedAt).toBe(null)
  })

  it('belongs to the viewer', () => {
    store.addToList('view_a', P, heat)
    expect(store.get('view_b', P).list).toEqual([])
  })
})
