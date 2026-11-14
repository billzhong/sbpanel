package master

// OpenAPI 3.1 description of the /api surface, served at GET /api/openapi.json.
// apiDocs has one entry per route pattern; TestOpenAPICoversRoutes fails when a registered
// /api route is missing here, so the spec can't drift from routes().

import (
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
)

type oaParam struct {
	Name, In, Desc string
	Schema         map[string]any
	Required       bool
}

type opDoc struct {
	Tag     string
	Summary string
	Desc    string
	Query   []oaParam
	Body    any // schema (map) or "$Name" component ref
	Resp    any // schema (map) or "$Name"; nil = {"ok": true}
	RespCT  string
}

// ---------- schema helpers ----------

type js = map[string]any

func ref(name string) js                { return js{"$ref": "#/components/schemas/" + name} }
func arr(items any) js                  { return js{"type": "array", "items": schemaOf(items)} }
func tStr(desc string) js               { return js{"type": "string", "description": desc} }
func tInt(desc string) js               { return js{"type": "integer", "description": desc} }
func tNum(desc string) js               { return js{"type": "number", "description": desc} }
func tBool(desc string) js              { return js{"type": "boolean", "description": desc} }
func tEnum(desc string, v ...string) js { return js{"type": "string", "description": desc, "enum": v} }
func tTS(desc string) js                { return js{"type": "integer", "format": "unix-time", "description": desc} }
func tBytes(desc string) js             { return js{"type": "integer", "format": "bytes", "description": desc} }
func tObj(props js, required ...string) js {
	o := js{"type": "object", "properties": props}
	if len(required) > 0 {
		o["required"] = required
	}
	return o
}
func tMap(desc string) js {
	return js{"type": "object", "description": desc, "additionalProperties": true}
}

func schemaOf(v any) any {
	if s, ok := v.(string); ok && strings.HasPrefix(s, "$") {
		return ref(s[1:])
	}
	return v
}

func qp(name, desc string, schema js) oaParam {
	return oaParam{Name: name, In: "query", Desc: desc, Schema: schema}
}

var trafficQuery = []oaParam{
	qp("from", "开始时间（unix 秒），默认 24 小时前", js{"type": "integer"}),
	qp("to", "结束时间（unix 秒），默认现在", js{"type": "integer"}),
	qp("user", "只看该用户 id", js{"type": "integer"}),
	qp("node", "只看该节点 id", js{"type": "string"}),
}

var okResp = tObj(js{"ok": tBool("")})
var idResp = tObj(js{"id": tInt("新对象 id")})

// ---------- components ----------

