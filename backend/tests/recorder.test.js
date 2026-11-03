import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { Writable } from 'stream'
import { getEventListeners } from 'events'
import { makeTs } from './helpers/makeTs.js'

const require = createRequire(import.meta.url)
const { startRecording, cachedFreeBytes } = require('../recordings/Recorder.js')

const GB = 1024 ** 3
let dir, file
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-recorder-')); file = path.join(dir, 'News 24 – Evening News.ts') })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms))
const untilAborted = (signal) => new Promise((r) => (signal.aborted ? r() : signal.addEventListener('abort', r, { once: true })))

// A clock the test moves, and a reader that plays a script of steps.
function setup({ steps, free = () => 10 * GB }) {
  const clock = { t: 1_000_000 }
  let calls = 0
  const reader = async (_url, { onData, onBreak, signal }) => {
    calls += 1
    for (const step of steps(calls)) {
      if (signal.aborted) return
      if (step === 'break') onBreak()
      else if (step === 'gaveUp') throw Object.assign(new Error('the channel stopped answering'), { gaveUp: true })
      else if (step === 'unsupported') return 'unsupported'
      else onData(step)
      await tick(5)
    }
    await untilAborted(signal)
  }
  const run = (o = {}) => startRecording({
    url: 'http://127.0.0.1:8983/proxy/stream/7', filePath: file, endAt: clock.t + 60_000,
    now: () => clock.t, freeBytes: free, reader, checkEveryMs: 5, retryMs: 5, ...o,
  })
  return { clock, run, calls: () => calls }
}

