import { normalizeMac } from './macDeviceId'

/**
 * What a connection needs before it can be saved (Settings → Connection's
 * form; the apps' ProfileRequired.kt says the same). Everything else — login,
 * password, token, signature — is optional. A device ID is needed only while
 * it's sent to the portal (its switch on). `advanced`: under "Advanced
 * options", which may be closed.
 */
export const REQUIRED_FIELDS = [
  { key: 'name', label: 'Profile name', ok: (f) => !!String(f.name || '').trim() },
  { key: 'portal', label: 'Portal URL', ok: (f) => !!String(f.portal || '').trim() },
  { key: 'mac', label: 'MAC address', ok: (f) => !!normalizeMac(f.mac) },
  { key: 'timezone', label: 'Timezone', ok: (f) => !!String(f.timezone || '').trim() },
  { key: 'lang', label: 'Language', ok: (f) => !!String(f.lang || '').trim() },
  { key: 'serial_number', label: 'Serial number', advanced: true, ok: (f) => !!String(f.serial_number || '').trim() },
  { key: 'connection_timeout', label: 'Timeout', advanced: true, ok: (f) => Number(f.connection_timeout) > 0 },
  { key: 'device_id', label: 'Device ID', advanced: true, ok: (f) => f.send_device_id === false || !!String(f.device_id || '').trim() },
  { key: 'device_id2', label: 'Device ID 2', advanced: true, ok: (f) => f.send_device_id2 === false || !!String(f.device_id2 || '').trim() },
]

const REQUIRED = new Set(REQUIRED_FIELDS.map((r) => r.key))

/** Whether a field is one a connection needs (its label gets a *). */
export const isRequired = (key) => REQUIRED.has(key)

/** The required fields still missing from a connection: [{ key, label, advanced }]. */
export function missingFields(form) {
  return REQUIRED_FIELDS.filter((r) => !r.ok(form || {})).map(({ key, label, advanced = false }) => ({ key, label, advanced }))
}
