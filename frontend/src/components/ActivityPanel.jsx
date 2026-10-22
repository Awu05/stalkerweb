import { useEffect, useState } from 'react'
import { Download, Loader2, Radio } from 'lucide-react'
import { getActivity } from '../stalkerApi'
import { ViewerAvatar } from '@/components/ViewerPicker'
import { playingFor, kindLabel, viaLabel, portalSummary } from '@/lib/activity'
import { cn } from '@/lib/utils'

const REFRESH_MS = 5_000

/** Settings → Activity: every stream going through this server now, whose, and on what. */
export default function ActivityPanel() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let off = false
    const load = () => {
      if (document.hidden) return
      getActivity()
        .then((d) => { if (!off) { setData(d); setError('') } })
        .catch((e) => { if (!off) setError(e.message || 'Could not load the activity') })
    }
    load()
    const id = setInterval(load, REFRESH_MS)
    document.addEventListener('visibilitychange', load)
    return () => { off = true; clearInterval(id); document.removeEventListener('visibilitychange', load) }
  }, [])

  if (!data && !error) {
    return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-[var(--color-primary-light)]" /></div>
  }

  const now = data?.now ?? Date.now()
  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-xs text-[var(--color-live)]">{error}</p>}
      {data && (
        <>
          <p className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
            <span className={cn('inline-block h-2 w-2 rounded-full', data.portal?.connected ? 'bg-emerald-500' : 'bg-[var(--color-muted)]')} />
            {portalSummary(data.portal)}
          </p>

          {data.streams.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--color-muted)]">Nothing is playing right now.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)] rounded-[var(--radius-sm)] border border-[var(--color-border)]">
              {data.streams.map((s) => (
                <li key={`${s.ip}|${s.device}|${s.kind}|${s.id}`} className="flex items-center gap-3 px-3 py-2.5">
                  <ViewerAvatar viewer={s.viewer} size={30} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm text-[var(--color-text)]">
                      <span className="truncate font-medium">{s.title}</span>
                      <span className={cn('shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide',
                        kindLabel(s) === 'Live' ? 'bg-[var(--color-live)]/15 text-[var(--color-live)]' : 'bg-[var(--color-surface-2)] text-[var(--color-muted)]')}>
                        {kindLabel(s)}
                      </span>
                    </p>
                    {s.subtitle && <p className="truncate text-xs text-[var(--color-muted)]">{s.subtitle}</p>}
                    <p className="truncate text-xs text-[var(--color-muted)]">
                      {s.viewer?.name || 'Unknown viewer'} · {s.device}{viaLabel(s) ? ` · ${viaLabel(s)}` : ''} · {s.ip}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-[var(--color-muted)]" title={new Date(s.startedAt).toLocaleString()}>
                    {playingFor(s.startedAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {data.downloads?.length > 0 && (
            <div className="flex flex-col gap-1">
              {data.downloads.map((d, i) => (
                <p key={i} className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                  <Download size={12} className="shrink-0" />
                  <span className="truncate">Downloading {d.title}</span>
                  {d.percent != null && <span className="tabular-nums">{d.percent}%</span>}
                </p>
              ))}
            </div>
          )}

          <p className="flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
            <Radio size={11} /> Updates every few seconds. A stream drops off about 30 s after it stops.
          </p>
        </>
      )}
    </div>
  )
}
