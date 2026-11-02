import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { CircleDot, Clock, CheckCircle2, AlertCircle, Play, Square, X, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getRecordings, stopRecording, deleteRecording } from '../stalkerApi'
import { groupRecordings, recordingLabel, canDelete } from '@/lib/recordings'
import { getViewerId } from '@/lib/viewer'
import { showToast } from '@/lib/toast'
import { Switch } from '@/components/ui/switch'

// Live TV recordings: what's booked, what's recording now, what's done
// (the server makes them — lib/recordings.js for the lines).

const REFRESH_MS = 5000
const EVERYONE_KEY = 'sw:recordings-everyone'

function Row({ r, onPlay, onStop, onDelete, everyone }) {
  const icon = r.status === 'recording' ? <CircleDot size={18} className="shrink-0 text-[var(--color-live)] animate-pulse" />
    : r.status === 'scheduled' ? <Clock size={18} className="shrink-0 text-[var(--color-muted)]" />
      : r.status === 'done' ? <CheckCircle2 size={18} className="shrink-0 text-[var(--color-success)]" />
        : <AlertCircle size={18} className="shrink-0 text-[var(--color-live)]" />
  const failed = r.status === 'failed' || r.status === 'missed'
  const iconButton = 'shrink-0 p-1.5 rounded-md text-[var(--color-muted)] transition-colors'
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--color-text)] truncate">
          {r.title || r.channelName}
          {everyone && r.viewerName && <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">· {r.viewerName}</span>}
        </p>
        <p className={cn('text-xs mt-0.5 truncate', failed ? 'text-[var(--color-live)]' : 'text-[var(--color-muted)]')}>
          {r.channelName}{r.channelName ? ' · ' : ''}{recordingLabel(r)}{r.status === 'done' && r.error ? ` · ${r.error}` : ''}
        </p>
      </div>
      {r.status === 'done' && (
        <button onClick={() => onPlay(r)} data-tooltip="Play" aria-label="Play" className={cn(iconButton, 'hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]')}>
          <Play size={16} />
        </button>
      )}
      {(r.status === 'recording' || r.status === 'scheduled') && (
        <button onClick={() => onStop(r)} data-tooltip={r.status === 'recording' ? 'Stop recording' : 'Cancel'} aria-label={r.status === 'recording' ? 'Stop recording' : 'Cancel'}
          className={cn(iconButton, 'hover:text-[var(--color-live)] hover:bg-[var(--color-live)]/10')}>
          {r.status === 'recording' ? <Square size={14} /> : <X size={14} />}
        </button>
      )}
      {r.status !== 'scheduled' && r.status !== 'recording' && canDelete(r, getViewerId()) && (
        <button onClick={() => onDelete(r)} data-tooltip="Delete" aria-label="Delete" className={cn(iconButton, 'hover:text-[var(--color-live)] hover:bg-[var(--color-live)]/10')}>
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}

function Section({ title, list, ...actions }) {
  // (actions carries `everyone` through to each row)
  if (!list.length) return null
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">{title} <span className="text-[var(--color-muted)] font-normal">{list.length}</span></h2>
      <div className="flex flex-col gap-2">{list.map((r) => <Row key={r.id} r={r} {...actions} />)}</div>
    </section>
  )
}

export default function RecordingsPage() {
  const navigate = useNavigate()
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  // Everyone's recordings (each with who booked it) — remembered on this device.
  const [everyone, setEveryone] = useState(() => { try { return localStorage.getItem(EVERYONE_KEY) === '1' } catch { return false } })
  const toggleEveryone = () => setEveryone((v) => { try { localStorage.setItem(EVERYONE_KEY, v ? '0' : '1') } catch { /* not kept */ } return !v })

  const load = useCallback(() => getRecordings(everyone).then((r) => { setList(r.recordings || []); setError('') }).catch((e) => setError(e.message)), [everyone])
  useEffect(() => { load(); const t = setInterval(load, REFRESH_MS); return () => clearInterval(t) }, [load])

  const act = (p, done) => p.then(done).catch((e) => showToast(e.message, 'error')).finally(load)
  const onPlay = (r) => navigate(`/vod-player?recording=${encodeURIComponent(r.id)}&title=${encodeURIComponent(r.title || r.channelName)}`)
  const onStop = (r) => act(stopRecording(r.id), () => showToast(r.status === 'recording' ? 'Recording stopped — what it has is kept' : 'Recording cancelled'))
  const onDelete = (r) => { if (window.confirm(`Delete "${r.title || r.channelName}"?`)) act(deleteRecording(r.id), () => showToast('Recording deleted')) }

  const g = groupRecordings(list || [])
  const empty = list && !g.scheduled.length && !g.recording.length && !g.done.length
  return (
    <div className="fade-in max-w-3xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--color-text)] flex items-center gap-2">
          <CircleDot size={22} className="text-[var(--color-live)]" />
          Recordings
        </h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Live TV recorded on the server — even with every app closed. Kept until you delete them.
        </p>
        <label className="mt-3 inline-flex items-center gap-2 text-sm text-[var(--color-text)] cursor-pointer">
          <Switch checked={everyone} onCheckedChange={toggleEveryone} aria-label="Everyone's recordings" />
          Everyone&rsquo;s recordings
          <span className="text-xs text-[var(--color-muted)]">— see every viewer&rsquo;s, and stop or cancel any of them</span>
        </label>
      </div>
      {error && <p className="text-sm text-[var(--color-live)] mb-4">{error}</p>}
      {empty ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <CircleDot size={40} className="text-[var(--color-muted)] opacity-40" />
          <p className="text-sm text-[var(--color-muted)]">No recordings yet.</p>
          <p className="text-xs text-[var(--color-muted)]">Press Record in the live player, or pick Record on a programme in the guide.</p>
        </div>
      ) : (
        <>
          <Section everyone={everyone} title="Recording now" list={g.recording} onPlay={onPlay} onStop={onStop} onDelete={onDelete} />
          <Section everyone={everyone} title="Scheduled" list={g.scheduled} onPlay={onPlay} onStop={onStop} onDelete={onDelete} />
          <Section everyone={everyone} title="Recorded" list={g.done} onPlay={onPlay} onStop={onStop} onDelete={onDelete} />
        </>
      )}
    </div>
  )
}
