# sbpanel API 与 MCP

sbpanel 的 HTTP API 和 MCP 端点面向脚本、机器人和 AI 智能体。面板本身也使用同一套 `/api`。

- 机器可读描述：`GET /api/openapi.json`（OpenAPI 3.1，需要认证）。面板里的「设置 → API 与智能体 → 打开 API 文档」可以浏览。
- MCP 端点：`POST /mcp`（Streamable HTTP，JSON-RPC 2.0）

## 认证

| 方式 | 适用 | 说明 |
|---|---|---|
| 会话 Cookie | 面板网页 | `POST /api/auth/login` 设置。拥有全部权限，不受限流。 |
| API 密钥 | 脚本、智能体 | `Authorization: Bearer sbp_<48 位 hex>`。在「设置 → API 与智能体」创建。 |

密钥的特点：

- **只显示一次**。数据库只存 SHA-256 哈希和前 10 位前缀（用于识别），日志和审计里不会出现密钥本身。
- **权限范围**（见下表），按接口检查。
- **有效期**（可选）。过期后返回 `401 {"error":"API 密钥已过期"}`。
- **来源 IP 允许列表**（可选，IP 或 CIDR，IPv4/IPv6）。只有连接来自本机（反向代理）时才采用 `X-Forwarded-For` / `X-Real-IP`，否则用 TCP 对端地址，所以无法通过伪造请求头绕过。不在列表中返回 `403`。
- **速率限制**：每个密钥一个令牌桶，默认 120 次/分钟，突发上限 `max(10, 速率/4)`；创建时可设置 `rate_limit`（次/分钟）和 `rate_burst`。超出返回 `429`，带 `Retry-After`（秒）。每个响应都有 `X-RateLimit-Limit` 和 `X-RateLimit-Remaining`。
- 记录**最近使用时间和来源 IP**。
- 通过密钥执行的写操作在审计日志中记为 `token:<名称>`；通过 MCP 执行的记为 `mcp:<名称>`。

### 权限范围（scopes）

| scope | 允许 |
|---|---|
| `read` | 所有 GET 接口：用户、节点、入站、分组、Host、模板、分流方案、流量（series / top / online / 实时连接）、事件与审计、设置、证书与域名；以及只读的 `POST /api/routing/profiles/{id}/preview`、`POST /api/dns/plan` |
| `users:write` | 创建、修改、删除用户，批量创建 `/users/bulk`，批量操作 `/users/batch`（启用、禁用、续期、加流量、重置用量、改分组、删除、撤销），踢下线，断开实时连接 |
| `nodes:write` | 节点、入站、分组、Host、路由模板、订阅分流方案、证书与域名、Reality 密钥生成 |
| `settings:write` | 面板设置（含外观 `ui_appearance`）、订阅页主题、通知渠道与测试 |
| `admin` | 以上全部，另加：API 密钥管理（`/api/tokens`）、下载备份（`/api/backup`，含 CA 私钥）、3x-ui 导入、DNS 服务商令牌、证书私钥下载 |

说明：

- 写权限不隐含 `read`，按需同时勾选。`admin` 隐含全部。
- 修改密码、两步验证（`/api/me/*`）只能用登录会话。
- `/api/auth/me`、`/api/openapi.json`、`/api/scopes` 任意有效密钥都可以访问。
- 每个路由需要的权限定义在 `internal/master/api_scopes.go` 的 `routeScopes` 表中；OpenAPI 里每个操作的 `x-required-scope` 字段也给出了同样的信息。未登记的路由按 `admin` 处理，测试会报错。
- 旧版本创建的令牌升级后保持 `admin` 权限。只传 `{"name": ...}` 的旧客户端创建的也是 `admin` 密钥。

### 错误格式

所有错误都是 `{"error": "中文说明"}`：`400` 参数错误，`401` 未认证、密钥无效或过期，`403` 权限不足或 IP 不允许，`404` 不存在，`409` 冲突（如节点离线），`429` 限流。

## 密钥管理接口

需要登录会话或 `admin` 权限。

```http
GET    /api/tokens          # 列表（不含密钥本身）
POST   /api/tokens          # 创建，响应 {"token": "sbp_…", "key": {...}}
DELETE /api/tokens/{id}     # 吊销，立即生效
GET    /api/scopes          # 可授予的权限与说明
```

创建请求：

```json
{
  "name": "claude-code",
  "description": "本地 Claude Code",
  "scopes": ["read", "users:write"],
  "expires_in_days": 90,
  "allow_ips": ["203.0.113.7", "10.0.0.0/8"],
  "rate_limit": 120,
  "rate_burst": 30
}
```

也可以用 `expires_at`（unix 秒）代替 `expires_in_days`。名称必须唯一。

## 示例

```bash
export SBP=https://panel.example.com
export KEY=sbp_...

# 概览
curl -H "Authorization: Bearer $KEY" $SBP/api/overview

# 最近 7 天流量最多的 10 个域名
curl -H "Authorization: Bearer $KEY" "$SBP/api/traffic/top?dim=domain&limit=10&from=$(($(date +%s)-604800))"

# 创建用户：50 GB、30 天后到期（需要 users:write）
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"username\":\"alice\",\"traffic_limit\":$((50*1024**3)),\"expire_at\":$(($(date +%s)+30*86400))}" \
  $SBP/api/users

# 给 id 为 3、4 的用户续期 30 天；响应里的 undo 可以原样提交 action=restore 撤销
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"ids":[3,4],"action":"extend_days","value":30}' $SBP/api/users/batch

# 订阅地址
curl -H "Authorization: Bearer $KEY" $SBP/api/users/3/sub | jq -r .url
```

