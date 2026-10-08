import { useState, useEffect } from 'react'
import { subscribeToasts } from '@/lib/toast'
import { cn } from '@/lib/utils'

export function ToastHost() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    return subscribeToasts(toast => {
      setToasts(prev => [...prev, toast])
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toast.id)), 3000)
    })
  }, [])

  if (!toasts.length) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={cn(
            'px-4 py-2.5 rounded-[var(--radius-md)] text-sm font-medium shadow-lg border',
            t.type === 'error'
              ? 'bg-[var(--color-surface)] border-[var(--color-live)]/40 text-[var(--color-live)]'
              : 'bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text)]'
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
