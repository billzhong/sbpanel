export class ApiError extends Error {
  status: number
  constructor(status: number, msg: string) {
    super(msg)
    this.status = status
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch('/api' + path, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('sbp:unauthorized'))
    throw new ApiError(res.status, data?.error ?? res.statusText)
  }
  return data as T
}

export type SysInfo = {
  cpu_pct?: number; mem_used?: number; mem_total?: number; load1?: number; uptime?: number
  net_rx?: number; net_tx?: number; disk_used?: number; disk_total?: number
}

export type Node = {
  id: string; name: string; address: string; online: boolean; enrolled: boolean
  revision: number; applied_revision: number; apply_error: string; last_seen: number; cert_expire: number
  info: { version?: string; singbox?: string; hostname?: string; os?: string; arch?: string }
  traffic_limit: number; reset_day: number; inbounds: number; sys?: SysInfo
  rate_up: number; rate_down: number; active_conns: number; spool_backlog: number; online_users: number
  month_up: number; month_down: number; today_up: number; today_down: number
}

export type Inbound = {
  id: number; node_id: string; node: string; tag: string; type: string; port: number
  options: Record<string, unknown>; client: Record<string, unknown>; enabled: boolean; remark: string
}

export type User = {
  id: number; username: string; sub_token: string; uuid: string; password?: string; status: string; enabled: boolean
  traffic_limit: number; expire_at: number; reset_strategy: string; note: string
  used_up: number; used_down: number; life_up: number; life_down: number; created_at: number; online_ips: number
}

export type TopRow = { key: string; label: string; up: number; down: number; conns: number; users: number }

export type Series = { key: string; label: string; up: number; down: number; points: [number, number, number][] }
export type SeriesResp = { step: number; from: number; to: number; group: string; series: Series[] }

export type Overview = {
  today_up: number; today_down: number; month_up: number; month_down: number
  rate_up: number; rate_down: number; active_conns: number
  users: number; active_users: number; online_users: number; online_ips: number
  nodes_total: number; nodes_online: number; nodes: Node[]
  top_users: TopRow[]; top_domains: TopRow[]; top_outbounds: TopRow[]
}

export type Event = { ts: number; kind: string; user_id: number; user: string; node_id: string; node: string; detail: string }

export type Enroll = { node_id: string; token: string; expires_at: number; master: string; ca_sha256: string; command: string }