单位：流量是字节，时间是 unix 秒。`/api/traffic/top` 的响应头 `X-Precision` 表示数据精度（`1m`、`5m`、`1h`）。

## MCP（Model Context Protocol）

面板内置一个无状态 MCP 服务器，供 Claude Code、Claude Desktop、Cursor 等智能体使用。

- 传输：Streamable HTTP。客户端 `POST /mcp`，每个请求一条 JSON-RPC 2.0 消息（也接受批量数组），响应为 `application/json`。不提供 SSE 流和会话（`GET /mcp` 返回 405）。
- 协议版本：`2025-06-18`、`2025-03-26`、`2024-11-05`。
- 方法：`initialize`、`ping`、`tools/list`、`tools/call`、`resources/list`、`resources/read`。`notifications/*` 返回 `202`。
- 认证：只接受 `Authorization: Bearer` 密钥（不接受会话 Cookie），密钥的有效期、IP 允许列表和限流都生效。带 `Origin` 头时必须与面板同源，用于防 DNS 重绑定。
- `tools/list` 只返回该密钥有权调用的工具。调用无权限的工具时，结果为 `isError: true` 并说明缺少的权限；未知工具或参数不合法返回 JSON-RPC 错误 `-32602`。
- 工具内部通过同一套 `/api` 路由执行，所以路由权限会再检查一次，写操作在审计日志中记为 `mcp:<密钥名>`。

### 工具

| 工具 | 权限 | 作用 |
|---|---|---|
| `list_users` | read | 列出用户（search、status、group、limit、offset） |
| `get_user` | read | 按 `id` 或 `username` 查看详情、在线 IP、订阅地址 |
| `traffic_summary` | read | 按 user / node / inbound / outbound / domain 汇总流量；`range` 为 1h、6h、24h、today、7d、30d、month，或用 `from`/`to` |
| `top_domains` | read | 热门域名，可限定用户或节点 |
| `list_nodes` | read | 节点健康：`health` 为 ok、offline、apply_error、pending_apply、not_enrolled，另有速率、连接数、CPU、内存、月流量 |
| `list_inbounds` | read | 入站（不含密钥等敏感配置） |
| `list_events` | read | 系统事件或审计日志（`source: events|audit`） |
| `get_live_connections` | read | 在线用户和节点上的实时连接 |
| `create_user` | users:write | 创建用户：`traffic_gb`、`expire_days` 或 `expire_at`、`groups`（名称或 id）、`reset_strategy`、`device_limit`、`note`；返回订阅地址 |
| `update_user` | users:write | 只修改传入的字段 |
| `extend_user` | users:write | 续期 N 天 |
| `add_traffic` | users:write | 给有配额的用户增加 N GB |
| `set_user_enabled` | users:write | 启用或禁用（禁用会断开连接） |
| `reset_usage` | users:write | 用量清零 |
| `kick_user` | users:write | 断开所有连接 |

工具参数用 GB 和天，时间可以是 unix 秒、RFC 3339 或 `YYYY-MM-DD`（面板时区，当天结束）。结果同时提供文本（JSON）和 `structuredContent`。

资源（需要 `read`）：`sbpanel://overview`、`sbpanel://nodes`、`sbpanel://scopes`。

### 连接 Claude Code

只读密钥适合查询；需要开通、续期用户时再加 `users:write`。

```bash
claude mcp add --transport http sbpanel https://panel.example.com/mcp \
  --header "Authorization: Bearer sbp_..."
claude mcp list        # 应显示 sbpanel: ✓ Connected
```

然后可以直接问「这周谁的流量最多」「给 alice 续期 30 天并加 20 GB」。

### 其它 MCP 客户端

支持 Streamable HTTP 和自定义请求头的客户端（Claude Desktop、Cursor、VS Code 等）：

```json
{
  "mcpServers": {
    "sbpanel": {
      "type": "http",
      "url": "https://panel.example.com/mcp",
      "headers": { "Authorization": "Bearer sbp_..." }
    }
  }
}
```

只支持 stdio 的客户端可以用 `mcp-remote` 之类的桥接：

```json
{ "command": "npx", "args": ["mcp-remote", "https://panel.example.com/mcp", "--header", "Authorization: Bearer sbp_..."] }
```

### 用 curl 调试

```bash
curl -s $SBP/mcp -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"traffic_summary","arguments":{"range":"7d","group_by":"user","limit":5}}}'
```

## 安全建议

- 每个程序一个密钥，只给需要的权限；给智能体用「只读」或「只读 + 用户写入」，不要给 `admin`。
- 固定出口的程序设置 IP 允许列表；临时用途设置有效期。
- 面板放在 HTTPS 反向代理之后，密钥只通过 HTTPS 传输。
- 密钥泄露时在面板删除即可立即吊销；审计日志能查到它做过的操作。
