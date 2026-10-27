import { useEffect, useRef } from 'react'
import { Captions, Check, Loader2, Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { byLanguage, delayLabel, languageName, DELAY_STEP } from '@/lib/subtitles'

// The VOD player's subtitles: off, the video's own, or online (lib/subtitles.js).

/** The controls bar's subtitles button, lit while subtitles are on. */
export function SubtitleButton({ on, open, onToggle }) {
  return (
    <button
      data-subtitles-button
      onClick={onToggle}
      className={cn('p-1.5 rounded transition-colors', on || open ? 'text-[var(--color-primary-light)] bg-white/10' : 'text-white/80 hover:text-white hover:bg-white/10')}
      aria-label="Subtitles" aria-expanded={open} title="Subtitles"
    >
      <Captions size={18} />
    </button>
  )
}

/**
 * The menu: Off, "In the video" (`embedded` [{ id, label, language }]) and
 * "Online" (`online` { loading, configured, results, error }), with the
 * delay for the online ones. `choice` { kind, id } is what's showing.
 */
export function SubtitleMenu({ embedded, online, choice, onPick, delay, onDelay, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    // A press outside closes it — not on its own button, which toggles it.
    const away = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('[data-subtitles-button]')) onClose() }
    const esc = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [onClose])

  const row = (selected, label, sub, onClick, key) => (
    <button key={key} onClick={onClick}
      className={cn('w-full flex items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-white/10', selected && 'text-[var(--color-primary-light)]')}>
      <span className="w-3.5 shrink-0 pt-0.5">{selected && <Check size={13} />}</span>
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {sub && <span className="block truncate text-[10px] text-white/50">{sub}</span>}
      </span>
    </button>
  )
  const heading = (text) => <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-white/50">{text}</p>

  return (
    <div ref={ref} onClick={(e) => e.stopPropagation()}
      className="absolute right-4 bottom-20 z-40 w-80 max-h-[60%] overflow-y-auto rounded-[var(--radius-md)] bg-black/90 backdrop-blur py-1 text-white shadow-xl">
      {row(choice.kind === 'off', 'Off', null, () => onPick('off'), 'off')}

      {heading('In the video')}
      {embedded.length === 0
        ? <p className="px-3 pb-1 text-xs text-white/50">None in this video.</p>
        : embedded.map((t) => row(choice.kind === 'embedded' && choice.id === t.id, t.label || languageName(t.language), t.label && t.language ? languageName(t.language) : null,
            () => onPick('embedded', t.id, t.language), `e${t.id}`))}

      {heading(`Online${online.provider ? ` · ${online.provider}` : ''}`)}
      {online.loading && <p className="flex items-center gap-1.5 px-3 pb-1 text-xs text-white/60"><Loader2 size={12} className="animate-spin" /> Looking…</p>}
      {!online.loading && online.configured === false && (
        <p className="px-3 pb-1 text-xs text-white/50">Add a subtitles key in Settings → Playback to look them up.</p>
      )}
      {!online.loading && online.error && <p className="px-3 pb-1 text-xs text-[var(--color-live)]">{online.error}</p>}
      {!online.loading && online.configured && !online.error && online.results.length === 0 && (
        <p className="px-3 pb-1 text-xs text-white/50">None found in your languages.</p>
      )}
      {byLanguage(online.results).map((g) => (
        <div key={g.language}>
          <p className="px-3 pt-1 text-[11px] font-medium text-white/70">{g.name}</p>
          {g.items.map((r) => row(choice.kind === 'online' && choice.id === r.fileId, r.label || 'Subtitles',
            [r.hearingImpaired && 'SDH', r.machine && 'machine-translated', `${r.downloads.toLocaleString()} downloads`].filter(Boolean).join(' · '),
            () => onPick('online', r.fileId, r.language), r.fileId))}
        </div>
      ))}

      {choice.kind === 'online' && (
        <div className="flex items-center gap-2 border-t border-white/10 mt-1 px-3 py-2 text-xs">
          <span className="flex-1 text-white/70">Delay <span className="text-white/40">(out of sync?)</span></span>
          <button onClick={() => onDelay(delay - DELAY_STEP)} className="p-1 rounded hover:bg-white/10" aria-label="Show subtitles earlier"><Minus size={12} /></button>
          <span className="w-12 text-center tabular-nums">{delayLabel(delay)}</span>
          <button onClick={() => onDelay(delay + DELAY_STEP)} className="p-1 rounded hover:bg-white/10" aria-label="Show subtitles later"><Plus size={12} /></button>
        </div>
      )}
    </div>
  )
}
