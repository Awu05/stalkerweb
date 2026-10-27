import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { cn } from '@/lib/utils'
import { getSettings, saveSettings } from '../stalkerApi'

// Settings → Playback: where the players' online subtitles come from (backend
// lib/subtitles.js). Shared by every viewer. The keys stay on the server: it
// never sends one back, only its last characters.

const PROVIDERS = [
  { id: 'wyzie', name: 'Wyzie Subs', note: '1,000 requests a day free — about 500 subtitles' },
  { id: 'opensubtitles', name: 'OpenSubtitles', note: '5 downloads a day free, 20 with an account' },
]

export default function SubtitleSettings() {
  const [saved, setSaved] = useState(null)     // what the server has: provider, key hints, username…
  const [form, setForm] = useState(null)       // { provider, wyzieKey, osKey, username, password, languages }
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)   // { type, msg }

  const load = (s) => {
    setSaved(s)
    setForm({ provider: s.subtitle_provider || 'wyzie', wyzieKey: '', wyzieSources: s.wyzie_sources || ['charlie'], osKey: '', username: s.opensubtitles_username || '', password: '', languages: s.subtitle_languages || 'en' })
  }
  useEffect(() => { getSettings().then(load).catch(() => load({})) }, [])

  if (!form) return <Loader2 size={16} className="animate-spin text-[var(--color-muted)]" />
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const kept = (hint) => (hint ? `Saved (ends in ${hint.replace('…', '')}) — leave blank to keep` : '')

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setNotice(null)
    try {
      await saveSettings({
        subtitle_provider: form.provider,
        // Blank keeps the saved key or password.
        wyzie_api_key: form.wyzieKey || undefined,
        wyzie_sources: form.wyzieSources,
        opensubtitles_api_key: form.osKey || undefined,
        opensubtitles_username: form.username,
        opensubtitles_password: form.username.trim() ? (form.password || undefined) : null,
        subtitle_languages: form.languages,
      })
      load(await getSettings())
      setNotice({ type: 'success', msg: 'Saved.' })
    } catch (err) {
      setNotice({ type: 'error', msg: err.message })
    } finally {
      setBusy(false)
    }
  }

  async function forget(key) {
    setBusy(true)
    try {
      await saveSettings({ [key]: null })
      load(await getSettings())
    } catch (err) {
      setNotice({ type: 'error', msg: err.message })
    } finally {
      setBusy(false)
    }
  }

  const forgetLink = (key) => (
    <button type="button" onClick={() => forget(key)} disabled={busy} className="self-start text-xs text-[var(--color-muted)] hover:text-[var(--color-live)]">
      Remove the saved key
    </button>
  )

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label>Subtitles from</Label>
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <button key={p.id} type="button" onClick={() => setForm((f) => ({ ...f, provider: p.id }))}
              className={cn('flex flex-col items-start px-3 py-2 rounded-[var(--radius-sm)] border text-left',
                form.provider === p.id ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/15' : 'border-[var(--color-border)] hover:bg-[var(--color-surface-2)]')}>
              <span className="text-sm font-medium text-[var(--color-text)]">{p.name}</span>
              <span className="text-[11px] text-[var(--color-muted)]">{p.note}</span>
            </button>
          ))}
        </div>
      </div>

      {form.provider === 'wyzie' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wyzie-key">Wyzie API key</Label>
          <PasswordInput id="wyzie-key" value={form.wyzieKey} onChange={set('wyzieKey')} placeholder={kept(saved.wyzie_key_hint)} autoComplete="off" />
          <p className="text-xs text-[var(--color-muted)]">Free from store.wyzie.io/redeem. It stays on this server: the website and the apps never see it.</p>
          {saved.wyzie_key_hint && forgetLink('wyzie_api_key')}
          <Label className="mt-2">Search these sources</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {(saved.wyzie_sources_available || [{ id: 'charlie', free: true, note: '' }]).map((src) => {
              const on = form.wyzieSources.includes(src.id)
              const toggle = () => setForm((f) => {
                const next = on ? f.wyzieSources.filter((x) => x !== src.id) : [...f.wyzieSources, src.id]
                return { ...f, wyzieSources: next.length ? next : ['charlie'] }
              })
              return (
                <label key={src.id} className="flex items-center gap-1.5 text-sm text-[var(--color-text)] cursor-pointer">
                  <input type="checkbox" checked={on} onChange={toggle} className="accent-[var(--color-primary)]" />
                  {src.id}
                  {/* Anime sources (Wyzie tags them so), marked for anyone watching anime */}
                  {src.note === 'anime' && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--color-primary)]/20 text-[var(--color-primary-light)]">Anime</span>
                  )}
                  <span className="text-[11px] text-[var(--color-muted)]">{src.free ? 'free' : 'Pro key'}</span>
                </label>
              )
            })}
          </div>
          <p className="text-xs text-[var(--color-muted)]">
            Wyzie names its sources by code. charlie is the one a free key gets, and the ones marked Anime are anime sources; a free key asking for a Pro one searches charlie alone.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="os-key">OpenSubtitles API key</Label>
            <PasswordInput id="os-key" value={form.osKey} onChange={set('osKey')} placeholder={kept(saved.opensubtitles_key_hint)} autoComplete="off" />
            <p className="text-xs text-[var(--color-muted)]">From opensubtitles.com → your profile → API consumers. It stays on this server.</p>
            {saved.opensubtitles_key_hint && forgetLink('opensubtitles_api_key')}
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="os-user">Username (optional)</Label>
              <Input id="os-user" value={form.username} onChange={set('username')} autoComplete="off" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="os-pw">Password (optional)</Label>
              <PasswordInput id="os-pw" value={form.password} onChange={set('password')} placeholder={saved.opensubtitles_password_set ? 'Saved — leave blank to keep' : ''} />
            </div>
          </div>
          <p className="-mt-2 text-xs text-[var(--color-muted)]">Signed in, the account gets 20 downloads a day instead of 5.</p>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sub-langs">Languages</Label>
        <Input id="sub-langs" value={form.languages} onChange={set('languages')} placeholder="en, es" />
        <p className="text-xs text-[var(--color-muted)]">
          Language codes, separated by commas: en, es, fr, pt-br… A subtitle played once is kept on the server, so playing it again costs nothing.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy}
          className="px-4 py-2 rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-white text-sm font-medium disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
        {notice && <p className={`text-xs ${notice.type === 'error' ? 'text-[var(--color-live)]' : 'text-[var(--color-success)]'}`}>{notice.msg}</p>}
      </div>
    </form>
  )
}
