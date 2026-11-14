package master

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

type rpcOut struct {
	ID     any             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

func rpc(t *testing.T, h http.Handler, tok string, id any, method string, params any, opts ...reqOpt) (int, rpcOut) {
	t.Helper()
	msg := map[string]any{"jsonrpc": "2.0", "method": method}
	if id != nil {
		msg["id"] = id
	}
	if params != nil {
		msg["params"] = params
	}
	w := call(h, "POST", "/mcp", msg, append([]reqOpt{bearer(tok), hdr("Accept", "application/json, text/event-stream")}, opts...)...)
	var out rpcOut
	if w.Code == 200 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("bad json-rpc body: %s", w.Body)
		}
	}
	return w.Code, out
}

type toolOut struct {
	Content []struct {
		Type, Text string
	} `json:"content"`
	Structured map[string]any `json:"structuredContent"`
	IsError    bool           `json:"isError"`
}

func callTool(t *testing.T, h http.Handler, tok, name string, args map[string]any) toolOut {
	t.Helper()
	code, out := rpc(t, h, tok, 7, "tools/call", map[string]any{"name": name, "arguments": args})
	if code != 200 || out.Error != nil {
		t.Fatalf("tools/call %s: %d %+v", name, code, out.Error)
	}
	var r toolOut
	json.Unmarshal(out.Result, &r)
	if len(r.Content) == 0 || r.Content[0].Type != "text" {
		t.Fatalf("tool %s: no text content", name)
	}
	return r
}