// The file and its index: pieces one after another, each starting on a TS packet, adding up to the file.
function pieces(f) {
  const idx = fs.readFileSync(f + '.index', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const buf = fs.readFileSync(f)
  let at = 0
  for (const p of idx) { expect(p.o).toBe(at); expect(buf[p.o]).toBe(0x47); at += p.l }
  expect(at).toBe(buf.length)
  return idx
}

const MIN = 60_000
const A = makeTs({ seconds: 2 })
const B = makeTs({ seconds: 2, startPts: 900_000 })

describe('startRecording', () => {
  it('writes the stream to one .ts file and renames it at the end time', async () => {
    const s = setup({ steps: () => [A] })
    const done = s.run()
    await tick(40)
    expect(fs.existsSync(file + '.part')).toBe(true)
    s.clock.t += 61_000
    const r = await done
    expect(r.status).toBe('done')
    expect(r.bytes).toBe(fs.statSync(file).size)
    expect(pieces(file).length).toBeGreaterThan(0)
    expect(fs.existsSync(file + '.part')).toBe(false)
    expect(fs.existsSync(file + '.part.index')).toBe(false)
  })

  it('carries on across a source restart', async () => {
    const s = setup({ steps: () => [A, 'break', B] })
    const done = s.run()
    await tick(60)
    s.clock.t += 61_000
    const r = await done
    expect(r.status).toBe('done')
    const idx = pieces(file)
    expect(idx.some((p) => p.disc)).toBe(true)          // the restart is marked where it happened
    expect(idx.reduce((t, p) => t + p.d, 0)).toBeCloseTo(4, 0)
  })

  it('opens the channel again when the reader gives up, until the end time', async () => {
    const s = setup({ steps: (n) => (n === 1 ? [A, 'gaveUp'] : [B]) })
    const done = s.run()
    await tick(80)
    s.clock.t += 61_000
    const r = await done
    expect(s.calls()).toBeGreaterThanOrEqual(2)
    expect(r.status).toBe('done')
    expect(pieces(file).reduce((t, p) => t + p.d, 0)).toBeCloseTo(4, 0)
  })

  it('fails when the source sends nothing for too long', async () => {
    const s = setup({ steps: () => [] })
    const done = s.run()
    await tick(30)
    s.clock.t += 61_000
    const r = await done
    expect(r).toMatchObject({ status: 'failed', bytes: 0 })
    expect(r.error).toMatch(/stopped sending|nothing/i)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(file + '.part')).toBe(false)
    expect(fs.existsSync(file + '.part.index')).toBe(false)
  })

  it('stopping early keeps what was recorded', async () => {
    const s = setup({ steps: () => [A] })
    const ac = new globalThis.AbortController()
    const done = s.run({ signal: ac.signal })
    await tick(40)
    ac.abort()
    const r = await done
    expect(r.status).toBe('done')
    expect(r.bytes).toBeGreaterThan(0)
    pieces(file)
  })

  it('disk full stops cleanly with what it has', async () => {
    let free = 10 * GB
    const s = setup({ steps: () => [A, B], free: () => free })
    const done = s.run()
    await tick(8)
    free = 0
    const r = await done
    expect(r.status).toBe('done')
    expect(r.error).toMatch(/disk filled up/i)
    expect(fs.statSync(file).size).toBeGreaterThan(0)
  })

  it('refuses to start with under 1 GB free', async () => {
    const s = setup({ steps: () => [A], free: () => GB - 1 })
    const r = await s.run()
    expect(r).toMatchObject({ status: 'failed', bytes: 0 })
    expect(r.error).toMatch(/1 GB/)
    expect(s.calls()).toBe(0)
    expect(fs.existsSync(file + '.part')).toBe(false)
  })

  it('an encrypted or fMP4 channel fails with the reason', async () => {
    const s = setup({ steps: () => ['unsupported'] })
    const r = await s.run({ reader: async (_u, o) => { o.onUnsupported('encrypted') } })
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/can't be recorded/i)
  })

  it('a shutdown leaves the .part and its index for the next start to keep as part 1', async () => {
    const s = setup({ steps: () => [A] })
    const ac = new globalThis.AbortController()
    const done = s.run({ signal: ac.signal })
    await tick(40)
    ac.abort('shutdown')
    const r = await done
    expect(r.status).toBe('shutdown')
    expect(r.bytes).toBeGreaterThan(0)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.statSync(file + '.part').size).toBe(r.bytes)
    expect(fs.readFileSync(file + '.part.index', 'utf8').trim().split('\n').length).toBeGreaterThan(0)
  })

  // A file stream that takes `ms` to finish each write (a slow disk).
  const slowFile = (ms) => (p) => {
    const real = fs.createWriteStream(p)
    return new Writable({
      write(chunk, _enc, cb) { setTimeout(() => real.write(chunk, cb), ms) },
      final(cb) { real.end(cb) },
    })
  }
  const LONG = makeTs({ seconds: 12, keyEvery: 2 })

  it('writes an index line only once its piece is in the file', async () => {
    const s = setup({ steps: () => [LONG] })
    const ac = new globalThis.AbortController()
    const done = s.run({ signal: ac.signal, openFile: slowFile(300) })
    await tick(60)
    // A piece is closed and queued, but the disk hasn't taken it yet: the index doesn't list it.
    expect(fs.readFileSync(file + '.part.index', 'utf8')).toBe('')
    ac.abort()
    const r = await done
    expect(r.status).toBe('done')
    pieces(file)
  })

  it('stops with what is on disk when the disk can\'t keep up', async () => {
    const s = setup({ steps: () => [LONG, LONG] })
    const r = await s.run({ openFile: slowFile(20), maxBacklog: 1 })
    expect(r.status).toBe('done')
    expect(r.error).toMatch(/couldn't keep up/i)
    expect(r.bytes).toBe(fs.statSync(file).size)
    pieces(file)
  })

  it('keeps no closed pieces in memory, and cuts pieces at the size it\'s given', async () => {
    const counts = []
    for (const maxPieceBytes of [undefined, 20_000]) {
      const s = setup({ steps: () => [LONG] })
      const ac = new globalThis.AbortController()
      const done = s.run({ signal: ac.signal, ...(maxPieceBytes ? { maxPieceBytes } : {}) })
      await tick(40)
      ac.abort()
      await done
      counts.push(pieces(file).length)
      fs.rmSync(file); fs.rmSync(file + '.index')
    }
    expect(counts[1]).toBeGreaterThan(counts[0])
  })

  it('waits between tries without piling up abort listeners', async () => {
    const seen = []
    const ac = new globalThis.AbortController()
    const reader = async (_u, { signal }) => {
      seen.push(getEventListeners(signal, 'abort').length)
      if (seen.length >= 12) ac.abort()
      throw Object.assign(new Error('the channel stopped answering'), { gaveUp: true })
    }
    const r = await startRecording({ url: 'u', filePath: file, endAt: null, signal: ac.signal, freeBytes: () => 10 * GB, reader, checkEveryMs: 5, retryMs: 1 })
    expect(r.status).toBe('failed')
    expect(seen.length).toBeGreaterThanOrEqual(12)
    expect(new Set(seen.slice(1)).size).toBe(1)
    expect(seen.at(-1)).toBe(seen[1])
  })

  // A source that's down: each try takes 10 minutes of the test's clock and gives up.
  const downFor = (clock, first = []) => {
    let calls = 0
    const reader = async (_u, { onData }) => {
      calls += 1
      if (calls === 1) for (const b of first) onData(b)
      clock.t += 10 * MIN
      throw Object.assign(new Error('the channel stopped answering'), { gaveUp: true })
    }
    return { reader, calls: () => calls }
  }

  it('an until-stopped recording gives up after 30 minutes with no source: done with what it has, failed with nothing', async () => {
    for (const [first, status] of [[[], 'failed'], [[LONG], 'done']]) {
      const clock = { t: 1_000_000 }
      const d = downFor(clock, first)
      const r = await startRecording({ url: 'u', filePath: file, endAt: null, now: () => clock.t, freeBytes: () => 10 * GB, reader: d.reader, checkEveryMs: 5, retryMs: 1 })
      expect(r.status).toBe(status)
      expect(r.error).toMatch(/30 minutes/)
      expect(d.calls()).toBeLessThanOrEqual(4)
      fs.rmSync(file, { force: true }); fs.rmSync(file + '.index', { force: true })
    }
  })

  it('a booked recording rides out a long outage until its end', async () => {
    const clock = { t: 1_000_000 }
    const d = downFor(clock, [LONG])
    const r = await startRecording({ url: 'u', filePath: file, endAt: clock.t + 120 * MIN, now: () => clock.t, freeBytes: () => 10 * GB, reader: d.reader, checkEveryMs: 5, retryMs: 1 })
    expect(r.status).toBe('done')
    expect(d.calls()).toBeGreaterThan(4)
    expect(r.error).toBeUndefined()
  })
})


