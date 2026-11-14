// Scoped API keys and agent (MCP) helpers.

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
  { id: 'read', label: '只读', desc: '读取用户、节点、入站、流量、事件和设置（不含密钥管理与备份）' },
  { id: 'users:write', label: '用户写入', desc: '创建、修改、删除用户，续期、加流量、重置用量、批量操作、踢下线' },
  { id: 'nodes:write', label: '节点写入', desc: '节点、入站、分组、Host、路由模板与订阅分流方案' },
  { id: 'settings:write', label: '设置写入', desc: '面板设置、外观、订阅页主题、通知渠道' },
  { id: 'admin', label: '管理员', desc: '全部权限，包括管理 API 密钥、下载备份和 3x-ui 导入' },
]
export const scopeLabel = (s: string) => SCOPES.find((x) => x.id === s)?.label ?? s

export const DEFAULT_RATE = 120

/** MCP tools the server exposes, for display (the server's tools/list is authoritative). */
export const MCP_TOOLS: { name: string; write: boolean; desc: string }[] = [
  { name: 'list_users', write: false, desc: '列出/搜索用户' },
  { name: 'get_user', write: false, desc: '用户详情与订阅链接' },
  { name: 'traffic_summary', write: false, desc: '按用户/节点/入站/域名汇总流量' },
  { name: 'top_domains', write: false, desc: '热门域名' },
  { name: 'list_nodes', write: false, desc: '节点健康' },
  { name: 'list_inbounds', write: false, desc: '入站列表' },
  { name: 'list_events', write: false, desc: '事件与审计' },
  { name: 'get_live_connections', write: false, desc: '在线用户与实时连接' },
  { name: 'create_user', write: true, desc: '创建用户' },
  { name: 'update_user', write: true, desc: '修改用户' },
  { name: 'extend_user', write: true, desc: '续期' },
  { name: 'add_traffic', write: true, desc: '加流量' },
  { name: 'set_user_enabled', write: true, desc: '启用/禁用' },
  { name: 'reset_usage', write: true, desc: '重置用量' },
  { name: 'kick_user', write: true, desc: '踢下线' },
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
