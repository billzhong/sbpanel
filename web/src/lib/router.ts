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
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return r
}

export function href(page: string, params?: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') qs.set(k, String(v))
  const s = qs.toString()
  return '#/' + page + (s ? '?' + s : '')
}

export function go(page: string, params?: Record<string, string | number | undefined>) {
  location.hash = href(page, params)
}
