import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { normalizeMac, macDeviceId, sha256Hex, deviceIdFrom, deviceIdSourceOf } from './macDeviceId'

const node = (s) => createHash('sha256').update(s).digest('hex')

describe('sha256Hex', () => {
  it('matches Node for empty, short, and multi-block input', () => {
    for (const s of ['', 'abc', '00:1A:79:AA:BB:CC', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'é'.repeat(100)]) {
      expect(sha256Hex(s)).toBe(node(s))
    }
  })
})

describe('macDeviceId', () => {
  it('hashes the uppercase MAC with colons, as uppercase hex', () => {
    expect(macDeviceId('00:1A:79:AA:BB:CC')).toBe(node('00:1A:79:AA:BB:CC').toUpperCase())
  })

  it('reads a MAC typed in lowercase, with dashes or without separators', () => {
    const id = macDeviceId('00:1A:79:AA:BB:CC')
    expect(macDeviceId('00:1a:79:aa:bb:cc')).toBe(id)
    expect(macDeviceId('00-1A-79-AA-BB-CC')).toBe(id)
    expect(macDeviceId(' 001a79aabbcc ')).toBe(id)
  })

  it('is empty until the MAC is complete', () => {
    expect(macDeviceId('')).toBe('')
    expect(macDeviceId('00:1A:79:AA:BB')).toBe('')
    expect(normalizeMac('00:1A:79:AA:BB:CC:DD')).toBe('')
  })

  it('only counts ASCII hex digits, as the apps do', () => {
    expect(macDeviceId('００:１２:３４:５６:７８:９０')).toBe('')
  })
})

// A made-up box shaped like a real one (MAG250: its serial is its MAC in lowercase, its UID ends with
// the MAC), and the IDs its providers would expect — worked out separately with Node's crypto.
const BOX = { mac: '00:1A:79:12:34:56', serial_number: '001a79123456', uid: '1234000000003456' }
const EXPECTED = {
  mac: '667094E7E8FF0347F6EC27A8E8115BE76E2AA9CD5C8F13C6FA00BCEDFAC02B41',
  'mac-plain': 'B45247562461D2938E199C57D45E2E9A098B957DE23CA0E79FDFC93FA3B0CA0F',
  serial: 'F08152E46364DAEE6395A9D1C02389A97573928E94F821FD8B87A3936064B4EA',
  uid: 'F53C390E841C37F1A9E6DA3B31901D66B28A0604FC67FC26508EDC21794483AE',
}

describe('deviceIdFrom', () => {
  it("makes each provider's device ID for a box", () => {
    for (const [source, id] of Object.entries(EXPECTED)) expect(deviceIdFrom(source, BOX), source).toBe(id)
  })

  it('reads the MAC however it is typed, but the serial and UID exactly as typed', () => {
    expect(deviceIdFrom('mac-plain', { mac: '00-1a-79-12-34-56' })).toBe(EXPECTED['mac-plain'])
    expect(deviceIdFrom('serial', { serial_number: ' 001a79123456 ' })).toBe(EXPECTED.serial)
    expect(deviceIdFrom('serial', { serial_number: '001A79123456' })).not.toBe(EXPECTED.serial)
  })

  it("is empty until what it hashes is filled in, and for 'typed'", () => {
    expect(deviceIdFrom('serial', {})).toBe('')
    expect(deviceIdFrom('mac-plain', { mac: 'A0:BB' })).toBe('')
    expect(deviceIdFrom('typed', BOX)).toBe('')
  })
})

describe('deviceIdSourceOf', () => {
  it('tells which source saved IDs came from', () => {
    for (const [source, id] of Object.entries(EXPECTED)) expect(deviceIdSourceOf({ ...BOX, device_id: id, device_id2: id })).toBe(source)
    expect(deviceIdSourceOf({ ...BOX, device_id: 'ABC', device_id2: 'ABC' })).toBe('typed')
    expect(deviceIdSourceOf({ ...BOX, device_id: EXPECTED.mac, device_id2: 'OTHER' })).toBe('typed')
    expect(deviceIdSourceOf({})).toBe('typed')
  })
})
