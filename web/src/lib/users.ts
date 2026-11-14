import type { User } from './api'

const now = () => Date.now() / 1000
export const usedOf = (u: User) => u.used_up + u.used_down
export const usedPct = (u: User) => (u.traffic_limit > 0 ? (usedOf(u) / u.traffic_limit) * 100 : 0)
/** Optional: newer backends may report when the user was last seen on any node. */
export const lastSeenOf = (u: User) => (u as User & { last_online?: number }).last_online ?? 0

export type FilterId = 'online' | 'expiring' | 'quota80' | 'limited' | 'expired' | 'disabled' | 'unused'
export const filterDefs: { id: FilterId; label: string; tone?: 'warn' | 'bad'; test: (u: User) => boolean }[] = [
  { id: 'online', label: '在线', test: (u) => u.online_ips > 0 },
  { id: 'expiring', label: '即将到期（≤7 天）', tone: 'warn', test: (u) => u.expire_at > now() && u.expire_at <= now() + 7 * 86400 },
  { id: 'quota80', label: '额度 ≥80%', tone: 'warn', test: (u) => u.traffic_limit > 0 && usedPct(u) >= 80 },
  { id: 'limited', label: '超额', tone: 'bad', test: (u) => u.status === 'limited' },
  { id: 'expired', label: '已过期', tone: 'bad', test: (u) => u.status === 'expired' || (u.expire_at > 0 && u.expire_at <= now()) },
  { id: 'disabled', label: '已禁用', test: (u) => !u.enabled },
  { id: 'unused', label: '从未使用', test: (u) => u.life_up + u.life_down === 0 },
]

export type SortId = 'created' | 'name' | 'usage' | 'expire' | 'seen'
export const sortDefs: { id: SortId; label: string; defDir: 'asc' | 'desc'; key: (u: User) => number | string }[] = [
  { id: 'created', label: '创建时间', defDir: 'desc', key: (u) => u.created_at * 1e4 + u.id },
  { id: 'name', label: '用户名', defDir: 'asc', key: (u) => u.username.toLowerCase() },
  { id: 'usage', label: '用量', defDir: 'desc', key: usedOf },
  { id: 'expire', label: '到期时间', defDir: 'asc', key: (u) => u.expire_at || Number.MAX_SAFE_INTEGER },
  { id: 'seen', label: '最近在线', defDir: 'desc', key: (u) => (u.online_ips > 0 ? 1e12 : 0) + (lastSeenOf(u) || u.sub_last_at) },
]

export function matchQuery(u: User, q: string) {
  if (!q) return true
  const s = q.toLowerCase()
  return u.username.toLowerCase().includes(s) || u.note.toLowerCase().includes(s) || u.uuid.toLowerCase().startsWith(s)
}

export const USERNAME_RE = /^[\p{L}\p{N}._@-]{1,64}$/u
