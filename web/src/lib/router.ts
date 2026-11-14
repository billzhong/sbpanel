import { useEffect, useState } from 'react'

export type Route = { page: string; params: URLSearchParams }

function parse(): Route {
  const h = location.hash.replace(/^#\/?/, '')
  const [page, qs] = h.split('?')
  return { page: page || 'overview', params: new URLSearchParams(qs ?? '') }
}

export function useRoute(): Route {
  const [r, setR] = useState(parse)
  useEffect(() => {
    const on = () => setR(parse())
    window.addEventListener('hashchange', on)
    window.addEventListener('sbp:route', on)
    return () => { window.removeEventListener('hashchange', on); window.removeEventListener('sbp:route', on) }
  }, [])
  return r
}

type P = Record<string, string | number | undefined>

export function href(page: string, params?: P): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') qs.set(k, String(v))
  const s = qs.toString()
  return '#/' + page + (s ? '?' + s : '')
}

export function go(page: string, params?: P) {
  location.hash = href(page, params)
}

/** Update the URL without adding a history entry (filters, search, tabs). */
export function replace(page: string, params?: P) {
  const h = href(page, params)
  if (location.hash === h) return
  history.replaceState(history.state, '', h)
  window.dispatchEvent(new Event('sbp:route'))
}

/** Current params merged with `patch` (undefined/'' removes a key). */
export function withParams(params: URLSearchParams, patch: P): P {
  const out: P = Object.fromEntries(params.entries())
  for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === '') delete out[k]; else out[k] = v }
  return out
}
