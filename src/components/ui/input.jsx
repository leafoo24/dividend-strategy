import { cn } from '@/lib/utils'

export function Input({ className, ...props }) {
  return (
    <input
      className={cn(
        'flex h-8 w-full rounded-md border border-border bg-muted px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-40',
        className
      )}
      {...props}
    />
  )
}
