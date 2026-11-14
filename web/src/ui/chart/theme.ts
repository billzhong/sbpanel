import { useSyncExternalStore } from 'react'

/** Resolve `var(--x)` (or `--x`) against :root — canvas can't read CSS variables. Other strings pass through. */
export function cssColor(c: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(c.trim()) ?? /^(--[\w-]+)$/.exec(c.trim())
  if (!m) return c
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || c
}

export const seriesColor = (i: number) => `var(--s${(i % 8) + 1})`

export const bodyFont = () => getComputedStyle(document.body).fontFamily || 'sans-serif'
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// One shared version counter for every chart: bumps whenever resolved colours may have changed.
let version = 0
const subs = new Set<() => void>()
let wired = false
function wire() {
  if (wired) return
  wired = true
  const bump = () => { version++; subs.forEach((f) => f()) }
  new MutationObserver(bump).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette', 'class', 'style'] })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', bump)
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', bump)
  window.addEventListener('sbp:appearance', bump)
}

/** Re-render on theme / palette / appearance / reduced-motion changes. */
export function useChartTheme(): number {
  return useSyncExternalStore((f) => { wire(); subs.add(f); return () => { subs.delete(f) } }, () => version)
}

/** HTML-escape text that goes into the tooltip (labels can be traffic-derived hostnames). */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
