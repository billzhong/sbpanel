import { Suspense, lazy, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { line, curveMonotoneX } from 'd3-shape'
import { bytes, pct } from '../lib/fmt'
import { cx } from './kit'
import { seriesColor } from './chart/theme'
import { useFlip, useTween } from './chart/motion'
import type { ChartSeries } from './chart/TimeSeriesChart'

export { seriesColor, type ChartSeries }
export { useTween } from './chart/motion'

// The chart component and echarts both live in lazy chunks; only this shim is in the main bundle.
const loadChart = () => import('./chart/TimeSeriesChart')
const LazyTimeSeries = lazy(() => loadChart().then((m) => ({ default: m.TimeSeriesChart })))

/** Fetch the chart chunks ahead of time (after login, on idle). Safe to call repeatedly. */
export function preloadCharts(): Promise<unknown> {
  return loadChart().then((m) => m.preloadCharts())
}

type TimeChartProps = ComponentProps<typeof LazyTimeSeries>

/** ECharts line / stacked-area time series. Props are the pre-ECharts TimeChart API (+ onBrush). */
export function TimeChart(props: TimeChartProps) {
  const h = (props.height ?? 240) + (props.series.length > 1 ? 30 : 0)
  return <Suspense fallback={<div style={{ height: h }} aria-busy />}><LazyTimeSeries {...props} /></Suspense>
}

/**
 * Colour follows the entity, not its rank: the first time a key is seen in a namespace it takes the next free
 * palette slot and keeps it for the session, so a user stays the same colour across filters and refreshes.
 */
const slots = new Map<string, Map<string, number>>()
export function entitySlot(ns: string, key: string): number {
  let m = slots.get(ns)
  if (!m) slots.set(ns, (m = new Map()))
  let i = m.get(key)
  if (i === undefined) { i = m.size; m.set(key, i) }
  return i
}
export const entityColor = (ns: string, key: string) => seriesColor(entitySlot(ns, key))

/** Bytes that tween between values (tabular digits, so the width never jitters). */
export function TweenBytes({ value, digits }: { value: number; digits?: number }) {
  return <>{bytes(useTween(value), digits)}</>
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  // Measure before the first paint so a (re)mounted chart never shows an empty frame.
  useLayoutEffect(() => {
    if (!ref.current) return
    setW(Math.floor(ref.current.getBoundingClientRect().width))
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** Ranked list with a proportional bar: the "share" view for domains, IPs, users. */
export function ShareList({ rows, total, onSelect, emptyText = '暂无数据', mono }: {
  rows: { key: string; label: string; value: number; extra?: ReactNode }[]; total?: number
  onSelect?: (key: string) => void; emptyText?: string; mono?: boolean
}) {
  const sum = total ?? rows.reduce((a, r) => a + r.value, 0)
  const max = rows.reduce((a, r) => Math.max(a, r.value), 0)
  // Rows keep their DOM node by key, so a re-rank slides them (FLIP) instead of swapping text in place.
  const list = useFlip<HTMLUListElement>(rows.map((r) => r.key).join('\u0000'))
  if (rows.length === 0) return <div className="py-8 text-center text-[13px] text-muted">{emptyText}</div>
  return (
    <ul ref={list} className="flex flex-col">
      {rows.map((r) => {
        const content = (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className={cx('min-w-0 flex-1 truncate', mono && 'font-mono text-[13px]')} title={r.label}>{r.label}</span>
              <span className="shrink-0 text-[13px] tabular"><TweenBytes value={r.value} /></span>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-overlay">
                <div className="h-full rounded-full bg-accent/80 transition-[width] duration-(--dur-3) ease-(--ease-std)" style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%` }} />
              </div>
              <span className="w-11 shrink-0 text-right text-xs text-muted tabular">{pct(r.value, sum).toFixed(1)}%</span>
            </div>
            {r.extra && <div className="mt-1 text-xs text-muted">{r.extra}</div>}
          </>
        )
        return (
          <li key={r.key} data-k={r.key}>
            {onSelect ? (
              <button type="button" onClick={() => onSelect(r.key)}
                className="w-full rounded-[10px] px-2 py-2 text-left outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-accent cursor-pointer">
                {content}
              </button>
            ) : <div className="px-2 py-2">{content}</div>}
          </li>
        )
      })}
    </ul>
  )
}

export function Spark({ values, color = 'var(--s1)', height = 32 }: { values: number[]; color?: string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const max = Math.max(1, ...values)
  const n = values.length
  const ln = line<number>().x((_, i) => (n <= 1 ? 0 : (i / (n - 1)) * width)).y((v) => height - 2 - (v / max) * (height - 4)).curve(curveMonotoneX)
  return (
    <div ref={ref} className="w-full" aria-hidden>
      {width === 0 ? <div style={{ height }} /> : <svg width={width} height={height}><path d={ln(values) ?? ''} fill="none" stroke={color} strokeWidth={2} style={{ transition: 'd var(--dur-3) var(--ease-std)' }} /></svg>}
    </div>
  )
}
