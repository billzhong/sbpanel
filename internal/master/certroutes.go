package master

import "net/http"

// certRoutes registers domain, certificate, DNS and connectivity-probe routes.
// Scopes: reads are ScopeRead; changes are ScopeNodesWrite (they alter what nodes
// serve), key download and DNS-token management are ScopeAdmin.
func (m *Master) certRoutes(mux *scopedMux, a func(http.HandlerFunc) http.HandlerFunc) {
	mux.HandleFunc("GET /api/certs", a(m.apiCerts))
	mux.HandleFunc("GET /api/certs/match", a(m.apiCertMatch))
	mux.HandleFunc("GET /api/certs/certbot", a(m.apiCertbotNames))
	mux.HandleFunc("POST /api/certs/upload", a(m.apiUploadCert))
	mux.HandleFunc("POST /api/certs/acme", a(m.apiIssueCert))
	mux.HandleFunc("POST /api/certs/node", a(m.apiNodeCert))
	mux.HandleFunc("GET /api/certs/{id}", a(m.apiCert))
	mux.HandleFunc("PATCH /api/certs/{id}", a(m.apiUpdateCert))
	mux.HandleFunc("DELETE /api/certs/{id}", a(m.apiDeleteCert))
	mux.HandleFunc("POST /api/certs/{id}/renew", a(m.apiRenewCert))
	mux.HandleFunc("GET /api/certs/{id}/download", a(m.apiDownloadCert))
	mux.HandleFunc("POST /api/certs/{id}/key", a(m.apiDownloadKey))

	mux.HandleFunc("GET /api/dns/providers", a(m.apiProviders))
	mux.HandleFunc("POST /api/dns/providers", a(m.apiCreateProvider))
	mux.HandleFunc("PATCH /api/dns/providers/{id}", a(m.apiUpdateProvider))
	mux.HandleFunc("POST /api/dns/providers/{id}/verify", a(m.apiVerifyProvider))
	mux.HandleFunc("DELETE /api/dns/providers/{id}", a(m.apiDeleteProvider))
	mux.HandleFunc("GET /api/dns/records", a(m.apiDNSRecords))
	mux.HandleFunc("POST /api/dns/plan", a(m.apiDNSPlan))
	mux.HandleFunc("POST /api/dns/apply", a(m.apiDNSApply))

	mux.HandleFunc("GET /api/domains", a(m.apiDomains))
	mux.HandleFunc("POST /api/domains", a(m.apiCreateDomain))
	mux.HandleFunc("PATCH /api/domains/{id}", a(m.apiUpdateDomain))
	mux.HandleFunc("DELETE /api/domains/{id}", a(m.apiDeleteDomain))

	mux.HandleFunc("POST /api/probe", a(m.apiProbe))
	mux.HandleFunc("GET /api/probe/results", a(m.apiProbeResults))
	mux.HandleFunc("GET /api/probe/settings", a(m.apiProbeSettings))
	mux.HandleFunc("PUT /api/probe/settings", a(m.apiProbeSettings))
}

