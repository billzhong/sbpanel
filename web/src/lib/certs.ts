import { useQuery } from '@tanstack/react-query'
import { api } from './api'

export type CertSource = 'acme' | 'upload' | 'node'
export type CertStatus = 'ok' | 'expiring' | 'expired' | 'pending' | 'error' | 'renewing'

export type CertUse = { id: number; tag: string; node_id: string; node: string; sni: string }

export type Cert = {
  id: string; name: string; source: CertSource; sans: string[]; issuer: string
  not_before: number; not_after: number; fingerprint: string; auto_renew: boolean
  acme: { provider_id?: number; ca?: string; staging?: boolean; email?: string; domains?: string[] }
  node_id: string; node?: string; cert_path: string; key_path: string
  last_error: string; attempts: number; next_attempt: number; renewed_at: number; reported_at: number
  created_at: number; updated_at: number; has_material: boolean
  uses: CertUse[]; days_left: number; status: CertStatus; renewing: boolean
}

export type Zone = { id: string; name: string; status: string }
export type Provider = { id: number; kind: string; name: string; token_set: boolean; zones: Zone[]; verified_at: number; last_error: string; created_at: number }

export type Domain = {
  id: number; fqdn: string; provider_id: number; zone_id: string; zone: string; node_id: string; node: string
  record_type: string; record_id: string; record_content: string; proxied: boolean; synced_at: number; node_ip: string; certs: string[]
}

export type DNSRecord = { id?: string; type: string; name: string; content: string; proxied: boolean; ttl?: number; comment?: string }
export type DNSPlan = {
  fqdn: string; zone: string; action: 'create' | 'update' | 'noop' | 'conflict'; record_id: string
  before: DNSRecord | null; after: DNSRecord; existing: DNSRecord[]; warning?: string
}

export type PemPreview = { sans: string[]; issuer: string; not_before: number; not_after: number; fingerprint: string; self_signed: boolean; id?: string }

export const SOURCE_LABEL: Record<CertSource, string> = { acme: 'ACME 自动', upload: '上传', node: '节点文件' }

export const useCerts = (refetch?: number | false) => useQuery({ queryKey: ['certs'], queryFn: () => api<Cert[]>('/certs'), refetchInterval: refetch })
export const useProviders = () => useQuery({ queryKey: ['dns-providers'], queryFn: () => api<Provider[]>('/dns/providers') })
export const useDomains = () => useQuery({ queryKey: ['domains'], queryFn: () => api<Domain[]>('/domains') })

/** Does a SAN list cover a host name (one-label wildcards)? Mirrors certCovers in certs.go. */
export function covers(sans: string[], host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return sans.some((s) => {
    s = s.toLowerCase()
    if (s === h) return true
    if (s.startsWith('*.')) { const i = h.indexOf('.'); return i > 0 && h.slice(i + 1) === s.slice(2) }
    return false
  })
}

export function daysLeft(ts: number): number {
  return Math.floor((ts - Date.now() / 1000) / 86400)
}

/** Countdown tone: ≤7 days (or expired) red, ≤30 amber, otherwise green. */
export function expiryTone(ts: number): 'good' | 'warn' | 'bad' | 'neutral' {
  if (!ts) return 'neutral'
  const d = daysLeft(ts)
  return d <= 7 ? 'bad' : d <= 30 ? 'warn' : 'good'
}

export function expiryText(ts: number): string {
  if (!ts) return '—'
  const d = daysLeft(ts)
  if (d < 0) return `已过期 ${-d} 天`
  if (d === 0) return '今天到期'
  return `剩余 ${d} 天`
}

/** A short label for selects: "name · SANs · 剩余 N 天". */
export function certLabel(c: Cert): string {
  const sans = c.sans.length ? c.sans.slice(0, 2).join(', ') + (c.sans.length > 2 ? ` +${c.sans.length - 2}` : '') : '未签发'
  return `${c.name} · ${sans}${c.not_after ? ' · ' + expiryText(c.not_after) : ''}`
}

/** Best usable panel certificate for an SNI on a node (newest expiry wins). */
export function matchCert(certs: Cert[], host: string, nodeId: string): Cert | undefined {
  return certs
    .filter((c) => c.not_after > Date.now() / 1000 && covers(c.sans, host) && (c.source !== 'node' || c.node_id === nodeId))
    .sort((a, b) => b.not_after - a.not_after)[0]
}

export async function downloadCert(c: Cert, part: 'chain' | 'key') {
  const res = await fetch(part === 'key' ? `/api/certs/${c.id}/key` : `/api/certs/${c.id}/download`, { method: part === 'key' ? 'POST' : 'GET', credentials: 'same-origin' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText)
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `${c.id}.pem`
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
