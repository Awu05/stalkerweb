import { describe, it, expect } from 'vitest'
import { serialSaves } from './serialSaves'

describe('serialSaves', () => {
  it('sends saves one at a time, in the order they were made', async () => {
    const log = []
    const pending = []
    const save = serialSaves((body) => {
      log.push(`start ${body}`)
      return new Promise((resolve) => pending.push(() => { log.push(`end ${body}`); resolve(body) }))
    })
    const a = save('a')
    const b = save('b')
    await Promise.resolve()
    expect(log).toEqual(['start a'])          // b waits for a
    pending.shift()()
    await a
    await new Promise((r) => setTimeout(r, 0))
    expect(log).toEqual(['start a', 'end a', 'start b'])
    pending.shift()()
    expect(await b).toBe('b')
  })

  it('carries on after a failed save, and reports the failure to its caller', async () => {
    let n = 0
    const save = serialSaves(async () => { if (++n === 1) throw new Error('503'); return 'ok' })
    await expect(save('a')).rejects.toThrow('503')
    await expect(save('b')).resolves.toBe('ok')
  })
})
