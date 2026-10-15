import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

export function fmtPct(v, digits = 2) {
  if (v == null) return '—'
  const s = (v >= 0 ? '+' : '') + v.toFixed(digits) + '%'
  return s
}

export function fmtPrice(v) {
  if (v == null) return '—'
  return v.toFixed(2)
}

export function changeClass(v) {
  if (v > 0) return 'rise'
  if (v < 0) return 'fall'
  return 'flat'
}
