import { useEffect, useMemo, useState, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { Tv2, BookOpen, Settings, Heart, RefreshCw, Timer, Loader2, Film, LayoutGrid, Download, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { AppContext } from '@/lib/appContext'
import { getStatus, getSettings } from './stalkerApi'
import { syncVodProgressFromBackend } from '@/lib/vodProgress'
import { fetchProfiles, getActiveProfileId, getProfileGenres } from '@/lib/profiles'
import ErrorBoundary from '@/components/ErrorBoundary'
import { ToastHost } from '@/components/ToastHost'
import { ReminderBell } from '@/components/ReminderBell'
import { useReminders } from '@/lib/useReminders'

const SetupPage      = lazy(() => import('./pages/SetupPage'))
const ChannelsPage   = lazy(() => import('./pages/ChannelsPage'))
const PlayerPage     = lazy(() => import('./pages/PlayerPage'))
const GuidePage      = lazy(() => import('./pages/GuidePage'))
const FavoritesPage  = lazy(() => import('./pages/FavoritesPage'))
const VodPage        = lazy(() => import('./pages/VodPage'))
const VodPlayerPage  = lazy(() => import('./pages/VodPlayerPage'))
const EpgGridPage    = lazy(() => import('./pages/EpgGridPage'))
const DownloadsPage  = lazy(() => import('./pages/DownloadsPage'))

// ── Sidebar nav link ──────────────────────────────────────────────────────
function NavItem({ to, icon: Icon, label, collapsed, onNavigate }) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          'relative flex items-center gap-3 rounded-[var(--radius-md)] text-sm font-medium transition-all duration-150 h-10',
          collapsed ? 'justify-center w-10 mx-auto' : 'px-3 w-full',
          isActive
            ? 'bg-[var(--color-surface-2)] text-[var(--color-primary-light)]'
            : 'text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]/70'
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-full bg-[var(--color-primary-light)]" />
          )}
          <Icon size={18} className="shrink-0" />
          {!collapsed && <span className="truncate">{label}</span>}
        </>
      )}
    </NavLink>
  )
}

// ── Keepalive badge ───────────────────────────────────────────────────────
function KeepaliveBadge({ lastPingAt, collapsed }) {
  const [label, setLabel] = useState('')

  useEffect(() => {
    if (!lastPingAt) return
    function update() {
      const diff = Math.floor((Date.now() - new Date(lastPingAt).getTime()) / 1000)
      if (diff < 60) setLabel('just now')
      else if (diff < 3600) setLabel(`${Math.floor(diff / 60)}m ago`)
      else setLabel(`${Math.floor(diff / 3600)}h ago`)
    }
    update()
    const id = setInterval(update, 30_000)
    return () => clearInterval(id)
  }, [lastPingAt])

  if (!lastPingAt || collapsed) return null
  return (
    <span className="flex items-center gap-1.5 text-xs text-[var(--color-muted)] opacity-70 hover:opacity-100 transition-opacity" title={`Session keepalive last sent: ${new Date(lastPingAt).toLocaleTimeString()}`}>
      <RefreshCw size={11} className="shrink-0" />
      {label}
    </span>
  )
}

// ── Idle countdown badge ──────────────────────────────────────────────────
function IdleBadge({ idleInfo, collapsed }) {
  const [label, setLabel] = useState('')

  useEffect(() => {
    if (!idleInfo?.lastActivityAt || !idleInfo?.idleTimeoutMs) return
    function update() {
      const elapsed = Date.now() - new Date(idleInfo.lastActivityAt).getTime()
      const remaining = Math.max(0, idleInfo.idleTimeoutMs - elapsed)
      const mins = Math.ceil(remaining / 60000)
      setLabel(remaining === 0 ? 'disconnecting…' : `idle · ${mins}m`)
    }
    update()
    const id = setInterval(update, 30_000)
    return () => clearInterval(id)
  }, [idleInfo])

  // No timeout means auto-disconnect is off ("Never" in Settings) — the status
  // poll still reports lastActivityAt, so this must check the timeout too, or
  // the badge stays up showing whatever countdown it last computed.
  if (!idleInfo?.lastActivityAt || !idleInfo?.idleTimeoutMs || collapsed) return null
  return (
    <span className="flex items-center gap-1.5 text-xs text-[var(--color-muted)] opacity-60 hover:opacity-100 transition-opacity" title="Auto-disconnect when idle">
      <Timer size={11} className="shrink-0" />
      {label}
    </span>
  )
}

