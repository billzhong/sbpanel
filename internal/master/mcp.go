package master

// MCP (Model Context Protocol) server over Streamable HTTP, JSON-RPC 2.0, at POST /mcp.
// Stateless: every POST carries one message (or a batch) and gets a JSON response; no SSE stream.
// Auth is the same bearer API key as /api (no session cookie). Each tool needs a scope; tool calls
// are executed by dispatching internal requests through the same scoped mux, so the route scopes
// in routeScopes are enforced a second time and handlers audit the actor as "mcp:<key name>".

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

var mcpVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

const (
	rpcParseError     = -32700
	rpcInvalidRequest = -32600
	rpcMethodNotFound = -32601
	rpcInvalidParams  = -32602
	rpcInternalError  = -32603
)

type rpcMsg struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type rpcResp struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func (m *Master) mcpNoStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Allow", "POST")
	writeErr(w, http.StatusMethodNotAllowed, "this MCP server is stateless: use POST /mcp (no SSE stream, no sessions)")
}

// mcpHandler serves POST /mcp. mux is the scoped mux the tools dispatch through.
func (m *Master) mcpHandler(mux http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// DNS-rebinding / cross-site protection required by the MCP transport spec
		if o := r.Header.Get("Origin"); o != "" {
			if u, err := url.Parse(o); err != nil || u.Host != r.Host {
				writeErr(w, http.StatusForbidden, "forbidden origin")
				return
			}
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			writeRPC(w, rpcResp{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: rpcParseError, Message: "request too large or unreadable"}})
			return
		}
		body = bytes.TrimSpace(body)
		c := &mcpCtx{m: m, mux: mux, r: r, p: principalFrom(r)}
		if len(body) > 0 && body[0] == '[' {
			var msgs []json.RawMessage
			if err := json.Unmarshal(body, &msgs); err != nil || len(msgs) == 0 {
				writeRPC(w, rpcResp{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: rpcParseError, Message: "parse error"}})
				return
			}
			out := []rpcResp{}
			for _, raw := range msgs {
				if resp, ok := c.handle(raw); ok {
					out = append(out, resp)
				}
			}
			if len(out) == 0 {
				w.WriteHeader(http.StatusAccepted)
				return
			}
			writeRPC(w, out)
			return
		}
		resp, ok := c.handle(body)
		if !ok {
			w.WriteHeader(http.StatusAccepted) // notification or client response
			return
		}
		writeRPC(w, resp)
	}
}

func writeRPC(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(v)
}

type mcpCtx struct {
	m   *Master
	mux http.Handler
	r   *http.Request
	p   *principal
}

// handle processes one message; ok=false means no response is due (notification / response).
func (c *mcpCtx) handle(raw json.RawMessage) (rpcResp, bool) {
	var msg rpcMsg
	if err := json.Unmarshal(raw, &msg); err != nil {
		return rpcResp{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: rpcParseError, Message: "parse error"}}, true
	}
	isNotification := len(msg.ID) == 0
	if msg.Method == "" {
		if msg.Result != nil || msg.Error != nil {
			return rpcResp{}, false // a response to a server request; we never send any
		}
		id := msg.ID
		if isNotification {
			id = json.RawMessage("null")
		}
		return rpcResp{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: rpcInvalidRequest, Message: "invalid request: missing method"}}, true
	}
	if msg.JSONRPC != "2.0" {
		if isNotification {
			return rpcResp{}, false
		}
		return rpcResp{JSONRPC: "2.0", ID: msg.ID, Error: &rpcError{Code: rpcInvalidRequest, Message: `invalid request: jsonrpc must be "2.0"`}}, true
	}
	if isNotification {
		return rpcResp{}, false // notifications/initialized, notifications/cancelled, …: nothing to do
	}
	res, rerr := c.dispatch(msg.Method, msg.Params)
	if rerr != nil {
		return rpcResp{JSONRPC: "2.0", ID: msg.ID, Error: rerr}, true
	}
	return rpcResp{JSONRPC: "2.0", ID: msg.ID, Result: res}, true
}

