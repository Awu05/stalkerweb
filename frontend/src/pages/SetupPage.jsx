import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronDown, ChevronUp, Loader2, CheckCircle2, XCircle,
  Trash2, RefreshCw, Image, Download, Upload, Plus, Pencil, Plug, PlugZap,
  X, Wifi, WifiOff, Copy, Check, ListVideo, CalendarDays, Server, KeyRound,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input }  from '@/components/ui/input'
import { Label }  from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import {
  connect, disconnect, getConfig, saveConfig, getStatus, getSettings, saveSettings,
  getLogos, addLogoOverride, deleteLogoOverride, refreshLogosDb,
  downloadStbEmuBackup, getChannels, getLogoMap, getProxiedLogoUrl,
  getLogoStripWords, addLogoStripWord, deleteLogoStripWord,
} from '../stalkerApi'
import { invalidateChannelCache } from '../lib/channelCache'
import { invalidateFavoritesCache } from '../lib/useFavorites'
import { useApp } from '@/lib/appContext'
import {
  fetchProfiles, createProfile, updateProfile, deleteProfile,
  normalizePortal, DEFAULT_FORM,
  setActiveProfile, getActiveProfileId,
} from '@/lib/profiles'
import ViewersCard from '@/components/ViewersCard'
import ChannelFilters from '@/components/ChannelFilters'
import { viewerQuery, viewerPath } from '@/lib/viewer'

// ── Helpers ───────────────────────────────────────────────────────────────────

// STBEmu device options — kept in sync with backend routes/settings.js
const STB_MODELS    = ['MAG200', 'MAG250', 'MAG254', 'MAG256', 'MAG270', 'MAG322', 'MAG352', 'CUSTOM']
const STB_FIRMWARES = ['0.2.18-r14-pub-250', '0.2.18-r19-pub-250', 'Generic']

async function checkLogoName(name) {
  const r = await fetch(`/api/logos/check?name=${encodeURIComponent(name)}`)
  return r.ok ? r.json() : null
}

// ── STBEmu backup import ──────────────────────────────────────────────────────
// Reverse of routes/export.js's field mapping — turns one profile entry from
// an STBEmu backup JSON back into a profile shaped like DEFAULT_FORM.

// mag-250 → MAG250, custom → CUSTOM
function stbSlugToModel(slug) {
  if (!slug) return 'MAG250'
  const s = String(slug).toLowerCase()
  if (s === 'custom') return 'CUSTOM'
  const m = s.match(/^mag-(\d+)$/)
  return m ? `MAG${m[1]}` : 'CUSTOM'
}

function parseStbEmuProfileEntry(entry) {
  const profile = entry?.profile
  if (!profile || !profile.portal_url || !profile.mac_address) return null

  const model        = STB_MODELS.includes(stbSlugToModel(profile.stb_model)) ? stbSlugToModel(profile.stb_model) : 'CUSTOM'
  const firmwareDesc = profile.firmware_image_description
  const firmware     = STB_FIRMWARES.includes(firmwareDesc) ? firmwareDesc : '0.2.18-r14-pub-250'

  let token = ''
  const tokenEntry = (entry.data || []).find(d => d.tag === 'user' && /^stalker_/.test(d.name || ''))
  if (tokenEntry) {
    try { token = JSON.parse(tokenEntry.value)?.token || '' } catch { /* not JSON — ignore */ }
  }

  return {
    name:            profile.name || '',
    portal:          normalizePortal(profile.portal_url),
    mac:             profile.mac_address,
    timezone:        profile.timezone || 'Europe/London',
    lang:            profile.language || 'en',
    serial_number:   profile.serial_number || '',
    device_id:       profile.device_id || '',
    device_id2:      profile.device_id2 || '',
    // STBEmu keeps device_id/device_id2 populated internally even when it
    // never sends them (send_device_id / device_custom_dev_id2 false) — the
    // portal never saw the value, so sending it now would look like a
    // spoofed/mismatched device. Default true (send) when the field is
    // absent, since older/other exporters may not include it.
    send_device_id:  profile.send_device_id !== false,
    send_device_id2: profile.device_custom_dev_id2 !== false,
    signature:       profile.device_signature || '',
    token,
    stb_model:       model,
    firmware,
    custom_firmware: model === 'CUSTOM' ? (profile.firmware || '') : '',
  }
}

// Returns the list of importable profiles found in a parsed backup JSON, or
// throws if the file doesn't look like an STBEmu backup at all.
function parseStbEmuBackup(json) {
  const entries = Array.isArray(json?.profiles) ? json.profiles : []
  if (!entries.length) throw new Error('Not a valid STBEmu backup file — no profiles found')
  const parsed = entries.map(parseStbEmuProfileEntry).filter(Boolean)
  if (!parsed.length) throw new Error('No importable profiles found — missing portal URL or MAC address')
  return parsed
}

// ── Shared UI primitives ─────────────────────────────────────────────────────

function Field({ label, id, hint, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-[var(--color-muted)]">{hint}</p>}
    </div>
  )
}

