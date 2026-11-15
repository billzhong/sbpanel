// Types mirroring internal/subgen (the generic routing model) and /api/routing/*.
import { tr } from '../i18n'
import { R } from '../i18n/routing'

export type ClientId = 'mihomo' | 'singbox' | 'surge'
export const CLIENTS: ClientId[] = ['mihomo', 'singbox', 'surge']
export const CLIENT_LABEL: Record<ClientId, string> = { mihomo: 'Clash / mihomo', singbox: 'sing-box', surge: 'Surge' }

export type MatcherType = 'domain' | 'domain_suffix' | 'domain_keyword' | 'domain_regex' | 'ip_cidr' | 'geosite' | 'geoip' | 'process_name' | 'port' | 'network'
export const MATCHER_TYPES: MatcherType[] = ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'ip_cidr', 'geosite', 'geoip', 'process_name', 'port', 'network']
export const matcherLabel = (k: MatcherType): string => tr(R)[`m_${k}`]

export type Matcher = { type: MatcherType; values: string[]; no_resolve?: boolean }
export type Source = { catalog?: string; behavior?: 'domain' | 'ipcidr' | 'classical'; urls?: Partial<Record<ClientId, string>>; interval?: number }
export type RuleSet = { id: string; name: string; inline?: Matcher[]; remote?: Source }
export type MemberKind = 'all' | 'filter' | 'group' | 'direct' | 'reject'
export type Member = { kind: MemberKind; ref?: string; include?: string; exclude?: string }
export type GroupType = 'select' | 'url-test' | 'fallback' | 'load-balance'
export type PGroup = { id: string; name: string; type: GroupType; members: Member[]; test_url?: string; interval?: number; tolerance?: number; hide_if_empty?: boolean }
export type Rule = { rule_set: string; target: string; disabled?: boolean; resolve_ip?: boolean }
export type DNSPolicy = { mode: string; domestic: string[] | null; remote: string[] | null; direct_sets: string[] | null; ipv6: boolean }
export type ClientTemplate = { enabled: boolean; base: string; options: Record<string, string> | null }
export type Profile = {
  rule_sets: RuleSet[]; groups: PGroup[]; rules: Rule[]; final: string; dns: DNSPolicy; mirror?: string
  clients: Partial<Record<ClientId, ClientTemplate>>
}

export type ProfileMeta = {
  id: number; slug: string; name: string; description: string; is_default: boolean; selectable: boolean
  published_at: number; updated_at: number; has_draft: boolean; users: number; group_ids: number[]
}
export type ProfileDetail = { profile: ProfileMeta; published: Profile; draft: Profile | null }

export type CatalogItem = { key: string; label: string; kind: string; geosite?: string; geoip?: string; surge?: string[] }
export type Catalog = {
  catalog: CatalogItem[]; presets: { slug: string; name: string; description: string }[]
  placeholders: Record<ClientId, string[]>; required: Record<ClientId, string[]>
  default_options: Record<ClientId, Record<string, string>>; clients: Record<ClientId, string>; bases: Record<ClientId, string>; mirror: string
}
export type Preview = { body: string; warnings: string[]; error: string; published_body: string; nodes: number }
export type NodeName = { remark: string; node: string; type: string; surge: boolean }
export type HistoryItem = { id: number; ts: number; admin: string; json: Profile }

const KINDS = ['private', 'cn', 'global', 'ads', 'ai', 'streaming', 'service', 'games'] as const
/** Label of a catalog category, or undefined for kinds the UI doesn't know. */
export const kindLabel = (k: string): string | undefined => (KINDS as readonly string[]).includes(k) ? tr(R)[`k_${k as typeof KINDS[number]}`] : undefined

/** Go RE2 "(?i)" prefix → JS flag; returns null on invalid patterns. */
export function goRegex(re: string): RegExp | null {
  let flags = ''
  let src = re
  const m = /^\(\?([imsU]+)\)/.exec(src)
  if (m) { src = src.slice(m[0].length); if (m[1].includes('i')) flags += 'i'; if (m[1].includes('s')) flags += 's' }
  try { return new RegExp(src, flags + 'u') } catch { return null }
}

export function memberMatches(m: Member, nodes: NodeName[]): NodeName[] {
  if (m.kind === 'all') return nodes.filter((n) => !excluded(m, n))
  if (m.kind !== 'filter') return []
  const inc = goRegex(m.include ?? '')
  if (!inc) return []
  return nodes.filter((n) => inc.test(n.remark + '\u0000' + n.node) && !excluded(m, n))
}
function excluded(m: Member, n: NodeName) {
  if (!m.exclude) return false
  const ex = goRegex(m.exclude)
  return !!ex && ex.test(n.remark + '\u0000' + n.node)
}

/** Distinct nodes a group ends up with (recursing into sub-groups), for the live count. */
export function groupNodes(p: Profile, id: string, nodes: NodeName[], seen = new Set<string>()): Set<string> {
  const out = new Set<string>()
  if (seen.has(id)) return out
  seen.add(id)
  const g = p.groups.find((x) => x.id === id)
  for (const m of g?.members ?? []) {
    if (m.kind === 'group' && m.ref) groupNodes(p, m.ref, nodes, seen).forEach((x) => out.add(x))
    else memberMatches(m, nodes).forEach((n) => out.add(n.remark))
  }
  return out
}

export function newId(prefix: string, taken: string[]) {
  let i = 1
  while (taken.includes(`${prefix}${i}`)) i++
  return `${prefix}${i}`
}

export function ruleSetSummary(rs: RuleSet | undefined, cat: CatalogItem[]): string {
  const t = tr(R)
  if (!rs) return t.rsMissing
  const parts: string[] = []
  if (rs.remote?.catalog) {
    const c = cat.find((x) => x.key === rs.remote!.catalog)
    parts.push(c ? [c.geosite && `geosite:${c.geosite}`, c.geoip && `geoip:${c.geoip}`].filter(Boolean).join(' + ') : rs.remote.catalog)
  } else if (rs.remote) parts.push(t.rsRemote(Object.keys(rs.remote.urls ?? {}).join(' / ')))
  const n = (rs.inline ?? []).reduce((a, m) => a + m.values.length, 0)
  if (n) parts.push(t.rsInline(n))
  return parts.join(' · ') || t.rsEmpty
}
