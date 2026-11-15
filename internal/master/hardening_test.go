package master

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"sbpanel/internal/pb"
)

// Templates / node routes / inbounds must not make the root node agent touch files.
func TestFileOptionsRejected(t *testing.T) {
	if _, err := validateSkeleton(DefaultSkeleton); err != nil {
		t.Fatalf("default skeleton rejected: %v", err)
	}
	var base map[string]any
	json.Unmarshal([]byte(DefaultSkeleton), &base)
	bad := []func(v map[string]any){
		func(v map[string]any) { v["log"] = map[string]any{"output": "/etc/cron.d/x"} },
		func(v map[string]any) {
			v["experimental"] = map[string]any{"cache_file": map[string]any{"enabled": true, "path": "/root/.ssh/authorized_keys"}}
		},
		func(v map[string]any) {
			v["experimental"] = map[string]any{"clash_api": map[string]any{"external_controller": "127.0.0.1:9090", "external_ui": "/etc", "external_ui_download_url": "https://x/y.zip"}}
		},
		func(v map[string]any) {
			r := v["route"].(map[string]any)
			r["rule_set"] = []any{map[string]any{"type": "local", "tag": "x", "format": "source", "path": "/etc/shadow"}}
		},
		func(v map[string]any) {
			v["outbounds"] = append(v["outbounds"].([]any), map[string]any{"type": "direct", "tag": "t", "tls": map[string]any{"certificate_path": "/etc/shadow"}})
		},
		func(v map[string]any) {
			v["endpoints"] = []any{map[string]any{"type": "tailscale", "tag": "ts", "state_directory": "/etc"}}
		},
	}
	for i, mut := range bad {
		var v map[string]any
		b, _ := json.Marshal(base)
		json.Unmarshal(b, &v)
		mut(v)
		js, _ := json.Marshal(v)
		if _, err := validateSkeleton(string(js)); err == nil {
			t.Fatalf("case %d accepted: %s", i, js)
		}
	}
	// a remote rule set and a ws path are fine
	var v map[string]any
	b, _ := json.Marshal(base)
	json.Unmarshal(b, &v)
	v["route"].(map[string]any)["rule_set"] = []any{map[string]any{"type": "remote", "tag": "x", "format": "binary", "url": "https://example.com/x.srs"}}
	js, _ := json.Marshal(v)
	if _, err := validateSkeleton(string(js)); err != nil {
		t.Fatalf("remote rule set rejected: %v", err)
	}

	in := func(opts string) error {
		_, _, err := (&inboundReq{Tag: "a", Type: "trojan", Options: json.RawMessage(opts)}).validate()
		return err
	}
	for _, o := range []string{
		`{"listen_port":1,"tls":{"enabled":true,"acme":{"domain":["x"],"data_directory":"/etc"}}}`,
		`{"listen_port":1,"tls":{"enabled":true,"certificate_path":"/dev/zero","key_path":"/etc/k"}}`,
		`{"listen_port":1,"tls":{"enabled":true,"certificate_path":"relative.pem"}}`,
	} {
		if in(o) == nil {
			t.Fatalf("inbound accepted: %s", o)
		}
	}
	if err := in(`{"listen_port":1,"tls":{"enabled":true,"certificate_path":"/etc/letsencrypt/live/x/fullchain.pem","key_path":"/etc/letsencrypt/live/x/privkey.pem"},"transport":{"type":"ws","path":"/w"}}`); err != nil {
		t.Fatalf("real certificate files rejected: %v", err)
	}
}

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 203.0.113.9")
	if got := clientIP(r); got != "203.0.113.9" {
		t.Fatalf("right-most XFF: %s", got)
	}
	r.Header.Set("X-Real-IP", "198.51.100.7")
	if got := clientIP(r); got != "198.51.100.7" {
		t.Fatalf("X-Real-IP first: %s", got)
	}
	r.RemoteAddr = "192.0.2.1:5000" // not our proxy: headers are ignored
	if got := clientIP(r); got != "192.0.2.1" {
		t.Fatalf("direct peer: %s", got)
	}
}

func login(m *Master, ip, user, pass, code string) *httptest.ResponseRecorder {
	b, _ := json.Marshal(map[string]string{"username": user, "password": pass, "code": code})
	r := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(b))
	r.RemoteAddr = "127.0.0.1:1"
	r.Header.Set("X-Real-IP", ip)
	w := httptest.NewRecorder()
	m.apiLogin(w, r)
	return w
}

func TestLoginLimitsAndSessions(t *testing.T) {
	m := newTestMaster(t)
	for i := 0; i < loginMaxIP; i++ {
		if w := login(m, "203.0.113.1", "admin", "wrong", ""); w.Code != 401 {
			t.Fatalf("attempt %d: %d", i, w.Code)
		}
	}
	if w := login(m, "203.0.113.1", "admin", "pw-12345678", ""); w.Code != 429 {
		t.Fatalf("IP not throttled: %d", w.Code)
	}
	// another IP still works, and success clears nothing it shouldn't
	w := login(m, "203.0.113.2", "admin", "pw-12345678", "")
	if w.Code != 200 {
		t.Fatalf("other IP: %d %s", w.Code, w.Body)
	}
	// the audit log keeps usernames short
	login(m, "203.0.113.3", strings.Repeat("x", 5000), "p", "")
	var n int
	m.db.QueryRow(`SELECT MAX(LENGTH(admin)) FROM audit_log`).Scan(&n)
	if n > 64 {
		t.Fatalf("audit username length %d", n)
	}

	// a session ends when the password changes
	cookie := w.Result().Cookies()[0]
	authed := func() bool {
		r := httptest.NewRequest("GET", "/api/auth/me", nil)
		r.AddCookie(cookie)
		_, ok := m.checkSession(r)
		return ok
	}
	if !authed() {
		t.Fatal("fresh session rejected")
	}
	h, _ := bcrypt.GenerateFromPassword([]byte("new-password-1"), bcrypt.MinCost)
	m.db.Exec(`UPDATE admins SET pass_hash=? WHERE username='admin'`, string(h))
	if authed() {
		t.Fatal("session survived a password change")
	}

	// a TOTP code works once
	sec := newTOTPSecret()
	now := time.Now()
	code := totpCode(sec, now)
	if !m.totpUse("admin", sec, code, now) || m.totpUse("admin", sec, code, now) {
		t.Fatal("TOTP replay accepted")
	}
}

func TestIngestRejectsForgedTraffic(t *testing.T) {
	m := newTestMaster(t)
	seedNode(t, m, "n1")
	m.db.Exec(`INSERT INTO users(id, username, sub_token, uuid, password, used_up, used_down, created_at) VALUES(5,'u','tok','x','y',1000,1000,0)`)
	m.ingest("n1", &pb.TrafficReport{Seq: 1, WindowStart: time.Now().Unix(), Users: []*pb.UserStat{
		{User: "5", Inbound: "in", Outbound: "direct", Up: -1000, Down: -1000},
		{User: "999", Inbound: "in", Outbound: "direct", Down: 1 << 40},
	}})
	var up, down int64
	m.db.QueryRow(`SELECT used_up, used_down FROM users WHERE id=5`).Scan(&up, &down)
	if up != 1000 || down != 1000 {
		t.Fatalf("negative bytes changed usage: %d/%d", up, down)
	}
	var rows int
	m.db.QueryRow(`SELECT COUNT(*) FROM traffic_hour WHERE user_id=999`).Scan(&rows)
	if rows != 0 {
		t.Fatal("traffic for a user that doesn't exist was stored")
	}
	_ = http.StatusOK
}