func (c *mcpCtx) dispatch(method string, params json.RawMessage) (any, *rpcError) {
	switch method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(params, &p)
		ver := mcpVersions[0]
		if slices.Contains(mcpVersions, p.ProtocolVersion) {
			ver = p.ProtocolVersion
		}
		return map[string]any{
			"protocolVersion": ver,
			"capabilities": map[string]any{
				"tools":     map[string]any{"listChanged": false},
				"resources": map[string]any{"listChanged": false, "subscribe": false},
			},
			"serverInfo": map[string]any{"name": "sbpanel", "title": "sbpanel 代理面板", "version": Version},
			"instructions": "sbpanel 是 sing-box 代理面板。用 list_users / get_user 查用户，traffic_summary / top_domains 看流量，" +
				"list_nodes 看节点健康；写操作（create_user、extend_user、add_traffic 等）需要 users:write 权限且会记入审计日志。" +
				" sbpanel manages sing-box proxy users and nodes. Sizes are in GB unless a field says bytes; times are unix seconds or ISO 8601.",
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		tools := []map[string]any{}
		for _, t := range mcpTools {
			if c.p.can(t.Scope) {
				tools = append(tools, t.describe())
			}
		}
		return map[string]any{"tools": tools}, nil
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &rpcError{Code: rpcInvalidParams, Message: "invalid params"}
		}
		t := findTool(p.Name)
		if t == nil {
			return nil, &rpcError{Code: rpcInvalidParams, Message: "Unknown tool: " + p.Name}
		}
		if p.Arguments == nil {
			p.Arguments = map[string]any{}
		}
		if err := validateArgs(t.Schema, p.Arguments); err != nil {
			return nil, &rpcError{Code: rpcInvalidParams, Message: "invalid arguments for " + t.Name + ": " + err.Error()}
		}
		if !c.p.can(t.Scope) {
			return toolError(fmt.Sprintf("权限不足：工具 %s 需要 %s 权限 / permission denied: %s requires the %s scope", t.Name, t.Scope, t.Name, t.Scope)), nil
		}
		out, err := t.Run(c, args(p.Arguments))
		if err != nil {
			return toolError(err.Error()), nil
		}
		return toolResult(out), nil
	case "resources/list":
		if !c.p.can(ScopeRead) {
			return map[string]any{"resources": []any{}}, nil
		}
		return map[string]any{"resources": []map[string]any{
			{"uri": "sbpanel://overview", "name": "overview", "title": "面板概览 / Overview", "description": "今日/本月流量、在线用户、节点状态、Top 用户与域名", "mimeType": "application/json"},
			{"uri": "sbpanel://nodes", "name": "nodes", "title": "节点 / Nodes", "description": "所有节点及其健康状态", "mimeType": "application/json"},
			{"uri": "sbpanel://scopes", "name": "scopes", "title": "权限说明 / Scopes", "description": "API 密钥可授予的权限", "mimeType": "application/json"},
		}}, nil
	case "resources/templates/list":
		return map[string]any{"resourceTemplates": []any{}}, nil
	case "resources/read":
		var p struct {
			URI string `json:"uri"`
		}
		json.Unmarshal(params, &p)
		var path string
		switch p.URI {
		case "sbpanel://overview":
			path = "/api/overview"
		case "sbpanel://nodes":
			path = "/api/nodes"
		case "sbpanel://scopes":
			path = "/api/scopes"
		default:
			return nil, &rpcError{Code: -32002, Message: "Resource not found", Data: map[string]string{"uri": p.URI}}
		}
		if !c.p.can(ScopeRead) {
			return nil, &rpcError{Code: rpcInvalidParams, Message: "permission denied: resources require the read scope"}
		}
		code, b, _ := c.call("GET", path, nil)
		if code != 200 {
			return nil, &rpcError{Code: rpcInternalError, Message: apiErrMsg(code, b)}
		}
		return map[string]any{"contents": []map[string]any{{"uri": p.URI, "mimeType": "application/json", "text": string(b)}}}, nil
	}
	return nil, &rpcError{Code: rpcMethodNotFound, Message: "Method not found: " + method}
}

func toolResult(v any) map[string]any {
	b, _ := json.MarshalIndent(v, "", "  ")
	out := map[string]any{"content": []map[string]any{{"type": "text", "text": string(b)}}, "isError": false}
	if _, ok := v.(map[string]any); ok {
		out["structuredContent"] = v
	}
	return out
}

func toolError(msg string) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": msg}}, "isError": true}
}

// ---------- internal dispatch ----------

