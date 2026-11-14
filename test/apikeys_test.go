package test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// mcpCall posts one JSON-RPC request to /mcp and decodes the result.
func mcpCall(t *testing.T, c *api, id int, method string, params any) (int, map[string]any) {
	t.Helper()
	code, b := c.call("POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	var out map[string]any
	if code == 200 {
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatalf("%s: bad body %s", method, b)
		}
	}
	return code, out
}

func mcpTool(t *testing.T, c *api, name string, args map[string]any) (map[string]any, bool) {
	t.Helper()
	code, out := mcpCall(t, c, 1, "tools/call", map[string]any{"name": name, "arguments": args})
	if code != 200 || out["error"] != nil {
		t.Fatalf("%s: %d %v", name, code, out["error"])
	}
	res := out["result"].(map[string]any)
	sc, _ := res["structuredContent"].(map[string]any)
	return sc, res["isError"] == true
}

func TestAPIKeysAndMCP(t *testing.T) {
	e := newEnv(t)
	key := func(body map[string]any) *api {
		var res struct{ Token string }
		e.api.do("POST", "/api/tokens", body, &res)
		return &api{t: t, base: e.api.base, hc: &http.Client{Timeout: 30 * time.Second}, auth: "Bearer " + res.Token}
	}
	reader := key(map[string]any{"name": "grafana", "scopes": []string{"read"}, "expires_in_days": 30})
	agent := key(map[string]any{"name": "claude", "scopes": []string{"read", "users:write"}, "description": "Claude Code"})

	t.Run("scoped REST", func(t *testing.T) {
		var nodes []struct{ ID string }
		reader.do("GET", "/api/nodes", nil, &nodes)
		if len(nodes) != 1 {
			t.Fatalf("nodes %v", nodes)
		}
		reader.expect(403, "POST", "/api/users", map[string]any{"username": "nope"})
		reader.expect(403, "GET", "/api/tokens", nil)
		agent.expect(403, "PATCH", "/api/nodes/"+e.nodeID, map[string]any{"name": "x"})
		var spec map[string]any
		reader.do("GET", "/api/openapi.json", nil, &spec)
		if spec["openapi"] != "3.1.0" || spec["paths"].(map[string]any)["/api/users/batch"] == nil {
			t.Fatal("openapi spec incomplete")
		}
	})

	t.Run("MCP over HTTP", func(t *testing.T) {
		code, out := mcpCall(t, agent, 1, "initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "e2e", "version": "1"}})
		if code != 200 || out["result"].(map[string]any)["protocolVersion"] != "2025-06-18" {
			t.Fatalf("initialize %d %v", code, out)
		}
		if code, _ := agent.call("POST", "/mcp", map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); code != 202 {
			t.Fatalf("initialized notification: %d", code)
		}
		_, out = mcpCall(t, agent, 2, "tools/list", nil)
		if n := len(out["result"].(map[string]any)["tools"].([]any)); n != 15 {
			t.Fatalf("tools: %d", n)
		}

		e.waitApplied()
		nodes, isErr := mcpTool(t, reader, "list_nodes", nil)
		if isErr || nodes["nodes"].([]any)[0].(map[string]any)["health"] != "ok" {
			t.Fatalf("list_nodes: %v", nodes)
		}

		u, isErr := mcpTool(t, agent, "create_user", map[string]any{"username": "mcp-bob", "traffic_gb": 5, "expire_days": 7, "groups": []any{"默认"}})
		if isErr {
			t.Fatalf("create_user: %v", u)
		}
		subURL := u["subscription"].(map[string]any)["url"].(string)
		resp, err := http.Get(subURL + "?format=base64")
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("subscription %s: %v %v", subURL, err, resp)
		}
		resp.Body.Close()

		if _, isErr := mcpTool(t, reader, "kick_user", map[string]any{"username": "mcp-bob"}); !isErr {
			t.Fatal("read key could kick")
		}
		if r, isErr := mcpTool(t, agent, "extend_user", map[string]any{"username": "mcp-bob", "days": 3}); isErr || !strings.HasPrefix(r["user"].(map[string]any)["expire"].(string), "20") {
			t.Fatalf("extend_user: %v", r)
		}
		var audit []struct{ Admin, Action string }
		e.api.do("GET", "/api/audit", nil, &audit)
		if audit[0].Admin != "mcp:claude" || audit[0].Action != "user.batch.extend_days" {
			t.Fatalf("audit: %+v", audit[0])
		}

		live, isErr := mcpTool(t, reader, "get_live_connections", map[string]any{"node": "local"})
		if isErr || live["nodes"].([]any)[0].(map[string]any)["ready"] != true {
			t.Fatalf("live: %v", live)
		}
		if sum, isErr := mcpTool(t, reader, "traffic_summary", map[string]any{"range": "24h", "group_by": "user"}); isErr || sum["group_by"] != "user" {
			t.Fatalf("traffic_summary: %v", sum)
		}
	})

	t.Run("rate limit and revocation", func(t *testing.T) {
		slow := key(map[string]any{"name": "slow", "scopes": []string{"read"}, "rate_limit": 30, "rate_burst": 1})
		slow.do("GET", "/api/users", nil, nil)
		code, _ := slow.call("GET", "/api/users", nil)
		if code != 429 {
			t.Fatalf("rate limit: %d", code)
		}
		var keys []struct {
			ID   int64
			Name string
		}
		e.api.do("GET", "/api/tokens", nil, &keys)
		for _, k := range keys {
			if k.Name == "grafana" {
				e.api.do("DELETE", "/api/tokens/"+itoa(k.ID), nil, nil)
			}
		}
		reader.expect(401, "GET", "/api/users", nil)
		if code, _ := mcpCall(t, reader, 1, "ping", nil); code != 401 {
			t.Fatalf("revoked key on /mcp: %d", code)
		}
	})
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }
