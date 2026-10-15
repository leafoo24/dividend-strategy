import { createContext, useContext, useState, useCallback } from 'react'
import { X, CheckCircle2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const toast = useCallback(({ title, variant = 'default' }) => {
    const id = Date.now()
    setToasts(prev => [...prev, { id, title, variant }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000)
  }, [])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80">
        {toasts.map(t => (
          <div
            key={t.id}
            className={cn(
              'flex items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg animate-in slide-in-from-right-full',
              t.variant === 'destructive'
                ? 'border-red-500/30 bg-red-950/80 text-red-200'
                : 'border-border bg-card text-foreground'
            )}
          >
            {t.variant === 'destructive'
              ? <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
              : <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />}
            <span className="flex-1">{t.title}</span>
            <button onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))} className="text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
