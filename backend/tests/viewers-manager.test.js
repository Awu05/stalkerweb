import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import ViewersManager from '../viewers/ViewersManager.js'

const { COLORS, ViewerError } = ViewersManager
let dir, viewers

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-viewers-'))
  viewers = new ViewersManager(dir)
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const statusOf = (fn) => { try { fn() } catch (e) { return e instanceof ViewerError ? e.status : 'other' } return null }

describe('first start', () => {
  it('creates a Default viewer from the shared favorites and filters', () => {
    const created = viewers.ensureInitialized({
      favorites: { channels: ['1', '2'], groups: [{ id: 'g1', name: 'News', channels: ['1'] }] },
      showAdult: true,
      disabledGenres: ['Sports'],
      disabledLanguages: ['FR'],
    })
    expect(created).toBe(true)
    const v = viewers.getDefault()
    expect(v).toMatchObject({ name: 'Default', showAdult: true, disabledGenres: ['Sports'], disabledLanguages: ['FR'] })
    expect(v.favorites.channels).toEqual(['1', '2'])
    expect(v.favorites.groups[0]).toMatchObject({ id: 'g1', name: 'News', channels: ['1'] })
  })

  it('gives an empty Default viewer when there is nothing to migrate', () => {
    viewers.ensureInitialized({})
    expect(viewers.getDefault()).toMatchObject({
      name: 'Default', showAdult: false, disabledGenres: [], disabledLanguages: [],
      favorites: { channels: [], groups: [] },
    })
  })

  it('does nothing once viewers.json exists', () => {
    viewers.ensureInitialized({ favorites: { channels: ['1'] } })
    viewers.create({ name: 'Andy' })
    expect(viewers.ensureInitialized({ favorites: { channels: ['9'] } })).toBe(false)
    expect(viewers.list().viewers.map(v => v.name)).toEqual(['Default', 'Andy'])
    expect(viewers.getDefault().favorites.channels).toEqual(['1'])
  })
})

describe('viewers', () => {
  beforeEach(() => viewers.ensureInitialized({}))

  it('creates a viewer with nothing hidden and no favorites', () => {
    const v = viewers.create({ name: '  Andy  ' })
    expect(v).toMatchObject({ name: 'Andy', showAdult: false, disabledGenres: [], favorites: { channels: [], groups: [] } })
    expect(COLORS).toContain(v.color)
    expect(v.id).toMatch(/^view_/)
  })

  it('refuses empty, too long and duplicate names, in any case', () => {
    viewers.create({ name: 'Andy' })
    expect(statusOf(() => viewers.create({ name: '   ' }))).toBe(400)
    expect(statusOf(() => viewers.create({ name: 'x'.repeat(31) }))).toBe(400)
    expect(statusOf(() => viewers.create({ name: 'andy' }))).toBe(409)
  })

  it('refuses a rename onto another viewer\'s name but allows changing its own case', () => {
    const a = viewers.create({ name: 'Andy' })
    const b = viewers.create({ name: 'Sam' })
    expect(statusOf(() => viewers.update(b.id, { name: 'ANDY' }))).toBe(409)
    expect(viewers.update(a.id, { name: 'ANDY' }).name).toBe('ANDY')
  })

  it('refuses names that are not text or hold control characters', () => {
    expect(statusOf(() => viewers.create({ name: {} }))).toBe(400)
    expect(statusOf(() => viewers.create({ name: 42 }))).toBe(400)
    expect(statusOf(() => viewers.create({ name: 'An\ndy' }))).toBe(400)
    expect(statusOf(() => viewers.create({ name: 'Andy\u0007' }))).toBe(400)
    expect(viewers.create({ name: 'Zoë' }).name).toBe('Zoë')
  })

  it('still finds a renamed viewer by its old name, unless someone now has that name', () => {
    const a = viewers.create({ name: 'Andy' })
    viewers.update(a.id, { name: 'Andrew' })
    expect(viewers.findByName('andy').id).toBe(a.id)      // an Xtream app set up with the old name
    expect(viewers.findByName('Andrew').id).toBe(a.id)
    const b = viewers.create({ name: 'Andy' })             // the old name is free to take
    expect(viewers.findByName('Andy').id).toBe(b.id)
  })

  it('only accepts palette colors', () => {
    const a = viewers.create({ name: 'Andy' })
    expect(statusOf(() => viewers.update(a.id, { color: 'red' }))).toBe(400)
    expect(viewers.update(a.id, { color: COLORS[3] }).color).toBe(COLORS[3])
  })

  it('never deletes the last viewer, and moves the default when it is deleted', () => {
    const def = viewers.getDefault()
    const a = viewers.create({ name: 'Andy' })
    viewers.remove(def.id)
    expect(viewers.getDefault().id).toBe(a.id)
    expect(statusOf(() => viewers.remove(a.id))).toBe(409)
    expect(statusOf(() => viewers.remove('view_missing'))).toBe(404)
  })

  it('finds a viewer by name or id, ignoring case', () => {
    const a = viewers.create({ name: 'Andy' })
    expect(viewers.findByName('andy').id).toBe(a.id)
    expect(viewers.findByName(a.id.toUpperCase()).id).toBe(a.id)
    expect(viewers.findByName('')).toBe(null)
    expect(viewers.findByName('nobody')).toBe(null)
  })

  it('saves each viewer\'s own filters, validating them', () => {
    const a = viewers.create({ name: 'Andy' })
    viewers.setFilters(a.id, { disabledGenres: ['Sports'], showAdult: true })
    expect(viewers.get(a.id)).toMatchObject({ disabledGenres: ['Sports'], disabledLanguages: [], showAdult: true })
    expect(viewers.getDefault().disabledGenres).toEqual([])
    expect(statusOf(() => viewers.setFilters(a.id, { disabledGenres: 'Sports' }))).toBe(400)
    expect(statusOf(() => viewers.setFilters(a.id, { showAdult: 'yes' }))).toBe(400)
  })
})

