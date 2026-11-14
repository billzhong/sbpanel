import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { area, line, curveMonotoneX } from 'd3-shape'
import { bytes, axisTime, pct } from '../lib/fmt'
import { cx } from './kit'

export const seriesColor = (i: number) => `var(--s${(i % 8) + 1})`

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** Max of a 4-interval axis whose ticks are round numbers in a byte unit. */
function niceMax(v: number): number {
  if (v <= 0) return 4 * 1024
  const units = [1, 1024, 1024 ** 2, 1024 ** 3, 1024 ** 4, 1024 ** 5]
  const raw = v / 4
  let u = units[0]
  for (const x of units) if (raw >= x) u = x
  const n = raw / u
  const step = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000].find((s) => s >= n) ?? 1000
  return 4 * step * u
}

export type ChartSeries = { key: string; label: string; values: number[]; color?: string }

export function TimeChart({ times, step, series, stacked = false, height = 240, empty }: {
  times: number[]; step: number; series: ChartSeries[]; stacked?: boolean; height?: number; empty?: ReactNode
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const pad = { l: 56, r: 12, t: 8, b: 26 }
  const W = Math.max(width, 200), H = height
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b
  const n = times.length

  const { stacks, max } = useMemo(() => {
    const stacks: [number, number][][] = []
    let max = 0
    const base = new Array(n).fill(0)
    for (const s of series) {
      const st: [number, number][] = []
      for (let i = 0; i < n; i++) {
        const v = s.values[i] ?? 0
        const y0 = stacked ? base[i] : 0
        const y1 = y0 + v
        st.push([y0, y1])
        if (stacked) base[i] = y1
        max = Math.max(max, y1)
      }
      stacks.push(st)
    }
    return { stacks, max: niceMax(max) }
  }, [series, n, stacked])

  const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = (v: number) => pad.t + ih - (v / max) * ih
  const total = series.reduce((a, s) => a + s.values.reduce((x, y) => x + y, 0), 0)

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)
  const xTickEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 72))))

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - r.left - pad.l
    const i = Math.round((px / iw) * (n - 1))
    setHover(i >= 0 && i < n ? i : null)
  }

  return (
    <div ref={ref} className="relative w-full select-none">
      {series.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-subtle" aria-label="图例">
          {series.map((s, i) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color ?? seriesColor(i) }} />
              <span className="text-text">{s.label}</span>
            </span>
          ))}
        </div>
      )}
      {width > 0 && (
        <svg width={W} height={H} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img"
          aria-label={`流量趋势，共 ${bytes(total)}`} className="block overflow-visible">
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--muted)] text-[11px] tabular">{bytes(t, 0)}</text>
            </g>
          ))}
          {times.map((t, i) => i % xTickEvery === 0 && (
            <text key={t} x={x(i)} y={H - 6} textAnchor="middle" className="fill-[var(--muted)] text-[11px] tabular">{axisTime(t, step)}</text>
          ))}
          {total === 0 && empty === undefined && (
            <text x={pad.l + iw / 2} y={pad.t + ih / 2} textAnchor="middle" className="fill-[var(--muted)] text-[13px]">暂无流量</text>
          )}
          {stacks.map((st, si) => {
            const color = series[si].color ?? seriesColor(si)
            const ar = area<[number, number]>().x((_, i) => x(i)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(curveMonotoneX)
            const ln = line<[number, number]>().x((_, i) => x(i)).y((d) => y(d[1])).curve(curveMonotoneX)
            return (
              <g key={series[si].key}>
                {(stacked || series.length === 1) && <path d={ar(st) ?? ''} fill={color} opacity={stacked ? 0.55 : 0.16} />}
                <path d={ln(st) ?? ''} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
              </g>
            )
          })}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--subtle)" strokeDasharray="3 3" />
              {stacks.map((st, si) => (
                <circle key={si} cx={x(hover)} cy={y(st[hover][1])} r={4} fill={series[si].color ?? seriesColor(si)} stroke="var(--surface)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}
      {hover !== null && width > 0 && (
        <div className="pointer-events-none absolute top-8 z-10 min-w-[180px] rounded-[12px] border bg-surface px-3 py-2 text-xs shadow-[0_8px_24px_rgb(0_0_0/0.14)]"
          style={{ left: Math.min(x(hover) + 12, W - 200) }}>
          <div className="mb-1 font-medium tabular">{new Date(times[hover] * 1000).toLocaleString('zh-CN', { hour12: false })}</div>
          {series.map((s, i) => (
            <div key={s.key} className="flex items-center justify-between gap-4 py-0.5">
              <span className="inline-flex items-center gap-1.5 text-subtle">
                <span className="h-2 w-2 rounded-[2px]" style={{ background: s.color ?? seriesColor(i) }} />{s.label}
              </span>
              <span className="tabular text-text">{bytes(s.values[hover] ?? 0)}<span className="ml-1 text-muted">({bytes((s.values[hover] ?? 0) / step)}/s)</span></span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Ranked list with a proportional bar: the "share" view for domains, IPs, users. */
export function ShareList({ rows, total, onSelect, emptyText = '暂无数据', mono }: {
  rows: { key: string; label: string; value: number; extra?: ReactNode }[]; total?: number
  onSelect?: (key: string) => void; emptyText?: string; mono?: boolean
}) {
  const sum = total ?? rows.reduce((a, r) => a + r.value, 0)
  const max = rows.reduce((a, r) => Math.max(a, r.value), 0)
  if (rows.length === 0) return <div className="py-8 text-center text-[13px] text-muted">{emptyText}</div>
  return (
    <ul className="flex flex-col">
      {rows.map((r) => {
        const content = (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className={cx('min-w-0 flex-1 truncate', mono && 'font-mono text-[13px]')} title={r.label}>{r.label}</span>
              <span className="shrink-0 text-[13px] tabular">{bytes(r.value)}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-overlay">
                <div className="h-full rounded-full bg-accent/80" style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%` }} />
              </div>
              <span className="w-11 shrink-0 text-right text-xs text-muted tabular">{pct(r.value, sum).toFixed(1)}%</span>
            </div>
            {r.extra && <div className="mt-1 text-xs text-muted">{r.extra}</div>}
          </>
        )
        return (
          <li key={r.key}>
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
      {width > 0 && <svg width={width} height={height}><path d={ln(values) ?? ''} fill="none" stroke={color} strokeWidth={2} /></svg>}
    </div>
  )
}
