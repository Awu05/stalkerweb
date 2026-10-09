import { useEffect, useMemo, useState, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Tv2, Settings, Heart, Loader2, Film, LayoutGrid, Download, PanelLeftClose, PanelLeftOpen, LogOut } from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { AppContext } from '@/lib/appContext'
import { getStatus, getSettings, getAccessStatus, accessLogout, ACCESS_REQUIRED, VIEWER_GONE, getViewers, createViewer, getMyViewer } from './stalkerApi'
import LoginPage from './pages/LoginPage'
import { loadWatch } from '@/lib/vodProgress'
import { fetchProfiles } from '@/lib/profiles'
import ViewerPicker, { ViewerAvatar } from '@/components/ViewerPicker'
import { getViewerId, setViewerId, chooseViewer } from '@/lib/viewer'
import { invalidateFavoritesCache } from '@/lib/useFavorites'
import ErrorBoundary from '@/components/ErrorBoundary'
import SettingsModal from '@/components/SettingsModal'
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
const DownloadsPage  = lazy(() => import('./pages/DownloadsPage'))

// ── Sidebar nav link ──────────────────────────────────────────────────────
function NavItem({ to, icon: Icon, label, collapsed, onNavigate, state }) {
  return (
    <NavLink
      to={to}
      state={state}
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

// ── Connection status ─────────────────────────────────────────────────────
// A dot, "Connected" and the idle auto-disconnect countdown; the full details
// (keepalive, countdown) are in its tooltip.
const ago = (iso) => {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  return `${Math.floor(secs / 3600)}h ago`
}

function useStatusDetails(connected, lastPingAt, idleInfo) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  if (!connected) return { tooltip: 'Not connected to a portal', idle: null }
  const parts = ['Connected to the portal']
  if (lastPingAt) parts.push(`keepalive sent ${ago(lastPingAt)}`)
  let idle = null
  if (idleInfo?.lastActivityAt && idleInfo?.idleTimeoutMs) {
    const left = Math.max(0, idleInfo.idleTimeoutMs - (Date.now() - new Date(idleInfo.lastActivityAt).getTime()))
    idle = left === 0 ? 'disconnecting' : `idle ${Math.ceil(left / 60000)}m`
    parts.push(left === 0 ? 'disconnecting (idle)' : `disconnects after ${Math.ceil(left / 60000)}m idle`)
  }
  return { tooltip: parts.join(' · '), idle }
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
function Sidebar({ connected, epgEnabled, lastPingAt, idleInfo, version, accessEnabled, collapsed, onToggle, mobileOpen, onCloseMobile, viewer, onSwitchViewer }) {
  const { reminders, removeReminder } = useReminders()
  const status = useStatusDetails(connected, lastPingAt, idleInfo)
  // Settings opens as a window over the page you're on (see AppInner).
  const location = useLocation()
  const settingsState = location.pathname === '/settings' ? location.state : { background: location }

  const navItems = connected && (
    <nav className="flex flex-col gap-1 px-3">
      <NavItem to="/channels"  icon={Tv2}         label="Channels"  collapsed={collapsed} onNavigate={onCloseMobile} />
      <NavItem to="/vod"       icon={Film}        label="VOD"       collapsed={collapsed} onNavigate={onCloseMobile} />
      <NavItem to="/downloads" icon={Download}    label="Downloads" collapsed={collapsed} onNavigate={onCloseMobile} />
      <NavItem to="/favorites" icon={Heart}       label="Favorites" collapsed={collapsed} onNavigate={onCloseMobile} />
      {epgEnabled && <NavItem to="/guide"    icon={LayoutGrid}  label="Guide"    collapsed={collapsed} onNavigate={onCloseMobile} />}
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
          <div className="flex items-center gap-1 shrink-0">
            {/* Reminders live up here beside the logo; a collapsed header is too
                narrow for both buttons, so there it heads the icon column. */}
            {connected && !collapsed && <ReminderBell reminders={reminders} onRemove={removeReminder} />}
            <button
              onClick={onToggle}
              className="hidden lg:flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors shrink-0"
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-3">
          {connected && collapsed && (
            <div className="flex justify-center pb-2 mb-2 border-b border-[var(--color-border)] mx-3">
              <ReminderBell reminders={reminders} onRemove={removeReminder} />
            </div>
          )}
          {navItems}
        </div>

        <div className={cn('shrink-0 border-t border-[var(--color-border)] p-3 flex flex-col gap-1', collapsed && 'items-center')}>
          {viewer && (
            <button
              onClick={() => { onCloseMobile?.(); onSwitchViewer() }}
              title="Switch viewer"
              aria-label={`Watching as ${viewer.name}. Switch viewer`}
              className={cn(
                'flex items-center gap-3 rounded-[var(--radius-md)] text-sm font-medium h-10 text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]/70 transition-all duration-150',
                collapsed ? 'justify-center w-10 mx-auto' : 'px-3 w-full'
              )}
            >
              <ViewerAvatar viewer={viewer} size={22} />
              {!collapsed && <span className="truncate">{viewer.name}</span>}
            </button>
          )}
          <NavItem to="/settings" state={settingsState} icon={Settings} label="Settings" collapsed={collapsed} onNavigate={onCloseMobile} />

          {/* Status: connection (details on hover), version, sign out */}
          <div className={cn('flex items-center text-xs text-[var(--color-muted)]', collapsed ? 'flex-col gap-2 pt-2' : 'gap-2 h-9 pl-3 pr-1')}>
            <span className="flex items-center gap-2 min-w-0" title={status.tooltip}>
              <span
                className={cn(
                  'inline-block h-2 w-2 rounded-full shrink-0',
                  connected ? 'bg-[var(--color-success)]' : 'bg-[var(--color-surface-3)]'
                )}
              />
              {!collapsed && <span className="truncate">{connected ? 'Connected' : 'Disconnected'}</span>}
              {!collapsed && status.idle && (
                <span className="shrink-0 opacity-70 tabular-nums">· {status.idle}</span>
              )}
            </span>
            {version && !collapsed && (
              <span className="ml-auto text-[11px] opacity-60 tabular-nums" title="StalkerWeb version">
                {/^v?\d/.test(version) ? (version.startsWith('v') ? version : `v${version}`) : version}
              </span>
            )}
            {accessEnabled && (
              <button
                onClick={() => accessLogout().finally(() => window.location.reload())}
                title="Sign out"
                aria-label="Sign out"
                className={cn(
                  'flex items-center justify-center h-7 w-7 rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors',
                  !collapsed && !version && 'ml-auto'
                )}
              >
                <LogOut size={15} />
              </button>
            )}
          </div>
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
  const [viewer, setViewer]   = useState(null)   // /api/viewers/me
  const [viewers, setViewers] = useState([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerRequired, setPickerRequired] = useState(false)
  const [lastPingAt, setLastPingAt] = useState(null)
  const [idleInfo, setIdleInfo] = useState(null) // { lastActivityAt, idleTimeoutMs }
  const [version, setVersion] = useState(null)
  // ACCESS_KEY: whether the server has one, and whether this browser must sign in.
  const [accessEnabled, setAccessEnabled] = useState(false)
  const [needsLogin, setNeedsLogin] = useState(false)
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

  // The viewer's own filters drive every channel list (Channels, Guide, Player).
  function applyViewer(me) {
    setViewer(me)
    setShowAdult(!!me.showAdult)
    setDisabledGenres(new Set(me.disabledGenres ?? []))
    setDisabledLanguages(new Set(me.disabledLanguages ?? []))
  }

  async function refreshViewers() {
    const [list, me] = await Promise.all([getViewers(), getMyViewer()])
    setViewers(list.viewers)
    applyViewer(me)
  }

  async function switchViewer(id) {
    setViewerId(id)
    invalidateFavoritesCache()
    loadWatch()
    applyViewer(await getMyViewer())
    setPickerOpen(false)
    setPickerRequired(false)
  }

  async function addViewerFromPicker(name) {
    const v = await createViewer({ name })
    await switchViewer(v.id)
    setViewers((await getViewers()).viewers)
  }

  // Any API call answered "sign in first" (the cookie expired or the key changed).
  useEffect(() => {
    const onRequired = () => setNeedsLogin(true)
    window.addEventListener(ACCESS_REQUIRED, onRequired)
    return () => window.removeEventListener(ACCESS_REQUIRED, onRequired)
  }, [])

  // This device's viewer was deleted on another device: forget it and ask again.
  useEffect(() => {
    const onGone = () => {
      setViewerId(null)
      invalidateFavoritesCache()
      getViewers().then(l => setViewers(l.viewers)).catch(() => {})
      setPickerRequired(true)
      setPickerOpen(true)
    }
    window.addEventListener(VIEWER_GONE, onGone)
    return () => window.removeEventListener(VIEWER_GONE, onGone)
  }, [])

  useEffect(() => {
    let id = null
    async function load() {
      const access = await getAccessStatus().catch(() => null)
      if (access?.enabled) {
        setAccessEnabled(true)
        if (!access.authenticated) {
          setNeedsLogin(true)
          setStatusLoaded(true)
          return false
        }
      }
      try {
        // Profiles must be fetched (and any leftover localStorage profiles
        // migrated in) before anything reads getActiveProfileId().
        const [status, settings, list] = await Promise.all([getStatus(), getSettings(), getViewers(), fetchProfiles().catch(() => {})])
        const pick = chooseViewer(list.viewers, getViewerId())
        setViewerId(pick.id)
        setViewers(list.viewers)
        if (pick.needsPicker) { setPickerRequired(true); setPickerOpen(true) }
        applyViewer(await getMyViewer())
        setConnected(status.connected)
        if (status.version) setVersion(status.version)
        loadWatch()   // what this viewer watched (after the viewer is set above)
        setEpgEnabled(settings.epg_enabled !== false)
        if (status.watchdog?.lastPingAt) setLastPingAt(status.watchdog.lastPingAt)
        if (status.lastActivityAt) updateIdleInfo(status.lastActivityAt, status.idleTimeoutMs)
      } catch {
        setConnected(false)
      } finally {
        setStatusLoaded(true)
      }
      return true
    }
    const poll = async () => {
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
    }
    let cancelled = false
    load().then(ok => { if (ok && !cancelled) id = setInterval(poll, 30_000) })
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Memoize so consumers don't re-render just because AppInner re-rendered
  // (e.g. the 30s poll updating local idle/ping badges). Must run before any
  // early return to keep hook order stable.
  // Settings is a window over a page (components/SettingsModal.jsx). Opened from
  // the sidebar, the page behind is the one it was opened over — still mounted,
  // so a playing channel keeps playing; opened directly (a refresh, a link), it
  // is Channels. Before a portal is connected there is no page behind it and
  // no way to close it.
  const location = useLocation()
  const navigate = useNavigate()
  const settingsOpen = location.pathname === '/settings'
  const background = location.state?.background
  const pageLocation = !settingsOpen
    ? location
    : background ?? (connected ? { ...location, pathname: '/channels', search: '', hash: '', state: null } : null)
  const closeSettings = connected
    ? () => (background ? navigate(-1) : navigate('/channels', { replace: true }))
    : null

  const ctxValue = useMemo(
    () => ({ connected, setConnected, epgEnabled, setEpgEnabled, showAdult, setShowAdult, disabledGenres, setDisabledGenres, disabledLanguages, setDisabledLanguages, setLastPingAt, setIdleInfo,
      viewer, viewers, refreshViewers, switchViewer, applyViewer, openViewerPicker: () => setPickerOpen(true),
      // Keeps the current viewer in step with a filter just saved (no reload).
      updateViewerFields: (fields) => setViewer((v) => (v ? { ...v, ...fields } : v)) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the functions only call setters
    [connected, epgEnabled, showAdult, disabledGenres, disabledLanguages, viewer, viewers]
  )

  if (needsLogin) return <LoginPage />

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
        {pickerOpen && (
          <ViewerPicker
            viewers={viewers}
            onPick={switchViewer}
            onCreate={addViewerFromPicker}
            onClose={pickerRequired ? undefined : () => setPickerOpen(false)}
          />
        )}
        <Sidebar
          connected={connected}
          epgEnabled={epgEnabled}
          lastPingAt={lastPingAt}
          idleInfo={idleInfo}
          version={version}
          accessEnabled={accessEnabled}
          collapsed={sidebarCollapsed}
          onToggle={toggleSidebar}
          mobileOpen={mobileNavOpen}
          onCloseMobile={() => setMobileNavOpen(false)}
          viewer={viewer}
          onSwitchViewer={() => setPickerOpen(true)}
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
          {pageLocation && (
          <Routes location={pageLocation} key={viewer?.id ?? 'none'}>
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
            {/* The grid used to be its own page; it's the Guide's default view now. */}
            <Route path="/epg-grid" element={<Navigate to="/guide" replace />} />
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
          )}
          </Suspense>
        </main>

        {settingsOpen && (
          <SettingsModal onClose={closeSettings}>
            <Suspense fallback={<div className="flex h-48 items-center justify-center"><Loader2 size={24} className="animate-spin text-[var(--color-primary-light)]" /></div>}>
              <SetupPage />
            </Suspense>
          </SettingsModal>
        )}
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
