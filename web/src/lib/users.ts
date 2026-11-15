import type { User } from './api'
import { tr } from '../i18n'
import { D } from '../i18n/userlists'

const now = () => Date.now() / 1000
export const usedOf = (u: User) => u.used_up + u.used_down
export const usedPct = (u: User) => (u.traffic_limit > 0 ? (usedOf(u) / u.traffic_limit) * 100 : 0)
/** Optional: newer backends may report when the user was last seen on any node. */
export const lastSeenOf = (u: User) => (u as User & { last_online?: number }).last_online ?? 0

export type FilterId = 'online' | 'expiring' | 'quota80' | 'limited' | 'expired' | 'disabled' | 'unused'
export const filterDefs: { id: FilterId; label: string; tone?: 'warn' | 'bad'; test: (u: User) => boolean }[] = [
  { id: 'online', get label() { return tr(D).online }, test: (u) => u.online_ips > 0 },
  { id: 'expiring', get label() { return tr(D).expiring }, tone: 'warn', test: (u) => u.expire_at > now() && u.expire_at <= now() + 7 * 86400 },
  { id: 'quota80', get label() { return tr(D).quota80 }, tone: 'warn', test: (u) => u.traffic_limit > 0 && usedPct(u) >= 80 },
  { id: 'limited', get label() { return tr(D).limited }, tone: 'bad', test: (u) => u.status === 'limited' },
  { id: 'expired', get label() { return tr(D).expired }, tone: 'bad', test: (u) => u.status === 'expired' || (u.expire_at > 0 && u.expire_at <= now()) },
  { id: 'disabled', get label() { return tr(D).disabled }, test: (u) => !u.enabled },
  { id: 'unused', get label() { return tr(D).unused }, test: (u) => u.life_up + u.life_down === 0 },
]

export type SortId = 'created' | 'name' | 'usage' | 'expire' | 'seen'
export const sortDefs: { id: SortId; label: string; defDir: 'asc' | 'desc'; key: (u: User) => number | string }[] = [
  { id: 'created', get label() { return tr(D).sCreated }, defDir: 'desc', key: (u) => u.created_at * 1e4 + u.id },
  { id: 'name', get label() { return tr(D).sName }, defDir: 'asc', key: (u) => u.username.toLowerCase() },
  { id: 'usage', get label() { return tr(D).sUsage }, defDir: 'desc', key: usedOf },
  { id: 'expire', get label() { return tr(D).sExpire }, defDir: 'asc', key: (u) => u.expire_at || Number.MAX_SAFE_INTEGER },
  { id: 'seen', get label() { return tr(D).sSeen }, defDir: 'desc', key: (u) => (u.online_ips > 0 ? 1e12 : 0) + (lastSeenOf(u) || u.sub_last_at) },
]

export function matchQuery(u: User, q: string) {
  if (!q) return true
  const s = q.toLowerCase()
  return u.username.toLowerCase().includes(s) || u.note.toLowerCase().includes(s) || u.uuid.toLowerCase().startsWith(s)
}

export const USERNAME_RE = /^[\p{L}\p{N}._@-]{1,64}$/u
