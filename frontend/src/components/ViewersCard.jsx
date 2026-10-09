import { useState } from 'react'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/appContext'
import { createViewer, updateViewer, deleteViewer } from '../stalkerApi'
import { ViewerAvatar } from './ViewerPicker'

// Same list as backend viewers/ViewersManager.js COLORS.
const COLORS = ['#5b8def', '#e5484d', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#e93d82', '#978365']

// Settings → Viewers: the people who watch here, each with their own
// favorites and channel filters. Everything else on this page is shared.
export default function ViewersCard() {
  const { viewer, viewers, refreshViewers, switchViewer } = useApp()
  const [editing, setEditing] = useState(null) // { id, name, color } | { id: null, name: '', color } for a new one
  const [error, setError] = useState(null)

  async function save() {
    setError(null)
    try {
      if (editing.id) await updateViewer(editing.id, { name: editing.name, color: editing.color })
      else await createViewer({ name: editing.name, color: editing.color })
      setEditing(null)
      await refreshViewers()
    } catch (err) {
      setError(err.message)
    }
  }

  async function remove(v) {
    if (!window.confirm(`Delete ${v.name}? Their favorites and channel filters are deleted too.`)) return
    setError(null)
    try {
      await deleteViewer(v.id)
      // Deleting yourself: carry on as whoever is left first.
      if (v.id === viewer?.id) await switchViewer(viewers.find(x => x.id !== v.id).id)
      await refreshViewers()
    } catch (err) {
      setError(err.message)
    }
  }

  const editor = editing && (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
      <input
        autoFocus
        value={editing.name}
        onChange={e => setEditing({ ...editing, name: e.target.value })}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(null) }}
        maxLength={30}
        placeholder="Name"
        aria-label="Viewer name"
        className="rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary-light)]"
      />
      <div className="flex gap-2" role="radiogroup" aria-label="Color">
        {COLORS.map(c => (
          <button
            key={c}
            role="radio"
            aria-checked={editing.color === c}
            aria-label={c}
            onClick={() => setEditing({ ...editing, color: c })}
            className={cn('h-6 w-6 rounded-full ring-offset-2 ring-offset-[var(--color-surface)]', editing.color === c && 'ring-2 ring-[var(--color-text)]')}
            style={{ background: c }}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={save} disabled={!editing.name.trim()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] text-xs font-medium disabled:opacity-50"><Check size={13} /> Save</button>
        <button onClick={() => { setEditing(null); setError(null) }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"><X size={13} /> Cancel</button>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-2">
      {viewers.map(v => (
        editing?.id === v.id ? <div key={v.id}>{editor}</div> : (
          <div key={v.id} className="flex items-center gap-3 rounded-[var(--radius-md)] px-2 py-1.5 hover:bg-[var(--color-surface-2)]/60">
            <ViewerAvatar viewer={v} size={28} />
            <span className="text-sm text-[var(--color-text)] truncate">{v.name}</span>
            {v.id === viewer?.id && <span className="text-[11px] text-[var(--color-muted)]">· you</span>}
            <div className="ml-auto flex gap-1">
              <button onClick={() => setEditing({ id: v.id, name: v.name, color: v.color })} className="p-1.5 rounded text-[var(--color-muted)] hover:text-[var(--color-text)]" title="Rename or recolor" aria-label={`Edit ${v.name}`}><Pencil size={14} /></button>
              {viewers.length > 1 && (
                <button onClick={() => remove(v)} className="p-1.5 rounded text-[var(--color-muted)] hover:text-[var(--color-live)]" title="Delete" aria-label={`Delete ${v.name}`}><Trash2 size={14} /></button>
              )}
            </div>
          </div>
        )
      ))}
      {editing && !editing.id ? editor : (
        <button
          onClick={() => setEditing({ id: null, name: '', color: COLORS[viewers.length % COLORS.length] })}
          className="flex items-center gap-2 px-2 py-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]"
        >
          <Plus size={14} /> Add viewer
        </button>
      )}
      {error && <p className="text-xs text-[var(--color-live)]">{error}</p>}
    </div>
  )
}
