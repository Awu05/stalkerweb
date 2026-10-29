import { useEffect, useRef } from 'react'
import { Check, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { audioTrackLabels, audioLanguageOptions } from '@/lib/audioTracks'
import { SKIP_MODE_CHOICES } from '@/lib/skipSegments'

// The movie & series player's settings gear: this title's audio track, the
// viewer's preferred audio language, and intro skipping (lib/usePlayerSettings.js).

/** The controls bar's gear button. */
export function PlayerSettingsButton({ open, onToggle }) {
  return (
    <button
      data-player-settings-button
      onClick={onToggle}
      className={cn('p-1.5 rounded transition-colors', open ? 'text-[var(--color-primary-light)] bg-white/10' : 'text-white/80 hover:text-white hover:bg-white/10')}
      aria-label="Player settings" aria-expanded={open} title="Player settings"
    >
      <Settings size={18} />
    </button>
  )
}

/**
 * The menu. `audio` is lib/useVodAudio.js's { tracks, active, switchable, pick };
 * `settings` { skipMode, audioLanguage } (null while loading), `onChange(patch)` saves.
 */
export function PlayerSettingsMenu({ audio, settings, onChange, onClose }) {
  const ref = useRef(null)
  // The latest onClose, read when needed (a new one each render).
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })
  useEffect(() => {
    // A press outside closes it — not on its own button, which toggles it.
    const away = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('[data-player-settings-button]')) closeRef.current() }
    const esc = (e) => { if (e.key === 'Escape') closeRef.current() }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [])

  const row = (selected, label, onClick, key, disabled = false) => (
    <button key={key} onClick={onClick} disabled={disabled} role="menuitemradio" aria-checked={selected}
      className={cn('w-full flex items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-white/10 disabled:opacity-50', selected && 'text-[var(--color-primary-light)]')}>
      <span className="w-3.5 shrink-0 pt-0.5">{selected && <Check size={13} />}</span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
  const heading = (text) => <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-white/50">{text}</p>
  const note = (text) => <p className="px-3 pb-1 text-xs text-white/50">{text}</p>

  const tracks = audioTrackLabels(audio.tracks)
  const skipMode = settings?.skipMode

  return (
    <div ref={ref} onClick={(e) => e.stopPropagation()} role="menu" aria-label="Player settings"
      className="absolute right-4 bottom-20 z-40 w-72 max-h-[60%] overflow-y-auto rounded-[var(--radius-md)] bg-black/90 backdrop-blur py-1 text-white shadow-xl">
      {heading('Audio')}
      {!audio.switchable ? note("This browser can't list or switch audio tracks in this video.")
        : tracks.length < 2 ? note('This video has one audio track.')
        : tracks.map((t) => row(t.id === audio.active, t.label, () => audio.pick(t.id), `a${t.id}`))}

      {heading('Preferred audio language')}
      <div className="px-3 pb-2">
        <select
          aria-label="Preferred audio language"
          value={settings?.audioLanguage ?? ''} disabled={!settings}
          onChange={(e) => onChange({ audioLanguage: e.target.value })}
          className="w-full rounded-[var(--radius-sm)] border border-white/20 bg-black/60 px-2 py-1 text-xs text-white"
        >
          {audioLanguageOptions().map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
        </select>
        <p className="mt-1 text-[10px] text-white/50">Each title starts in it where it has a track in it.</p>
      </div>

      {heading('Intro skipping')}
      {SKIP_MODE_CHOICES.map((c) => row(skipMode === c.id, c.label, () => onChange({ skipMode: c.id }), `s${c.id}`, !settings))}
    </div>
  )
}
