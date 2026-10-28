import { describe, it, expect } from 'vitest'
import { missingFields, isRequired, prepareForm } from './profileRequired'

// A connection filled in: everything a portal needs.
const FILLED = {
  name: 'IPTV', portal: 'http://portal.example/c/', mac: '00:1A:79:12:34:56', timezone: 'America/New_York', lang: 'en',
  serial_number: '001a79123456', connection_timeout: 10, device_id: 'ABC', device_id2: 'ABC',
  send_device_id: true, send_device_id2: true, login: '', password: '', signature: '',
}
const keys = (f) => missingFields(f).map((m) => m.key)

describe('missingFields', () => {
  it('needs nothing more for a connection filled in, with login, password and signature empty', () => {
    expect(missingFields(FILLED)).toEqual([])
  })

  it('names what is missing, and which of it is under Advanced options', () => {
    expect(missingFields({ ...FILLED, name: ' ', serial_number: '' })).toEqual([
      { key: 'name', label: 'Profile name', advanced: false },
      { key: 'serial_number', label: 'Serial number', advanced: true },
    ])
  })

  it('needs a whole MAC, and a timeout above 0', () => {
    expect(keys({ ...FILLED, mac: '00:1A:79' })).toEqual(['mac'])
    expect(keys({ ...FILLED, connection_timeout: 0 })).toEqual(['connection_timeout'])
  })

  it('needs a device ID only while it is sent to the portal', () => {
    expect(keys({ ...FILLED, device_id: '', device_id2: '' })).toEqual(['device_id', 'device_id2'])
    expect(keys({ ...FILLED, device_id: '', send_device_id: false })).toEqual([])
  })

  it('needs everything required of an empty form', () => {
    expect(keys({})).toEqual(['name', 'portal', 'mac', 'timezone', 'lang', 'serial_number', 'connection_timeout', 'device_id', 'device_id2'])
  })

  it('marks the required fields, not the optional ones', () => {
    expect(isRequired('portal')).toBe(true)
    expect(isRequired('login')).toBe(false)
    expect(isRequired('signature')).toBe(false)
  })
})

describe('prepareForm', () => {
  it('shows the blanks the server fills anyway as it does, so a working connection can be saved', () => {
    const old = { portal: 'http://portal.example/c/', mac: '00:1A:79:12:34:56', timezone: 'UTC', lang: 'en', connection_timeout: 10,
      name: '', serial_number: '', device_id: '', device_id2: '', send_device_id: true, send_device_id2: true }
    const f = prepareForm(old)
    expect(f).toMatchObject({ name: 'portal.example', serial_number: '0000000000000', send_device_id: false, send_device_id2: false })
    expect(missingFields(f)).toEqual([])
  })

  it('leaves what is filled in as it is', () => {
    expect(prepareForm(FILLED)).toEqual(FILLED)
  })
})
