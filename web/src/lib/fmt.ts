import { locale, tr } from '../i18n'
import { C } from '../i18n/common'

const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function bytes(n: number, digits = 1): string {
  if (!isFinite(n) || n <= 0) return '0 B'
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : digits)) + ' ' + units[i]
}

export const rate = (n: number) => bytes(n) + '/s'

export function num(n: number): string {
  return new Intl.NumberFormat(locale()).format(n)
}

export function pct(a: number, b: number): number {
  return b > 0 ? Math.min(100, (a / b) * 100) : 0
}

export function dateTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleString(locale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function date(ts: number): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleDateString(locale())
}

export function ago(ts: number): string {
  const t = tr(C)
  if (!ts) return t.never_
  const s = Math.max(0, Date.now() / 1000 - ts)
  if (s < 60) return t.secAgo(Math.floor(s))
  if (s < 3600) return t.minAgo(Math.floor(s / 60))
  if (s < 86400) return t.hrAgo(Math.floor(s / 3600))
  return t.dayAgo(Math.floor(s / 86400))
}

export function duration(sec: number): string {
  if (!sec) return '—'
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  const t = tr(C)
  return d > 0 ? t.durDH(d, h) : h > 0 ? t.durHM(h, m) : t.durM(m)
}

export function axisTime(ts: number, step: number): string {
  const d = new Date(ts * 1000)
  if (step >= 86400) return `${d.getMonth() + 1}/${d.getDate()}`
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return hm
}

/** Parse "100 GB" / "1.5T" / "500" (GB) into bytes. */
export function parseSize(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*([KMGTP]?)B?$/i)
  if (!m) return NaN
  const mult: Record<string, number> = { '': 1024 ** 3, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }
  return Math.round(parseFloat(m[1]) * mult[m[2].toUpperCase()])
}

/** "in 3 days" / "expired 2 days ago" / "Never" for an expiry timestamp. */
export function expiresIn(ts: number): string {
  const t = tr(C)
  if (!ts) return t.forever
  const s = ts - Date.now() / 1000
  const a = Math.abs(s)
  const unit = a >= 86400 ? t.unitD(Math.floor(a / 86400)) : a >= 3600 ? t.unitH(Math.floor(a / 3600)) : t.unitM(Math.max(1, Math.floor(a / 60)))
  return s >= 0 ? t.inX(unit) : t.expiredX(unit)
}

export const DAY = 86400
export const GB = 1024 ** 3

/** Full local date-time for tooltips. */
export function fullTime(ts: number): string {
  return ts ? new Date(ts * 1000).toLocaleString(locale(), { hour12: false }) : '—'
}
