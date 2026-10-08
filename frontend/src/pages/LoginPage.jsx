import { useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { accessLogin } from '../stalkerApi'

// Shown instead of the app when the server has an ACCESS_KEY and this browser
// isn't signed in. Signing in sets a cookie for a year; a reload then starts
// the app as usual.
export default function LoginPage() {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!key) return
    setBusy(true)
    setError(null)
    try {
      await accessLogin(key)
      window.location.reload()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-sm flex flex-col gap-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <KeyRound size={28} className="text-[var(--color-primary-light)]" />
          <h1 className="text-lg font-semibold text-[var(--color-text)]">StalkerWeb</h1>
          <p className="text-sm text-[var(--color-muted)]">Enter the access key to continue.</p>
        </div>
        <Input
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Access key"
          aria-label="Access key"
          value={key}
          onChange={e => { setKey(e.target.value); setError(null) }}
        />
        {error && <p className="text-xs text-[var(--color-live)]">{error}</p>}
        <Button type="submit" disabled={busy || !key} className="gap-2">
          {busy && <Loader2 size={14} className="animate-spin" />}
          Sign in
        </Button>
      </form>
    </div>
  )
}