// call runs an /api request in-process with the caller's principal (actor "mcp:<key>").
func (c *mcpCtx) call(method, path string, body any) (int, []byte, http.Header) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(c.r.Context(), method, path, rd)
	if err != nil {
		return 500, []byte(`{"error":"bad request"}`), nil
	}
	req.Host = c.r.Host
	req.RemoteAddr = c.r.RemoteAddr
	req.TLS = c.r.TLS
	for _, h := range []string{"X-Forwarded-For", "X-Real-IP", "X-Forwarded-Proto", "User-Agent"} {
		if v := c.r.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	who := "mcp:" + c.p.name
	if c.p.session {
		who = c.p.name
	}
	req = withPrincipal(req, c.p, who)
	rec := httptest.NewRecorder()
	c.mux.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes(), rec.Header()
}

func apiErrMsg(code int, b []byte) string {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(b, &e) == nil && e.Error != "" {
		return e.Error
	}
	return fmt.Sprintf("HTTP %d", code)
}

func (c *mcpCtx) get(path string, out any) error {
	code, b, _ := c.call("GET", path, nil)
	if code != 200 {
		return fmt.Errorf("%s", apiErrMsg(code, b))
	}
	return json.Unmarshal(b, out)
}

func (c *mcpCtx) send(method, path string, body any, out any) error {
	code, b, _ := c.call(method, path, body)
	if code != 200 {
		return fmt.Errorf("%s", apiErrMsg(code, b))
	}
	if out != nil {
		return json.Unmarshal(b, out)
	}
	return nil
}

// ---------- arguments ----------

type args map[string]any

func (a args) has(k string) bool { _, ok := a[k]; return ok && a[k] != nil }