var oaSchemas = js{
	"Error": tObj(js{"error": tStr("错误信息（中文）")}, "error"),
	"Ok":    okResp,
	"Me": tObj(js{"username": tStr("管理员用户名，或 token:<密钥名>"), "totp": tBool("是否开启两步验证"), "token": tBool("是否通过 API 密钥访问"),
		"scopes": arr(tStr(""))}),
	"Scope": tObj(js{"id": tEnum("", AllScopes...), "label": tStr(""), "description": tStr("")}),
	"ApiKey": tObj(js{
		"id": tInt(""), "name": tStr("名称（审计里记为 token:<name> / mcp:<name>）"), "description": tStr(""), "prefix": tStr("密钥前 10 位，用于识别"),
		"scopes": arr(tEnum("", AllScopes...)), "created_at": tTS(""), "created_by": tStr(""), "expires_at": tTS("0 = 永不过期"),
		"allow_ips": arr(tStr("IP 或 CIDR")), "rate_limit": tInt("每分钟请求数（生效值）"), "rate_burst": tInt("突发上限（生效值）"),
		"last_used": tTS(""), "last_ip": tStr(""), "expired": tBool(""),
	}),
	"ApiKeyCreate": tObj(js{
		"name": tStr("名称，唯一"), "description": tStr(""), "scopes": arr(tEnum("", AllScopes...)),
		"expires_at": tTS("过期时间，0 = 永不"), "expires_in_days": tInt("或：多少天后过期"),
		"allow_ips":  arr(tStr("允许的来源 IP 或 CIDR；空 = 不限。反向代理时仅信任来自本机的 X-Forwarded-For")),
		"rate_limit": tInt("每分钟请求数，0 = 默认 120"), "rate_burst": tInt("令牌桶容量，0 = max(10, rate/4)"),
	}, "name", "scopes"),
	"ApiKeyCreated": tObj(js{"token": tStr("完整密钥 sbp_…，只返回这一次"), "key": ref("ApiKey")}),
	"User": tObj(js{
		"id": tInt(""), "username": tStr(""), "sub_token": tStr("订阅令牌（/s/<sub_token>）"), "uuid": tStr("VLESS/VMess UUID"),
		"status": tEnum("由配额与到期计算", "active", "limited", "expired"), "enabled": tBool(""),
		"traffic_limit": tBytes("配额，0 = 不限"), "expire_at": tTS("0 = 永不到期"),
		"reset_strategy": tEnum("", resetEnum...), "note": tStr(""),
		"used_up": tBytes("本周期上行"), "used_down": tBytes("本周期下行"), "life_up": tBytes("累计上行"), "life_down": tBytes("累计下行"),
		"created_at": tTS(""), "online_ips": tInt("当前在线 IP 数"), "device_limit": tInt("0 = 不限"),
		"speed_up": tInt("上行限速 bytes/s，0 = 不限"), "speed_down": tInt("下行限速 bytes/s，0 = 不限"),
		"last_reset_at": tTS(""), "sub_last_at": tTS("最近拉取订阅"), "sub_last_ua": tStr(""), "group_ids": arr(tInt("")),
		"last_online": tTS(""), "sub_profile_id": tInt("分流方案，0 = 跟随分组/默认"),
	}),
	"UserInput": tObj(js{
		"username": tStr("字母、数字、. _ @ -，最长 64"), "traffic_limit": tBytes("0 = 不限"), "expire_at": tTS("0 = 永不"),
		"reset_strategy": tEnum("", resetEnum...), "note": tStr(""), "enabled": tBool(""),
		"reset_usage": tBool("仅 PATCH：清零本周期用量"), "rotate_secrets": tBool("仅 PATCH：重置 UUID/密码/订阅令牌"),
		"device_limit": tInt(""), "speed_up": tInt(""), "speed_down": tInt(""), "group_ids": arr(tInt("")), "sub_profile_id": tInt(""),
	}),
	"UserDetail": tObj(js{"user": ref("User"), "ips": arr(tObj(js{"ip": tStr(""), "node_id": tStr(""), "node": tStr(""),
		"first_seen": tTS(""), "last_seen": tTS(""), "online": tBool("")}))}),
	"UserSub": tObj(js{"url": tStr("订阅地址"), "qr": tStr("二维码 data URI"), "active": tBool(""),
		"formats": tObj(js{"base64": tStr(""), "singbox": tStr(""), "mihomo": tStr(""), "surge": tStr(""), "page": tStr("")}),
		"links":   arr(tObj(js{"remark": tStr(""), "type": tStr(""), "uri": tStr("分享链接")})),
		"access":  arr(tObj(js{"ts": tTS(""), "ip": tStr(""), "ua": tStr(""), "format": tStr("")}))}),
	"BatchRequest": tObj(js{
		"ids":    arr(tInt("")),
		"action": tEnum("批量操作", "enable", "disable", "reset_usage", "delete", "extend_days", "add_traffic", "set_groups", "restore"),
		"value":  js{"description": "extend_days: 天数；add_traffic: 字节（可为负）；set_groups: 分组 id 数组；restore: 上次返回的 undo 快照"},
	}, "ids", "action"),
	"BatchResult": tObj(js{"affected": tInt(""), "undo": arr(tMap("快照，可原样 POST action=restore 撤销"))}),
	"BulkRequest": tObj(js{"prefix": tStr(""), "count": tInt("1-1000"), "start": tInt("起始序号"), "traffic_limit": tBytes(""),
		"expire_days": tInt(""), "reset_strategy": tEnum("", resetEnum...), "group_ids": arr(tInt(""))}, "prefix", "count"),
	"Node": tObj(js{
		"id": tStr(""), "name": tStr(""), "address": tStr("最近连接地址"), "public_address": tStr("订阅里使用的地址"), "template_id": tInt(""),
		"online": tBool(""), "enrolled": tBool(""), "revision": tInt("期望配置版本"), "applied_revision": tInt("已应用版本"),
		"apply_error": tStr(""), "last_seen": tTS(""), "cert_expire": tTS(""), "info": tMap("版本、主机名、系统"),
		"traffic_limit": tBytes("节点月流量上限"), "reset_day": tInt(""), "inbounds": tInt(""), "sys": tMap("CPU、内存、负载、磁盘"),
		"rate_up": tInt("bytes/s"), "rate_down": tInt("bytes/s"), "active_conns": tInt(""), "spool_backlog": tInt(""), "online_users": tInt(""),
		"month_up": tBytes(""), "month_down": tBytes(""), "today_up": tBytes(""), "today_down": tBytes(""),
	}),
	"NodeInput": tObj(js{"name": tStr(""), "public_address": tStr(""), "template_id": tInt(""), "traffic_limit": tBytes("仅 PATCH"),
		"reset_day": tInt("仅 PATCH，1-28"), "skeleton": tMap("仅 PATCH：节点自定义骨架")}),
	"Enroll": tObj(js{"node_id": tStr(""), "token": tStr("一次性接入令牌"), "expires_at": tTS(""), "master": tStr(""),
		"ca_sha256": tStr(""), "command": tStr("在节点上执行的 sbnode enroll 命令")}),
	"Inbound": tObj(js{"id": tInt(""), "node_id": tStr(""), "node": tStr(""), "tag": tStr(""), "type": tStr("vless、vmess、trojan、shadowsocks、hysteria2、tuic、anytls…"),
		"port": tInt(""), "options": tMap("sing-box 入站选项（含密钥）"), "client": tMap("客户端侧参数"), "enabled": tBool(""), "remark": tStr(""),
		"sort": tInt(""), "group_ids": arr(tInt(""))}),
	"InboundInput": tObj(js{"node_id": tStr(""), "tag": tStr(""), "type": tStr(""), "options": tMap("sing-box 入站选项，需含 listen_port"),
		"client": tMap(""), "enabled": tBool(""), "remark": tStr(""), "group_ids": arr(tInt("")), "sort": tInt("")}, "node_id", "tag", "type", "options"),
	"Group": tObj(js{"id": tInt(""), "name": tStr(""), "remark": tStr(""), "is_default": tBool("新用户/入站自动加入"),
		"inbound_ids": arr(tInt("")), "users": tInt(""), "sub_profile_id": tInt("")}),
	"GroupInput": tObj(js{"name": tStr(""), "remark": tStr(""), "is_default": tBool(""), "inbound_ids": arr(tInt("")), "sub_profile_id": tInt("")}),
	"Host": tObj(js{"id": tInt(""), "inbound_id": tInt(""), "remark": tStr(""), "address": tStr("订阅中替换的地址（CDN、中转）"), "port": tInt("0 = 沿用入站端口"),
		"sni": tStr(""), "host": tStr(""), "path": tStr(""), "alpn": tStr(""), "fingerprint": tStr(""), "allow_insecure": tBool(""), "sort": tInt(""), "enabled": tBool("")}),
	"Template": tObj(js{"id": tInt(""), "name": tStr(""), "json": tStr("已发布的 sing-box 骨架 JSON"), "draft": tStr("草稿"), "has_draft": tBool(""),
		"updated_at": tTS(""), "nodes": arr(tStr("使用该模板的节点 id"))}),
	"TemplateInput": tObj(js{"name": tStr(""), "from": tInt("复制自模板 id"), "draft": tStr("仅 PATCH：骨架 JSON 草稿")}),
	"RoutingProfile": tObj(js{"id": tInt(""), "slug": tStr(""), "name": tStr(""), "description": tStr(""), "is_default": tBool(""),
		"selectable": tBool("用户可在订阅页选择"), "published_at": tTS(""), "updated_at": tTS(""), "has_draft": tBool(""),
		"users": tInt(""), "group_ids": arr(tInt(""))}),
	"RoutingProfileInput": tObj(js{"name": tStr(""), "slug": tStr(""), "description": tStr(""), "preset": tStr("从内置预设创建"),
		"from": tInt("复制自方案 id"), "selectable": tBool(""), "is_default": tBool("")}),
	"TopRow": tObj(js{"key": tStr("维度值（用户 id、节点 id、域名…）"), "label": tStr("显示名"), "up": tBytes(""), "down": tBytes(""),
		"conns": tInt(""), "users": tInt("涉及的用户数")}),
	"Series": tObj(js{"key": tStr(""), "label": tStr(""), "up": tBytes(""), "down": tBytes(""),
		"points": arr(js{"type": "array", "items": js{"type": "integer"}, "description": "[ts, up, down]"})}),
	"Online": tObj(js{"user_id": tInt(""), "user": tStr(""), "ip": tStr(""), "node_id": tStr(""), "node": tStr("")}),
	"Conn": tObj(js{"id": tInt(""), "user": tStr("用户 id"), "username": tStr(""), "inbound": tStr(""), "outbound": tStr(""), "network": tStr(""),
		"host": tStr("目标"), "port": tInt(""), "src_ip": tStr(""), "rule": tStr("命中的路由规则"), "start": tTS(""), "up": tBytes(""), "down": tBytes("")}),
	"Event": tObj(js{"ts": tTS(""), "kind": tStr("node_offline、quota_exceeded、user_expired…"), "user_id": tInt(""), "user": tStr(""),
		"node_id": tStr(""), "node": tStr(""), "detail": tStr("")}),
	"AuditEntry": tObj(js{"ts": tTS(""), "admin": tStr("管理员用户名、token:<名> 或 mcp:<名>"), "action": tStr("如 user.create"),
		"target": tStr(""), "detail": tStr(""), "ip": tStr("")}),
	"Overview": tMap("today_up/down、month_up/down、rate_up/down、active_conns、users、active_users、online_users、online_ips、nodes、top_users、top_domains、top_outbounds"),
	"Settings": tObj(js{"sub_base_url": tStr(""), "sub_title": tStr(""), "sub_update_hours": tStr(""), "tg_chat": tStr(""), "webhook_url": tStr(""),
		"notify_events": tStr("逗号分隔"), "device_policy": tEnum("", "reject", "kick_oldest"), "sub_announcement": tStr(""), "sub_logo_url": tStr(""),
		"sub_support_links": tStr("JSON"), "sub_clients": tStr(""), "sub_rule_mirror": tStr(""), "ui_appearance": tStr("JSON"),
		"tg_token_set": tBool("只读"), "ca_sha256": tStr("只读"), "grpc_listen": tStr("只读"), "public_grpc": tStr("只读"), "tz": tStr("只读")}),
	"SettingsInput": js{"type": "object", "description": "要修改的设置项（字符串值），未知键返回 400；另可写 tg_token", "additionalProperties": js{"type": "string"}},
	"SubTheme":      tMap("订阅页主题：id、name、version、active、settings schema"),
	"ImportRequest": tObj(js{"node_id": tStr(""), "data": tStr("3x-ui /panel/api/inbounds/list 的 JSON"), "dry_run": tBool("只预览")}, "node_id", "data"),
	"ImportReport":  tMap("dry_run、users、updated、skipped、groups、warnings、inbounds"),
}