// ── Logo mark ─────────────────────────────────────────────────────────────
function LogoMark({ collapsed }) {
  return (
    <div className={cn('flex items-center gap-2.5 overflow-hidden', collapsed && 'justify-center')}>
      <svg width="22" height="22" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 text-[var(--color-primary-light)]">
        <path d="M 3 25 A 13 13 0 0 0 29 25" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.35" />
        <path d="M 7 25 A 9 9 0 0 0 25 25" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.65" />
        <path d="M 11 25 A 5 5 0 0 0 21 25" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="16" cy="25" r="2.5" fill="currentColor" />
      </svg>
      {!collapsed && <span className="font-display font-semibold text-[15px] whitespace-nowrap text-[var(--color-text)]">StalkerWeb</span>}
    </div>
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────────
function Sidebar({ connected, epgEnabled, lastPingAt, idleInfo, version, collapsed, onToggle, mobileOpen, onCloseMobile }) {
  const { reminders, removeReminder } = useReminders()

  const navItems = connected && (
    <nav className="flex flex-col gap-1 px-3">
      <NavItem to="/channels"  icon={Tv2}         label="Channels"  collapsed={collapsed} onNavigate={onCloseMobile} />
      <NavItem to="/vod"       icon={Film}        label="VOD"       collapsed={collapsed} onNavigate={onCloseMobile} />
      <NavItem to="/downloads" icon={Download}    label="Downloads" collapsed={collapsed} onNavigate={onCloseMobile} />
      <NavItem to="/favorites" icon={Heart}       label="Favorites" collapsed={collapsed} onNavigate={onCloseMobile} />
      {epgEnabled && <NavItem to="/guide"    icon={BookOpen}    label="Guide"    collapsed={collapsed} onNavigate={onCloseMobile} />}
      {epgEnabled && <NavItem to="/epg-grid" icon={LayoutGrid}  label="EPG Grid" collapsed={collapsed} onNavigate={onCloseMobile} />}
    </nav>
  )

  return (
    <>
      {/* Mobile scrim */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={onCloseMobile} />
      )}

      <aside
        data-open={mobileOpen}
        className={cn(
          'app-sidebar fixed inset-y-0 left-0 z-50 flex flex-col bg-[var(--color-bg)] border-r border-[var(--color-border)] transition-transform duration-200 ease-out',
          collapsed ? 'w-16' : 'w-64'
        )}
      >
        <div className={cn('flex items-center h-14 shrink-0 border-b border-[var(--color-border)]', collapsed ? 'justify-center px-2' : 'justify-between px-4')}>
          <LogoMark collapsed={collapsed} />
          <button
            onClick={onToggle}
            className="hidden lg:flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors shrink-0"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-3">
          {navItems}
        </div>

        <div className={cn('shrink-0 border-t border-[var(--color-border)] py-3 px-3 flex flex-col gap-2', collapsed && 'items-center')}>
          {connected && (
            <div className={cn('flex items-center gap-1', collapsed ? 'flex-col' : 'justify-between')}>
              <ReminderBell reminders={reminders} onRemove={removeReminder} />
              {!collapsed && <IdleBadge idleInfo={idleInfo} collapsed={collapsed} />}
            </div>
          )}
          {!collapsed && <KeepaliveBadge lastPingAt={lastPingAt} collapsed={collapsed} />}

          <span
            className={cn('flex items-center gap-1.5 text-xs text-[var(--color-muted)]', collapsed && 'justify-center')}
            title={connected ? 'Connected' : 'Disconnected'}
          >
            <span
              className={cn(
                'inline-block h-2 w-2 rounded-full shrink-0',
                connected ? 'bg-[var(--color-success)]' : 'bg-[var(--color-surface-3)]'
              )}
            />
            {!collapsed && (connected ? 'Connected' : 'Disconnected')}
          </span>

          {version && !collapsed && (
            <span className="text-[10px] text-[var(--color-muted)] opacity-50">
              {/^v?\d/.test(version) ? (version.startsWith('v') ? version : `v${version}`) : version}
            </span>
          )}

          <NavItem to="/settings" icon={Settings} label="Profiles" collapsed={collapsed} onNavigate={onCloseMobile} />
        </div>
      </aside>
    </>
  )
}

function RequireAuth({ connected, children }) {
  if (!connected) return <Navigate to="/settings" replace />
  return children
}

function AppInner() {
  const [connected, setConnected] = useState(false)
  const [statusLoaded, setStatusLoaded] = useState(false)
  const [epgEnabled, setEpgEnabled] = useState(true)
  const [showAdult, setShowAdult]   = useState(false)
  const [disabledGenres, setDisabledGenres] = useState(new Set())
  const [disabledLanguages, setDisabledLanguages] = useState(new Set())
  const [lastPingAt, setLastPingAt] = useState(null)
  const [idleInfo, setIdleInfo] = useState(null) // { lastActivityAt, idleTimeoutMs }
  const [version, setVersion] = useState(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sw:sidebarCollapsed') === '1')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  function toggleSidebar() {
    setSidebarCollapsed(v => {
      localStorage.setItem('sw:sidebarCollapsed', v ? '0' : '1')
      return !v
    })
  }

  // Only replace idleInfo when a field actually changes — the 30s status poll
  // otherwise hands a fresh object every tick, re-rendering every context
  // consumer (PlayerPage, ChannelsPage, …) for no real state change.
  function updateIdleInfo(lastActivityAt, idleTimeoutMs) {
    setIdleInfo(prev =>
      prev && prev.lastActivityAt === lastActivityAt && prev.idleTimeoutMs === idleTimeoutMs
        ? prev
        : { lastActivityAt, idleTimeoutMs }
    )
  }

  useEffect(() => {
    async function load() {
      try {
        // Profiles must be fetched (and any leftover localStorage profiles
        // migrated in) before anything reads getActiveProfileId() — including
        // syncVodProgressFromBackend()'s per-profile localStorage scoping below.
        const [status, settings] = await Promise.all([getStatus(), getSettings(), fetchProfiles().catch(() => {})])
        setConnected(status.connected)
        if (status.version) setVersion(status.version)
        syncVodProgressFromBackend().catch(() => {})
        setEpgEnabled(settings.epg_enabled !== false)
        setShowAdult(!!settings.show_adult)
        // Genre filters are strictly per-profile — an empty list means "no
        // filters", not "inherit".
        const activeId = getActiveProfileId()
        setDisabledGenres(new Set(activeId ? getProfileGenres(activeId) : []))
        if (status.watchdog?.lastPingAt) setLastPingAt(status.watchdog.lastPingAt)
        if (status.lastActivityAt) updateIdleInfo(status.lastActivityAt, status.idleTimeoutMs)
      } catch {
        setConnected(false)
      } finally {
        setStatusLoaded(true)
      }
    }
    load()
    const id = setInterval(async () => {
      try {
        const s = await getStatus()
        setConnected(s.connected)
        if (s.watchdog?.lastPingAt) setLastPingAt(s.watchdog.lastPingAt)
        else if (!s.connected) setLastPingAt(null)
        if (s.lastActivityAt) updateIdleInfo(s.lastActivityAt, s.idleTimeoutMs)
        else if (!s.connected) setIdleInfo(null)
      } catch {
        setConnected(false)
      }
    }, 30_000)
    return () => clearInterval(id)
  }, [])

  // Memoize so consumers don't re-render just because AppInner re-rendered
  // (e.g. the 30s poll updating local idle/ping badges). Must run before any
  // early return to keep hook order stable.
  const ctxValue = useMemo(
    () => ({ connected, setConnected, epgEnabled, setEpgEnabled, showAdult, setShowAdult, disabledGenres, setDisabledGenres, disabledLanguages, setDisabledLanguages, setLastPingAt, setIdleInfo }),
    [connected, epgEnabled, showAdult, disabledGenres, disabledLanguages]
  )

  if (!statusLoaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 rounded-full border-2 border-[var(--color-primary)] border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <AppContext.Provider value={ctxValue}>
      <TooltipProvider delayDuration={300}>
        <Sidebar
          connected={connected}
          epgEnabled={epgEnabled}
          lastPingAt={lastPingAt}
          idleInfo={idleInfo}
          version={version}
          collapsed={sidebarCollapsed}
          onToggle={toggleSidebar}
          mobileOpen={mobileNavOpen}
          onCloseMobile={() => setMobileNavOpen(false)}
        />

        {/* Mobile top bar — hidden at lg+, where the sidebar takes over */}
        <header className="lg:hidden fixed top-0 inset-x-0 z-30 h-14 flex items-center gap-3 px-4 border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur-xl">
          <button
            onClick={() => setMobileNavOpen(true)}
            className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
            aria-label="Open navigation"
          >
            <PanelLeftOpen size={18} />
          </button>
          <LogoMark collapsed={false} />
          <div className="flex-1" />
          <span
            className="inline-block h-2 w-2 rounded-full shrink-0"
            style={{ background: connected ? 'var(--color-success)' : 'var(--color-surface-3)' }}
            title={connected ? 'Connected' : 'Disconnected'}
          />
        </header>

        <main
          className={cn(
            'pt-14 lg:pt-0 min-h-full transition-[margin] duration-200 ease-out',
            sidebarCollapsed ? 'lg:ml-16' : 'lg:ml-64'
          )}
        >
          <Suspense fallback={<div className="flex h-48 items-center justify-center"><Loader2 size={24} className="animate-spin text-[var(--color-primary-light)]" /></div>}>
          <Routes>
            <Route path="/settings" element={<SetupPage />} />
            <Route
              path="/channels"
              element={
                <RequireAuth connected={connected}>
                  <ChannelsPage />
                </RequireAuth>
              }
            />
            <Route
              path="/player"
              element={
                <RequireAuth connected={connected}>
                  <PlayerPage />
                </RequireAuth>
              }
            />
            <Route
              path="/favorites"
              element={
                <RequireAuth connected={connected}>
                  <FavoritesPage />
                </RequireAuth>
              }
            />
            <Route
              path="/guide"
              element={
                <RequireAuth connected={connected}>
                  <GuidePage />
                </RequireAuth>
              }
            />
            <Route
              path="/epg-grid"
              element={
                <RequireAuth connected={connected}>
                  <EpgGridPage />
                </RequireAuth>
              }
            />
            <Route
              path="/vod"
              element={
                <RequireAuth connected={connected}>
                  <VodPage />
                </RequireAuth>
              }
            />
            <Route
              path="/vod-player"
              element={
                <RequireAuth connected={connected}>
                  <VodPlayerPage />
                </RequireAuth>
              }
            />
            <Route
              path="/downloads"
              element={
                <RequireAuth connected={connected}>
                  <DownloadsPage />
                </RequireAuth>
              }
            />
            <Route
              path="*"
              element={<Navigate to={connected ? '/channels' : '/settings'} replace />}
            />
          </Routes>
          </Suspense>
        </main>
      </TooltipProvider>
    </AppContext.Provider>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <AppInner />
        <ToastHost />
      </ErrorBoundary>
    </BrowserRouter>
  )
}
