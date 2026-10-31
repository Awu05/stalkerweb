import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getSettings, saveSettings } from '../stalkerApi'

// Settings for live TV recordings (routes/recordings.js): how many streams
// the provider allows at once, and the minutes added around a programme
// booked from the guide. Shared by every viewer.
const FIELDS = [
  { key: 'max_streams', label: 'Streams your provider allows at once', min: 1, max: 10, unit: '' },
  { key: 'record_pad_before_min', label: 'Start recording early by', min: 0, max: 60, unit: 'min' },
  { key: 'record_pad_after_min', label: 'Keep recording after the end for', min: 0, max: 60, unit: 'min' },
]

export default function RecordingSettings() {
  const [saved, setSaved] = useState(null)
  const [draft, setDraft] = useState({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    getSettings().then((s) => {
      const v = Object.fromEntries(FIELDS.map((f) => [f.key, s[f.key]]))
      setSaved(v)
      setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(v[f.key] ?? '')])))
    }).catch(() => {})
  }, [])

  const parsed = Object.fromEntries(FIELDS.map((f) => [f.key, Number(draft[f.key])]))
  const valid = FIELDS.every((f) => Number.isInteger(parsed[f.key]) && parsed[f.key] >= f.min && parsed[f.key] <= f.max)
  const changed = saved && FIELDS.some((f) => parsed[f.key] !== saved[f.key])

  const save = async () => {
    setBusy(true); setNotice(null)
    try {
      await saveSettings(parsed)
      setSaved(parsed)
      setNotice({ type: 'success', msg: 'Saved — applies to recordings booked from now on.' })
    } catch (e) {
      setNotice({ type: 'error', msg: e.message })
    } finally { setBusy(false) }
  }

  if (!saved) return <p className="text-xs text-[var(--color-muted)]">Loading…</p>
  return (
    <div className="flex flex-col gap-3">
      {FIELDS.map((f) => (
        <label key={f.key} className="flex items-center gap-3">
          <span className="flex-1 text-sm text-[var(--color-text)]">{f.label}</span>
          <Input type="number" inputMode="numeric" min={f.min} max={f.max} value={draft[f.key]} aria-label={f.label}
            onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} className="w-20" />
          <span className="w-8 text-xs text-[var(--color-muted)]">{f.unit}</span>
        </label>
      ))}
      <p className="text-xs text-[var(--color-muted)]">
        Watching, casting and recording all count toward the streams your provider allows. A recording that would go over is refused when you book it; recording now asks first.
      </p>
      <div className="flex items-center gap-3">
        <Button type="button" onClick={save} disabled={busy || !valid || !changed} className="h-9 px-3 text-xs">
          {busy ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
        </Button>
        {!valid && <p className="text-xs text-[var(--color-live)]">Streams: 1–10. Minutes: 0–60.</p>}
        {notice && <p className={cn('text-xs', notice.type === 'error' ? 'text-[var(--color-live)]' : 'text-[var(--color-success)]')}>{notice.msg}</p>}
      </div>
    </div>
  )
}
