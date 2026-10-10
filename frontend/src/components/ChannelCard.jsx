import { useState, memo } from 'react'
import { Tv2, AlertTriangle, Heart, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getProxiedLogoUrl } from '../stalkerApi'

// Channels with at least this many recent (unresolved) stream errors are "flaky".
export const FLAKY_THRESHOLD = 2

function healthTitle(errors) {
  return `${errors} recent stream ${errors === 1 ? 'failure' : 'failures'} — may not play`
}

// Always-visible edit control at the top of a tile. Editing used to be a hover
// overlay on the logo, which hid it on touch screens and made clicking the logo
// edit instead of play; the logo is now part of the tile's play target.
// A span (not a nested <button>, which is invalid inside the tile's button)
// with button semantics and keyboard support.
function EditButton({ channel, onEdit, className }) {
  const edit = (e) => { e.stopPropagation(); e.preventDefault(); onEdit(channel) }
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={edit}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') edit(e) }}
      title="Edit channel"
      aria-label={`Edit ${channel.name}`}
      className={cn('absolute z-10 p-1.5 rounded text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)] transition-colors', className)}
    >
      <Pencil size={18} />
    </span>
  )
}

// Favourite toggle for a tile — shown on hover, and always once favourited.
// A span with button semantics for the same reason as EditButton.
function FavoriteButton({ channel, isFavorite, onToggle, className }) {
  const toggle = (e) => { e.stopPropagation(); e.preventDefault(); onToggle(channel) }
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={toggle}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') toggle(e) }}
      title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      aria-label={isFavorite ? `Remove ${channel.name} from favorites` : `Add ${channel.name} to favorites`}
      aria-pressed={isFavorite}
      className={cn('absolute z-10 p-1.5 rounded transition-colors', className,
        isFavorite
          ? 'text-rose-500'
          : 'text-[var(--color-muted)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-rose-400')}
    >
      <Heart size={18} fill={isFavorite ? 'currentColor' : 'none'} />
    </span>
  )
}

// ── Channel tile ──────────────────────────────────────────────────────────
// The one tile for a channel — the grid, Recently Watched and Favorites all
// use it, so they're the same size everywhere. It fills the width it's given
// and is always the same height: the name takes two lines and the guide
// strip is there even without guide data, so a row of tiles lines up.
//
// Memoized: with thousands of channels rendered through the virtualizer, the
// grid re-renders on every scroll tick and on health/now-next polls. memo +
// stable callback props keep all but the genuinely-changed cards from
// re-rendering.
export const ChannelCard = memo(function ChannelCard({ channel, logoUrl, isFavorite, onToggleFavorite, onClick, onSetLogo, nowNext, health }) {
  const [imgError, setImgError] = useState(false)
  const logo = logoUrl || getProxiedLogoUrl(channel.iconPath) || ''
  const errors = health?.errors || 0

  const epgProgress = nowNext?.now
    ? Math.min(100, Math.round(((Math.floor(Date.now() / 1000) - nowNext.now.startTime) /
        (nowNext.now.endTime - nowNext.now.startTime)) * 100))
    : 0

  return (
    <button
      onClick={() => onClick(channel)}
      className="surface-card group relative w-full h-full flex flex-col items-center gap-2.5 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)] px-4 pb-4 pt-10 text-left hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-surface-2)] cursor-pointer"
    >
      {onToggleFavorite && <FavoriteButton channel={channel} isFavorite={isFavorite} onToggle={onToggleFavorite} className="top-1.5 right-11" />}
      {errors > 0 && (
        <span
          className={cn('absolute top-2.5 left-2.5 flex items-center gap-1 text-[10px] font-medium',
            errors >= FLAKY_THRESHOLD ? 'text-amber-400' : 'text-amber-400/70')}
          title={healthTitle(errors)}
        >
          <AlertTriangle size={16} fill="currentColor" />
        </span>
      )}
      {onSetLogo && <EditButton channel={channel} onEdit={onSetLogo} className="top-1.5 right-1.5" />}
      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] overflow-hidden">
        {logo && !imgError
          ? <img src={logo} alt={channel.name} loading="lazy" onError={() => setImgError(true)} className="h-full w-full object-contain p-1" />
          : <Tv2 size={28} className="text-[var(--color-muted)]" />}
      </div>
      <div className="w-full min-w-0 text-center">
        <p className="text-xs text-[var(--color-muted)] mb-0.5 h-[1lh]">{channel.number ? `Ch ${channel.number}` : ''}</p>
        <p className="h-[2lh] text-sm font-medium text-[var(--color-text)] leading-tight break-words line-clamp-2" title={channel.name}>{channel.name}</p>
      </div>
      {/* The guide strip: always this tall, so tiles with and without guide data match. */}
      <div className="w-full min-w-0 mt-auto pt-2 h-[52px] border-t border-[var(--color-border)]">
        {nowNext?.now && (
          <>
            <p className="text-[10px] font-medium text-[var(--color-primary-light)] leading-tight truncate text-left">{nowNext.now.title}</p>
            <div className="mt-1.5 h-[3px] w-full rounded-full bg-[var(--color-surface-3)] overflow-hidden">
              <div className="h-full rounded-full bg-[var(--color-primary)] transition-none" style={{ width: `${epgProgress}%` }} />
            </div>
            {nowNext.next && (
              <p className="mt-1 text-[9px] text-[var(--color-muted)] truncate text-left">Next: {nowNext.next.title}</p>
            )}
          </>
        )}
      </div>
    </button>
  )
})
