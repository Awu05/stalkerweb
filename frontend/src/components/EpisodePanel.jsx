import { Loader2, Play } from 'lucide-react'
import { cn } from '@/lib/utils'

// A show's episodes in the VOD player: pick a season, play any episode. The one
// playing is highlighted. Used in the player's side panel, and in a pop-up on
// screens too narrow for it.
export default function EpisodePanel({ seasons, seasonId, onSeason, episodes, playingSeasonId, playingEpisodeId, onPlay }) {
  if (!seasons) {
    return <div className="flex justify-center py-4"><Loader2 size={18} className="animate-spin text-[var(--color-primary-light)]" /></div>
  }
  if (!seasons.length) return null
  const season = seasons.find((s) => s.id === seasonId)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="text-[10px] font-semibold text-[var(--color-muted)] uppercase tracking-wide">Episodes</p>
        {seasons.length > 1 && (
          <select
            aria-label="Season"
            value={seasonId}
            onChange={(e) => onSeason(e.target.value)}
            className="ml-auto rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-primary-light)]"
          >
            {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {seasons.length === 1 && <span className="ml-auto text-xs text-[var(--color-muted)]">{season?.name}</span>}
      </div>
      {!episodes ? (
        <div className="flex justify-center py-4"><Loader2 size={18} className="animate-spin text-[var(--color-primary-light)]" /></div>
      ) : episodes.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)] py-2">No episodes in this season.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {episodes.map((ep) => {
            const playing = seasonId === playingSeasonId && ep.episodeId === playingEpisodeId
            return (
              <li key={ep.episodeId}>
                <button
                  type="button"
                  onClick={() => onPlay(season, ep)}
                  aria-current={playing ? 'true' : undefined}
                  className={cn(
                    'w-full flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs transition-colors',
                    playing
                      ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary-light)] font-medium'
                      : 'text-[var(--color-text)] hover:bg-[var(--color-surface-2)]'
                  )}
                >
                  <Play size={11} className={cn('shrink-0', playing ? 'opacity-100' : 'opacity-40')} fill="currentColor" />
                  <span className="truncate">{ep.name || `Episode ${ep.seriesNumber}`}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