func TestMCP(t *testing.T) {
	m := newTestMaster(t)
	h := m.routes()
	reader, _ := mkKey(t, m, h, map[string]any{"name": "claude-ro", "scopes": []string{"read"}})
	agent, _ := mkKey(t, m, h, map[string]any{"name": "claude", "scopes": []string{"read", "users:write"}})

	// initialize negotiates the protocol version
	code, out := rpc(t, h, reader, 1, "initialize", map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "test", "version": "1"}})
	if code != 200 || out.Error != nil {
		t.Fatalf("initialize %d %+v", code, out.Error)
	}
	var init struct {
		ProtocolVersion string         `json:"protocolVersion"`
		Capabilities    map[string]any `json:"capabilities"`
		ServerInfo      map[string]any `json:"serverInfo"`
	}
	json.Unmarshal(out.Result, &init)
	if init.ProtocolVersion != "2025-03-26" || init.Capabilities["tools"] == nil || init.ServerInfo["name"] != "sbpanel" || out.ID != float64(1) {
		t.Fatalf("initialize result %s", out.Result)
	}
	if _, o := rpc(t, h, reader, 2, "initialize", map[string]any{"protocolVersion": "1999-01-01"}); !strings.Contains(string(o.Result), mcpVersions[0]) {
		t.Fatal("unknown version should fall back to latest")
	}
	// notifications get 202 and no body
	if code, _ := rpc(t, h, reader, nil, "notifications/initialized", nil); code != 202 {
		t.Fatalf("notification %d", code)
	}
	if _, o := rpc(t, h, reader, 3, "nope/nope", nil); o.Error == nil || o.Error.Code != rpcMethodNotFound {
		t.Fatalf("unknown method: %+v", o.Error)
	}
	if _, o := rpc(t, h, reader, 4, "ping", nil); o.Error != nil || string(o.Result) != "{}" {
		t.Fatalf("ping %s", o.Result)
	}
	// parse error
	if w := call(h, "POST", "/mcp", nil, bearer(reader), func(r *http.Request) {}); w.Code != 200 || !strings.Contains(w.Body.String(), "-32700") {
		t.Fatalf("parse error: %d %s", w.Code, w.Body)
	}

	// tools/list shows only what the key may call
	list := func(tok string) []string {
		_, o := rpc(t, h, tok, 5, "tools/list", map[string]any{})
		var r struct {
			Tools []struct {
				Name        string         `json:"name"`
				Description string         `json:"description"`
				InputSchema map[string]any `json:"inputSchema"`
			} `json:"tools"`
		}
		json.Unmarshal(o.Result, &r)
		names := []string{}
		for _, tl := range r.Tools {
			if tl.InputSchema["type"] != "object" || tl.Description == "" {
				t.Errorf("tool %s: bad schema/description", tl.Name)
			}
			names = append(names, tl.Name)
		}
		return names
	}
	ro, rw := list(reader), list(agent)
	if len(ro) != 8 || len(rw) != len(mcpTools) || strings.Contains(strings.Join(ro, ","), "create_user") {
		t.Fatalf("tools: ro=%v rw=%v", ro, rw)
	}

	// write tool with scope: creates the user, audited as mcp:<key>, returns the subscription URL
	r := callTool(t, h, agent, "create_user", map[string]any{"username": "alice", "traffic_gb": 50, "expire_days": 30, "note": "from claude"})
	if r.IsError {
		t.Fatalf("create_user: %s", r.Content[0].Text)
	}
	sub := r.Structured["subscription"].(map[string]any)
	if !strings.Contains(sub["url"].(string), "/s/") || r.Structured["user"].(map[string]any)["limit_gb"] != float64(50) {
		t.Fatalf("create_user result: %s", r.Content[0].Text)
	}
	var who string
	m.db.QueryRow(`SELECT admin FROM audit_log WHERE action='user.create' ORDER BY id DESC`).Scan(&who)
	if who != "mcp:claude" {
		t.Fatalf("audit actor %q", who)
	}

	// write tool without scope: a tool error, nothing changes
	r = callTool(t, h, reader, "create_user", map[string]any{"username": "mallory"})
	if !r.IsError || !strings.Contains(r.Content[0].Text, "users:write") {
		t.Fatalf("read key created a user: %+v", r)
	}
	var n int
	m.db.QueryRow(`SELECT COUNT(*) FROM users WHERE username='mallory'`).Scan(&n)
	if n != 0 {
		t.Fatal("user created without scope")
	}

	// read tools
	r = callTool(t, h, reader, "list_users", map[string]any{"search": "ali"})
	if r.IsError || r.Structured["total"] != float64(1) {
		t.Fatalf("list_users: %s", r.Content[0].Text)
	}
	r = callTool(t, h, reader, "get_user", map[string]any{"username": "alice"})
	if r.IsError || r.Structured["user"].(map[string]any)["username"] != "alice" {
		t.Fatalf("get_user: %s", r.Content[0].Text)
	}
	for _, name := range []string{"list_nodes", "list_inbounds", "list_events", "get_live_connections", "top_domains"} {
		if r := callTool(t, h, reader, name, map[string]any{}); r.IsError {
			t.Errorf("%s: %s", name, r.Content[0].Text)
		}
	}
	if r := callTool(t, h, reader, "traffic_summary", map[string]any{"range": "7d", "group_by": "node"}); r.IsError || r.Structured["group_by"] != "node" {
		t.Fatalf("traffic_summary: %s", r.Content[0].Text)
	}

	// more writes
	if r := callTool(t, h, agent, "extend_user", map[string]any{"username": "alice", "days": 10}); r.IsError {
		t.Fatal(r.Content[0].Text)
	}
	var exp, limit int64
	var enabled bool
	m.db.QueryRow(`SELECT expire_at, traffic_limit FROM users WHERE username='alice'`).Scan(&exp, &limit)
	if exp < now()+39*86400 {
		t.Fatalf("extend: expire_at %d", exp-now())
	}
	callTool(t, h, agent, "add_traffic", map[string]any{"username": "alice", "gb": 10})
	m.db.QueryRow(`SELECT traffic_limit FROM users WHERE username='alice'`).Scan(&limit)
	if limit != 60*gb {
		t.Fatalf("add_traffic: %d", limit)
	}
	callTool(t, h, agent, "set_user_enabled", map[string]any{"username": "alice", "enabled": false})
	m.db.QueryRow(`SELECT enabled FROM users WHERE username='alice'`).Scan(&enabled)
	if enabled {
		t.Fatal("set_user_enabled")
	}
	callTool(t, h, agent, "update_user", map[string]any{"username": "alice", "note": "vip", "expire_at": "2030-01-01"})
	if r := callTool(t, h, agent, "reset_usage", map[string]any{"username": "alice"}); r.IsError {
		t.Fatal(r.Content[0].Text)
	}
	if r := callTool(t, h, agent, "kick_user", map[string]any{"username": "alice"}); r.IsError {
		t.Fatal(r.Content[0].Text)
	}
	m.db.QueryRow(`SELECT admin FROM audit_log WHERE action='user.kick' ORDER BY id DESC`).Scan(&who)
	if who != "mcp:claude" {
		t.Fatalf("kick audit %q", who)
	}

	// invalid arguments are protocol errors
	if _, o := rpc(t, h, agent, 8, "tools/call", map[string]any{"name": "extend_user", "arguments": map[string]any{"username": "alice"}}); o.Error == nil || o.Error.Code != rpcInvalidParams {
		t.Fatalf("missing required arg: %+v", o)
	}
	if _, o := rpc(t, h, agent, 9, "tools/call", map[string]any{"name": "no_such_tool"}); o.Error == nil || o.Error.Code != rpcInvalidParams {
		t.Fatalf("unknown tool: %+v", o)
	}
	if r := callTool(t, h, agent, "get_user", map[string]any{"username": "nobody"}); !r.IsError {
		t.Fatal("missing user should be a tool error")
	}

	// resources
	if _, o := rpc(t, h, reader, 10, "resources/read", map[string]any{"uri": "sbpanel://overview"}); o.Error != nil || !strings.Contains(string(o.Result), "today_up") {
		t.Fatalf("resource: %s %+v", o.Result, o.Error)
	}

	// batch
	w := call(h, "POST", "/mcp", []map[string]any{{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}}, bearer(reader))
	var batch []rpcOut
	if json.Unmarshal(w.Body.Bytes(), &batch); len(batch) != 1 {
		t.Fatalf("batch: %s", w.Body)
	}
}

