import * as React from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
  {
    variants: {
      variant: {
        live:    'badge-live',
        success: 'bg-[var(--color-success)]/20 text-[var(--color-success)]',
        muted:   'bg-[var(--color-surface-2)] text-[var(--color-muted)]',
        primary: 'bg-[var(--color-primary)]/20 text-[var(--color-primary-light)]',
      },
    },
    defaultVariants: { variant: 'muted' },
  }
)

const Badge = ({ className, variant, ...props }) => (
  <span className={cn(badgeVariants({ variant }), className)} {...props} />
)

// eslint-disable-next-line react-refresh/only-export-components
export { Badge, badgeVariants }
