import { useState, useEffect, useMemo, useRef } from 'react'
import { Heart, Layers, Pencil, Trash2, Plus, Check, X, Search, ChevronDown, ChevronUp, GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { isAdult } from '@/lib/adultFilter'
import {
  getFavorites, getChannels,
  createFavoriteGroup, renameFavoriteGroup, deleteFavoriteGroup,
  addChannelToGroup, removeChannelFromGroup,
  reorderFavoriteChannels, reorderFavoriteGroups,
} from '../stalkerApi'
import { useApp } from '@/lib/appContext'
import { ChannelLogo } from '@/components/ChannelLogo'
import { ChannelCard } from '@/components/ChannelCard'

// ── Drag-and-drop helpers ─────────────────────────────────────────────────
function useDragReorder(items, setItems, onReorder) {
  const dragIdx  = useRef(null)
  const [draggingIndex, setDraggingIndex] = useState(null)

  function onDragStart(i) { dragIdx.current = i; setDraggingIndex(i) }

  function onDragOver(e, i) {
    e.preventDefault()
    if (dragIdx.current === null || dragIdx.current === i) return
    const from = dragIdx.current
    dragIdx.current = i
    setDraggingIndex(i)
    setItems(prev => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(i, 0, moved)
      return next
    })
  }

  // items ref so onDragEnd sees the latest order without stale closure
  const itemsRef = useRef(items)
  itemsRef.current = items

  function onDragEnd() {
    dragIdx.current = null
    setDraggingIndex(null)
    onReorder(itemsRef.current.map(it => String(it.uniqueId ?? it.id)))
  }

  return { onDragStart, onDragOver, onDragEnd, draggingIndex }
}

// ── Group logo preview (2×2 grid of first 4 channel logos) ───────────────
function GroupPreview({ channels, logoMap }) {
  const first4 = channels.slice(0, 4)
  if (first4.length === 0) {
    return (
      <div className="h-16 w-16 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] flex items-center justify-center shrink-0">
        <Layers size={24} className="text-[var(--color-muted)]" />
      </div>
    )
  }
  return (
    <div className="h-16 w-16 rounded-[var(--radius-sm)] overflow-hidden grid grid-cols-2 gap-px bg-[var(--color-border)] shrink-0">
      {Array.from({ length: 4 }).map((_, i) => {
        const ch = first4[i]
        return (
          <div key={i} className="bg-[var(--color-surface-2)] flex items-center justify-center overflow-hidden">
            {ch
              ? <ChannelLogo src={logoMap[String(ch.uniqueId)]} name={ch.name} size="sm" />
              : null}
          </div>
        )
      })}
    </div>
  )
}

