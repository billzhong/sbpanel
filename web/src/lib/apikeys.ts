// Scoped API keys and agent (MCP) helpers.
import { tr } from '../i18n'
import { K } from '../i18n/apikeys'

export type Scope = 'read' | 'users:write' | 'nodes:write' | 'settings:write' | 'admin'

export type ApiKey = {
  id: number; name: string; description: string; prefix: string; scopes: Scope[]
  created_at: number; created_by: string; expires_at: number; allow_ips: string[]
  rate_limit: number; rate_burst: number; last_used: number; last_ip: string; expired: boolean
}

export type ApiKeyCreate = {
  name: string; description?: string; scopes: Scope[]; expires_in_days?: number
  allow_ips?: string[]; rate_limit?: number
}

export const SCOPES: { id: Scope; label: string; desc: string }[] = [
  { id: 'read', get label() { return tr(K).s_read }, get desc() { return tr(K).s_read_d } },
  { id: 'users:write', get label() { return tr(K).s_users }, get desc() { return tr(K).s_users_d } },
  { id: 'nodes:write', get label() { return tr(K).s_nodes }, get desc() { return tr(K).s_nodes_d } },
  { id: 'settings:write', get label() { return tr(K).s_settings }, get desc() { return tr(K).s_settings_d } },
  { id: 'admin', get label() { return tr(K).s_admin }, get desc() { return tr(K).s_admin_d } },
]
export const scopeLabel = (s: string) => SCOPES.find((x) => x.id === s)?.label ?? s

export const DEFAULT_RATE = 120

/** MCP tools the server exposes, for display (the server's tools/list is authoritative). */
export const MCP_TOOLS: { name: string; write: boolean; desc: string }[] = [
  { name: 'list_users', write: false, get desc() { return tr(K).list_users } },
  { name: 'get_user', write: false, get desc() { return tr(K).get_user } },
  { name: 'traffic_summary', write: false, get desc() { return tr(K).traffic_summary } },
  { name: 'top_domains', write: false, get desc() { return tr(K).top_domains } },
  { name: 'list_nodes', write: false, get desc() { return tr(K).list_nodes } },
  { name: 'list_inbounds', write: false, get desc() { return tr(K).list_inbounds } },
  { name: 'list_events', write: false, get desc() { return tr(K).list_events } },
  { name: 'get_live_connections', write: false, get desc() { return tr(K).get_live_connections } },
  { name: 'create_user', write: true, get desc() { return tr(K).create_user } },
  { name: 'update_user', write: true, get desc() { return tr(K).update_user } },
  { name: 'extend_user', write: true, get desc() { return tr(K).extend_user } },
  { name: 'add_traffic', write: true, get desc() { return tr(K).add_traffic } },
  { name: 'set_user_enabled', write: true, get desc() { return tr(K).set_user_enabled } },
  { name: 'reset_usage', write: true, get desc() { return tr(K).reset_usage } },
  { name: 'kick_user', write: true, get desc() { return tr(K).kick_user } },
]

export const panelOrigin = () => location.origin

export function curlExample(token: string, scopes: Scope[]): string {
  const path = scopes.includes('read') || scopes.includes('admin') ? '/api/overview' : '/api/auth/me'
  return `curl -H "Authorization: Bearer ${token}" ${panelOrigin()}${path}`
}

export function claudeMcpCommand(token: string): string {
  return `claude mcp add --transport http sbpanel ${panelOrigin()}/mcp --header "Authorization: Bearer ${token}"`
}

export function mcpJsonConfig(token: string): string {
  return JSON.stringify({ mcpServers: { sbpanel: { type: 'http', url: `${panelOrigin()}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
}
