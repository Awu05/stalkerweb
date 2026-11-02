import { describe, it, expect } from 'vitest'
import { connectionLabel, portalUsable, connectionBadge, connectionActions } from './connection'

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

// Asleep: the idle timeout dropped the portal session; the first data request
// reconnects it (backend lib/portalSession.js). Routing treats it as connected.
describe('portalUsable', () => {
  it('connected or asleep: the pages are open', () => {
    expect(portalUsable({ connected: true })).toBe(true)
    expect(portalUsable({ connected: false, asleep: true })).toBe(true)
    expect(portalUsable({ connected: false, asleep: true, wakeError: 'portal unreachable' })).toBe(true)
  })

  it('disconnected (or no answer): Settings', () => {
    expect(portalUsable({ connected: false, asleep: false })).toBe(false)
    expect(portalUsable(null)).toBe(false)
  })
})

describe('connectionBadge', () => {
  it('says connected, asleep, why a reconnect failed, or disconnected', () => {
    expect(connectionBadge({ connected: true })).toEqual({ text: 'Connected', tone: 'ok' })
    expect(connectionBadge({ connected: false, asleep: true })).toEqual({ text: 'Asleep — reconnects when you use it', tone: 'asleep' })
    expect(connectionBadge({ connected: false, asleep: true, wakeError: 'portal unreachable' }))
      .toEqual({ text: "Couldn't reconnect: portal unreachable", tone: 'error' })
    expect(connectionBadge({ connected: false, asleep: false })).toEqual({ text: 'Disconnected', tone: 'off' })
    expect(connectionBadge(null)).toEqual({ text: 'Disconnected', tone: 'off' })
  })
})

describe('connectionLabel while asleep', () => {
  it('names the portal it will reconnect to', () => {
    expect(connectionLabel({ ...status, connected: false, asleep: true }, [home])).toEqual({ name: 'Home IPTV', host: 'tv.example.com:8080' })
  })
})

// Settings → IPTV connection: what it offers. A failed wake is as good as
// disconnected (pick a portal, Reconnect) — plus Disconnect, which stops the
// reconnect on use.
describe('connectionActions', () => {
  it('connected or asleep: Disconnect', () => {
    expect(connectionActions({ connected: true })).toEqual({ portals: false, reconnect: false, disconnect: true })
    expect(connectionActions({ connected: false, asleep: true })).toEqual({ portals: false, reconnect: false, disconnect: true })
  })

  it('a failed wake: the portals, Reconnect and Disconnect', () => {
    expect(connectionActions({ connected: false, asleep: true, wakeError: 'portal unreachable' })).toEqual({ portals: true, reconnect: true, disconnect: true })
  })

  it('disconnected: the portals and Reconnect', () => {
    expect(connectionActions({ connected: false, asleep: false })).toEqual({ portals: true, reconnect: true, disconnect: false })
    expect(connectionActions(null)).toEqual({ portals: true, reconnect: true, disconnect: false })
  })
})