func TestMCPAuth(t *testing.T) {
	m := newTestMaster(t)
	h := m.routes()
	init := map[string]any{"protocolVersion": "2025-06-18"}

	if code, _ := rpc(t, h, "", 1, "initialize", init); code != 401 {
		t.Fatalf("no key: %d", code)
	}
	// session cookies are not accepted on /mcp
	if w := call(h, "POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"}, sessionOpt(m)); w.Code != 401 {
		t.Fatalf("session on /mcp: %d", w.Code)
	}
	tok, k := mkKey(t, m, h, map[string]any{"name": "a", "scopes": []string{"read"}})
	if code, _ := rpc(t, h, tok, 1, "initialize", init, hdr("Origin", "https://evil.example")); code != 403 {
		t.Fatalf("cross-origin: %d", code)
	}
	m.db.Exec(`UPDATE api_tokens SET expires_at=? WHERE id=?`, now()-5, k.ID)
	if code, _ := rpc(t, h, tok, 1, "initialize", init); code != 401 {
		t.Fatalf("expired key: %d", code)
	}

	ipk, _ := mkKey(t, m, h, map[string]any{"name": "b", "scopes": []string{"read"}, "allow_ips": []string{"10.0.0.1"}})
	if code, _ := rpc(t, h, ipk, 1, "initialize", init); code != 403 {
		t.Fatalf("disallowed ip: %d", code)
	}
	if code, _ := rpc(t, h, ipk, 1, "initialize", init, from("10.0.0.1:999")); code != 200 {
		t.Fatalf("allowed ip: %d", code)
	}

	rl, _ := mkKey(t, m, h, map[string]any{"name": "c", "scopes": []string{"read"}, "rate_limit": 60, "rate_burst": 3})
	for i := 0; i < 3; i++ {
		if code, _ := rpc(t, h, rl, i, "ping", nil); code != 200 {
			t.Fatalf("call %d: %d", i, code)
		}
	}
	w := call(h, "POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 9, "method": "ping"}, bearer(rl))
	if w.Code != 429 || w.Header().Get("Retry-After") != "1" {
		t.Fatalf("rate limit: %d %q", w.Code, w.Header().Get("Retry-After"))
	}
	if w := call(h, "GET", "/mcp", nil, bearer(ipk), from("10.0.0.1:1")); w.Code != 405 {
		t.Fatalf("GET /mcp: %d", w.Code)
	}
}
