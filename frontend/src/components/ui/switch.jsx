import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'

// On and off differ in three ways, not just track shade: the monochrome accent
// made "on" a light-grey track and "off" a dark one, with the same white thumb
// — hard to read at a glance. On: green track, white thumb. Off: outlined dark
// track, dimmed thumb.
const Switch = React.forwardRef(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-200',
      'data-[state=checked]:bg-[var(--color-success)] data-[state=checked]:border-[var(--color-success)]',
      'data-[state=unchecked]:bg-[var(--color-surface-3)] data-[state=unchecked]:border-[#3c3c44]',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-light)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block h-4 w-4 rounded-full shadow-sm transition-[transform,background-color] duration-200',
        'data-[state=checked]:translate-x-[17px] data-[state=checked]:bg-white',
        'data-[state=unchecked]:translate-x-[1px] data-[state=unchecked]:bg-[var(--color-muted)]'
      )}
    />
  </SwitchPrimitive.Root>
))
Switch.displayName = 'Switch'

export { Switch }
