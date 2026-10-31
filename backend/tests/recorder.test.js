import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { makeTs } from './helpers/makeTs.js'

const require = createRequire(import.meta.url)
const { startRecording } = require('../recordings/Recorder.js')

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
    expect(r).toMatchObject({ status: 'done', bytes: A.length })
    expect(fs.readFileSync(file).equals(A)).toBe(true)
    expect(fs.existsSync(file + '.part')).toBe(false)
  })

  it('carries on across a source restart', async () => {
    const s = setup({ steps: () => [A, 'break', B] })
    const done = s.run()
    await tick(60)
    s.clock.t += 61_000
    const r = await done
    expect(r.status).toBe('done')
    expect(fs.readFileSync(file).equals(Buffer.concat([A, B]))).toBe(true)
  })

  it('opens the channel again when the reader gives up, until the end time', async () => {
    const s = setup({ steps: (n) => (n === 1 ? [A, 'gaveUp'] : [B]) })
    const done = s.run()
    await tick(80)
    s.clock.t += 61_000
    const r = await done
    expect(s.calls()).toBeGreaterThanOrEqual(2)
    expect(fs.readFileSync(file).equals(Buffer.concat([A, B]))).toBe(true)
    expect(r.status).toBe('done')
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
  })

  it('stopping early keeps what was recorded', async () => {
    const s = setup({ steps: () => [A] })
    const ac = new globalThis.AbortController()
    const done = s.run({ signal: ac.signal })
    await tick(40)
    ac.abort()
    const r = await done
    expect(r).toMatchObject({ status: 'done', bytes: A.length })
    expect(fs.readFileSync(file).equals(A)).toBe(true)
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
})
