import { useEffect, useRef, useState } from 'react'
import { CircleDot, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getRecordings, recordNow, stopRecording } from '../stalkerApi'
import { recordChoices, endForChoice, stillRecording } from '@/lib/recordings'
import { showToast } from '@/lib/toast'

/**
 * Record in the live player: the channel playing, from now — until the
 * programme ends, for a while, or until stopped (lib/recordings.js). The
 * server records it (recordings/), so it goes on with the player closed;
 * pressed again while this player started one, it stops it.
 */
export default function RecordButton({ channel, programme }) {
  const [open, setOpen] = useState(false)
  const [recordingId, setRecordingId] = useState(null)
  const box = useRef(null)
  useEffect(() => { setRecordingId(null); setOpen(false) }, [channel?.uniqueId])
  // While it shows "recording": a look every 30 s — ended by itself, stopped elsewhere or failed, it's Record again.
  useEffect(() => {
    if (!recordingId) return
    let gone = false
    // A timer's request: never wakes an asleep server (stalkerApi.js, { background: true }).
    const look = () => getRecordings(false, { background: true })
      .then((r) => { if (!gone && !stillRecording(r.recordings, recordingId)) setRecordingId((id) => (id === recordingId ? null : id)) })
      .catch(() => { /* offline for a moment: ask again next time */ })
    const t = setInterval(look, 30_000)
    return () => { gone = true; clearInterval(t) }
  }, [recordingId])
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
      setRecordingId(r.id)
      showToast(`Recording "${body.title}" — it's on the Recordings page`)
    } catch (e) {
      // The provider's stream limit is in use: ask first (routes/recordings.js).
      if (e.status === 409 && e.body?.takesStream && window.confirm(e.message)) return start(choice, true)
      if (!(e.status === 409 && e.body?.takesStream)) showToast(e.message, 'error')
    }
  }
  const stop = () => stopRecording(recordingId)
    .then(() => { setRecordingId(null); showToast('Recording stopped — what it has is kept') })
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
