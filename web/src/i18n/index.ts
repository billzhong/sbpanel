import { useSyncExternalStore, type ReactNode } from 'react'

/**
 * Tiny typed i18n.
 *
 *   const D = dict({ save: 'Save', users: (n: number) => `${n} users` },
 *                  { save: '保存', users: (n) => `${n} 个用户` })
 *   const t = useT(D)   // in components (or tr(D) anywhere else)
 *   t.save; t.users(3)
 *
 * English is the source of truth: the zh object must have exactly the same keys
 * (a missing or extra key fails `tsc`), and function messages keep their signature.
 * Dictionaries live in src/i18n/*.ts; nothing outside that folder should contain CJK text.
 *
 * Switching the language remounts the app below <LangRoot> (see main.tsx), so tr() is safe in
 * render code and in getters on constant tables. Don't evaluate tr() at module load.
 */

export type Lang = 'en' | 'zh'
export const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'zh', label: '简体中文', short: '中' },
]

type Msg = string | ((...a: any[]) => ReactNode)
type Widen<R> = R extends string ? string : R
type Shape<T> = { [K in keyof T]: T[K] extends string ? string : T[K] extends (...a: infer A) => infer R ? (...a: A) => Widen<R> : T[K] }
export type Dict<T> = { en: Shape<T>; zh: Shape<T> }

export function dict<T extends Record<string, Msg>>(en: T, zh: Shape<T>): Dict<T> {
  return { en: en as Shape<T>, zh }
}

const KEY = 'sbp-lang'

/** zh, zh-CN, zh-TW, zh-HK, zh-Hans… → zh; anything else → en. */
export function fromLocale(tag: string | undefined | null): Lang {
  return tag && /^zh\b/i.test(tag.trim()) ? 'zh' : 'en'
}

function detect(): Lang {
  try {
    const s = localStorage.getItem(KEY)
    if (s === 'en' || s === 'zh') return s
  } catch { /* storage blocked */ }
  const nav = typeof navigator !== 'undefined' ? (navigator.languages?.[0] ?? navigator.language) : ''
  return fromLocale(nav)
}

let current: Lang = detect()
const subs = new Set<() => void>()
const apply = () => { if (typeof document !== 'undefined') document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en' }
apply()

export const getLang = () => current
/** BCP-47 tag for Intl / toLocaleString. */
export const locale = () => (current === 'zh' ? 'zh-CN' : 'en-US')

export function setLang(l: Lang) {
  if (l === current) return
  current = l
  try { localStorage.setItem(KEY, l) } catch { /* private mode */ }
  apply()
  subs.forEach((f) => f())
}

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang)
}

/** The current language's messages (reactive). */
export function useT<T>(d: Dict<T>): Shape<T> {
  return d[useLang()]
}

/** The current language's messages, for non-component code (toasts, helpers, table getters). */
export function tr<T>(d: Dict<T>): Shape<T> {
  return d[current]
}