// ---------- operations ----------

var apiDocs = map[string]opDoc{
	"POST /api/auth/login": {Tag: "auth", Summary: "登录（设置会话 Cookie）", Desc: "自动化请改用 API 密钥。",
		Body: tObj(js{"username": tStr(""), "password": tStr(""), "code": tStr("两步验证码（开启时必填）")}, "username", "password"),
		Resp: tObj(js{"username": tStr("")})},
	"POST /api/auth/logout":     {Tag: "auth", Summary: "退出登录"},
	"GET /api/auth/me":          {Tag: "auth", Summary: "当前身份与权限", Resp: "$Me"},
	"POST /api/me/password":     {Tag: "auth", Summary: "修改密码（仅会话）", Body: tObj(js{"old": tStr(""), "new": tStr("至少 8 位")}, "old", "new")},
	"POST /api/me/totp/setup":   {Tag: "auth", Summary: "生成两步验证密钥（仅会话）", Resp: tObj(js{"secret": tStr(""), "uri": tStr(""), "qr": tStr("")})},
	"POST /api/me/totp/enable":  {Tag: "auth", Summary: "开启两步验证（仅会话）", Body: tObj(js{"code": tStr("")}, "code")},
	"POST /api/me/totp/disable": {Tag: "auth", Summary: "关闭两步验证（仅会话）", Body: tObj(js{"password": tStr("")}, "password")},
	"GET /api/openapi.json":     {Tag: "auth", Summary: "本 OpenAPI 文档", Resp: tMap("OpenAPI 3.1")},
	"GET /api/scopes":           {Tag: "api-keys", Summary: "可授予的权限列表", Resp: arr("$Scope")},

	"GET /api/tokens":         {Tag: "api-keys", Summary: "列出 API 密钥", Desc: "需要会话或 admin 权限。不返回密钥本身。", Resp: arr("$ApiKey")},
	"POST /api/tokens":        {Tag: "api-keys", Summary: "创建 API 密钥", Desc: "完整密钥只在此响应中出现一次。", Body: "$ApiKeyCreate", Resp: "$ApiKeyCreated"},
	"DELETE /api/tokens/{id}": {Tag: "api-keys", Summary: "删除（吊销）API 密钥"},

	"GET /api/audit":        {Tag: "events", Summary: "审计日志（最新在前）", Query: []oaParam{qp("limit", "默认 200", js{"type": "integer"})}, Resp: arr("$AuditEntry")},
	"GET /api/settings":     {Tag: "settings", Summary: "读取面板设置", Resp: "$Settings"},
	"PUT /api/settings":     {Tag: "settings", Summary: "修改面板设置（含外观 ui_appearance）", Body: "$SettingsInput"},
	"GET /api/backup":       {Tag: "settings", Summary: "下载 SQLite 备份（admin）", Desc: "包含 CA 私钥和所有密钥。", Resp: js{"type": "string", "format": "binary"}, RespCT: "application/octet-stream"},
	"POST /api/notify/test": {Tag: "settings", Summary: "发送测试通知"},
	"POST /api/import/3xui": {Tag: "settings", Summary: "从 3x-ui 导入入站和用户（admin）", Body: "$ImportRequest", Resp: "$ImportReport"},

	"GET /api/overview": {Tag: "traffic", Summary: "概览仪表盘数据", Resp: "$Overview"},
	"GET /api/traffic/series": {Tag: "traffic", Summary: "流量时间序列", Resp: arr("$Series"),
		Query: append([]oaParam{
			qp("step", "粒度秒数", js{"type": "integer", "enum": []int{60, 300, 900, 1800, 3600, 10800, 21600, 86400}, "default": 300}),
			qp("group", "拆分维度", js{"type": "string", "enum": []string{"total", "user", "node", "inbound", "outbound"}}),
		}, trafficQuery...)},
	"GET /api/traffic/top": {Tag: "traffic", Summary: "流量排行", Desc: "响应头 X-Precision 表示数据精度（1m/5m/1h）。", Resp: arr("$TopRow"),
		Query: append([]oaParam{
			{Name: "dim", In: "query", Required: true, Desc: "维度", Schema: js{"type": "string", "enum": []string{"user", "node", "inbound", "outbound", "host", "domain", "src_ip", "port", "rule", "network"}}},
			qp("limit", "1-1000，默认 50", js{"type": "integer"}),
		}, trafficQuery...)},
	"GET /api/events": {Tag: "events", Summary: "系统事件（最新在前）", Query: []oaParam{qp("limit", "默认 100", js{"type": "integer"})}, Resp: arr("$Event")},
	"GET /api/online": {Tag: "traffic", Summary: "当前在线用户与来源 IP（实时）", Resp: arr("$Online")},

	"GET /api/nodes":                   {Tag: "nodes", Summary: "节点列表与健康状态", Resp: arr("$Node")},
	"POST /api/nodes":                  {Tag: "nodes", Summary: "新建节点并返回接入命令", Body: "$NodeInput", Resp: "$Enroll"},
	"PATCH /api/nodes/{id}":            {Tag: "nodes", Summary: "修改节点", Body: "$NodeInput"},
	"DELETE /api/nodes/{id}":           {Tag: "nodes", Summary: "删除节点"},
	"POST /api/nodes/{id}/token":       {Tag: "nodes", Summary: "重新生成接入令牌", Resp: "$Enroll"},
	"GET /api/nodes/{id}/spec":         {Tag: "nodes", Summary: "节点当前下发的配置（调试）", Resp: tMap("")},
	"GET /api/nodes/{id}/conns":        {Tag: "traffic", Summary: "节点实时连接", Desc: "首次调用会让节点开始推送，ready=false 时稍后重试。", Resp: tObj(js{"conns": arr("$Conn"), "total": tInt(""), "ready": tBool("")})},
	"POST /api/nodes/{id}/conns/close": {Tag: "traffic", Summary: "断开指定连接", Body: tObj(js{"ids": arr(tInt(""))}, "ids")},

	"GET /api/inbounds":               {Tag: "inbounds", Summary: "入站列表", Query: []oaParam{qp("node", "节点 id", js{"type": "string"})}, Resp: arr("$Inbound")},
	"POST /api/inbounds":              {Tag: "inbounds", Summary: "新建入站", Body: "$InboundInput", Resp: idResp},
	"PATCH /api/inbounds/{id}":        {Tag: "inbounds", Summary: "修改入站", Body: "$InboundInput"},
	"DELETE /api/inbounds/{id}":       {Tag: "inbounds", Summary: "删除入站"},
	"POST /api/tools/reality-keypair": {Tag: "inbounds", Summary: "生成 Reality 密钥对", Resp: tObj(js{"private_key": tStr(""), "public_key": tStr(""), "short_id": tStr("")})},

	"GET /api/groups":         {Tag: "groups", Summary: "分组列表", Resp: arr("$Group")},
	"POST /api/groups":        {Tag: "groups", Summary: "新建分组", Body: "$GroupInput", Resp: idResp},
	"PATCH /api/groups/{id}":  {Tag: "groups", Summary: "修改分组", Body: "$GroupInput"},
	"DELETE /api/groups/{id}": {Tag: "groups", Summary: "删除分组"},

	"GET /api/hosts":         {Tag: "hosts", Summary: "Host（订阅地址覆盖）列表", Resp: arr("$Host")},
	"POST /api/hosts":        {Tag: "hosts", Summary: "新建 Host", Body: "$Host", Resp: idResp},
	"PUT /api/hosts/{id}":    {Tag: "hosts", Summary: "修改 Host", Body: "$Host", Resp: idResp},
	"DELETE /api/hosts/{id}": {Tag: "hosts", Summary: "删除 Host"},

	"GET /api/templates":             {Tag: "templates", Summary: "路由模板（sing-box 骨架）列表", Resp: arr("$Template")},
	"POST /api/templates":            {Tag: "templates", Summary: "新建模板", Body: "$TemplateInput", Resp: idResp},
	"PATCH /api/templates/{id}":      {Tag: "templates", Summary: "保存模板草稿/改名", Body: "$TemplateInput"},
	"POST /api/templates/{id}/apply": {Tag: "templates", Summary: "发布草稿并下发到节点"},
	"DELETE /api/templates/{id}":     {Tag: "templates", Summary: "删除模板"},

	"GET /api/routing/catalog":                              {Tag: "routing", Summary: "可用规则集目录", Resp: arr(tObj(js{"key": tStr(""), "label": tStr(""), "kind": tStr(""), "geosite": tStr(""), "geoip": tStr("")}))},
	"GET /api/routing/nodes":                                {Tag: "routing", Summary: "可作为出口的节点/入站", Resp: arr(tMap(""))},
	"GET /api/routing/profiles":                             {Tag: "routing", Summary: "订阅分流方案列表", Resp: arr("$RoutingProfile")},
	"POST /api/routing/profiles":                            {Tag: "routing", Summary: "新建分流方案", Body: "$RoutingProfileInput", Resp: idResp},
	"GET /api/routing/profiles/{id}":                        {Tag: "routing", Summary: "分流方案详情（含规则与草稿）", Resp: tMap("")},
	"PATCH /api/routing/profiles/{id}":                      {Tag: "routing", Summary: "修改方案属性", Body: "$RoutingProfileInput"},
	"DELETE /api/routing/profiles/{id}":                     {Tag: "routing", Summary: "删除方案"},
	"PUT /api/routing/profiles/{id}/draft":                  {Tag: "routing", Summary: "保存草稿", Body: tObj(js{"draft": tMap("规则草稿")}, "draft")},
	"DELETE /api/routing/profiles/{id}/draft":               {Tag: "routing", Summary: "丢弃草稿"},
	"POST /api/routing/profiles/{id}/preview":               {Tag: "routing", Summary: "预览某客户端生成的配置", Body: tObj(js{"client": tEnum("", "singbox", "mihomo", "surge"), "user_id": tInt(""), "draft": tMap("")}), Resp: tMap("")},
	"POST /api/routing/profiles/{id}/publish":               {Tag: "routing", Summary: "发布草稿"},
	"GET /api/routing/profiles/{id}/history":                {Tag: "routing", Summary: "发布历史", Resp: arr(tObj(js{"id": tInt(""), "ts": tTS(""), "admin": tStr(""), "json": tMap("")}))},
	"POST /api/routing/profiles/{id}/history/{hid}/restore": {Tag: "routing", Summary: "把历史版本恢复为草稿"},

	"GET /api/users":            {Tag: "users", Summary: "用户列表", Resp: arr("$User")},
	"POST /api/users":           {Tag: "users", Summary: "创建用户", Body: "$UserInput", Resp: idResp},
	"POST /api/users/bulk":      {Tag: "users", Summary: "按前缀批量创建用户", Body: "$BulkRequest", Resp: tMap("created、ids")},
	"POST /api/users/batch":     {Tag: "users", Summary: "批量操作（启用/禁用/续期/加流量/重置/改分组/删除/撤销）", Body: "$BatchRequest", Resp: "$BatchResult"},
	"GET /api/users/{id}":       {Tag: "users", Summary: "用户详情与 IP 记录", Resp: "$UserDetail"},
	"GET /api/users/{id}/sub":   {Tag: "users", Summary: "用户订阅地址、各格式链接和访问记录", Resp: "$UserSub"},
	"PATCH /api/users/{id}":     {Tag: "users", Summary: "修改用户（只改传入字段）", Body: "$UserInput"},
	"DELETE /api/users/{id}":    {Tag: "users", Summary: "删除用户"},
	"POST /api/users/{id}/kick": {Tag: "users", Summary: "踢下线（断开所有连接）"},

	"GET /api/sub-themes":               {Tag: "settings", Summary: "订阅页主题列表", Resp: arr("$SubTheme")},
	"POST /api/sub-themes":              {Tag: "settings", Summary: "上传主题包（zip，multipart）", Body: js{"type": "string", "format": "binary"}},
	"PUT /api/sub-themes/active":        {Tag: "settings", Summary: "启用主题", Body: tObj(js{"id": tStr("")}, "id")},
	"PUT /api/sub-themes/{id}/settings": {Tag: "settings", Summary: "保存主题设置", Body: tMap("")},
	"DELETE /api/sub-themes/{id}":       {Tag: "settings", Summary: "删除主题"},
	"GET /api/sub-themes/{id}/preview":  {Tag: "settings", Summary: "主题预览页（HTML）", Resp: js{"type": "string"}, RespCT: "text/html"},

	"POST /mcp": {Tag: "mcp", Summary: "MCP 端点（JSON-RPC 2.0，Streamable HTTP，无状态）",
		Desc: "方法：initialize、tools/list、tools/call、resources/list、resources/read、ping。详见 docs/API.md。",
		Body: tMap("JSON-RPC 2.0 请求或批量数组"), Resp: tMap("JSON-RPC 2.0 响应；通知返回 202")},
}

