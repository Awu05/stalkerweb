import { usePlayerSettings } from '@/lib/usePlayerSettings'
import { audioLanguageOptions } from '@/lib/audioTracks'
import { SKIP_MODE_CHOICES } from '@/lib/skipSegments'
import { cn } from '@/lib/utils'

/**
 * Settings → Viewers → My playback: intro skipping and the preferred audio
 * language, for this viewer — the same settings as the player's gear.
 */
export default function PlaybackSettings() {
  const { settings, change } = usePlayerSettings()
  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-sm font-medium text-[var(--color-text)]">Intro skipping</p>
        <p className="text-xs text-[var(--color-muted)] mt-0.5 mb-2">
          Where their times are known (from IntroDB, a community database): a Skip button while an intro, recap or the credits play, or intros and recaps skipped by themselves. Credits are never skipped by themselves.
        </p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Intro skipping">
          {SKIP_MODE_CHOICES.map((c) => (
            <button key={c.id} role="radio" aria-checked={settings?.skipMode === c.id} disabled={!settings}
              onClick={() => change({ skipMode: c.id })}
              className={cn('rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
                settings?.skipMode === c.id
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/15 text-[var(--color-primary-light)]'
                  : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]')}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-sm font-medium text-[var(--color-text)]">Preferred audio language</span>
          <span className="block text-xs text-[var(--color-muted)] mt-0.5">A movie or episode with a track in it starts in it; otherwise the stream&apos;s own plays.</span>
        </span>
        <select value={settings?.audioLanguage ?? ''} disabled={!settings} onChange={(e) => change({ audioLanguage: e.target.value })}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-text)]">
          {audioLanguageOptions().map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
        </select>
      </label>
    </div>
  )
}