describe('cachedFreeBytes', () => {
  const stat = (bavail) => ({ bavail, bsize: 4096 })

  it('looks once per interval, and a folder not made yet by the one above it', async () => {
    const asked = []
    const c = { t: 0 }
    const statfs = async (d) => {
      asked.push(d)
      if (d === path.join('/data', 'recordings')) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return stat(10)
    }
    const free = cachedFreeBytes(path.join('/data', 'recordings'), { ttlMs: 30_000, now: () => c.t, statfs })
    expect(await free()).toBe(40960)
    expect(asked).toEqual([path.join('/data', 'recordings'), '/data'.replace(/\//g, path.sep)])
    c.t = 29_000
    await free()
    expect(asked.length).toBe(2)
    c.t = 31_000
    await free()
    expect(asked.length).toBe(4)
  })

  it("gives up on a disk that hangs (null, or what it last said) — and doesn't block", async () => {
    let answer = null
    const statfs = () => new Promise((resolve) => { answer = resolve })
    const free = cachedFreeBytes('/rec', { ttlMs: 0, waitMs: 20, statfs })
    expect(await free()).toBe(null)
    answer(stat(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(await free()).toBe(4096)   // the late answer is kept; this look hangs again
  })

  it('an error other than a missing folder: unknown', async () => {
    const free = cachedFreeBytes('/rec', { statfs: async () => { throw Object.assign(new Error('io'), { code: 'EIO' }) } })
    expect(await free()).toBe(null)
  })
})
