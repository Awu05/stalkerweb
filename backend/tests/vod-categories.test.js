import { describe, it, expect, vi } from 'vitest'
import VodManager from '../stalker/VodManager.js'

const fakeClient = () => {
  const client = {
    calls: 0,
    fail: false,
    _stalkerCall: async () => {
      client.calls++
      if (client.fail) throw new Error('HTTP 429')
      return { js: [{ id: 1, title: 'Movies' }] }
    },
  }
  return client
}

describe('VodManager category cache', () => {
  it('serves repeat and concurrent requests from one portal call', async () => {
    const client = fakeClient()
    const vm = new VodManager(client)

    const [a, b] = await Promise.all([vm.getCategories('vod'), vm.getCategories('vod')])
    await vm.getCategories('vod')

    expect(client.calls).toBe(1)
    expect(a).toEqual(b)
    expect(a[0].title).toBe('Movies')
  })

  it('caches each type separately', async () => {
    const client = fakeClient()
    const vm = new VodManager(client)

    await vm.getCategories('vod')
    await vm.getCategories('series')

    expect(client.calls).toBe(2)
  })

  it('does not cache a failure', async () => {
    const client = fakeClient()
    const vm = new VodManager(client)

    client.fail = true
    await expect(vm.getCategories('vod')).rejects.toThrow('429')
    client.fail = false
    await expect(vm.getCategories('vod')).resolves.toHaveLength(1)
    expect(client.calls).toBe(2)
  })

  it('keeps an empty answer for a minute, not half an hour', async () => {
    vi.useFakeTimers()
    try {
      let reply = { js: { error: 'session expired' } }
      const client = { calls: 0, _stalkerCall: async () => { client.calls++; return reply } }
      const vm = new VodManager(client)

      expect(await vm.getCategories('vod')).toEqual([])
      await vm.getCategories('vod')
      expect(client.calls).toBe(1)

      reply = { js: [{ id: 1, title: 'Movies' }] }
      vi.advanceTimersByTime(61 * 1000)
      expect(await vm.getCategories('vod')).toHaveLength(1)
      expect(client.calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
