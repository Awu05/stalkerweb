import { describe, it, expect } from 'vitest'
import { connectionLabel } from './connection'

const status = { connected: true, portal: 'http://tv.example.com:8080/c/', mac: '00:1a:79:aa:bb:cc' }
const home = { id: 'p1', name: 'Home IPTV', portal: 'http://tv.example.com:8080', mac: '00:1A:79:AA:BB:CC' }
const other = { id: 'p2', name: 'Backup', portal: 'http://tv.example.com:8080/c', mac: '00:1A:79:00:00:01' }

describe('connectionLabel', () => {
  it('names the connection by the saved profile for this portal and MAC', () => {
    expect(connectionLabel(status, [other, home])).toEqual({ name: 'Home IPTV', host: 'tv.example.com:8080' })
  })

  it('falls back to the portal address when no profile matches', () => {
    expect(connectionLabel(status, [])).toEqual({ name: 'tv.example.com:8080', host: 'tv.example.com:8080' })
  })

  it('is nothing while disconnected', () => {
    expect(connectionLabel({ ...status, connected: false }, [home])).toBe(null)
  })
})
