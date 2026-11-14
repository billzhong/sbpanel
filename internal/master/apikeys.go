package master

// Scoped API keys: authentication, scope checks, per-key IP allowlists and rate limiting.
// Every /api route is guarded by scopedMux (api_scopes.go), which looks up the scope the route
// needs in routeScopes and runs guard() before the handler.

import (
	"context"
	"crypto/subtle"
	"fmt"
	"math"
	"net"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Scopes. A session (logged-in admin) has every scope; keys have the scopes they were created with.
const (
	ScopeRead          = "read"           // every GET endpoint (except key management and backup)
	ScopeUsersWrite    = "users:write"    // create/update/delete users, batch ops, kick, close connections
	ScopeNodesWrite    = "nodes:write"    // nodes, inbounds, groups, hosts, templates, routing profiles
	ScopeSettingsWrite = "settings:write" // panel settings, appearance, subscription themes, notifications
	ScopeAdmin         = "admin"          // everything, incl. API key management, backup and 3x-ui import

	// pseudo scopes used only in routeScopes
	scopePublic  = "public"  // no authentication
	scopeAny     = "any"     // any authenticated caller (session or key with any scope)
	scopeSession = "session" // logged-in admin only (password, 2FA); keys are refused
	scopeKey     = "key"     // bearer key only (MCP); per-tool scopes are checked by the handler
)

// AllScopes lists the grantable scopes in display order.
var AllScopes = []string{ScopeRead, ScopeUsersWrite, ScopeNodesWrite, ScopeSettingsWrite, ScopeAdmin}

const (
	defaultRatePerMin = 120 // requests per minute when a key does not set its own limit
	maxRatePerMin     = 100000
	keyPrefix         = "sbp_"
)

type principal struct {
	session bool
	name    string // admin username or key name
	keyID   int64
	scopes  []string
}

func (p *principal) can(scope string) bool {
	switch scope {
	case scopePublic, scopeAny:
		return true
	case scopeSession:
		return p.session
	case scopeKey:
		return !p.session
	}
	return p.session || slices.Contains(p.scopes, ScopeAdmin) || slices.Contains(p.scopes, scope)
}

type principalKey struct{}

func principalFrom(r *http.Request) *principal {
	p, _ := r.Context().Value(principalKey{}).(*principal)
	return p
}

func withPrincipal(r *http.Request, p *principal, who string) *http.Request {
	ctx := context.WithValue(r.Context(), principalKey{}, p)
	return r.WithContext(context.WithValue(ctx, actorKey{}, who))
}

// guard authenticates the request (unless an outer layer already did) and checks the scope.
func (m *Master) guard(scope string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if scope == scopePublic {
			h(w, r)
			return
		}
		p := principalFrom(r)
		if p == nil {
			var who string
			p, who = m.authenticate(w, r, scope == scopeKey)
			if p == nil {
				return
			}
			r = withPrincipal(r, p, who)
		}
		if !p.can(scope) {
			if scope == scopeSession {
				writeErr(w, http.StatusForbidden, "此操作需要登录面板（API 密钥不可用）")
			} else {
				writeErr(w, http.StatusForbidden, "权限不足：需要 "+scope+" 权限")
			}
			return
		}
		h(w, r)
	}
}

// authenticate accepts a session cookie (unless bearerOnly) or "Authorization: Bearer sbp_…".
// On failure it writes the response (401/403/429) and returns nil.
func (m *Master) authenticate(w http.ResponseWriter, r *http.Request, bearerOnly bool) (*principal, string) {
	h := r.Header.Get("Authorization")
	if !bearerOnly && !strings.HasPrefix(h, "Bearer ") {
		if u, ok := m.checkSession(r); ok {
			return &principal{session: true, name: u}, u
		}
	}
	if !strings.HasPrefix(h, "Bearer ") {
		w.Header().Set("WWW-Authenticate", `Bearer realm="sbpanel"`)
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return nil, ""
	}
	k, err := m.lookupKey(strings.TrimSpace(h[7:]))
	if err != nil {
		w.Header().Set("WWW-Authenticate", `Bearer realm="sbpanel", error="invalid_token"`)
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return nil, ""
	}
	if k.ExpiresAt > 0 && k.ExpiresAt <= now() {
		w.Header().Set("WWW-Authenticate", `Bearer realm="sbpanel", error="invalid_token", error_description="expired"`)
		writeErr(w, http.StatusUnauthorized, "API 密钥已过期")
		return nil, ""
	}
	ip := clientIP(r)
	if !ipAllowed(k.AllowIPs, ip) {
		writeErr(w, http.StatusForbidden, "来源 IP 不在此密钥的允许列表中")
		return nil, ""
	}
	ks := m.keyState()
	if ok, retry, remaining := ks.take(k.ID, k.RateLimit, k.RateBurst); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(retry))
		w.Header().Set("X-RateLimit-Limit", strconv.FormatInt(k.RateLimit, 10))
		w.Header().Set("X-RateLimit-Remaining", "0")
		writeErr(w, http.StatusTooManyRequests, fmt.Sprintf("请求过于频繁，请 %d 秒后重试", retry))
		return nil, ""
	} else {
		w.Header().Set("X-RateLimit-Limit", strconv.FormatInt(k.RateLimit, 10))
		w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
	}
	if ks.touch(k.ID, ip) {
		m.db.Exec(`UPDATE api_tokens SET last_used=?, last_ip=? WHERE id=?`, now(), ip, k.ID)
	}
	return &principal{name: k.Name, keyID: k.ID, scopes: k.Scopes}, "token:" + k.Name
}

