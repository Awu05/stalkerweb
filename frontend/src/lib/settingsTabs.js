// The Settings tabs (pages/SetupPage.jsx) and which one opens.
export const SETTINGS_TABS = [
  { id: 'viewers',    label: 'Viewers' },
  { id: 'connection', label: 'Connection' },
  { id: 'links',      label: 'Links' },
  { id: 'playback',   label: 'Playback' },
  { id: 'logos',      label: 'Logos' },
]

const KEY = 'sw:settingsTab'
const isTab = (id) => SETTINGS_TABS.some((t) => t.id === id)

// The tab named in the address (?tab=), else Connection while no portal is
// connected (the only thing to do on first run), else the last one used,
// else Viewers.
export function chooseTab(requested, remembered, connected) {
  if (isTab(requested)) return requested
  if (!connected) return 'connection'
  return isTab(remembered) ? remembered : 'viewers'
}

export function rememberedTab() {
  try { return localStorage.getItem(KEY) } catch { return null }
}

export function rememberTab(id) {
  try { localStorage.setItem(KEY, id) } catch { /* storage blocked — not remembered */ }
}
