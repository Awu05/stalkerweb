import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'

// "Who's watching?" — full-screen, on a device that hasn't picked a viewer
// yet (or whose viewer was deleted), and from the sidebar to switch. Tiles
// are plain buttons in a row, so arrow keys / Tab and Enter work on a TV.
export function ViewerAvatar({ viewer, size = 32 }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold text-white shrink-0"
      style={{ background: viewer?.color || 'var(--color-surface-3)', width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {(viewer?.name || '?').slice(0, 1).toUpperCase()}
    </span>
  )
}

export default function ViewerPicker({ viewers, onPick, onCreate, onClose }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const first = useRef(null)

  useEffect(() => { first.current?.focus() }, [])

  // Left/Right move between tiles, like a TV launcher.
  function onKeyDown(e) {
    // Keys stay in the picker: the page behind (the player's shortcuts) never sees them.
    e.stopPropagation()
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
    const back = e.key === 'Escape' || e.key === 'GoBack' || e.key === 'XF86Back' || e.keyCode === 461 || e.keyCode === 10009 ||
      (e.key === 'Backspace' && !typing)
    if (back) {
      if (onClose) { e.preventDefault(); onClose() }
      return
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const tiles = [...e.currentTarget.querySelectorAll('[data-tile]')]
    const i = tiles.indexOf(document.activeElement)
    if (i < 0) return
    e.preventDefault()
    tiles[(i + (e.key === 'ArrowRight' ? 1 : tiles.length - 1)) % tiles.length].focus()
  }

  async function add(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onCreate(name.trim())
      setAdding(false)
      setName('')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-8 bg-[var(--color-bg)] px-4" role="dialog" aria-modal="true" aria-label="Who's watching?" onKeyDown={onKeyDown}>
      {onClose && (
        <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]" aria-label="Close">
          <X size={18} />
        </button>
      )}
      <h1 className="text-2xl font-semibold text-[var(--color-text)]">Who&apos;s watching?</h1>

      <div className="flex flex-wrap justify-center gap-4 max-w-3xl">
        {viewers.map((v, i) => (
          <button
            key={v.id}
            ref={i === 0 ? first : undefined}
            data-tile
            onClick={() => onPick(v.id)}
            className="flex flex-col items-center gap-2 w-28 p-3 rounded-[var(--radius-md)] hover:bg-[var(--color-surface-2)] transition-colors"
          >
            <ViewerAvatar viewer={v} size={72} />
            <span className="text-sm text-[var(--color-text)] truncate max-w-full">{v.name}</span>
          </button>
        ))}
        {!adding && (
          <button
            data-tile
            onClick={() => setAdding(true)}
            className="flex flex-col items-center gap-2 w-28 p-3 rounded-[var(--radius-md)] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
          >
            <span className="flex items-center justify-center w-[72px] h-[72px] rounded-full border-2 border-dashed border-[var(--color-border)]">
              <Plus size={28} />
            </span>
            <span className="text-sm">Add viewer</span>
          </button>
        )}
      </div>

      {adding && (
        <form onSubmit={add} className="flex flex-col items-center gap-2 w-full max-w-xs">
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={30}
            placeholder="Name"
            aria-label="New viewer's name"
            className="w-full rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary-light)]"
          />
          {error && <p className="text-xs text-[var(--color-live)]">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={!name.trim() || saving} className="px-4 py-1.5 rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] text-sm font-medium disabled:opacity-50">Add</button>
            <button type="button" onClick={() => { setAdding(false); setError(null) }} className="px-4 py-1.5 rounded-[var(--radius-sm)] text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]">Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}
