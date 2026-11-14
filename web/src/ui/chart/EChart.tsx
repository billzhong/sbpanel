import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import type { EChartsType } from './echarts'

type Mod = typeof import('./echarts')
let modP: Promise<Mod> | null = null
let mod: Mod | null = null

/** Fetch the chart chunk ahead of time (called after login, on idle). Safe to call repeatedly. */
export function preloadCharts(): Promise<Mod> {
  modP ??= import('./echarts').then((m) => (mod = m))
  return modP
}

/**
 * Hosts one echarts instance for the lifetime of the mount. Callers drive it imperatively through
 * `onReady` + setOption, so every data change is a transition from the previous frame — never a re-init.
 */
export function EChart({ height, onReady, className, style }: {
  height: number; onReady: (c: EChartsType) => void; className?: string; style?: CSSProperties
}) {
  const el = useRef<HTMLDivElement>(null)
  const ready = useRef(onReady)
  ready.current = onReady

  useLayoutEffect(() => {
    let disposed = false
    let chart: EChartsType | null = null
    let ro: ResizeObserver | null = null
    const start = (m: Mod) => {
      if (disposed || !el.current) return
      chart = m.init(el.current, undefined, { renderer: 'canvas' })
      // Resizes snap: dragging a window or opening a drawer must never lag behind.
      ro = new ResizeObserver(() => chart?.resize({ animation: { duration: 0 } }))
      ro.observe(el.current)
      ready.current(chart)
    }
    if (mod) start(mod)
    else preloadCharts().then(start, () => { /* chunk failed: leave the reserved box empty */ })
    return () => { disposed = true; ro?.disconnect(); chart?.dispose() }
  }, [])

  return <div ref={el} className={className} style={{ height, width: '100%', ...style }} />
}