function Card({ title, description, children, className }) {
  return (
    <div className={cn('glass rounded-[var(--radius-lg)] p-6 flex flex-col gap-5', className)}>
      <div>
        <h2 className="font-semibold text-[var(--color-text)]">{title}</h2>
        {description && <p className="text-sm text-[var(--color-muted)] mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  )
}

function Notice({ notice }) {
  if (!notice) return null
  return (
    <div className={cn(
      'flex items-center gap-2 rounded-[var(--radius-sm)] px-4 py-3 text-sm',
      notice.type === 'success'
        ? 'bg-[var(--color-success)]/10 text-[var(--color-success)] border border-[var(--color-success)]/25'
        : 'bg-[var(--color-live)]/10 text-[var(--color-live)] border border-[var(--color-live)]/25'
    )}>
      {notice.type === 'success' ? <CheckCircle2 size={16} className="shrink-0" /> : <XCircle size={16} className="shrink-0" />}
      {notice.msg}
    </div>
  )
}

// ── Copyable link row (M3U / XMLTV export URLs) ───────────────────────────────

function LinkRow({ label, url, hint, icon: Icon, filename }) {
  const [copied, setCopied] = useState(null) // null | 'ok' | 'manual'
  const inputRef = useRef(null)

  async function copy() {
    if (await copyText(url)) {
      setCopied('ok')
    } else {
      // Clipboard fully blocked: select the URL so Ctrl/Cmd+C finishes the job,
      // and say so instead of failing silently.
      inputRef.current?.focus()
      inputRef.current?.select()
      setCopied('manual')
    }
    setTimeout(() => setCopied(null), 2500)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-[var(--color-muted)] shrink-0" />
        <span className="text-sm font-medium text-[var(--color-text)]">{label}</span>
      </div>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          readOnly
          value={url}
          onFocus={e => e.target.select()}
          className="font-mono text-xs flex-1"
        />
        <Button type="button" variant="outline" onClick={copy} className="shrink-0 h-9 px-3 text-xs gap-1.5">
          {copied === 'ok' ? <Check size={13} className="text-[var(--color-success)]" /> : <Copy size={13} />}
          {copied === 'ok' ? 'Copied' : 'Copy'}
        </Button>
        {filename && (
          <a
            href={url}
            download={filename}
            title={`Download ${filename}`}
            aria-label={`Download ${filename}`}
            className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
          >
            <Download size={13} />
          </a>
        )}
      </div>
      {copied === 'manual' && (
        <p className="text-xs text-[var(--color-live)]">Your browser blocked copying — the link is selected, press Ctrl+C (⌘C on Mac).</p>
      )}
      {hint && <p className="text-xs text-[var(--color-muted)]">{hint}</p>}
    </div>
  )
}

// ── Profile form sheet ────────────────────────────────────────────────────────

function ProfileSheet({ initial, onSave, onClose }) {
  const [form, setForm]       = useState({ ...DEFAULT_FORM, ...initial })
  const [showAdv, setShowAdv] = useState(false)

  const set     = k => e => setForm(f => ({ ...f, [k]: e.target.value }))
  const setBool = k => v => setForm(f => ({ ...f, [k]: v }))

  function handleSubmit(e) {
    e.preventDefault()
    const p = { ...form, portal: normalizePortal(form.portal) }
    onSave(p)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* panel */}
      <div className="modal-panel relative z-10 w-full sm:max-w-lg max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden">

        {/* header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)] shrink-0">
          <h3 className="font-semibold text-[var(--color-text)]">
            {initial?.id ? 'Edit Profile' : initial?.portal ? 'Duplicate Profile' : 'New Profile'}
          </h3>
          <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors p-1 rounded">
            <X size={16} />
          </button>
        </div>

        {/* scrollable form body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">

          <Field label="Profile Name" id="prof-name" hint="A friendly label — shown in the profiles list.">
            <Input id="prof-name" placeholder="e.g. Home IPTV" value={form.name} onChange={set('name')} />
          </Field>

          <Field label="Portal URL" id="prof-portal">
            <Input id="prof-portal" type="url" placeholder="http://my.portal.com" value={form.portal}
              onChange={set('portal')}
              onBlur={() => { if (form.portal.trim()) setForm(f => ({ ...f, portal: normalizePortal(f.portal) })) }}
              required />
          </Field>

          <Field label="MAC Address" id="prof-mac">
            <Input id="prof-mac" placeholder="00:1A:79:XX:XX:XX" value={form.mac} onChange={set('mac')} required />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Timezone" id="prof-tz">
              <Input id="prof-tz" value={form.timezone} onChange={set('timezone')} />
            </Field>
            <Field label="Language" id="prof-lang">
              <Input id="prof-lang" value={form.lang} onChange={set('lang')} />
            </Field>
          </div>

          {/* advanced toggle */}
          <button
            type="button"
            onClick={() => setShowAdv(v => !v)}
            className="flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors w-fit"
          >
            {showAdv ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            Advanced options
          </button>

          {showAdv && (
            <div className="flex flex-col gap-4 pt-1 border-t border-[var(--color-border)]">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Login" id="prof-login">
                  <Input id="prof-login" value={form.login} onChange={set('login')} />
                </Field>
                <Field label="Password" id="prof-pw">
                  <Input id="prof-pw" type="password" value={form.password} onChange={set('password')} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Serial Number" id="prof-sn">
                  <Input id="prof-sn" value={form.serial_number} onChange={set('serial_number')} className="font-mono text-xs" />
                </Field>
                <Field label="Timeout (s)" id="prof-to">
                  <Input id="prof-to" type="number" min={3} max={60} value={form.connection_timeout} onChange={set('connection_timeout')} />
                </Field>
              </div>
              <Field label="Device ID" id="prof-did"
                hint={form.send_device_id === false ? 'Stored but not sent to the portal.' : undefined}>
                <div className="flex items-center gap-2">
                  <Input id="prof-did" value={form.device_id || ''} onChange={set('device_id')} className="font-mono text-xs flex-1" />
                  <Switch checked={form.send_device_id !== false} onCheckedChange={setBool('send_device_id')}
                    title={form.send_device_id !== false ? 'Sent to the portal' : 'Not sent to the portal'} />
                </div>
              </Field>
              <Field label="Device ID 2" id="prof-did2"
                hint={form.send_device_id2 === false ? 'Stored but not sent to the portal.' : undefined}>
                <div className="flex items-center gap-2">
                  <Input id="prof-did2" value={form.device_id2 || ''} onChange={set('device_id2')} className="font-mono text-xs flex-1" />
                  <Switch checked={form.send_device_id2 !== false} onCheckedChange={setBool('send_device_id2')}
                    title={form.send_device_id2 !== false ? 'Sent to the portal' : 'Not sent to the portal'} />
                </div>
              </Field>
              <Field label="Signature" id="prof-sig">
                <Input id="prof-sig" value={form.signature || ''} onChange={set('signature')} className="font-mono text-xs" />
              </Field>

              {/* STBEmu device — used when exporting an STBEmu backup for this profile */}
              <div className="grid grid-cols-2 gap-3 pt-1 border-t border-[var(--color-border)]">
                <Field label="STB Model" id="prof-stb-model">
                  <select id="prof-stb-model" value={form.stb_model || 'MAG250'} onChange={set('stb_model')}
                    className="flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary-light)]">
                    {STB_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </Field>
                <Field label="Firmware" id="prof-stb-fw">
                  <select id="prof-stb-fw" value={form.firmware || '0.2.18-r14-pub-250'} onChange={set('firmware')}
                    className="flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary-light)]">
                    {STB_FIRMWARES.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </Field>
              </div>
              {form.stb_model === 'CUSTOM' && (
                <Field label="Custom Firmware String" id="prof-custom-fw" hint="e.g. mag-custom-2.20.02-pub-000">
                  <Input id="prof-custom-fw" placeholder="mag-xxx-2.20.02-pub-xxx" value={form.custom_firmware || ''}
                    onChange={set('custom_firmware')} className="font-mono text-xs" />
                </Field>
              )}
            </div>
          )}

          {/* sticky footer */}
          <div className="flex gap-3 pt-2 pb-1 mt-auto sticky bottom-0 bg-[var(--color-surface)] border-t border-[var(--color-border)] -mx-5 px-5 py-3">
            <Button type="submit" className="flex-1">Save Profile</Button>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── STBEmu import picker (backup files with multiple profiles) ─────────────────

function StbImportPicker({ candidates, onImport, onClose }) {
  const [selected, setSelected] = useState(() => new Set(candidates.map((_, i) => i)))

  function toggle(i) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="modal-panel relative z-10 w-full sm:max-w-lg max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)] shrink-0">
          <h3 className="font-semibold text-[var(--color-text)]">Select Profiles to Import</h3>
          <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors p-1 rounded">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-2">
          <p className="text-xs text-[var(--color-muted)] mb-1">
            This backup file contains {candidates.length} profiles. Choose which ones to import as new profiles.
          </p>
          {candidates.map((p, i) => (
            <label key={i} className={cn(
              'flex items-start gap-3 rounded-[var(--radius-sm)] border px-3 py-2.5 cursor-pointer transition-colors',
              selected.has(i) ? 'border-[var(--color-primary)]/50 bg-[var(--color-primary)]/5' : 'border-[var(--color-border)]'
            )}>
              <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} className="mt-0.5 shrink-0" />
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium text-[var(--color-text)] truncate">{p.name || p.portal}</span>
                <span className="text-xs text-[var(--color-muted)] truncate">{p.portal}</span>
                <span className="text-xs font-mono text-[var(--color-muted)]">{p.mac} · {p.stb_model}</span>
              </div>
            </label>
          ))}
        </div>

        <div className="flex gap-3 px-5 py-3 border-t border-[var(--color-border)] shrink-0">
          <Button type="button" onClick={() => onImport(candidates.filter((_, i) => selected.has(i)))} disabled={selected.size === 0} className="flex-1">
            Import {selected.size > 0 ? `${selected.size} ` : ''}Profile{selected.size === 1 ? '' : 's'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}

// ── Profile card ──────────────────────────────────────────────────────────────

function ProfileCard({ profile, isConnected, onConnect, onEdit, onDuplicate, onDelete, connecting }) {
  const label = profile.name || new URL(profile.portal).hostname || profile.portal
  const busy  = connecting === profile.id

  return (
    <div className={cn(
      'relative rounded-[var(--radius-md)] border bg-[var(--color-surface)] p-4 flex flex-col gap-3 transition-colors',
      isConnected
        ? 'border-[var(--color-primary)]/50 bg-[var(--color-primary)]/5'
        : 'border-[var(--color-border)]'
    )}>

      {/* connected badge */}
      {isConnected && (
        <span className="absolute top-3 right-3 flex items-center gap-1 text-[10px] font-semibold text-[var(--color-primary-light)] bg-[var(--color-primary)]/15 rounded-full px-2 py-0.5">
          <Wifi size={10} />
          Connected
        </span>
      )}

      {/* identity */}
      <div className="flex flex-col gap-0.5 pr-24">
        <p className="text-sm font-semibold text-[var(--color-text)] truncate">{label}</p>
        <p className="text-xs text-[var(--color-muted)] truncate">{profile.portal}</p>
        <p className="text-xs font-mono text-[var(--color-muted)]">{profile.mac}</p>
      </div>

      {/* actions */}
      <div className="flex items-center gap-2">
        {isConnected ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onConnect(profile)}
            disabled={!!connecting}
            className="h-8 px-3 text-xs gap-1.5"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />}
            Reconnect
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => onConnect(profile)}
            disabled={!!connecting}
            className="h-8 px-3 text-xs gap-1.5"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
            Connect
          </Button>
        )}
        <button
          onClick={() => onEdit(profile)}
          className="h-8 w-8 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
          title="Edit"
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={() => onDuplicate(profile)}
          className="h-8 w-8 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
          title="Duplicate"
          aria-label="Duplicate profile"
        >
          <Copy size={13} />
        </button>
        <button
          onClick={() => onDelete(profile.id)}
          className="h-8 w-8 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-live)] hover:bg-[var(--color-surface-2)] transition-colors"
          title="Delete"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SetupPage() {
  const navigate = useNavigate()
  const { connected, setConnected, setEpgEnabled, setLastPingAt, setIdleInfo, viewer } = useApp()

  // ── Profiles ────────────────────────────────────────────────────────────────
  const [profiles, setProfiles]     = useState([])
  const [sheet, setSheet]           = useState(null)   // null | {} (new) | { id,... } (edit)
  const [connecting, setConnecting] = useState(null)   // profile id being connected
  const [notice, setNotice]         = useState(null)
  const [connectedPortal, setConnectedPortal] = useState(null) // {portal, mac} from status
  const [initLoading, setInitLoading] = useState(true)

  // ── App preferences / logos / genres / stbemu state ─────────────────────────
  const [epg, setEpg]               = useState(true)
  const [downloadDir, setDownloadDir]           = useState('')
  const [downloadDirSaving, setDownloadDirSaving] = useState(false)
  const [downloadDirNotice, setDownloadDirNotice] = useState(null)
  // Idle auto-disconnect. idleMinutes is the text field; idleNever mirrors a
  // saved 0. idleSaved is what the server has, to enable Save only on change.
  const [idleMinutes, setIdleMinutes]   = useState('')
  const [idleNever, setIdleNever]       = useState(false)
  const [idleSaved, setIdleSaved]       = useState(null)
  const [idleDefault, setIdleDefault]   = useState(30)
  const [httpsPort, setHttpsPort]       = useState(null)  // HTTPS_PORT, for the Stremio link
  const [shareToken, setShareToken]     = useState(null)  // with ACCESS_KEY: the playback token for the links
  const [idleSaving, setIdleSaving]     = useState(false)
  // Live delay buffer, seconds (0 = off). bufferSaved is what the server has.
  const [bufferSeconds, setBufferSeconds] = useState('0')
  const [bufferSaved, setBufferSaved]     = useState(null)
  const [bufferSaving, setBufferSaving]   = useState(false)
  const [bufferNotice, setBufferNotice]   = useState(null)
  const [idleNotice, setIdleNotice]     = useState(null)
  const [logoStats, setLogoStats]   = useState(null)
  const [logoOverrides, setLogoOverrides] = useState({})
  const [logoRefreshing, setLogoRefreshing] = useState(false)
  const [newLogoName, setNewLogoName] = useState('')
  const [newLogoUrl, setNewLogoUrl]   = useState('')
  const [logoNotice, setLogoNotice]   = useState(null)
  const [testName, setTestName]       = useState('')
  const [testResult, setTestResult]   = useState(null)
  const [deviceProfile, setDeviceProfile] = useState(null)
  const [unmatchedChannels, setUnmatchedChannels] = useState([])
  const [logoSearchOpen, setLogoSearchOpen]       = useState(false)
  const [logoSearchQuery, setLogoSearchQuery]     = useState('')
  const logoSearchRef = useRef(null)
  const [stripWords, setStripWords]       = useState([])
  const [newStripWord, setNewStripWord]   = useState('')
  const [stripApplying, setStripApplying] = useState(false)

  // STBEmu export — the user picks ANY profile to export (connected or not).
  // Model/firmware/device come from the chosen profile.
  const [exportProfileId, setExportProfileId] = useState('')
  const [stbEmuExporting, setStbEmuExporting] = useState(false)
  const [stbEmuNotice, setStbEmuNotice]   = useState(null)

  // STBEmu import — file with one profile imports immediately; a file with
  // several opens a picker so the user chooses which ones to bring in.
  const stbImportInputRef = useRef(null)
  const [stbImportCandidates, setStbImportCandidates] = useState(null) // null | [{...profile}]

  // ── Startup: load status + saved config + logos ───────────────────────────
  useEffect(() => {
    (async () => {
      const [cfg, s, logos, status, sw, { profiles: serverProfiles }] = await Promise.all([
        getConfig().catch(() => null),
        getSettings().catch(() => null),
        getLogos().catch(() => ({ overrides: {}, stats: null })),
        getStatus().catch(() => ({})),
        getLogoStripWords().catch(() => ({ stripWords: [] })),
        fetchProfiles().catch(() => ({ profiles: [], activeProfileId: null })),
      ])
      let profileList = serverProfiles

      if (sw?.stripWords) setStripWords(sw.stripWords)
      // Track which portal is currently connected
      if (status?.connected && status?.portal && status?.mac) {
        setConnectedPortal({ portal: status.portal, mac: status.mac })
      }

      // Import backend-saved single-config (config.json) as a profile if it
      // doesn't already exist — a leftover path from before multi-profile
      // support existed, kept so a very old install's connection isn't lost.
      if (cfg?.portal && cfg?.mac) {
        const match = profileList.find(p => p.portal === cfg.portal && p.mac === cfg.mac)
        if (!match) {
          try {
            const imported = await createProfile({ ...DEFAULT_FORM, ...cfg, name: '' })
            profileList = [imported, ...profileList]
            if (status?.connected && status?.portal === cfg.portal && status?.mac === cfg.mac) {
              await setActiveProfile(imported.id)
            }
          } catch { /* best effort */ }
        } else if (status?.connected && status?.portal === cfg.portal && status?.mac === cfg.mac && !getActiveProfileId()) {
          await setActiveProfile(match.id).catch(() => {})
        }
      }

      setProfiles(profileList)

      if (s) {
        setEpg(s.epg_enabled !== false)
        setDownloadDir(s.download_dir || '')
        if (s.idle_timeout_default != null) setIdleDefault(s.idle_timeout_default)
        setHttpsPort(s.https_port || null)
        if (s.live_buffer_seconds != null) {
          setBufferSaved(s.live_buffer_seconds)
          setBufferSeconds(String(s.live_buffer_seconds))
        }
        setShareToken(s.access_share_token || null)
        if (s.idle_timeout_minutes != null) {
          setIdleSaved(s.idle_timeout_minutes)
          setIdleNever(s.idle_timeout_minutes === 0)
          setIdleMinutes(s.idle_timeout_minutes === 0 ? String(s.idle_timeout_default ?? 30) : String(s.idle_timeout_minutes))
        }
      }
      if (logos) { setLogoOverrides(logos.overrides || {}); setLogoStats(logos.stats || null) }
      if (status?.device) setDeviceProfile(status.device)
      setInitLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (!connected) return
    Promise.all([getChannels(), getLogoMap()]).then(([chRes, logoMap]) => {
      const channels   = chRes.channels ?? []
      const unmatched  = channels.filter(ch => !logoMap[String(ch.uniqueId)]).map(ch => ({ name: ch.name, number: ch.number })).filter(ch => ch.name).sort((a, b) => a.number - b.number)
      setUnmatchedChannels(unmatched)
    }).catch(() => {})
  }, [connected])

  useEffect(() => {
    if (!logoSearchOpen) return
    const handleClickOutside = e => {
      if (logoSearchRef.current && !logoSearchRef.current.contains(e.target)) setLogoSearchOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [logoSearchOpen])

  // ── Profile CRUD ─────────────────────────────────────────────────────────
  async function handleSaveProfile(form) {
    const isNew = !form.id
    try {
      if (isNew) {
        const created = await createProfile(form)
        setProfiles(prev => [created, ...prev])
      } else {
        await updateProfile(form.id, form)
        setProfiles(prev => prev.map(p => p.id === form.id ? form : p))
      }
      setSheet(null)
      setNotice({ type: 'success', msg: isNew ? 'Profile added.' : 'Profile updated.' })
      setTimeout(() => setNotice(null), 2500)
    } catch (err) {
      setNotice({ type: 'error', msg: err.message })
    }
  }

  // Opens the form filled in from an existing profile — portal, MAC, advanced
  // fields and its genre/language filters — saved as a new profile.
  function handleDuplicateProfile(profile) {
    const { id: _id, ...copy } = profile
    const label = profile.name || (() => { try { return new URL(profile.portal).hostname } catch { return profile.portal } })()
    setSheet({ ...copy, name: `${label} (copy)` })
  }

  async function handleDeleteProfile(id) {
    const target = profiles.find(p => p.id === id)
    try {
      await deleteProfile(id)
      setProfiles(prev => prev.filter(p => p.id !== id))
    } catch (err) {
      setNotice({ type: 'error', msg: err.message })
      return
    }

    // If the backend still has this portal/mac saved as its current config,
    // clear it too — otherwise the startup "import saved config" effect will
    // resurrect this profile as a "new" one on the next reload.
    if (target?.portal && target?.mac) {
      try {
        const cfg = await getConfig()
        if (cfg?.portal === target.portal && cfg?.mac === target.mac) {
          await saveConfig({ portal: '', mac: '' })
        }
      } catch { /* best effort */ }
    }
  }

  async function handleConnect(profile) {
    setConnecting(profile.id)
    setNotice(null)
    try {
      await connect(profile)
      setConnected(true)
      setConnectedPortal({ portal: profile.portal, mac: profile.mac })

      // Discard any channel list / favorites cached from a previously
      // connected portal, so pages re-fetch this portal's data instead of
      // serving a stale snapshot.
      invalidateChannelCache()
      invalidateFavoritesCache()

      // Mark this profile active. Channel filters belong to the viewer, not
      // the portal profile, so they stay as they are.
      await setActiveProfile(profile.id).catch(() => {})

      setNotice({ type: 'success', msg: `Connected to ${profile.name || profile.portal}` })
      setTimeout(() => navigate('/channels', { replace: true }), 900)
    } catch (err) {
      setNotice({ type: 'error', msg: err.message })
    } finally {
      setConnecting(null)
    }
  }

  async function handleDisconnect() {
    try {
      await disconnect()
      setConnected(false)
      setConnectedPortal(null)
      await setActiveProfile(null).catch(() => {})
      setLastPingAt(null)
      setIdleInfo(null)
      setNotice({ type: 'success', msg: 'Disconnected.' })
      setTimeout(() => setNotice(null), 2500)
    } catch (err) {
      setNotice({ type: 'error', msg: err.message })
    }
  }

  function isConnectedProfile(p) {
    return connected && connectedPortal &&
      p.portal === connectedPortal.portal && p.mac === connectedPortal.mac
  }

  // ── Strip word handlers ───────────────────────────────────────────────────
  // After any strip-word change, re-fetch logo stats (to show the updated
  // matched-channel count) and invalidate the channel cache so ChannelsPage
  // and PlayerPage pick up the new logo map on their next render.
  async function _applyStripChange(apiCall) {
    setStripApplying(true)
    setLogoNotice(null)
    try {
      const r = await apiCall()
      setStripWords(r.stripWords)

      // Re-fetch logo stats — getLogo() applies strip words dynamically,
      // so a fresh /api/logos call gives the updated matched-channel count
      // without needing to re-download the iptv-org database.
      const logos = await getLogos()
      if (logos.stats) setLogoStats(logos.stats)

      // Invalidate channel cache so logo map refreshes on next page visit
      invalidateChannelCache()

      const matched = logos.stats?.matched_channels ?? '?'
      const total   = logos.stats?.total_channels   ?? '?'
      setLogoNotice({ type: 'success', msg: `Applied — ${matched} of ${total} channels now matched. Logo map will refresh on next visit.` })
    } catch (err) {
      setLogoNotice({ type: 'error', msg: err.message })
    } finally {
      setStripApplying(false)
    }
  }

  async function handleAddStripWord(e) {
    e.preventDefault()
    const w = newStripWord.trim()
    if (!w) return
    setNewStripWord('')
    await _applyStripChange(() => addLogoStripWord(w))
  }

  async function handleDeleteStripWord(word) {
    await _applyStripChange(() => deleteLogoStripWord(word))
  }

  // ── Other handlers ────────────────────────────────────────────────────────
  async function handleLogoRefresh() {
    setLogoRefreshing(true); setLogoNotice(null)
    try {
      const { stats } = await refreshLogosDb()
      setLogoStats(stats)
      setLogoNotice({ type: 'success', msg: `Database refreshed — ${stats.db_size.toLocaleString()} channels indexed.` })
    } catch (err) { setLogoNotice({ type: 'error', msg: err.message }) }
    finally { setLogoRefreshing(false) }
  }

  async function handleAddOverride(e) {
    e.preventDefault()
    if (!newLogoName.trim() || !newLogoUrl.trim()) return
    try {
      await addLogoOverride(newLogoName.trim(), newLogoUrl.trim())
      setLogoOverrides(prev => ({ ...prev, [newLogoName.trim()]: newLogoUrl.trim() }))
      setNewLogoName(''); setNewLogoUrl(''); setLogoSearchQuery(''); setLogoSearchOpen(false)
    } catch (err) { setLogoNotice({ type: 'error', msg: err.message }) }
  }

  async function handleDeleteOverride(name) {
    try {
      await deleteLogoOverride(name)
      setLogoOverrides(prev => { const n = { ...prev }; delete n[name]; return n })
    } catch (err) { setLogoNotice({ type: 'error', msg: err.message }) }
  }

  async function handleEpgToggle(val) {
    setEpg(val); setEpgEnabled(val)
    try { await saveSettings({ epg_enabled: val }) } catch { /* non-critical */ }
  }
  async function handleSaveDownloadDir() {
    if (!downloadDir.trim()) return
    setDownloadDirSaving(true)
    setDownloadDirNotice(null)
    try {
      await saveSettings({ download_dir: downloadDir.trim() })
      setDownloadDirNotice({ type: 'success', msg: 'Saved.' })
    } catch (err) {
      setDownloadDirNotice({ type: 'error', msg: err.message })
    } finally {
      setDownloadDirSaving(false)
      setTimeout(() => setDownloadDirNotice(null), 2500)
    }
  }
  // Saving applies on the server immediately (no restart); then refresh the
  // sidebar's idle countdown, which otherwise waits for the next status poll.
  async function saveIdleTimeout(minutes) {
    setIdleSaving(true)
    setIdleNotice(null)
    try {
      await saveSettings({ idle_timeout_minutes: minutes })
      setIdleSaved(minutes)
      setIdleNotice({ type: 'success', msg: minutes === 0 ? 'Auto-disconnect turned off.' : 'Saved.' })
      const st = await getStatus().catch(() => null)
      setIdleInfo(st?.lastActivityAt && st?.idleTimeoutMs
        ? { lastActivityAt: st.lastActivityAt, idleTimeoutMs: st.idleTimeoutMs }
        : null)
    } catch (err) {
      setIdleNotice({ type: 'error', msg: err.message })
    } finally {
      setIdleSaving(false)
      setTimeout(() => setIdleNotice(null), 2500)
    }
  }
  async function saveLiveBuffer(seconds) {
    setBufferSaving(true)
    setBufferNotice(null)
    try {
      await saveSettings({ live_buffer_seconds: seconds })
      setBufferSaved(seconds)
      setBufferSeconds(String(seconds))
      setBufferNotice({ type: 'success', msg: seconds ? 'Saved — applies to channels started from now on.' : 'Live buffer turned off.' })
    } catch (err) {
      setBufferNotice({ type: 'error', msg: err.message })
    } finally {
      setBufferSaving(false)
      setTimeout(() => setBufferNotice(null), 3000)
    }
  }
  const bufferParsed = parseInt(bufferSeconds, 10)
  const bufferValid  = /^\d+$/.test(bufferSeconds.trim()) && bufferParsed >= 0 && bufferParsed <= 120

  function handleIdleNeverToggle(never) {
    setIdleNever(never)
    const minutes = never ? 0 : parseInt(idleMinutes, 10)
    if (never || (Number.isInteger(minutes) && minutes > 0)) saveIdleTimeout(minutes)
  }
  const idleParsed = parseInt(idleMinutes, 10)
  const idleValid  = /^\d+$/.test(idleMinutes.trim()) && idleParsed >= 1 && idleParsed <= 10080

  async function handleStbEmuExport() {
    setStbEmuExporting(true); setStbEmuNotice(null)
    try {
      // If a profile is selected, export that profile; otherwise export the
      // currently-connected/saved config (GET fallback).
      const prof = exportProfileId ? profiles.find(p => p.id === exportProfileId) : null
      await downloadStbEmuBackup(prof || undefined)
    } catch (err) { setStbEmuNotice({ type: 'error', msg: err.message }) }
    finally { setStbEmuExporting(false) }
  }

  async function addImportedProfiles(parsedProfiles) {
    try {
      const added = await Promise.all(
        parsedProfiles.map(p => createProfile({ ...DEFAULT_FORM, ...p }))
      )
      setProfiles(prev => [...added, ...prev])
      setStbEmuNotice({
        type: 'success',
        msg: added.length === 1
          ? `Imported "${added[0].name || added[0].portal}" as a new profile.`
          : `Imported ${added.length} profiles.`,
      })
    } catch (err) {
      setStbEmuNotice({ type: 'error', msg: err.message || 'Failed to import profile(s).' })
    }
  }

  async function handleStbEmuImportFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    setStbEmuNotice(null)
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      const candidates = parseStbEmuBackup(json)
      if (candidates.length === 1) addImportedProfiles(candidates)
      else setStbImportCandidates(candidates)
    } catch (err) {
      setStbEmuNotice({ type: 'error', msg: err.message || 'Failed to import backup file.' })
    }
  }

  if (initLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-6 w-6 rounded-full border-2 border-[var(--color-primary)] border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <>
      <div className="max-w-2xl mx-auto px-6 py-10 flex flex-col gap-6">

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--color-text)]">Settings</h1>
            <p className="text-sm text-[var(--color-muted)] mt-1">Portal profiles, IPTV links and app preferences.</p>
          </div>
          {connected && (
            <button
              onClick={handleDisconnect}
              className="flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-live)] transition-colors border border-[var(--color-border)] rounded-[var(--radius-sm)] px-3 py-1.5 hover:border-[var(--color-live)]/40 mt-1"
            >
              <WifiOff size={13} />
              Disconnect
            </button>
          )}
        </div>

        <Notice notice={notice} />

        {/* ── Profile list ────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Profiles</h2>
          {profiles.length === 0 && (
            <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center">
              <p className="text-sm text-[var(--color-muted)]">No profiles yet.</p>
              <p className="text-xs text-[var(--color-muted)] mt-1">Add a profile to connect to a Stalker portal.</p>
            </div>
          )}

          {profiles.map(p => (
            <ProfileCard
              key={p.id}
              profile={p}
              isConnected={isConnectedProfile(p)}
              onConnect={handleConnect}
              onEdit={prof => setSheet(prof)}
              onDuplicate={handleDuplicateProfile}
              onDelete={handleDeleteProfile}
              connecting={connecting}
            />
          ))}

          <button
            onClick={() => setSheet({})}
            className="flex items-center justify-center gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 text-sm text-[var(--color-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-primary)]/5 transition-colors"
          >
            <Plus size={15} />
            Add Profile
          </button>
        </div>

        {/* ── IPTV Links (M3U / XMLTV) ─────────────────────────────────────── */}
        {(() => {
          const origin = (typeof window !== 'undefined' && window.location?.origin) || ''
          // Stremio only installs addons over HTTPS. When the page is open over
          // HTTP but the built-in HTTPS listener is on, offer that address.
          const loc = typeof window !== 'undefined' ? window.location : null
          const stremioOrigin = loc?.protocol === 'http:' && httpsPort
            ? `https://${loc.hostname}:${httpsPort}`  // hostname keeps an IPv6 address's brackets
            : origin
          // With ACCESS_KEY set, players can't sign in — the links carry a
          // playback-only token in their path instead (backend lib/access.js).
          const k = shareToken ? `/k/${shareToken}` : ''
          // The current viewer's channels (the default viewer's links are unchanged).
          const vq = viewerQuery(viewer)
          const vp = viewerPath(viewer)
          const xtreamUser = viewer && !viewer.isDefault ? <>the username <strong>{viewer.name}</strong></> : 'any username'
          return (
            <Card title="IPTV Links" description="Add StalkerWeb to Jellyfin, Plex, Emby, Dispatcharr, or any IPTV client using these URLs.">
              <LinkRow
                label="Xtream Codes Server"
                icon={Server}
                url={origin}
                hint={shareToken
                  ? <>Live TV, movies and series, each by category — the way the portal lays them out. In Jellyfin&apos;s Xtream plugin, TiviMate, IPTV Smarters or any Xtream player, enter this as the server, {xtreamUser}, and the Xtream password below.</>
                  : <>Live TV, movies and series, each by category — the way the portal lays them out. In Jellyfin&apos;s Xtream plugin, TiviMate, IPTV Smarters or any Xtream player, enter this as the server, with {xtreamUser} and any password.</>}
              />
              {shareToken && (
                <LinkRow
                  label="Xtream Password"
                  icon={KeyRound}
                  url={shareToken}
                  hint="The password for Xtream players. It allows playback only — not this settings page."
                />
              )}
              <LinkRow
                label="Stremio Addon"
                icon={Server}
                url={`${stremioOrigin}${k}${vp}/stremio/manifest.json`}
                hint={stremioOrigin.startsWith('https:')
                  ? <>Live TV, movies and series by category in Stremio: Addons → paste this link in the search box → Install.</>
                  : <>Live TV, movies and series by category in Stremio: Addons → paste this link in the search box → Install. Stremio needs an <strong>https://</strong> address unless it runs on this same computer and the link starts with http://127.0.0.1 — see the README for HTTPS.</>}
              />
              <LinkRow
                label="M3U Playlist"
                icon={ListVideo}
                url={`${origin}${k}/api/m3u${vq}`}
                filename="stalkerweb.m3u"
                hint={<>Channel list — add as an M3U / playlist URL in your IPTV client or tuner. For players that don&apos;t group channels (Jellyfin Live TV), add <code className="font-mono">{vq ? '&prefix=1' : '?prefix=1'}</code> to put the category in each name, like “Sports | ESPN”.</>}
              />
              <LinkRow
                label="VLC Playlist"
                icon={ListVideo}
                url={`${origin}${k}/api/xspf${vq}`}
                filename="stalkerweb.xspf"
                hint="The same channels for VLC, with a folder per category — VLC shows M3U files as one flat list. Open it in VLC, or use Media → Open Network Stream with this URL."
              />
              <LinkRow
                label="XMLTV EPG Guide"
                icon={CalendarDays}
                url={`${origin}${k}/api/xmltv${vq}`}
                filename="stalkerweb-epg.xml"
                hint={epg
                  ? 'Program guide in XMLTV format — add as the EPG / guide URL alongside the M3U.'
                  : 'Program guide in XMLTV format. Enable EPG below for this to return data.'}
              />
              <p className="text-xs text-[var(--color-muted)]">
                These links show {viewer ? <><strong>{viewer.name}</strong>&apos;s</> : 'your'} channels: they leave out the categories hidden under My channels, and adult content unless it is turned on there. Each viewer gets their own links. Add <code className="font-mono">{vq ? '&all=1' : '?all=1'}</code> to the M3U, VLC or XMLTV link to include every channel; the Xtream server and Stremio addon always apply the filters.
              </p>
              {shareToken && (
                <p className="text-xs text-[var(--color-muted)]">
                  An access key is set, so these links include a token that allows playback only. Share them with people you trust to watch; changing <code className="font-mono">ACCESS_KEY</code> replaces the token and stops every old link. In the Android app, enter the access key itself.
                </p>
              )}
              {!connected && (
                <p className="text-xs text-[var(--color-muted)]">
                  Connect to a portal above so clients can pull live channel and guide data from these links.
                </p>
              )}
            </Card>
          )
        })()}

        {/* ── App Preferences ─────────────────────────────────────────────── */}
        <Card title="App Preferences" description="Customize how StalkerWeb behaves.">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--color-text)]">EPG / Program Guide</p>
              <p className="text-xs text-[var(--color-muted)] mt-0.5">Disable if your portal does not support EPG data.</p>
            </div>
            <Switch checked={epg} onCheckedChange={handleEpgToggle} />
          </div>
          <div className="pt-4 border-t border-[var(--color-border)]">
            <Field label="Download Directory" id="download-dir" hint="Where VOD downloads are saved on the server's disk. Changes apply to new downloads only.">
              <div className="flex items-center gap-2">
                <Input
                  id="download-dir"
                  value={downloadDir}
                  onChange={e => setDownloadDir(e.target.value)}
                  placeholder="/data/downloads"
                  className="flex-1"
                />
                <Button
                  type="button"
                  onClick={handleSaveDownloadDir}
                  disabled={downloadDirSaving || !downloadDir.trim()}
                  className="shrink-0 h-9 px-3 text-xs"
                >
                  {downloadDirSaving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
                </Button>
              </div>
              {downloadDirNotice && (
                <p className={cn('text-xs mt-1', downloadDirNotice.type === 'error' ? 'text-[var(--color-live)]' : 'text-[var(--color-success)]')}>
                  {downloadDirNotice.msg}
                </p>
              )}
            </Field>
          </div>
          <div className="pt-4 border-t border-[var(--color-border)]">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-[var(--color-text)]">Idle Auto-Disconnect</p>
                <p className="text-xs text-[var(--color-muted)] mt-0.5">
                  Disconnect from the portal after this long with nothing playing. Playback always keeps the session open.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 pl-4">
                <span className="text-xs text-[var(--color-muted)]">Never</span>
                <Switch checked={idleNever} onCheckedChange={handleIdleNeverToggle} disabled={idleSaving} />
              </div>
            </div>
            {!idleNever && (
              <div className="flex items-center gap-2 mt-3">
                <Input
                  id="idle-timeout"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={10080}
                  value={idleMinutes}
                  onChange={e => setIdleMinutes(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && idleValid && idleParsed !== idleSaved) saveIdleTimeout(idleParsed) }}
                  aria-label="Idle timeout in minutes"
                  className="w-28"
                />
                <span className="text-sm text-[var(--color-muted)]">minutes</span>
                <Button
                  type="button"
                  onClick={() => saveIdleTimeout(idleParsed)}
                  disabled={idleSaving || !idleValid || idleParsed === idleSaved}
                  className="shrink-0 h-9 px-3 text-xs ml-auto"
                >
                  {idleSaving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
                </Button>
              </div>
            )}
            {!idleNever && idleMinutes.trim() !== '' && !idleValid && (
              <p className="text-xs mt-1 text-[var(--color-live)]">Enter a whole number from 1 to 10080 (one week).</p>
            )}
            {!idleNotice && !idleNever && (
              <p className="text-xs mt-1 text-[var(--color-muted)]">Default: {idleDefault} minutes (IDLE_TIMEOUT_MINUTES).</p>
            )}
            {idleNotice && (
              <p className={cn('text-xs mt-1', idleNotice.type === 'error' ? 'text-[var(--color-live)]' : 'text-[var(--color-success)]')}>
                {idleNotice.msg}
              </p>
            )}
          </div>
          <div className="pt-4 border-t border-[var(--color-border)]">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-[var(--color-text)]">Live Buffer</p>
                <p className="text-xs text-[var(--color-muted)] mt-0.5">
                  Keeps live channels this many seconds behind live and downloads ahead, so short stalls and restarts at the source play through instead of pausing. Uses memory while a channel plays (about 100 MB for 30 s of 4K). 0 turns it off.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 pl-4">
                <span className="text-xs text-[var(--color-muted)]">On</span>
                <Switch
                  checked={(bufferSaved ?? 0) > 0}
                  onCheckedChange={on => saveLiveBuffer(on ? (bufferParsed > 0 ? bufferParsed : 30) : 0)}
                  disabled={bufferSaving}
                />
              </div>
            </div>
            {(bufferSaved ?? 0) > 0 && (
              <div className="flex items-center gap-2 mt-3">
                <Input
                  id="live-buffer"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={120}
                  value={bufferSeconds}
                  onChange={e => setBufferSeconds(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && bufferValid && bufferParsed !== bufferSaved) saveLiveBuffer(bufferParsed) }}
                  aria-label="Live buffer in seconds"
                  className="w-28"
                />
                <span className="text-sm text-[var(--color-muted)]">seconds</span>
                <Button
                  type="button"
                  onClick={() => saveLiveBuffer(bufferParsed)}
                  disabled={bufferSaving || !bufferValid || bufferParsed === bufferSaved}
                  className="shrink-0 h-9 px-3 text-xs ml-auto"
                >
                  {bufferSaving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
                </Button>
              </div>
            )}
            {bufferSeconds.trim() !== '' && !bufferValid && (
              <p className="text-xs mt-1 text-[var(--color-live)]">Enter a whole number from 0 to 120.</p>
            )}
            {bufferNotice && (
              <p className={cn('text-xs mt-1', bufferNotice.type === 'error' ? 'text-[var(--color-live)]' : 'text-[var(--color-success)]')}>
                {bufferNotice.msg}
              </p>
            )}
          </div>
        </Card>

        {/* ── Genre Filters ────────────────────────────────────────────────── */}
        {/* ── Viewers ─────────────────────────────────────────────────────── */}
        <Card title="Viewers" description="Everyone who watches here. Each viewer has their own favorites and channel filters; every other setting on this page is shared.">
          <ViewersCard />
        </Card>

        <Card
          title={viewer ? `My channels (${viewer.name})` : 'My channels'}
          description="Which categories you see in Live TV and Movies & Series, and whether adult content is shown. These belong to you — other viewers keep their own."
        >
          <ChannelFilters />
        </Card>

        {/* ── STBEmu Export / Import ──────────────────────────────────────── */}
        <Card title="STBEmu Backup" description="Export a profile as an STBEmu-compatible backup, or import a backup file (from STBEmu or from this app) as new profiles.">
          <div className="flex flex-col gap-4">
            {stbEmuNotice && (
              <div className={cn('flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-xs',
                stbEmuNotice.type === 'success'
                  ? 'bg-[var(--color-success)]/10 text-[var(--color-success)] border border-[var(--color-success)]/25'
                  : 'bg-[var(--color-live)]/10 text-[var(--color-live)] border border-[var(--color-live)]/25'
              )}>
                {stbEmuNotice.type === 'success' ? <CheckCircle2 size={13} className="shrink-0" /> : <XCircle size={13} className="shrink-0" />}
                {stbEmuNotice.msg}
              </div>
            )}

            <div>
              <p className="text-sm font-medium text-[var(--color-text)]">Export</p>
              <p className="text-xs text-[var(--color-muted)] mt-0.5 mb-3">Pick which profile to export — the STB model, firmware, and profile name come from that profile.</p>
              <Field label="Profile to Export" id="stb-export-profile">
                <select id="stb-export-profile" value={exportProfileId}
                  onChange={e => setExportProfileId(e.target.value)}
                  className="flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary-light)]">
                  <option value="">Current / Connected Config</option>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.portal}{p.stb_model ? ` (${p.stb_model})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="flex items-center gap-3 pt-3">
                <Button type="button" onClick={handleStbEmuExport} disabled={stbEmuExporting} className="h-9 px-4 text-sm gap-2">
                  {stbEmuExporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  Download Backup
                </Button>
              </div>
            </div>

            <div className="pt-4 border-t border-[var(--color-border)]">
              <p className="text-sm font-medium text-[var(--color-text)]">Import</p>
              <p className="text-xs text-[var(--color-muted)] mt-0.5 mb-3">Restore an STBEmu backup JSON file as one or more new profiles. If the file contains multiple profiles, you&apos;ll be asked which to import.</p>
              <input ref={stbImportInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleStbEmuImportFile} />
              <Button type="button" variant="outline" onClick={() => stbImportInputRef.current?.click()} className="h-9 px-4 text-sm gap-2">
                <Upload size={14} />
                Choose Backup File
              </Button>
            </div>
          </div>
        </Card>

        {/* ── Logo Strip Words ─────────────────────────────────────────────── */}
        <Card title="Logo Strip Words" description="Words removed from channel names before logo matching. Useful when your portal adds country or quality suffixes — e.g. add 'CANADA' so 'BBC CANADA' matches the 'BBC' logo.">

          {/* Feedback notice shared with logo overrides section */}
          {logoNotice && (
            <div className={cn('flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-xs',
              logoNotice.type === 'success'
                ? 'bg-[var(--color-success)]/10 text-[var(--color-success)] border border-[var(--color-success)]/25'
                : 'bg-[var(--color-live)]/10 text-[var(--color-live)] border border-[var(--color-live)]/25'
            )}>
              {logoNotice.type === 'success' ? <CheckCircle2 size={13} className="shrink-0" /> : <XCircle size={13} className="shrink-0" />}
              {logoNotice.msg}
            </div>
          )}

          {/* Current strip words as dismissible pill chips */}
          {stripWords.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {stripWords.map(w => (
                <span key={w} className="flex items-center gap-1 rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border)] pl-3 pr-1.5 py-1 text-xs text-[var(--color-text)]">
                  {w}
                  <button type="button" onClick={() => handleDeleteStripWord(w)} disabled={stripApplying}
                    className="text-[var(--color-muted)] hover:text-[var(--color-live)] transition-colors ml-0.5 disabled:opacity-40" title="Remove">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {stripWords.length === 0 && !stripApplying && (
            <p className="text-xs text-[var(--color-muted)]">No strip words configured yet.</p>
          )}

          <form onSubmit={handleAddStripWord} className="flex gap-2">
            <Input placeholder="e.g. CANADA, USA, FHD…" value={newStripWord}
              onChange={e => setNewStripWord(e.target.value)} className="text-xs flex-1"
              disabled={stripApplying} />
            <Button type="submit" disabled={!newStripWord.trim() || stripApplying} className="shrink-0 h-9 px-4 text-xs gap-1.5">
              {stripApplying ? <Loader2 size={12} className="animate-spin" /> : null}
              Add
            </Button>
          </form>
          <p className="text-xs text-[var(--color-muted)]">
            Whole-word, case-insensitive. After adding a word the logo match count updates automatically
            and all channel pages refresh their logos on the next visit.
          </p>
        </Card>

        {/* ── Channel Logos ─────────────────────────────────────────────────── */}
        <Card title="Channel Logos" description="Logos come from your Stalker portal by default. Optionally fetch the iptv-org database to fill in logos for channels the portal doesn't provide, and add manual overrides per channel.">
          {logoNotice && (
            <div className={cn('flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-xs',
              logoNotice.type === 'success'
                ? 'bg-[var(--color-success)]/10 text-[var(--color-success)] border border-[var(--color-success)]/25'
                : 'bg-[var(--color-live)]/10 text-[var(--color-live)] border border-[var(--color-live)]/25'
            )}>
              {logoNotice.type === 'success' ? <CheckCircle2 size={13} className="shrink-0" /> : <XCircle size={13} className="shrink-0" />}
              {logoNotice.msg}
            </div>
          )}
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <div className="flex items-center gap-2">
                <Image size={15} className="text-[var(--color-muted)] shrink-0" />
                <span className="text-xs text-[var(--color-muted)] truncate">
                  {logoStats ? logoStats.db_size > 0 ? `iptv-org: ${logoStats.db_size.toLocaleString()} entries` : 'iptv-org database not loaded — click Refresh DB' : 'Loading…'}
                  {logoStats?.db_cached_at ? ` · updated ${new Date(logoStats.db_cached_at).toLocaleDateString()}` : ''}
                </span>
              </div>
              {logoStats?.total_channels > 0 && (
                <span className={cn('text-xs ml-5', logoStats.matched_channels > 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-live)]')}>
                  {logoStats.matched_channels} of {logoStats.total_channels} channels matched by iptv-org/overrides
                </span>
              )}
            </div>
            <Button type="button" variant="outline" onClick={handleLogoRefresh} disabled={logoRefreshing} className="shrink-0 h-8 px-3 text-xs gap-1.5">
              <RefreshCw size={12} className={logoRefreshing ? 'animate-spin' : ''} />
              {logoRefreshing ? 'Refreshing…' : 'Refresh DB'}
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-[var(--color-muted)] uppercase tracking-wide">Test Channel Name</p>
            <div className="flex gap-2">
              <Input placeholder="e.g. BBC ONE HD" value={testName}
                onChange={e => { setTestName(e.target.value); setTestResult(null) }} className="text-xs" />
              <Button type="button" variant="outline" disabled={!testName.trim()}
                onClick={async () => setTestResult(await checkLogoName(testName.trim()))}
                className="shrink-0 h-9 px-3 text-xs">Test</Button>
            </div>
            {testResult && (
              <div className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs flex flex-col gap-1">
                <span className="text-[var(--color-muted)]">Normalized: <span className="font-mono text-[var(--color-text)]">{testResult.normalized}</span></span>
                {testResult.logo
                  ? <button type="button" onClick={() => setNewLogoUrl(testResult.logo)}
                      className="flex items-center gap-2 text-left hover:opacity-80 transition-opacity group" title="Click to use in Add Override">
                      <img src={getProxiedLogoUrl(testResult.logo)} alt="" className="h-8 w-8 object-contain rounded shrink-0" onError={e => e.currentTarget.style.display='none'} />
                      <span className="text-[var(--color-success)] truncate group-hover:underline">{testResult.logo}</span>
                    </button>
                  : <span className={testResult.db_loaded ? 'text-[var(--color-live)]' : 'text-[var(--color-muted)]'}>
                      {testResult.db_loaded ? 'No match found in database' : 'Database not loaded yet'}
                    </span>
                }
              </div>
            )}
          </div>
          {Object.keys(logoOverrides).length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-[var(--color-muted)] uppercase tracking-wide">Manual Overrides</p>
              <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
                {Object.entries(logoOverrides).map(([name, url]) => (
                  <div key={name} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5">
                    {url && <img src={getProxiedLogoUrl(url)} alt="" className="w-6 h-6 object-contain shrink-0 rounded" onError={e => { e.currentTarget.style.display='none' }} />}
                    <span className="text-xs font-medium text-[var(--color-text)] flex-1 truncate">{name}</span>
                    <span className="text-xs text-[var(--color-muted)] flex-1 truncate hidden sm:block">{url}</span>
                    <button type="button" onClick={() => handleDeleteOverride(name)} className="text-[var(--color-muted)] hover:text-[var(--color-live)] transition-colors shrink-0">
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <form onSubmit={handleAddOverride} className="flex flex-col gap-2">
            <p className="text-xs font-medium text-[var(--color-muted)] uppercase tracking-wide">Add Override</p>
            <div className="flex gap-2">
              <div ref={logoSearchRef} className="relative flex-1">
                <Input
                  placeholder="Channel name or number"
                  value={newLogoName}
                  onChange={e => { setNewLogoName(e.target.value); setLogoSearchQuery(e.target.value); setLogoSearchOpen(true) }}
                  onFocus={() => { setLogoSearchQuery(newLogoName); setLogoSearchOpen(true) }}
                  className="text-xs"
                />
                {logoSearchOpen && logoSearchQuery.trim() && (() => {
                  const q = logoSearchQuery.toLowerCase()
                  const matches = unmatchedChannels.filter(ch =>
                    ch.name.toLowerCase().includes(q) ||
                    String(ch.number).includes(q)
                  ).slice(0, 20)
                  if (!matches.length) return null
                  return (
                    <div className="modal-panel absolute z-50 top-full left-0 right-0 mt-1 rounded-lg max-h-48 overflow-y-auto">
                      {matches.map(ch => (
                        <button key={ch.name} type="button"
                          onClick={() => { setNewLogoName(ch.name); setLogoSearchOpen(false) }}
                          className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-hover)] flex items-center gap-2"
                        >
                          <span className="text-[var(--color-muted)] shrink-0 w-10 text-right">Ch {ch.number}</span>
                          <span className="truncate">{ch.name}</span>
                        </button>
                      ))}
                    </div>
                  )
                })()}
              </div>
              <Input placeholder="Logo URL" value={newLogoUrl} onChange={e => setNewLogoUrl(e.target.value)} className="text-xs flex-[2]" />
              <Button type="submit" disabled={!newLogoName.trim() || !newLogoUrl.trim()} className="shrink-0 h-9 px-4 text-xs">Add</Button>
            </div>
          </form>
        </Card>

        {/* ── Device Profile ───────────────────────────────────────────────── */}
        {deviceProfile && (
          <Card title="Device Profile" description="STB identity sent to the Stalker portal on every request.">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              {[
                ['STB Model', deviceProfile.stb_type], ['HW Version', deviceProfile.hw_version],
                ['Image Version', deviceProfile.image_version], ['Firmware', deviceProfile.image_description],
                ['Portal API', deviceProfile.portal_version], ['JS API Version', deviceProfile.js_api_version],
                ['STB API Version', deviceProfile.stb_api_version], ['Player Engine', deviceProfile.player_engine_version],
              ].map(([label, value]) => value && (
                <div key={label} className="flex flex-col gap-0.5">
                  <span className="text-xs text-[var(--color-muted)]">{label}</span>
                  <span className="text-xs font-mono text-[var(--color-text)]">{value}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-0.5 pt-1 border-t border-[var(--color-border)]">
              <span className="text-xs text-[var(--color-muted)]">User-Agent</span>
              <span className="text-xs font-mono text-[var(--color-text)] break-all">{deviceProfile.user_agent}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-[var(--color-muted)]">X-User-Agent</span>
              <span className="text-xs font-mono text-[var(--color-text)]">{deviceProfile.x_user_agent}</span>
            </div>
          </Card>
        )}
      </div>

      {/* ── Profile sheet (add / edit) ───────────────────────────────────── */}
      {sheet !== null && (
        <ProfileSheet
          initial={sheet}
          onSave={handleSaveProfile}
          onClose={() => setSheet(null)}
        />
      )}

      {/* ── STBEmu import picker (multi-profile backup files) ────────────── */}
      {stbImportCandidates !== null && (
        <StbImportPicker
          candidates={stbImportCandidates}
          onImport={selected => { addImportedProfiles(selected); setStbImportCandidates(null) }}
          onClose={() => setStbImportCandidates(null)}
        />
      )}
    </>
  )
}
