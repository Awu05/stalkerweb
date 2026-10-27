import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { getSettings, saveSettings } from '../stalkerApi'

// Settings → Playback: OpenSubtitles, for the players' online subtitles
// (backend lib/subtitles.js). Shared by every viewer.

export default function SubtitleSettings() {
  const [form, setForm] = useState(null)       // { apiKey, username, password, languages }
  const [passwordSet, setPasswordSet] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)   // { type, msg }

  useEffect(() => {
    getSettings().then((s) => {
      setForm({ apiKey: s.opensubtitles_api_key || '', username: s.opensubtitles_username || '', password: '', languages: s.subtitle_languages || 'en' })
      setPasswordSet(!!s.opensubtitles_password_set)
    }).catch(() => setForm({ apiKey: '', username: '', password: '', languages: 'en' }))
  }, [])

  if (!form) return <Loader2 size={16} className="animate-spin text-[var(--color-muted)]" />
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setNotice(null)
    try {
      await saveSettings({
        opensubtitles_api_key: form.apiKey,
        opensubtitles_username: form.username,
        // Blank keeps the saved one; no username, no password either.
        opensubtitles_password: form.username.trim() ? (form.password || undefined) : null,
        subtitle_languages: form.languages,
      })
      if (form.password && form.username.trim()) setPasswordSet(true)
      if (!form.username.trim()) setPasswordSet(false)
      setForm((f) => ({ ...f, password: '' }))
      setNotice({ type: 'success', msg: 'Saved.' })
    } catch (err) {
      setNotice({ type: 'error', msg: err.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="os-key">API key</Label>
        <Input id="os-key" value={form.apiKey} onChange={set('apiKey')} placeholder="From opensubtitles.com → your profile → API consumers" autoComplete="off" />
        <p className="text-xs text-[var(--color-muted)]">
          Free: make an account at opensubtitles.com, then create an API consumer under your profile. Without a key, only the subtitles inside the videos are offered.
        </p>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="os-user">Username (optional)</Label>
          <Input id="os-user" value={form.username} onChange={set('username')} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="os-pw">Password (optional)</Label>
          <PasswordInput id="os-pw" value={form.password} onChange={set('password')} placeholder={passwordSet ? 'Saved — leave blank to keep' : ''} />
        </div>
      </div>
      <p className="-mt-2 text-xs text-[var(--color-muted)]">
        Signed in, the account gets 20 downloads a day instead of 5. A subtitle played once is kept on the server, so playing it again doesn&apos;t count.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="os-langs">Languages</Label>
        <Input id="os-langs" value={form.languages} onChange={set('languages')} placeholder="en, es" />
        <p className="text-xs text-[var(--color-muted)]">Language codes, separated by commas: en, es, fr, pt-br…</p>
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
