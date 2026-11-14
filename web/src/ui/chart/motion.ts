import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { reducedMotion } from './theme'

/** Tween a number toward `target` (cubic-out). Retargets from the current value mid-flight; never restarts from 0. */
export function useTween(target: number, ms = 400): number {
  const [v, setV] = useState(target)
  const cur = useRef(target)
  useEffect(() => {
    if (reducedMotion() || !isFinite(target) || !isFinite(cur.current) || cur.current === target) {
      cur.current = target; setV(target); return
    }
    const from = cur.current, t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3)
      cur.current = k === 1 ? target : from + (target - from) * e
      setV(cur.current)
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}

/**
 * FLIP for keyed lists: children carry `data-k`; when the key order changes, each moved row slides from its
 * previous slot (transform only) and new rows fade in. Returns the ref for the list element.
 */
export function useFlip<T extends HTMLElement>(order: string) {
  const box = useRef<T>(null)
  const last = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const kids = Array.from(el.children) as HTMLElement[]
    const now = new Map<string, number>()
    for (const li of kids) if (li.dataset.k !== undefined) now.set(li.dataset.k, li.offsetTop)
    const first = last.current.size === 0
    if (!first && !reducedMotion()) {
      for (const li of kids) {
        const k = li.dataset.k
        if (k === undefined) continue
        const before = last.current.get(k), after = now.get(k)!
        if (before === undefined) li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 80, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' })
        else if (before !== after) li.animate([{ transform: `translateY(${before - after}px)` }, { transform: 'none' }], { duration: 360, easing: 'cubic-bezier(.45,0,.4,1)' })
      }
    }
    last.current = now
  }, [order])
  return box
}