// ── Group editor (inline, shown when editing a group) ────────────────────
function GroupEditor({ group, logoMap, allChannels, onSave, onCancel }) {
  const [name, setName] = useState(group.name)
  const [channels, setChannels] = useState(group.channels || [])
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)

  const channelIds = useMemo(() => new Set(channels.map(c => String(c.uniqueId))), [channels])

  const suggestions = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return allChannels
      .filter(c => !channelIds.has(String(c.uniqueId)) && c.name?.toLowerCase().includes(q))
      .slice(0, 20)
  }, [query, allChannels, channelIds])

  async function handleAddChannel(ch) {
    await addChannelToGroup(group.id, ch.uniqueId)
    setChannels(prev => [...prev, ch])
    setQuery('')
  }

  async function handleRemoveChannel(ch) {
    await removeChannelFromGroup(group.id, ch.uniqueId)
    setChannels(prev => prev.filter(c => String(c.uniqueId) !== String(ch.uniqueId)))
  }

  async function handleSave() {
    setSaving(true)
    await renameFavoriteGroup(group.id, name)
    onSave({ ...group, name, channels })
    setSaving(false)
  }

  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius-md)] border border-[var(--color-primary)]/40 bg-[var(--color-surface)] p-5">
      {/* Name row */}
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          className="text-sm font-medium"
          placeholder="Group name"
          onKeyDown={e => e.key === 'Enter' && handleSave()}
        />
        <Button onClick={handleSave} disabled={saving || !name.trim()} className="shrink-0 h-9 px-3 text-xs gap-1">
          <Check size={13} /> Save
        </Button>
        <Button variant="outline" onClick={onCancel} className="shrink-0 h-9 px-3 text-xs">
          Cancel
        </Button>
      </div>

      {/* Channels in group */}
      {channels.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-[var(--color-muted)] uppercase tracking-wide">Channels in group</p>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
            {channels.map(ch => (
              <div key={ch.uniqueId} className="flex items-center gap-1.5 rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text)]">
                <ChannelLogo src={logoMap[String(ch.uniqueId)]} name={ch.name} size="sm" />
                <span className="max-w-28 truncate">{ch.name}</span>
                <button onClick={() => handleRemoveChannel(ch)} className="text-[var(--color-muted)] hover:text-[var(--color-live)] ml-0.5">
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add channel search */}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-[var(--color-muted)] uppercase tracking-wide">Add channels</p>
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)] pointer-events-none" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search channels to add…"
            className="pl-8 text-xs"
          />
        </div>
        {suggestions.length > 0 && (
          <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)]">
            {suggestions.map(ch => (
              <button
                key={ch.uniqueId}
                onClick={() => handleAddChannel(ch)}
                className="flex items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-2)] transition-colors"
              >
                <ChannelLogo src={logoMap[String(ch.uniqueId)]} name={ch.name} size="sm" />
                <span className="flex-1 truncate text-[var(--color-text)]">{ch.name}</span>
                <Plus size={12} className="text-[var(--color-muted)] shrink-0" />
              </button>
            ))}
          </div>
        )}
        {query.trim() && suggestions.length === 0 && (
          <p className="text-xs text-[var(--color-muted)] px-1">No channels found</p>
        )}
      </div>
    </div>
  )
}

// ── Group card ────────────────────────────────────────────────────────────
function GroupCard({ group, logoMap, onEdit, onDelete, onNavigate, dragHandlers, isDragging }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      draggable={!!dragHandlers}
      onDragStart={dragHandlers?.onDragStart}
      onDragOver={dragHandlers?.onDragOver}
      onDragEnd={dragHandlers?.onDragEnd}
      className={cn('rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)] p-4 flex flex-col gap-3 select-none', isDragging && 'opacity-40')}
    >
      {/* Header row */}
      <div className="flex items-center gap-3">
        {dragHandlers && <GripVertical size={14} className="text-[var(--color-muted)] opacity-40 hover:opacity-80 cursor-grab active:cursor-grabbing shrink-0" />}
        <GroupPreview channels={group.channels} logoMap={logoMap} />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm text-[var(--color-text)] truncate">{group.name}</p>
          <p className="text-xs text-[var(--color-muted)]">{group.channels.length} channel{group.channels.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setExpanded(v => !v)}
            className="p-1.5 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
          <button
            onClick={onEdit}
            className="p-1.5 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors"
            title="Edit group"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded hover:bg-[var(--color-live)]/10 text-[var(--color-muted)] hover:text-[var(--color-live)] transition-colors"
            title="Delete group"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Expanded channel list */}
      {expanded && group.channels.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-[var(--color-border)] pt-2">
          {group.channels.map(ch => (
            <button
              key={ch.uniqueId}
              onClick={() => onNavigate(ch)}
              className="flex items-center gap-2.5 px-2 py-1.5 rounded-[var(--radius-sm)] hover:bg-[var(--color-surface-2)] transition-colors text-left"
            >
              <ChannelLogo src={logoMap[String(ch.uniqueId)]} name={ch.name} size="sm" />
              <span className="text-xs text-[var(--color-text)] truncate flex-1">{ch.name}</span>
              {ch.number > 0 && <span className="text-xs text-[var(--color-muted)] shrink-0">Ch {ch.number}</span>}
            </button>
          ))}
        </div>
      )}
      {expanded && group.channels.length === 0 && (
        <p className="text-xs text-[var(--color-muted)] border-t border-[var(--color-border)] pt-2">No channels — click Edit to add some.</p>
      )}
    </div>
  )
}

