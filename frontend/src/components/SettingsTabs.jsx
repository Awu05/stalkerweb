import { cn } from '@/lib/utils'
import { SETTINGS_TABS } from '@/lib/settingsTabs'

// The tab bar at the top of Settings. Stays pinned while a tab scrolls; on a
// narrow screen it scrolls sideways. Left/Right (keyboard, TV remote) move
// between tabs and open them.
export default function SettingsTabs({ tab, onChange }) {
  function onKeyDown(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const i = SETTINGS_TABS.findIndex((t) => t.id === tab)
    const next = SETTINGS_TABS[(i + (e.key === 'ArrowRight' ? 1 : SETTINGS_TABS.length - 1)) % SETTINGS_TABS.length]
    onChange(next.id)
    // Focus follows, so the next arrow press carries on from the new tab.
    requestAnimationFrame(() => document.getElementById(`settings-tab-${next.id}`)?.focus())
  }

  return (
    <div className="sticky top-0 z-[5] -mx-4 sm:-mx-8 px-4 sm:px-8 pr-14 py-2 bg-[var(--color-bg)]/95 backdrop-blur border-b border-[var(--color-border)]">
      <div role="tablist" aria-label="Settings sections" className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" onKeyDown={onKeyDown}>
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            id={`settings-tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls="settings-panel"
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={cn(
              'shrink-0 px-3.5 py-1.5 rounded-[var(--radius-sm)] text-sm font-medium transition-colors whitespace-nowrap',
              tab === t.id
                ? 'bg-[var(--color-primary)] text-[var(--color-bg)]'
                : 'text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}
