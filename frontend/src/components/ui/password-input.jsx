import * as React from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** An Input for a password or key, with an eye button to show or hide what's typed. */
const PasswordInput = React.forwardRef(({ className, ...props }, ref) => {
  const [shown, setShown] = React.useState(false)
  const label = shown ? 'Hide password' : 'Show password'
  return (
    <div className="relative">
      <Input ref={ref} type={shown ? 'text' : 'password'} className={cn('pr-9', className)} {...props} />
      <button
        type="button"
        onClick={() => setShown(s => !s)}
        aria-label={label}
        aria-pressed={shown}
        title={label}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors"
      >
        {shown ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  )
})
PasswordInput.displayName = 'PasswordInput'

export { PasswordInput }