describe('reading viewers.json', () => {
  it('reads the file once, not on every request, yet sees an edit made by hand', () => {
    viewers.ensureInitialized({})
    const file = path.join(dir, 'viewers.json')
    const spy = vi.spyOn(fs, 'readFileSync')
    try {
      viewers.getDefault()
      viewers.list()
      viewers.findByName('Default')
      expect(spy.mock.calls.filter(([p]) => String(p) === file).length).toBeLessThanOrEqual(1)
    } finally {
      spy.mockRestore()
    }
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    d.viewers[0].name = 'Family'
    fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n'.repeat(3)) // a different size, like a hand edit
    expect(viewers.getDefault().name).toBe('Family')
  })

  it('does not keep a change whose save failed', () => {
    viewers.ensureInitialized({})
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk full') })
    try {
      expect(() => viewers.create({ name: 'Andy' })).toThrow('disk full')
    } finally {
      spy.mockRestore()
    }
    expect(viewers.list().viewers.map((v) => v.name)).toEqual(['Default'])
  })
})

describe('a viewers.json edited by hand', () => {
  it('copes with a viewer that has no name', () => {
    viewers.ensureInitialized({})
    const file = path.join(dir, 'viewers.json')
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    d.viewers.push({ id: 'view_noname', formerNames: 'x' })
    fs.writeFileSync(file, JSON.stringify(d))
    expect(viewers.findByName('nobody')).toBe(null)
    expect(viewers.list().viewers.map((v) => v.name)).toEqual(['Default', 'Viewer 2'])
    expect(viewers.create({ name: 'Andy' }).name).toBe('Andy')
  })
})

describe('an unreadable viewers.json', () => {
  it('is never overwritten: a temporary Default is served and changes are refused', () => {
    viewers.ensureInitialized({ favorites: { channels: ['1'] } })
    const file = path.join(dir, 'viewers.json')
    fs.writeFileSync(file, '{ "viewers": [ {"id": "view_a", ') // a hand edit gone wrong
    const before = fs.readFileSync(file, 'utf8')

    expect(viewers.list().viewers.length).toBe(1)
    expect(viewers.getDefault()).toBeTruthy()
    expect(statusOf(() => viewers.create({ name: 'Andy' }))).toBe(503)
    expect(statusOf(() => viewers.favoritesOf(viewers.getDefault().id).addChannel('2'))).toBe(503)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('recovers once the file is fixed', () => {
    viewers.ensureInitialized({})
    const file = path.join(dir, 'viewers.json')
    const good = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, 'not json')
    viewers.list()
    fs.writeFileSync(file, good)
    expect(viewers.create({ name: 'Andy' }).name).toBe('Andy')
  })
})

describe('favorites per viewer', () => {
  beforeEach(() => viewers.ensureInitialized({}))

  it('keeps two viewers\' favorites apart, even when written in turn', () => {
    const a = viewers.create({ name: 'Andy' })
    const b = viewers.create({ name: 'Sam' })
    const fa = viewers.favoritesOf(a.id)
    const fb = viewers.favoritesOf(b.id)
    fa.addChannel('1')
    fb.addChannel('2')
    fa.addChannel('3')
    const g = fb.createGroup('Kids')
    fb.addChannelToGroup(g.id, '2')
    expect(viewers.get(a.id).favorites).toEqual({ channels: ['1', '3'], groups: [] })
    expect(viewers.get(b.id).favorites.channels).toEqual(['2'])
    expect(viewers.get(b.id).favorites.groups[0]).toMatchObject({ name: 'Kids', channels: ['2'] })
  })

  it('survives a restart', () => {
    const a = viewers.create({ name: 'Andy' })
    viewers.favoritesOf(a.id).addChannel('7')
    const again = new ViewersManager(dir)
    expect(again.favoritesOf(a.id).getRaw().channels).toEqual(['7'])
  })

  it('migrates legacy ids per viewer', () => {
    const a = viewers.create({ name: 'Andy' })
    viewers.favoritesOf(a.id).addChannel('607446590')
    expect(viewers.favoritesOf(a.id).migrateLegacyIds(id => (id === '607446590' ? '90210' : null))).toBe(1)
    expect(viewers.get(a.id).favorites.channels).toEqual(['90210'])
  })
})