func (a args) str(k string) string {
	switch v := a[k].(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

func (a args) num(k string, d float64) float64 {
	switch v := a[k].(type) {
	case float64:
		return v
	case string:
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return d
}

func (a args) int(k string, d int64) int64 { return int64(a.num(k, float64(d))) }

func (a args) boolean(k string) (bool, bool) {
	v, ok := a[k].(bool)
	return v, ok
}

// validateArgs checks required properties, basic JSON types and enums of a flat object schema.
func validateArgs(schema map[string]any, a map[string]any) error {
	props, _ := schema["properties"].(map[string]any)
	if req, ok := schema["required"].([]string); ok {
		for _, k := range req {
			if v, ok := a[k]; !ok || v == nil {
				return fmt.Errorf("missing required argument %q", k)
			}
		}
	}
	for k, v := range a {
		ps, ok := props[k].(map[string]any)
		if !ok {
			if schema["additionalProperties"] == false {
				return fmt.Errorf("unknown argument %q", k)
			}
			continue
		}
		if v == nil {
			continue
		}
		if !typeOK(ps["type"], v) {
			return fmt.Errorf("argument %q has the wrong type (want %v)", k, ps["type"])
		}
		if enum, ok := ps["enum"].([]string); ok {
			if s, isStr := v.(string); isStr && !slices.Contains(enum, s) {
				return fmt.Errorf("argument %q must be one of %s", k, strings.Join(enum, ", "))
			}
		}
		if min, ok := ps["minimum"].(float64); ok {
			if f, isNum := v.(float64); isNum && f < min {
				return fmt.Errorf("argument %q must be ≥ %v", k, min)
			}
		}
		if mx, ok := ps["maximum"].(float64); ok {
			if f, isNum := v.(float64); isNum && f > mx {
				return fmt.Errorf("argument %q must be ≤ %v", k, mx)
			}
		}
	}
	return nil
}

func typeOK(t any, v any) bool {
	switch tt := t.(type) {
	case string:
		switch tt {
		case "string":
			_, ok := v.(string)
			return ok
		case "integer":
			f, ok := v.(float64)
			return ok && f == float64(int64(f))
		case "number":
			_, ok := v.(float64)
			return ok
		case "boolean":
			_, ok := v.(bool)
			return ok
		case "array":
			_, ok := v.([]any)
			return ok
		case "object":
			_, ok := v.(map[string]any)
			return ok
		}
		return true
	case []string:
		for _, x := range tt {
			if typeOK(x, v) {
				return true
			}
		}
		return false
	}
	return true
}

// ---------- shared helpers ----------

const gb = 1 << 30

func gbOf(n int64) float64 { return float64(int64(float64(n)/gb*100)) / 100 }

func isoTime(ts int64) string {
	if ts <= 0 {
		return ""
	}
	return time.Unix(ts, 0).UTC().Format(time.RFC3339)
}

// parseTime accepts unix seconds, RFC 3339 or YYYY-MM-DD (panel time zone).
func (m *Master) parseTime(v any) (int64, error) {
	switch x := v.(type) {
	case float64:
		return int64(x), nil
	case string:
		x = strings.TrimSpace(x)
		if n, err := strconv.ParseInt(x, 10, 64); err == nil {
			return n, nil
		}
		if t, err := time.Parse(time.RFC3339, x); err == nil {
			return t.Unix(), nil
		}
		if t, err := time.ParseInLocation("2006-01-02", x, m.loc); err == nil {
			return t.Add(24*time.Hour - time.Second).Unix(), nil // end of that day
		}
		if t, err := time.ParseInLocation("2006-01-02 15:04", x, m.loc); err == nil {
			return t.Unix(), nil
		}
	}
	return 0, fmt.Errorf("无法解析时间 %v（用 unix 秒、RFC 3339 或 YYYY-MM-DD）", v)
}

// resolveUser finds a user by "id" or "username".
func (c *mcpCtx) resolveUser(a args) (int64, string, error) {
	var id int64
	var name string
	switch {
	case a.has("id"):
		id = a.int("id", 0)
		if c.m.db.QueryRow(`SELECT username FROM users WHERE id=?`, id).Scan(&name) != nil {
			return 0, "", fmt.Errorf("用户 id=%d 不存在 / user not found", id)
		}
	case a.str("username") != "":
		name = a.str("username")
		if c.m.db.QueryRow(`SELECT id FROM users WHERE username=?`, name).Scan(&id) != nil {
			return 0, "", fmt.Errorf("用户 %q 不存在 / user not found", name)
		}
	default:
		return 0, "", fmt.Errorf("需要 id 或 username / pass id or username")
	}
	return id, name, nil
}

// resolveGroups maps group names or ids to ids.
func (c *mcpCtx) resolveGroups(v any) ([]int64, error) {
	list, _ := v.([]any)
	out := []int64{}
	for _, it := range list {
		switch x := it.(type) {
		case float64:
			out = append(out, int64(x))
		case string:
			var id int64
			if n, err := strconv.ParseInt(x, 10, 64); err == nil {
				id = n
			} else if c.m.db.QueryRow(`SELECT id FROM groups WHERE name=?`, x).Scan(&id) != nil {
				return nil, fmt.Errorf("分组 %q 不存在 / group not found", x)
			}
			out = append(out, id)
		}
	}
	return out, nil
}

// resolveNode finds a node by id or name.
func (c *mcpCtx) resolveNode(s string) (string, error) {
	var id string
	if c.m.db.QueryRow(`SELECT id FROM nodes WHERE id=? OR name=? ORDER BY id=? DESC LIMIT 1`, s, s, s).Scan(&id) != nil {
		return "", fmt.Errorf("节点 %q 不存在 / node not found", s)
	}
	return id, nil
}

// timeRange turns range/from/to arguments into unix bounds.
func (c *mcpCtx) timeRange(a args) (int64, int64, error) {
	n := time.Now()
	to := n.Unix() + 1
	var from int64
	switch a.str("range") {
	case "1h":
		from = to - 3600
	case "6h":
		from = to - 6*3600
	case "", "24h":
		from = to - 86400
	case "today":
		from = c.m.dayStart(n)
	case "7d":
		from = to - 7*86400
	case "30d":
		from = to - 30*86400
	case "month":
		from = c.m.monthStart(n, 1)
	default:
		return 0, 0, fmt.Errorf("range 只能是 1h/6h/24h/today/7d/30d/month")
	}
	if a.has("from") {
		f, err := c.m.parseTime(a["from"])
		if err != nil {
			return 0, 0, err
		}
		from = f
	}
	if a.has("to") {
		t, err := c.m.parseTime(a["to"])
		if err != nil {
			return 0, 0, err
		}
		to = t
	}
	if to <= from {
		return 0, 0, fmt.Errorf("结束时间必须晚于开始时间")
	}
	return from, to, nil
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
