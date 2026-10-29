import { useState } from 'react'
import { ChevronsRight, SkipForward } from 'lucide-react'
import { showToast } from '@/lib/toast'
import { matchLabel } from '@/lib/skipSegments'
import { setVodSkipMatch } from '../stalkerApi'

// Skip intro / recap / credits (lib/skipSegments.js).

/**
 * The button over the video while an intro, recap or the credits play — or
 * "Next episode" (`skip.kind` 'next': near the end, or at the credits, with
 * another episode to come; lib/skipSegments.js nextPromptAt).
 */
export function SkipButton({ skip, onSkip, raised = false }) {
  if (!skip) return null
  const next = skip.kind === 'next'
  const Icon = next ? SkipForward : ChevronsRight
  return (
    <button
      // Above the controls bar while it's shown, near the bottom when it isn't.
      className={`absolute right-4 ${raised ? 'bottom-28' : 'bottom-8'} z-30 flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-black/75 hover:bg-white hover:text-black border border-white/40 backdrop-blur px-4 py-2 text-sm font-semibold text-white shadow-lg transition-all`}
      onClick={(e) => { e.stopPropagation(); onSkip(next) }}
    >
      <Icon size={16} fill={next ? 'currentColor' : 'none'} />
      {next ? 'Next episode' : skip.label}
    </button>
  )
}

/**
 * The player's side panel: which IMDb title the show's skip times come from,
 * and a way to set the right one, or turn skipping off for it. Shared by
 * every viewer — it's the show's.
 */
export function SkipMatch({ videoId, found, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  if (!found) return null
  const m = found.match ?? {}
  const parts = ['intro', 'recap', 'outro'].filter((k) => found[k]).length

  async function choose(imdbId) {
    setBusy(true)
    try {
      await setVodSkipMatch(videoId, imdbId)
      setEditing(false)
      setText('')
      onChanged()
    } catch (e) {
      showToast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const status = m.off ? 'Skipping is off for this title.'
    : !found.imdbId ? 'Not found on IMDb.'
    : `${matchLabel(m) || found.imdbId}${m.set ? ' (set by hand)' : ''} · ${parts ? 'times found' : 'no times submitted yet'}`
  const link = 'text-[11px] font-medium text-[var(--color-primary-light)] hover:underline disabled:opacity-50'

  return (
    <div className="pt-3 border-t border-[var(--color-border)]">
      <p className="text-[10px] font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-0.5">Skip intro & credits</p>
      <p className="text-xs text-[var(--color-text)]">{status}</p>
      {!editing ? (
        <div className="flex gap-3 mt-1">
          <button className={link} onClick={() => setEditing(true)}>Change</button>
          {(m.set || m.off) && <button className={link} disabled={busy} onClick={() => choose(null)}>Match by name</button>}
          {!m.off && <button className={link} disabled={busy} onClick={() => choose('off')}>Turn off skipping</button>}
        </div>
      ) : (
        <form className="flex flex-col gap-1.5 mt-1.5" onSubmit={(e) => { e.preventDefault(); if (text.trim()) choose(text.trim()) }}>
          <input
            autoFocus value={text} onChange={(e) => setText(e.target.value)}
            placeholder="tt0903747 or the IMDb page link"
            className="w-full rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)]"
          />
          <p className="text-[10px] text-[var(--color-muted)]">The show&apos;s IMDb page address has its id: imdb.com/title/<b>tt…</b>/</p>
          <div className="flex gap-3">
            <button type="submit" className={link} disabled={busy || !text.trim()}>Save</button>
            <button type="button" className={link} onClick={() => { setEditing(false); setText('') }}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}
