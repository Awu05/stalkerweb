/**
 * A MAG box's device IDs, made from what identifies it: SHA-256 of its MAC
 * (uppercase, with or without colons), its serial number or its UID, as
 * uppercase hex — providers differ. The apps' DeviceId.kt does the same.
 */

/** "00:1a:79-aa bb cc" → "00:1A:79:AA:BB:CC", or '' if it isn't 12 hex digits. */
export function normalizeMac(mac) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '').toUpperCase()
  return hex.length === 12 ? hex.match(/../g).join(':') : ''
}

/** The device ID for this MAC, or '' when the MAC isn't complete. */
export function macDeviceId(mac) {
  const m = normalizeMac(mac)
  return m ? sha256Hex(m).toUpperCase() : ''
}

/**
 * How a provider wants Device ID 1 and 2 made — boxes differ: SHA-256, as
 * uppercase hex, of one of these. 'typed': not made, typed in as given.
 */
export const DEVICE_ID_SOURCES = [
  { id: 'typed', label: 'Typed in' },
  { id: 'mac', label: 'Hash of the MAC (uppercase, with colons)' },
  { id: 'mac-plain', label: 'Hash of the MAC (uppercase, no colons)' },
  { id: 'serial', label: 'Hash of the serial number' },
  { id: 'uid', label: 'Hash of the UID' },
]

/**
 * The device ID a source makes from a connection ({ mac, serial_number,
 * uid }) — '' when what it hashes isn't filled in yet (or for 'typed'). The
 * MAC is read as a MAC (any case or separators); the serial and the UID are
 * hashed exactly as typed (a box shows them in lowercase, and hashes them so).
 */
// A new connection's serial until one is typed (lib/profiles.js) — the
// server's own for a blank one. Not a box's: never hashed into its IDs.
export const SERIAL_PLACEHOLDER = '0000000000000'

export function deviceIdFrom(source, { mac = '', serial_number = '', uid = '' } = {}) {
  const hash = (s) => (s && s !== SERIAL_PLACEHOLDER ? sha256Hex(s).toUpperCase() : '')
  switch (source) {
    case 'mac': return macDeviceId(mac)
    case 'mac-plain': return hash(normalizeMac(mac).replace(/:/g, ''))
    case 'serial': return hash(String(serial_number).trim())
    case 'uid': return hash(String(uid).trim())
    default: return ''
  }
}

const SOURCE_IDS = new Set(DEVICE_ID_SOURCES.map((s) => s.id))

/**
 * Which source a connection's device IDs come from: the one saved with it
 * (`device_id_source`), else — a connection saved before it was — the one
 * its IDs are ('typed' when none of them makes both).
 */
export function deviceIdSourceOf(profile) {
  if (SOURCE_IDS.has(profile?.device_id_source)) return profile.device_id_source
  const id1 = profile?.device_id || ''
  if (!id1 || id1 !== (profile?.device_id2 || '')) return 'typed'
  return DEVICE_ID_SOURCES.find((s) => s.id !== 'typed' && deviceIdFrom(s.id, profile) === id1)?.id ?? 'typed'
}

// crypto.subtle only exists on https/localhost, and StalkerWeb is often opened
// over plain http on the LAN — so a small synchronous SHA-256 of our own.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text)
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 4, bytes.length * 8)   // < 512 MB: the high word stays 0
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = w[i - 16] + s0 + w[i - 7] + s1
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('')
}