var oaTags = []js{
	{"name": "auth", "description": "登录、身份与账户"},
	{"name": "api-keys", "description": "API 密钥管理（会话或 admin 权限）"},
	{"name": "users", "description": "用户、配额、到期、批量操作"},
	{"name": "nodes", "description": "节点接入与配置"},
	{"name": "inbounds", "description": "入站协议"},
	{"name": "groups", "description": "分组（用户 ↔ 入站）"},
	{"name": "hosts", "description": "订阅地址覆盖（CDN/中转）"},
	{"name": "templates", "description": "sing-box 路由模板"},
	{"name": "routing", "description": "订阅分流方案"},
	{"name": "traffic", "description": "流量统计、在线与实时连接"},
	{"name": "events", "description": "系统事件与审计日志"},
	{"name": "settings", "description": "面板设置、主题、备份与迁移"},
	{"name": "mcp", "description": "给 AI 智能体用的 Model Context Protocol 端点"},
}

var pathParamRe = regexp.MustCompile(`\{([a-z]+)\}`)

var (
	openAPIOnce sync.Once
	openAPIJSON []byte
)

// buildOpenAPI renders the spec from apiDocs + routeScopes.
func buildOpenAPI() map[string]any {
	paths := map[string]js{}
	pats := sortedKeys(apiDocs)
	for _, pat := range pats {
		d := apiDocs[pat]
		method, path, _ := strings.Cut(pat, " ")
		method = strings.ToLower(method)
		scope := routeScopes[pat]
		op := js{
			"tags": []string{d.Tag}, "summary": d.Summary,
			"operationId":      operationID(method, path),
			"x-required-scope": scope,
		}
		desc := d.Desc
		switch scope {
		case scopePublic:
			op["security"] = []js{}
		case scopeSession:
			op["security"] = []js{{"cookieAuth": []string{}}}
			desc = strings.TrimSpace("仅限登录会话，API 密钥不可用。" + desc)
		case scopeKey:
			op["security"] = []js{{"bearerAuth": []string{}}}
			desc = strings.TrimSpace("仅 API 密钥（Bearer）；每个工具按自己的权限校验。" + desc)
		case scopeAny:
			desc = strings.TrimSpace("任意已认证调用方。" + desc)
		default:
			desc = strings.TrimSpace("需要权限：`" + scope + "`。" + desc)
		}
		op["description"] = desc
		params := []js{}
		for _, m := range pathParamRe.FindAllStringSubmatch(path, -1) {
			t := "integer"
			if m[1] == "id" && (strings.HasPrefix(path, "/api/nodes/") || strings.HasPrefix(path, "/api/sub-themes/")) {
				t = "string"
			}
			params = append(params, js{"name": m[1], "in": "path", "required": true, "schema": js{"type": t}})
		}
		for _, q := range d.Query {
			p := js{"name": q.Name, "in": q.In, "schema": q.Schema}
			if q.Desc != "" {
				p["description"] = q.Desc
			}
			if q.Required {
				p["required"] = true
			}
			params = append(params, p)
		}
		if len(params) > 0 {
			op["parameters"] = params
		}
		if d.Body != nil {
			ct := "application/json"
			if pat == "POST /api/sub-themes" {
				ct = "application/zip"
			}
			op["requestBody"] = js{"required": true, "content": js{ct: js{"schema": schemaOf(d.Body)}}}
		}
		resp := d.Resp
		if resp == nil {
			resp = "$Ok"
		}
		ct := d.RespCT
		if ct == "" {
			ct = "application/json"
		}
		responses := js{"200": js{"description": "成功", "content": js{ct: js{"schema": schemaOf(resp)}}}}
		if scope != scopePublic {
			responses["401"] = js{"$ref": "#/components/responses/Unauthorized"}
			responses["403"] = js{"$ref": "#/components/responses/Forbidden"}
			responses["429"] = js{"$ref": "#/components/responses/RateLimited"}
		}
		if d.Body != nil || len(d.Query) > 0 || strings.Contains(path, "{") {
			responses["400"] = js{"$ref": "#/components/responses/BadRequest"}
		}
		op["responses"] = responses
		if paths[path] == nil {
			paths[path] = js{}
		}
		paths[path][method] = op
	}
	errResp := func(desc string) js {
		return js{"description": desc, "content": js{"application/json": js{"schema": ref("Error")}}}
	}
	rl := errResp("超出该密钥的速率限制")
	rl["headers"] = js{"Retry-After": js{"description": "需要等待的秒数", "schema": js{"type": "integer"}}}
	return map[string]any{
		"openapi": "3.1.0",
		"info": js{
			"title":       "sbpanel API",
			"version":     "1",
			"description": "sing-box 代理面板的 HTTP API。用 `Authorization: Bearer sbp_…`（设置 → API 与智能体 创建）调用；每个接口所需权限见 `x-required-scope`。AI 智能体可改用 MCP 端点 `POST /mcp`。",
		},
		"servers":  []js{{"url": "/", "description": "当前面板"}},
		"security": []js{{"bearerAuth": []string{}}, {"cookieAuth": []string{}}},
		"tags":     oaTags,
		"paths":    paths,
		"components": js{
			"securitySchemes": js{
				"bearerAuth": js{"type": "http", "scheme": "bearer", "bearerFormat": "sbp_<48 hex>", "description": "API 密钥"},
				"cookieAuth": js{"type": "apiKey", "in": "cookie", "name": sessionCookie, "description": "面板登录会话"},
			},
			"schemas": oaSchemas,
			"responses": js{
				"BadRequest":   errResp("参数错误"),
				"Unauthorized": errResp("未认证、密钥无效或已过期"),
				"Forbidden":    errResp("权限不足或来源 IP 不在允许列表"),
				"RateLimited":  rl,
			},
		},
		"x-scopes": scopeInfo(),
	}
}

func operationID(method, path string) string {
	parts := []string{method}
	for _, seg := range strings.Split(strings.TrimPrefix(path, "/api/"), "/") {
		seg = strings.NewReplacer("{", "by_", "}", "", "-", "_", ".", "_").Replace(seg)
		parts = append(parts, seg)
	}
	return strings.Join(parts, "_")
}

func (m *Master) apiOpenAPI(w http.ResponseWriter, r *http.Request) {
	openAPIOnce.Do(func() { openAPIJSON, _ = json.Marshal(buildOpenAPI()) })
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(openAPIJSON)
}

// openAPIPaths lists "METHOD /path" for every operation in the spec (tests).
func openAPIPaths(spec map[string]any) []string {
	out := []string{}
	for p, ops := range spec["paths"].(map[string]js) {
		for meth := range ops {
			out = append(out, strings.ToUpper(meth)+" "+p)
		}
	}
	sort.Strings(out)
	return out
}
