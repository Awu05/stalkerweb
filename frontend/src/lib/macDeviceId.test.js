import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { normalizeMac, macDeviceId, sha256Hex } from './macDeviceId'

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