// ── Section header ────────────────────────────────────────────────────────
function SectionHeader({ icon: Icon, title, count, action }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={16} className="text-[var(--color-primary-light)]" />
      <h2 className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
      {count > 0 && (
        <span className="text-xs text-[var(--color-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded-full">{count}</span>
      )}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  )
}

// ── Favorites (the collapsible section on the Channels page) ─────────────
// The favorite channels use the Channels page's own tile (components/
// ChannelCard), in the grid's columns, so they look and size like the rest.
// Which channels are favorites comes from the page (useFavorites): a heart
// toggled anywhere on the page shows here at once — off, the tile goes; on,
// the list is read again to get the new channel in its place.
export default function FavoritesView({ favoriteIds, favoritesLoaded, favoritesSaved = 0, onToggleFavorite, onOpen, onSetLogo, logoMap = {}, nowNext = {}, health = {}, columns = 1, gap = 12 }) {
  const { showAdult } = useApp()

  const [channels, setChannels] = useState([])    // favorited channels (enriched), order matters
  const [groups, setGroups] = useState([])         // favorite groups (enriched), order matters
  const [allChannels, setAllChannels] = useState([]) // loaded lazily for group editor
  const [editingGroupId, setEditingGroupId] = useState(null)
  const [newGroupName, setNewGroupName] = useState('')
  const [showNewGroup, setShowNewGroup] = useState(false)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    getFavorites()
      .then((fav) => {
        if (cancelled) return
        let chList = fav.channels || []
        let gList  = fav.groups   || []
        if (!showAdult) {
          chList = chList.filter(c => !isAdult(c.genre) && !isAdult(c.name))
          gList  = gList.filter(g => !isAdult(g.name))
        }
        setChannels(chList)
        setGroups(gList)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [showAdult, reload])

  // Follow the page's hearts: drop channels unfavorited at once; read the list
  // again for one favorited that isn't here yet, once the server has it.
  const favKey = favoritesLoaded ? [...favoriteIds].sort().join(',') : null
  const haveKey = channels.map(c => String(c.uniqueId)).sort().join(',')
  useEffect(() => {
    if (favKey === null || loading) return
    const here = new Set(haveKey.split(',').filter(Boolean))
    const wanted = favKey.split(',').filter(Boolean)
    if (here.size > wanted.length || [...here].some(id => !favoriteIds.has(id))) {
      setChannels(prev => prev.filter(c => favoriteIds.has(String(c.uniqueId))))
    }
    if (wanted.some(id => !here.has(id))) setReload(n => n + 1)
  }, [favKey, favoritesSaved]) // eslint-disable-line react-hooks/exhaustive-deps -- only when the favorites change

  // Load all channels lazily when a group editor is opened
  async function ensureAllChannels() {
    if (allChannels.length > 0) return
    try {
      const r = await getChannels()
      let list = r.channels ?? []
      if (!showAdult) {
        list = list.filter(c => !isAdult(c.genre) && !isAdult(c.name))
      }
      setAllChannels(list)
    } catch { /* ignore fetch errors */ }
  }

  function openGroupEditor(groupId) {
    setEditingGroupId(groupId)
    ensureAllChannels()
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleCreateGroup() {
    if (!newGroupName.trim()) return
    const { group } = await createFavoriteGroup(newGroupName.trim())
    setGroups(prev => [...prev, { ...group, channels: [] }])
    setNewGroupName('')
    setShowNewGroup(false)
    openGroupEditor(group.id)
  }

  async function handleDeleteGroup(id) {
    await deleteFavoriteGroup(id)
    setGroups(prev => prev.filter(g => g.id !== id))
    if (editingGroupId === id) setEditingGroupId(null)
  }

  function handleGroupSaved(updated) {
    setGroups(prev => prev.map(g => g.id === updated.id ? updated : g))
    setEditingGroupId(null)
  }

  // ── Drag-and-drop reordering ──────────────────────────────────────────────
  const channelDrag = useDragReorder(channels, setChannels, reorderFavoriteChannels)
  const groupDrag   = useDragReorder(groups,   setGroups,   reorderFavoriteGroups)

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-6 w-6 rounded-full border-2 border-[var(--color-primary)] border-t-transparent animate-spin" />
      </div>
    )
  }

  const empty = channels.length === 0 && groups.length === 0

  return (
    <div className="flex flex-col gap-8">
      {empty && (
        <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
          <Heart size={28} className="text-[var(--color-muted)]" />
          <p className="text-sm text-[var(--color-muted)]">No favorites yet.</p>
          <p className="text-xs text-[var(--color-muted)]">Use the heart on any channel to add it here.</p>
        </div>
      )}

      {/* ── Favorite Channels ── */}
      {channels.length > 0 && (
        <section>
          <SectionHeader icon={Heart} title="Channels" count={channels.length} />
          <div className="grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: `${gap}px` }}>
            {channels.map((ch, i) => (
              // Drag a tile to reorder; the tile itself plays and its heart unfavorites.
              <div
                key={ch.uniqueId}
                draggable
                onDragStart={() => channelDrag.onDragStart(i)}
                onDragOver={(e) => channelDrag.onDragOver(e, i)}
                onDragEnd={channelDrag.onDragEnd}
                className={cn('relative min-w-0', channelDrag.draggingIndex === i && 'opacity-40')}
                title="Drag to reorder"
              >
                <ChannelCard
                  channel={ch}
                  logoUrl={logoMap[String(ch.uniqueId)]}
                  isFavorite
                  onToggleFavorite={onToggleFavorite}
                  onClick={onOpen}
                  onSetLogo={onSetLogo}
                  nowNext={nowNext[String(ch.uniqueId)]}
                  health={health[String(ch.uniqueId)]}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Groups ── */}
      <section>
        <SectionHeader
          icon={Layers}
          title="Groups"
          count={groups.length}
          action={
            <Button
              variant="outline"
              onClick={() => setShowNewGroup(v => !v)}
              className="h-8 px-3 text-xs gap-1.5"
            >
              <Plus size={13} /> New Group
            </Button>
          }
        />

        {/* New group form */}
        {showNewGroup && (
          <div className="flex items-center gap-2 mb-4 rounded-[var(--radius-md)] border border-[var(--color-primary)]/40 bg-[var(--color-surface)] p-4">
            <Input
              autoFocus
              placeholder="Group name…"
              value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateGroup()}
              className="text-sm"
            />
            <Button onClick={handleCreateGroup} disabled={!newGroupName.trim()} className="shrink-0 h-9 px-3 text-xs gap-1">
              <Check size={13} /> Create
            </Button>
            <Button variant="outline" onClick={() => { setShowNewGroup(false); setNewGroupName('') }} className="shrink-0 h-9 px-3 text-xs">
              Cancel
            </Button>
          </div>
        )}

        {groups.length === 0 && !showNewGroup && (
          <p className="text-sm text-[var(--color-muted)]">No groups yet — click New Group to create one.</p>
        )}

        <div className="flex flex-col gap-3">
          {groups.map((group, i) =>
            editingGroupId === group.id ? (
              <GroupEditor
                key={group.id}
                group={group}
                logoMap={logoMap}
                allChannels={allChannels}
                onSave={handleGroupSaved}
                onCancel={() => setEditingGroupId(null)}
              />
            ) : (
              <GroupCard
                key={group.id}
                group={group}
                logoMap={logoMap}
                onEdit={() => openGroupEditor(group.id)}
                onDelete={() => handleDeleteGroup(group.id)}
                onNavigate={onOpen}
                isDragging={groupDrag.draggingIndex === i}
                dragHandlers={{
                  onDragStart: () => groupDrag.onDragStart(i),
                  onDragOver:  (e) => groupDrag.onDragOver(e, i),
                  onDragEnd:   groupDrag.onDragEnd,
                }}
              />
            )
          )}
        </div>
      </section>
    </div>
  )
}
