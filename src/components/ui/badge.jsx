import { cn } from '@/lib/utils'

export function Badge({ className, variant = 'default', children }) {
  const variants = {
    default: 'bg-muted text-muted-foreground',
    success: 'bg-emerald-500/15 text-emerald-400',
    danger: 'bg-red-500/15 text-red-400',
    warning: 'bg-amber-500/15 text-amber-400',
    info: 'bg-primary/15 text-primary',
  }
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium', variants[variant], className)}>
      {children}
    </span>
  )
}