// ---------- key storage ----------

type apiKey struct {
	ID          int64    `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Prefix      string   `json:"prefix"`
	Scopes      []string `json:"scopes"`
	CreatedAt   int64    `json:"created_at"`
	CreatedBy   string   `json:"created_by"`
	ExpiresAt   int64    `json:"expires_at"`
	AllowIPs    []string `json:"allow_ips"`
	RateLimit   int64    `json:"rate_limit"` // requests per minute (effective)
	RateBurst   int64    `json:"rate_burst"` // bucket size (effective)
	LastUsed    int64    `json:"last_used"`
	LastIP      string   `json:"last_ip"`
	Expired     bool     `json:"expired"`
}

const keyCols = `id, name, description, prefix, scopes, created_at, created_by, expires_at, allow_ips, rate_limit, rate_burst, last_used, last_ip`

func scanKey(s func(...any) error) (apiKey, error) {
	var k apiKey
	var scopes, ips string
	err := s(&k.ID, &k.Name, &k.Description, &k.Prefix, &scopes, &k.CreatedAt, &k.CreatedBy, &k.ExpiresAt, &ips, &k.RateLimit, &k.RateBurst, &k.LastUsed, &k.LastIP)
	k.Scopes = splitList(scopes)
	k.AllowIPs = splitList(ips)
	k.RateLimit, k.RateBurst = effectiveRate(k.RateLimit, k.RateBurst)
	k.Expired = k.ExpiresAt > 0 && k.ExpiresAt <= now()
	return k, err
}

func (m *Master) lookupKey(tok string) (apiKey, error) {
	if !strings.HasPrefix(tok, keyPrefix) || len(tok) < 20 {
		return apiKey{}, fmt.Errorf("bad key")
	}
	hash := hashToken(tok)
	ks, err := scanRows(m, `SELECT `+keyCols+`, token_hash FROM api_tokens WHERE token_hash=?`, []any{hash}, func(s func(...any) error) (apiKey, error) {
		var stored string
		k, err := scanKey(func(d ...any) error { return s(append(d, &stored)...) })
		if err == nil && subtle.ConstantTimeCompare([]byte(stored), []byte(hash)) != 1 {
			err = fmt.Errorf("mismatch")
		}
		return k, err
	})
	if err != nil || len(ks) == 0 {
		return apiKey{}, fmt.Errorf("unknown key")
	}
	return ks[0], nil
}

func effectiveRate(rate, burst int64) (int64, int64) {
	if rate <= 0 {
		rate = defaultRatePerMin
	}
	if burst <= 0 {
		burst = max(10, rate/4)
	}
	return rate, burst
}

func splitList(s string) []string {
	out := []string{}
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == '\n' || r == ' ' || r == ';' }) {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// normalizeAllowList validates IPs / CIDRs and returns them in canonical form.
func normalizeAllowList(items []string) ([]string, error) {
	out := []string{}
	for _, it := range items {
		it = strings.TrimSpace(it)
		if it == "" {
			continue
		}
		if strings.Contains(it, "/") {
			_, n, err := net.ParseCIDR(it)
			if err != nil {
				return nil, fmt.Errorf("无效的 CIDR：%s", it)
			}
			it = n.String()
		} else {
			ip := net.ParseIP(it)
			if ip == nil {
				return nil, fmt.Errorf("无效的 IP：%s", it)
			}
			it = ip.String()
		}
		if !slices.Contains(out, it) {
			out = append(out, it)
		}
	}
	if len(out) > 100 {
		return nil, fmt.Errorf("允许列表最多 100 项")
	}
	return out, nil
}

func ipAllowed(list []string, ip string) bool {
	if len(list) == 0 {
		return true
	}
	addr := net.ParseIP(ip)
	if addr == nil {
		return false
	}
	for _, it := range list {
		if strings.Contains(it, "/") {
			if _, n, err := net.ParseCIDR(it); err == nil && n.Contains(addr) {
				return true
			}
		} else if p := net.ParseIP(it); p != nil && p.Equal(addr) {
			return true
		}
	}
	return false
}

// ---------- rate limiting (token bucket per key, in memory) ----------

type bucket struct {
	tokens float64
	last   time.Time
}

type keyRuntime struct {
	mu      sync.Mutex
	buckets map[int64]*bucket
	touched map[int64]time.Time // throttles last_used writes
	lastIP  map[int64]string
	mux     *scopedMux // the most recently built router
}

var keyStates sync.Map // *Master -> *keyRuntime

func (m *Master) keyState() *keyRuntime {
	if v, ok := keyStates.Load(m); ok {
		return v.(*keyRuntime)
	}
	v, _ := keyStates.LoadOrStore(m, &keyRuntime{buckets: map[int64]*bucket{}, touched: map[int64]time.Time{}, lastIP: map[int64]string{}})
	return v.(*keyRuntime)
}

// take removes one token. It returns whether the request may proceed, the seconds to wait
// otherwise, and the whole tokens left.
func (k *keyRuntime) take(id, ratePerMin, burst int64) (bool, int, int) {
	k.mu.Lock()
	defer k.mu.Unlock()
	t := time.Now()
	perSec := float64(ratePerMin) / 60
	b := k.buckets[id]
	if b == nil {
		b = &bucket{tokens: float64(burst), last: t}
		k.buckets[id] = b
	}
	b.tokens = math.Min(float64(burst), b.tokens+t.Sub(b.last).Seconds()*perSec)
	b.last = t
	if b.tokens < 1 {
		return false, max(1, int(math.Ceil((1-b.tokens)/perSec))), 0
	}
	b.tokens--
	return true, 0, int(b.tokens)
}

// touch reports whether last_used/last_ip should be written (at most every 10 s or on IP change).
func (k *keyRuntime) touch(id int64, ip string) bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	if time.Since(k.touched[id]) < 10*time.Second && k.lastIP[id] == ip {
		return false
	}
	k.touched[id], k.lastIP[id] = time.Now(), ip
	return true
}

func (k *keyRuntime) forget(id int64) {
	k.mu.Lock()
	delete(k.buckets, id)
	delete(k.touched, id)
	delete(k.lastIP, id)
	k.mu.Unlock()
}

// ---------- key management endpoints (session or admin scope) ----------

func (m *Master) apiTokens(w http.ResponseWriter, r *http.Request) {
	out, err := scanRows(m, `SELECT `+keyCols+` FROM api_tokens ORDER BY id`, nil, scanKey)
	if errf(w, err) {
		return
	}
	writeJSON(w, 200, out)
}

type keyReq struct {
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	Scopes        []string `json:"scopes"`
	ExpiresAt     int64    `json:"expires_at"`      // unix seconds, 0 = never
	ExpiresInDays int64    `json:"expires_in_days"` // alternative to expires_at
	AllowIPs      []string `json:"allow_ips"`       // IPs or CIDRs; empty = any
	RateLimit     int64    `json:"rate_limit"`      // requests per minute; 0 = default (120)
	RateBurst     int64    `json:"rate_burst"`      // bucket size; 0 = max(10, rate/4)
}

func (req *keyReq) normalize() error {
	req.Name = strings.TrimSpace(req.Name)
	req.Description = strings.TrimSpace(req.Description)
	if req.Name == "" || len([]rune(req.Name)) > 64 {
		return fmt.Errorf("名称不能为空，最长 64 个字符")
	}
	if len([]rune(req.Description)) > 500 {
		return fmt.Errorf("描述最长 500 个字符")
	}
	if req.Scopes == nil {
		req.Scopes = []string{ScopeAdmin} // old clients ({name} only) keep full access
	}
	var scopes []string
	for _, s := range req.Scopes {
		s = strings.TrimSpace(s)
		if !slices.Contains(AllScopes, s) {
			return fmt.Errorf("未知权限：%s（可选 %s）", s, strings.Join(AllScopes, ", "))
		}
		if !slices.Contains(scopes, s) {
			scopes = append(scopes, s)
		}
	}
	if len(scopes) == 0 {
		return fmt.Errorf("至少选择一个权限")
	}
	sort.SliceStable(scopes, func(i, j int) bool { return slices.Index(AllScopes, scopes[i]) < slices.Index(AllScopes, scopes[j]) })
	req.Scopes = scopes
	if req.ExpiresInDays < 0 || req.ExpiresInDays > 3650 {
		return fmt.Errorf("有效期为 1-3650 天")
	}
	if req.ExpiresInDays > 0 {
		req.ExpiresAt = now() + req.ExpiresInDays*86400
	}
	if req.ExpiresAt < 0 || (req.ExpiresAt > 0 && req.ExpiresAt <= now()) {
		return fmt.Errorf("过期时间必须晚于现在")
	}
	ips, err := normalizeAllowList(req.AllowIPs)
	if err != nil {
		return err
	}
	req.AllowIPs = ips
	if req.RateLimit < 0 || req.RateLimit > maxRatePerMin {
		return fmt.Errorf("速率限制为 1-%d 次/分钟（0 为默认 %d）", maxRatePerMin, defaultRatePerMin)
	}
	if req.RateBurst < 0 || req.RateBurst > maxRatePerMin {
		return fmt.Errorf("突发上限为 1-%d", maxRatePerMin)
	}
	return nil
}

func (m *Master) apiCreateToken(w http.ResponseWriter, r *http.Request) {
	var req keyReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "请求格式错误")
		return
	}
	if err := req.normalize(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var dup int
	m.db.QueryRow(`SELECT COUNT(*) FROM api_tokens WHERE name=?`, req.Name).Scan(&dup)
	if dup > 0 {
		writeErr(w, 400, "已有同名密钥")
		return
	}
	tok := keyPrefix + randHex(24)
	res, err := m.db.Exec(`INSERT INTO api_tokens(name, token_hash, prefix, created_at, scopes, description, expires_at, allow_ips, rate_limit, rate_burst, created_by)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`, req.Name, hashToken(tok), tok[:10], now(), strings.Join(req.Scopes, ","), req.Description,
		req.ExpiresAt, strings.Join(req.AllowIPs, ","), req.RateLimit, req.RateBurst, actor(r))
	if errf(w, err) {
		return
	}
	id, _ := res.LastInsertId()
	// key material is never logged: the audit entry carries the name and scopes only
	m.audit(r, "token.create", req.Name, "scopes="+strings.Join(req.Scopes, ","))
	ks, _ := scanRows(m, `SELECT `+keyCols+` FROM api_tokens WHERE id=?`, []any{id}, scanKey)
	out := map[string]any{"token": tok}
	if len(ks) == 1 {
		out["key"] = ks[0]
	}
	writeJSON(w, 200, out)
}

func (m *Master) apiDeleteToken(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var name string
	if m.db.QueryRow(`SELECT name FROM api_tokens WHERE id=?`, id).Scan(&name) != nil {
		writeErr(w, 404, "密钥不存在")
		return
	}
	m.db.Exec(`DELETE FROM api_tokens WHERE id=?`, id)
	m.keyState().forget(id)
	m.audit(r, "token.delete", name, "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// apiScopes describes the grantable scopes (used by the UI and agents).
func (m *Master) apiScopes(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, scopeInfo())
}

func scopeInfo() []map[string]string {
	desc := map[string][2]string{
		ScopeRead:          {"只读", "读取所有 GET 接口：用户、节点、入站、流量、事件、设置（不含密钥管理和备份）"},
		ScopeUsersWrite:    {"用户写入", "创建、修改、删除用户，批量操作、续期、加流量、重置用量、踢下线"},
		ScopeNodesWrite:    {"节点写入", "节点、入站、分组、Host、路由模板、订阅分流方案"},
		ScopeSettingsWrite: {"设置写入", "面板设置、外观、订阅页主题、通知渠道"},
		ScopeAdmin:         {"管理员", "全部权限，包括管理 API 密钥、下载备份、3x-ui 导入"},
	}
	out := []map[string]string{}
	for _, s := range AllScopes {
		out = append(out, map[string]string{"id": s, "label": desc[s][0], "description": desc[s][1]})
	}
	return out
}
