import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/85',
        outline: 'border border-border bg-transparent hover:bg-muted text-foreground',
        ghost: 'hover:bg-muted text-muted-foreground hover:text-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/85',
        link: 'text-primary underline-offset-4 hover:underline p-0 h-auto',
      },
      size: {
        default: 'h-8 px-3 py-1.5',
        sm: 'h-7 px-2.5 text-xs',
        lg: 'h-9 px-5',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

export function Button({ className, variant, size, ...props }) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