// The scope and OpenAPI tables are merged in here so this feature stays in its
// own files (api_scopes.go / openapi.go hold the rest).
func init() {
	scopes := map[string]string{
		"GET /api/certs": ScopeRead, "GET /api/certs/match": ScopeRead, "GET /api/certs/certbot": ScopeRead,
		"POST /api/certs/upload": ScopeNodesWrite, "POST /api/certs/acme": ScopeNodesWrite, "POST /api/certs/node": ScopeNodesWrite,
		"GET /api/certs/{id}": ScopeRead, "PATCH /api/certs/{id}": ScopeNodesWrite, "DELETE /api/certs/{id}": ScopeNodesWrite,
		"POST /api/certs/{id}/renew":   ScopeNodesWrite,
		"GET /api/certs/{id}/download": ScopeRead,  // the public chain
		"POST /api/certs/{id}/key":     ScopeAdmin, // the private key
		"GET /api/dns/providers":       ScopeRead, "POST /api/dns/providers": ScopeAdmin,
		"PATCH /api/dns/providers/{id}": ScopeAdmin, "POST /api/dns/providers/{id}/verify": ScopeNodesWrite,
		"DELETE /api/dns/providers/{id}": ScopeAdmin,
		"GET /api/dns/records":           ScopeRead, "POST /api/dns/plan": ScopeRead, "POST /api/dns/apply": ScopeNodesWrite,
		"GET /api/domains": ScopeRead, "POST /api/domains": ScopeNodesWrite, "PATCH /api/domains/{id}": ScopeNodesWrite,
		"DELETE /api/domains/{id}": ScopeNodesWrite,
		"POST /api/probe":          ScopeNodesWrite, "GET /api/probe/results": ScopeRead,
		"GET /api/probe/settings": ScopeRead, "PUT /api/probe/settings": ScopeSettingsWrite,
	}
	for k, v := range scopes {
		routeScopes[k] = v
	}
	cert := tObj(js{"id": tStr(""), "name": tStr(""), "source": tEnum("", certACME, certUpload, certNode), "sans": arr(tStr("")),
		"issuer": tStr(""), "not_before": tTS(""), "not_after": tTS(""), "fingerprint": tStr("SHA-256"), "auto_renew": tBool(""),
		"status": tEnum("", "ok", "expiring", "expired", "pending", "error", "renewing"), "days_left": tInt(""), "last_error": tStr(""),
		"uses": arr(tObj(js{"id": tInt("入站 ID"), "tag": tStr(""), "node": tStr("")}))})
	pemBody := tObj(js{"name": tStr(""), "cert_pem": tStr("完整证书链 PEM"), "key_pem": tStr("私钥 PEM"), "dry_run": tBool("只校验并预览")}, "cert_pem", "key_pem")
	dnsChange := tObj(js{"domain_id": tInt(""), "type": tEnum("", "A", "AAAA"), "content": tStr("IP"), "proxied": tBool("Cloudflare 代理（橙色云朵）"),
		"record_id": tStr("apply：plan 返回的 record_id（空 = 新建）")}, "domain_id", "type", "content")
	probeRes := tObj(js{"inbound_id": tInt(""), "endpoint": tStr(""), "ok": tBool(""), "stage": tStr("失败的阶段"), "error": tStr("中文解释"),
		"stages": arr(tObj(js{"name": tStr(""), "ok": tBool(""), "ms": tInt(""), "detail": tStr("")})), "total_ms": tInt("")})
	docs := map[string]opDoc{
		"GET /api/certs":                      {Tag: "certs", Summary: "证书列表（含使用的入站）", Resp: arr(cert)},
		"GET /api/certs/match":                {Tag: "certs", Summary: "找覆盖某个 SNI 的面板证书", Query: []oaParam{qp("host", "SNI", tStr("")), qp("node", "节点 ID", tStr(""))}, Resp: tObj(js{"id": tStr("空 = 没有")})},
		"GET /api/certs/certbot":              {Tag: "certs", Summary: "节点上报的 certbot 证书名", Query: []oaParam{qp("node", "节点 ID", tStr(""))}, Resp: tObj(js{"names": arr(tStr(""))})},
		"POST /api/certs/upload":              {Tag: "certs", Summary: "上传 PEM 证书（校验私钥匹配与有效期）", Body: pemBody, Resp: tObj(js{"id": tStr(""), "sans": arr(tStr("")), "not_after": tTS("")})},
		"POST /api/certs/acme":                {Tag: "certs", Summary: "通过 ACME DNS-01（Cloudflare）签发证书", Body: tObj(js{"name": tStr(""), "provider_id": tInt(""), "domains": arr(tStr("支持 *.example.com")), "ca": tEnum("", "letsencrypt", "zerossl"), "staging": tBool("测试环境"), "email": tStr("")}, "provider_id", "domains"), Resp: tObj(js{"id": tStr("")})},
		"POST /api/certs/node":                {Tag: "certs", Summary: "引用节点本地证书文件（certbot）", Body: tObj(js{"name": tStr(""), "node_id": tStr(""), "cert_path": tStr(""), "key_path": tStr(""), "certbot": tStr("certbot 证书名，自动填路径")}, "node_id"), Resp: tObj(js{"id": tStr("")})},
		"GET /api/certs/{id}":                 {Tag: "certs", Summary: "证书详情", Resp: cert},
		"PATCH /api/certs/{id}":               {Tag: "certs", Summary: "改名、自动续期开关、替换 PEM 或节点路径", Body: tObj(js{"name": tStr(""), "auto_renew": tBool(""), "cert_pem": tStr(""), "key_pem": tStr(""), "cert_path": tStr(""), "key_path": tStr("")})},
		"DELETE /api/certs/{id}":              {Tag: "certs", Summary: "删除证书（仍被入站使用时返回 409）"},
		"POST /api/certs/{id}/renew":          {Tag: "certs", Summary: "立即续期（ACME 后台执行）", Resp: tObj(js{"started": tBool("")})},
		"GET /api/certs/{id}/download":        {Tag: "certs", Summary: "下载证书链（fullchain.pem）", Resp: tStr("PEM"), RespCT: "application/x-pem-file"},
		"POST /api/certs/{id}/key":            {Tag: "certs", Summary: "下载私钥（记入审计日志）", Resp: tStr("PEM"), RespCT: "application/x-pem-file"},
		"GET /api/dns/providers":              {Tag: "certs", Summary: "DNS 服务商（令牌永不返回，只有 token_set）", Resp: arr(tObj(js{"id": tInt(""), "kind": tStr(""), "name": tStr(""), "token_set": tBool(""), "zones": arr(tObj(js{"id": tStr(""), "name": tStr("")}))}))},
		"POST /api/dns/providers":             {Tag: "certs", Summary: "连接 Cloudflare（验证令牌并列出区域）", Body: tObj(js{"kind": tEnum("", "cloudflare"), "name": tStr(""), "token": tStr("API 令牌：Zone:Read + DNS:Edit")}, "token"), Resp: tObj(js{"id": tInt(""), "zones": arr(tObj(js{"id": tStr(""), "name": tStr("")}))})},
		"PATCH /api/dns/providers/{id}":       {Tag: "certs", Summary: "改名或更换令牌", Body: tObj(js{"name": tStr(""), "token": tStr("")})},
		"POST /api/dns/providers/{id}/verify": {Tag: "certs", Summary: "重新验证令牌并刷新区域", Resp: tObj(js{"zones": arr(tObj(js{"id": tStr(""), "name": tStr("")}))})},
		"DELETE /api/dns/providers/{id}":      {Tag: "certs", Summary: "删除 DNS 服务商"},
		"GET /api/dns/records":                {Tag: "certs", Summary: "只读：列出域名现有的 DNS 记录", Query: []oaParam{qp("domain_id", "", tInt(""))}, Resp: arr(tObj(js{"id": tStr(""), "type": tStr(""), "name": tStr(""), "content": tStr(""), "proxied": tBool("")}))},
		"POST /api/dns/plan":                  {Tag: "certs", Summary: "预览一条 A/AAAA 记录的改动（不修改任何东西）", Body: dnsChange, Resp: tObj(js{"action": tEnum("", "create", "update", "noop", "conflict"), "record_id": tStr(""), "before": tMap(""), "after": tMap(""), "existing": arr(tMap("")), "warning": tStr("")})},
		"POST /api/dns/apply":                 {Tag: "certs", Summary: "执行预览过的改动（最多改一条记录）", Body: dnsChange, Resp: tObj(js{"action": tStr(""), "record": tMap("")})},
		"GET /api/domains":                    {Tag: "certs", Summary: "域名列表", Resp: arr(tObj(js{"id": tInt(""), "fqdn": tStr(""), "zone": tStr(""), "node_id": tStr(""), "node_ip": tStr("建议的记录值"), "record_content": tStr(""), "proxied": tBool("")}))},
		"POST /api/domains":                   {Tag: "certs", Summary: "添加域名", Body: tObj(js{"fqdn": tStr(""), "provider_id": tInt(""), "node_id": tStr(""), "proxied": tBool("")}, "fqdn"), Resp: tObj(js{"id": tInt("")})},
		"PATCH /api/domains/{id}":             {Tag: "certs", Summary: "改节点或代理开关（不改 DNS）", Body: tObj(js{"node_id": tStr(""), "proxied": tBool("")})},
		"DELETE /api/domains/{id}":            {Tag: "certs", Summary: "从面板移除域名（DNS 记录保留）"},
		"POST /api/probe":                     {Tag: "probe", Summary: "从面板测试入站连通性（DNS → TCP/QUIC → TLS → 代理请求）", Body: tObj(js{"inbound_id": tInt(""), "node_id": tStr(""), "all": tBool("")}), Resp: arr(probeRes)},
		"GET /api/probe/results":              {Tag: "probe", Summary: "最近一次的测试结果", Resp: arr(probeRes)},
		"GET /api/probe/settings":             {Tag: "probe", Summary: "探测地址与定时检查", Resp: tObj(js{"url": tStr(""), "fallback_url": tStr(""), "interval": tInt("分钟，0 = 关闭")})},
		"PUT /api/probe/settings":             {Tag: "probe", Summary: "修改探测地址与定时检查", Body: tObj(js{"url": tStr(""), "fallback_url": tStr(""), "interval": tInt("")}), Resp: tObj(js{"url": tStr(""), "fallback_url": tStr(""), "interval": tInt("")})},
	}
	for k, v := range docs {
		apiDocs[k] = v
	}
	oaTags = append(oaTags, js{"name": "certs", "description": "域名、DNS 与证书"}, js{"name": "probe", "description": "入站连通性测试"})
}
