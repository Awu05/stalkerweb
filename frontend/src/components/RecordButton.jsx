import { useEffect, useRef, useState } from 'react'
import { CircleDot, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getRecordings, recordNow, stopRecording } from '../stalkerApi'
import { recordChoices, endForChoice, recordingOn } from '@/lib/recordings'
import { showToast } from '@/lib/toast'

/**
 * Record in the live player: the channel playing, from now — until the
 * programme ends, for a while, or until stopped (lib/recordings.js). The
 * server records it (recordings/), so it goes on with the player closed.
 * While one of this viewer's recordings is being made on the channel —
 * started here, elsewhere or from the guide — it shows so, and stops it.
 */
export default function RecordButton({ channel, programme }) {
  const [open, setOpen] = useState(false)
  // { channelId, id }: kept with its channel, so an answer that comes after a
  // zap never shows Stop on the next channel (and stops the wrong one).
  const [recording, setRecording] = useState(null)
  const box = useRef(null)
  const changed = useRef(0)   // bumped by Record and Stop here: a look sent before can't undo them
  const channelId = channel ? String(channel.uniqueId) : null
  const recordingId = recording?.channelId === channelId ? recording.id : null
  // On the channel (a moment after: not for each one zapped past), and every
  // 30 s: what's recording on it — a booking that started, one begun
  // elsewhere; ended, stopped or failed, it's Record again.
  useEffect(() => {
    setOpen(false)
    if (!channelId) return
    let gone = false
    // Never wakes an asleep server (stalkerApi.js, { background: true }).
    const look = () => {
      const n = changed.current
      getRecordings(false, { background: true })
        .then((r) => {
          if (gone || n !== changed.current) return
          const id = recordingOn(r.recordings, channelId)
          setRecording(id ? { channelId, id } : null)
        })
        .catch(() => { /* offline for a moment: ask again next time */ })
    }
    const first = setTimeout(look, 1_000)
    const t = setInterval(look, 30_000)
    return () => { gone = true; clearTimeout(first); clearInterval(t) }
  }, [channelId])
  useEffect(() => {
    if (!open) return
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  if (!channel) return null

  const start = async (choice, force = false) => {
    setOpen(false)
    const now = Date.now()
    const body = {
      channelId: String(channel.uniqueId), channelName: channel.name, title: programme?.title || channel.name,
      endAt: endForChoice(choice, now, programme?.endTime ? programme.endTime * 1000 : null), force,
    }
    try {
      const r = await recordNow(body)
      changed.current++
      setRecording({ channelId: body.channelId, id: r.id })
      showToast(`Recording "${body.title}" — it's on the Recordings page`)
    } catch (e) {
      // The provider's stream limit is in use: ask first (routes/recordings.js).
      if (e.status === 409 && e.body?.takesStream && window.confirm(e.message)) return start(choice, true)
      if (!(e.status === 409 && e.body?.takesStream)) showToast(e.message, 'error')
    }
  }
  const stop = () => stopRecording(recordingId)
    .then(() => { changed.current++; setRecording(null); showToast('Recording stopped — what it has is kept') })
    .catch((e) => showToast(e.message, 'error'))

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => (recordingId ? stop() : setOpen((o) => !o))}
        aria-label={recordingId ? 'Stop recording' : 'Record'}
        data-tooltip={recordingId ? 'Stop recording' : 'Record'}
        className={cn('p-1 transition-colors', recordingId ? 'text-[var(--color-live)] animate-pulse' : 'text-white/90 hover:text-white')}
      >
        {recordingId ? <Square size={18} /> : <CircleDot size={18} />}
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full right-0 mb-2 w-56 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-xl z-50">
          <p className="px-3 py-1.5 text-xs text-[var(--color-muted)]">Record {programme?.title ? `"${programme.title}"` : channel.name}</p>
          {recordChoices(programme?.endTime ? programme.endTime * 1000 : null, Date.now()).map((c) => (
            <button key={c.id} role="menuitem" onClick={() => start(c.id)}
              className="block w-full text-left px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
