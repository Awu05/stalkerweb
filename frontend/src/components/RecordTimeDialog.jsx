import { useState } from 'react'
import { CircleDot, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { bookRecording } from '@/lib/bookRecording'
import { RECORD_LENGTHS, endAtTime, timedBooking } from '@/lib/recordings'

const MIN = 60_000

// <input type="datetime-local"> and type="time" speak local time as text.
const pad = (n) => String(n).padStart(2, '0')
const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` }
const toTimeInput = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const lengthLabel = (m) => (m < 60 ? `${m} min` : `${m / 60} h`)
const timeFormat = new Intl.DateTimeFormat([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/**
 * Record a time: where the guide has no programme to book (no guide data, or a
 * "No information available" stand-in) — a start, a length or an end, and a
 * title (the channel's name unless one is typed). lib/recordings.js.
 */
export default function RecordTimeDialog({ channel, defaultStart, onClose }) {
  const [start, setStart] = useState(() => toLocalInput(defaultStart))
  const [length, setLength] = useState(60)        // minutes, or null: the end time below
  const [endTime, setEndTime] = useState(() => toTimeInput(defaultStart + 60 * MIN))
  const [title, setTitle] = useState('')

  const startAt = start ? new Date(start).getTime() : NaN
  const endAt = length ? startAt + length * MIN : endAtTime(startAt, endTime)
  const booking = timedBooking({ startAt, endAt: endAt ?? NaN, title, channelName: channel.name, now: Date.now() })

  const record = () => {
    if (booking.error) return
    bookRecording({ channelId: String(channel.uniqueId), channelName: channel.name, title: booking.title, startAt: booking.startAt, endAt: booking.endAt }, onClose)
  }
  const field = 'rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary-light)]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-label={`Record a time on ${channel.name}`} className="modal-panel rounded-[var(--radius-lg)] w-full max-w-md mx-4 p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[var(--color-text)]">Record a time</h2>
            <p className="text-xs text-[var(--color-muted)]">{channel.name} · no programme in the guide to book</p>
          </div>
          <button aria-label="Close" onClick={onClose} className="shrink-0 p-1 rounded text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Starts
            <input type="datetime-local" value={start} onChange={e => setStart(e.target.value)} className={field} />
          </label>

          <div className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Length
            <div className="flex flex-wrap items-center gap-1.5">
              {RECORD_LENGTHS.map(m => (
                <button key={m} aria-pressed={length === m} onClick={() => setLength(m)}
                  className={cn('px-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-medium transition-colors',
                    length === m ? 'fill-primary' : 'bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)]')}>
                  {lengthLabel(m)}
                </button>
              ))}
              <button aria-pressed={length === null} onClick={() => { setEndTime(toTimeInput(Number.isFinite(endAt) ? endAt : startAt + 60 * MIN)); setLength(null) }}
                className={cn('px-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-medium transition-colors',
                  length === null ? 'fill-primary' : 'bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)]')}>
                Until…
              </button>
              {length === null && (
                <input type="time" aria-label="Ends at" value={endTime} onChange={e => setEndTime(e.target.value)} className={cn(field, 'py-1')} />
              )}
            </div>
          </div>

          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Title
            <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && record()} maxLength={120} placeholder={channel.name} className={field} />
          </label>

          <p className={cn('text-xs', booking.error ? 'text-[var(--color-live)]' : 'text-[var(--color-muted)]')}>
            {booking.error ?? `Records ${timeFormat.format(booking.startAt)} – ${timeFormat.format(booking.endAt)}, plus your padding`}
          </p>
        </div>

        <div className="flex items-center gap-2 mt-4">
          <button onClick={record} disabled={!!booking.error}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-sm font-medium border bg-[var(--color-surface-2)] border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-live)]/50 transition-colors disabled:opacity-50">
            <CircleDot size={13} className="text-[var(--color-live)]" /> Record
          </button>
          <button onClick={onClose} className="ml-auto text-sm text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors px-2 py-1.5">Cancel</button>
        </div>
      </div>
    </div>
  )
}
