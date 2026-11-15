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
		"uses": arr(tObj(js{"id": tInt("Inbound ID"), "tag": tStr(""), "node": tStr("")}))})
	pemBody := tObj(js{"name": tStr(""), "cert_pem": tStr("Full certificate chain PEM"), "key_pem": tStr("Private key PEM"), "dry_run": tBool("Validate and preview only")}, "cert_pem", "key_pem")
	dnsChange := tObj(js{"domain_id": tInt(""), "type": tEnum("", "A", "AAAA"), "content": tStr("IP"), "proxied": tBool("Cloudflare proxy (orange cloud)"),
		"record_id": tStr("apply: the record_id returned by plan (empty = create)")}, "domain_id", "type", "content")
	probeRes := tObj(js{"inbound_id": tInt(""), "endpoint": tStr(""), "ok": tBool(""), "stage": tStr("Stage that failed"), "error": tStr("Plain-language explanation (in the request language)"),
		"stages": arr(tObj(js{"name": tStr(""), "ok": tBool(""), "ms": tInt(""), "detail": tStr("")})), "total_ms": tInt("")})
	docs := map[string]opDoc{
		"GET /api/certs":                      {Tag: "certs", Summary: "List certificates (with the inbounds using them)", Resp: arr(cert)},
		"GET /api/certs/match":                {Tag: "certs", Summary: "Find the panel certificate covering an SNI", Query: []oaParam{qp("host", "SNI", tStr("")), qp("node", "Node ID", tStr(""))}, Resp: tObj(js{"id": tStr("Empty = none")})},
		"GET /api/certs/certbot":              {Tag: "certs", Summary: "certbot certificate names reported by a node", Query: []oaParam{qp("node", "Node ID", tStr(""))}, Resp: tObj(js{"names": arr(tStr(""))})},
		"POST /api/certs/upload":              {Tag: "certs", Summary: "Upload a PEM certificate (checks the key matches and the validity period)", Body: pemBody, Resp: tObj(js{"id": tStr(""), "sans": arr(tStr("")), "not_after": tTS("")})},
		"POST /api/certs/acme":                {Tag: "certs", Summary: "Issue a certificate via ACME DNS-01 (Cloudflare)", Body: tObj(js{"name": tStr(""), "provider_id": tInt(""), "domains": arr(tStr("*.example.com is supported")), "ca": tEnum("", "letsencrypt", "zerossl"), "staging": tBool("Staging environment"), "email": tStr("")}, "provider_id", "domains"), Resp: tObj(js{"id": tStr("")})},
		"POST /api/certs/node":                {Tag: "certs", Summary: "Use certificate files on a node (certbot)", Body: tObj(js{"name": tStr(""), "node_id": tStr(""), "cert_path": tStr(""), "key_path": tStr(""), "certbot": tStr("certbot certificate name; fills in the paths")}, "node_id"), Resp: tObj(js{"id": tStr("")})},
		"GET /api/certs/{id}":                 {Tag: "certs", Summary: "Certificate details", Resp: cert},
		"PATCH /api/certs/{id}":               {Tag: "certs", Summary: "Rename, toggle auto-renew, replace the PEM or the node paths", Body: tObj(js{"name": tStr(""), "auto_renew": tBool(""), "cert_pem": tStr(""), "key_pem": tStr(""), "cert_path": tStr(""), "key_path": tStr("")})},
		"DELETE /api/certs/{id}":              {Tag: "certs", Summary: "Delete a certificate (409 while inbounds still use it)"},
		"POST /api/certs/{id}/renew":          {Tag: "certs", Summary: "Renew now (ACME runs in the background)", Resp: tObj(js{"started": tBool("")})},
		"GET /api/certs/{id}/download":        {Tag: "certs", Summary: "Download the certificate chain (fullchain.pem)", Resp: tStr("PEM"), RespCT: "application/x-pem-file"},
		"POST /api/certs/{id}/key":            {Tag: "certs", Summary: "Download the private key (recorded in the audit log)", Resp: tStr("PEM"), RespCT: "application/x-pem-file"},
		"GET /api/dns/providers":              {Tag: "certs", Summary: "DNS providers (tokens are never returned, only token_set)", Resp: arr(tObj(js{"id": tInt(""), "kind": tStr(""), "name": tStr(""), "token_set": tBool(""), "zones": arr(tObj(js{"id": tStr(""), "name": tStr("")}))}))},
		"POST /api/dns/providers":             {Tag: "certs", Summary: "Connect Cloudflare (verifies the token and lists zones)", Body: tObj(js{"kind": tEnum("", "cloudflare"), "name": tStr(""), "token": tStr("API token: Zone:Read + DNS:Edit")}, "token"), Resp: tObj(js{"id": tInt(""), "zones": arr(tObj(js{"id": tStr(""), "name": tStr("")}))})},
		"PATCH /api/dns/providers/{id}":       {Tag: "certs", Summary: "Rename or replace the token", Body: tObj(js{"name": tStr(""), "token": tStr("")})},
		"POST /api/dns/providers/{id}/verify": {Tag: "certs", Summary: "Re-verify the token and refresh zones", Resp: tObj(js{"zones": arr(tObj(js{"id": tStr(""), "name": tStr("")}))})},
		"DELETE /api/dns/providers/{id}":      {Tag: "certs", Summary: "Delete a DNS provider"},
		"GET /api/dns/records":                {Tag: "certs", Summary: "Read-only: list a domain's existing DNS records", Query: []oaParam{qp("domain_id", "", tInt(""))}, Resp: arr(tObj(js{"id": tStr(""), "type": tStr(""), "name": tStr(""), "content": tStr(""), "proxied": tBool("")}))},
		"POST /api/dns/plan":                  {Tag: "certs", Summary: "Preview a change to one A/AAAA record (changes nothing)", Body: dnsChange, Resp: tObj(js{"action": tEnum("", "create", "update", "noop", "conflict"), "record_id": tStr(""), "before": tMap(""), "after": tMap(""), "existing": arr(tMap("")), "warning": tStr("")})},
		"POST /api/dns/apply":                 {Tag: "certs", Summary: "Apply a previewed change (touches at most one record)", Body: dnsChange, Resp: tObj(js{"action": tStr(""), "record": tMap("")})},
		"GET /api/domains":                    {Tag: "certs", Summary: "List domains", Resp: arr(tObj(js{"id": tInt(""), "fqdn": tStr(""), "zone": tStr(""), "node_id": tStr(""), "node_ip": tStr("Suggested record value"), "record_content": tStr(""), "proxied": tBool("")}))},
		"POST /api/domains":                   {Tag: "certs", Summary: "Add a domain", Body: tObj(js{"fqdn": tStr(""), "provider_id": tInt(""), "node_id": tStr(""), "proxied": tBool("")}, "fqdn"), Resp: tObj(js{"id": tInt("")})},
		"PATCH /api/domains/{id}":             {Tag: "certs", Summary: "Change the node or proxy toggle (DNS untouched)", Body: tObj(js{"node_id": tStr(""), "proxied": tBool("")})},
		"DELETE /api/domains/{id}":            {Tag: "certs", Summary: "Remove a domain from the panel (DNS records are kept)"},
		"POST /api/probe":                     {Tag: "probe", Summary: "Test inbound connectivity from the panel (DNS → TCP/QUIC → TLS → proxied request)", Body: tObj(js{"inbound_id": tInt(""), "node_id": tStr(""), "all": tBool("")}), Resp: arr(probeRes)},
		"GET /api/probe/results":              {Tag: "probe", Summary: "Latest test results", Resp: arr(probeRes)},
		"GET /api/probe/settings":             {Tag: "probe", Summary: "Probe URL and scheduled checks", Resp: tObj(js{"url": tStr(""), "fallback_url": tStr(""), "interval": tInt("Minutes; 0 = off")})},
		"PUT /api/probe/settings":             {Tag: "probe", Summary: "Update the probe URL and scheduled checks", Body: tObj(js{"url": tStr(""), "fallback_url": tStr(""), "interval": tInt("")}), Resp: tObj(js{"url": tStr(""), "fallback_url": tStr(""), "interval": tInt("")})},
	}
	for k, v := range docs {
		apiDocs[k] = v
	}
	oaTags = append(oaTags, js{"name": "certs", "description": "Domains, DNS and certificates"}, js{"name": "probe", "description": "Inbound connectivity tests"})
}
