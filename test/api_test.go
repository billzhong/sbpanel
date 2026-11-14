package test

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
	"time"
)

func totp(secret string) string {
	key, _ := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(time.Now().Unix()/30))
	m := hmac.New(sha1.New, key)
	m.Write(msg[:])
	s := m.Sum(nil)
	o := s[len(s)-1] & 15
	return fmt.Sprintf("%06d", (binary.BigEndian.Uint32(s[o:o+4])&0x7fffffff)%1000000)
}

func TestAPISecurity(t *testing.T) {
	e := newEnv(t)
	jar, _ := cookiejar.New(nil)
	anon := &api{t: t, base: e.api.base, hc: &http.Client{Jar: jar, Timeout: 10 * time.Second}}

	t.Run("everything under /api requires auth", func(t *testing.T) {
		for _, p := range []string{"GET /api/users", "GET /api/nodes", "POST /api/users", "GET /api/overview", "GET /api/backup",
			"GET /api/settings", "PUT /api/settings", "GET /api/tokens", "POST /api/import/3xui", "GET /api/nodes/x/conns",
			"GET /api/templates", "POST /api/tools/reality-keypair", "GET /api/audit", "DELETE /api/users/1"} {
			f := strings.Fields(p)
			if code, _ := anon.call(f[0], f[1], map[string]any{}); code != 401 {
				t.Errorf("%s -> %d", p, code)
			}
		}
		// subscription endpoints are public but need a valid token
		if code, _ := anon.call("GET", "/s/doesnotexist", nil); code != 404 {
			t.Errorf("bad sub token -> %d", code)
		}
	})

	t.Run("wrong password and audit", func(t *testing.T) {
		if code, _ := anon.call("POST", "/api/auth/login", map[string]string{"username": "admin", "password": "nope"}); code != 401 {
			t.Fatalf("bad login -> %d", code)
		}
		var audit []struct{ Action, IP string }
		e.api.do("GET", "/api/audit", nil, &audit)
		found := false
		for _, a := range audit {
			found = found || a.Action == "login.failed"
		}
		if !found {
			t.Fatal("failed login not audited")
		}
	})

	t.Run("API tokens", func(t *testing.T) {
		var tok struct{ Token string }
		e.api.do("POST", "/api/tokens", map[string]string{"name": "ci"}, &tok)
		bearer := &api{t: t, base: e.api.base, hc: &http.Client{Timeout: 10 * time.Second}, auth: "Bearer " + tok.Token}
		bearer.do("GET", "/api/users", nil, nil)
		bearer.do("POST", "/api/users", map[string]any{"username": "via-token"}, nil)
		var audit []struct{ Admin, Action string }
		e.api.do("GET", "/api/audit", nil, &audit)
		if audit[0].Admin != "token:ci" || audit[0].Action != "user.create" {
			t.Fatalf("token actions not attributed: %+v", audit[0])
		}
		var ts []struct{ ID int64 }
		e.api.do("GET", "/api/tokens", nil, &ts)
		e.api.do("DELETE", fmt.Sprintf("/api/tokens/%d", ts[0].ID), nil, nil)
		bearer.expect(401, "GET", "/api/users", nil)
		(&api{t: t, base: e.api.base, hc: &http.Client{}, auth: "Bearer sbp_forged"}).expect(401, "GET", "/api/users", nil)
	})

	t.Run("password change", func(t *testing.T) {
		e.api.expect(400, "POST", "/api/me/password", map[string]string{"old": "wrong", "new": "newpassword1"})
		e.api.expect(400, "POST", "/api/me/password", map[string]string{"old": "test-pass", "new": "short"})
		e.api.do("POST", "/api/me/password", map[string]string{"old": "test-pass", "new": "newpassword1"}, nil)
		anon.expect(401, "POST", "/api/auth/login", map[string]string{"username": "admin", "password": "test-pass"})
		anon.do("POST", "/api/auth/login", map[string]string{"username": "admin", "password": "newpassword1"}, nil)
		e.api.do("POST", "/api/me/password", map[string]string{"old": "newpassword1", "new": "test-pass"}, nil)
	})

	t.Run("two-factor login", func(t *testing.T) {
		var setup struct{ Secret string }
		e.api.do("POST", "/api/me/totp/setup", nil, &setup)
		e.api.expect(400, "POST", "/api/me/totp/enable", map[string]string{"code": "000000"})
		e.api.do("POST", "/api/me/totp/enable", map[string]string{"code": totp(setup.Secret)}, nil)
		jar2, _ := cookiejar.New(nil)
		c := &api{t: t, base: e.api.base, hc: &http.Client{Jar: jar2}}
		body := c.expect(401, "POST", "/api/auth/login", map[string]string{"username": "admin", "password": "test-pass"})
		if !strings.Contains(body, "need_totp") {
			t.Fatalf("no totp prompt: %s", body)
		}
		c.expect(401, "POST", "/api/auth/login", map[string]string{"username": "admin", "password": "test-pass", "code": "123456"})
		c.do("POST", "/api/auth/login", map[string]string{"username": "admin", "password": "test-pass", "code": totp(setup.Secret)}, nil)
		c.do("GET", "/api/users", nil, nil)
		e.api.expect(400, "POST", "/api/me/totp/disable", map[string]string{"password": "wrong"})
		e.api.do("POST", "/api/me/totp/disable", map[string]string{"password": "test-pass"}, nil)
	})

	t.Run("backup is a sqlite database", func(t *testing.T) {
		req, _ := http.NewRequest("GET", e.api.base+"/api/backup", nil)
		resp, err := e.api.hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if !strings.HasPrefix(string(b), "SQLite format 3") || len(b) < 4096 {
			t.Fatalf("backup %d bytes, header %q", len(b), b[:min(16, len(b))])
		}
	})
}

func TestAPIValidation(t *testing.T) {
	e := newEnv(t)
	a := e.api
	cases := []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/users", map[string]any{"username": "bad name!"}},
		{"POST", "/api/users", map[string]any{"username": ""}},
		{"POST", "/api/users", map[string]any{"username": "x", "traffic_limit": -1}},
		{"POST", "/api/users", map[string]any{"username": "x", "reset_strategy": "hourly"}},
		{"POST", "/api/users/bulk", map[string]any{"prefix": "u", "count": 0}},
		{"POST", "/api/users/bulk", map[string]any{"prefix": "u", "count": 501}},
		{"PATCH", "/api/users/999", map[string]any{"note": "x"}},
		{"POST", "/api/inbounds", map[string]any{"node_id": e.nodeID, "tag": "bad tag", "type": "vless", "options": map[string]any{"listen_port": 1000}}},
		{"POST", "/api/inbounds", map[string]any{"node_id": e.nodeID, "tag": "t", "type": "socks", "options": map[string]any{"listen_port": 1000}}},
		{"POST", "/api/inbounds", map[string]any{"node_id": e.nodeID, "tag": "t", "type": "vless", "options": map[string]any{"listen_port": 70000}}},
		{"POST", "/api/inbounds", map[string]any{"node_id": "nope", "tag": "t", "type": "vless", "options": map[string]any{"listen_port": 1000}}},
		{"POST", "/api/nodes", map[string]any{"name": "  "}},
		{"POST", "/api/groups", map[string]any{"name": ""}},
		{"POST", "/api/hosts", map[string]any{"inbound_id": 999}},
		{"PUT", "/api/settings", map[string]any{"unknown_key": "x"}},
		{"PUT", "/api/settings", map[string]any{"sub_base_url": "ftp://x"}},
		{"PUT", "/api/settings", map[string]any{"sub_update_hours": "0"}},
		{"PUT", "/api/settings", map[string]any{"device_policy": "random"}},
		{"POST", "/api/import/3xui", map[string]any{"node_id": e.nodeID, "data": "not json"}},
		{"GET", "/api/traffic/series?step=7", nil},
		{"GET", "/api/traffic/top?dim=password", nil},
	}
	for _, c := range cases {
		code, b := a.call(c.method, c.path, c.body)
		if code < 400 || code >= 500 {
			t.Errorf("%s %s %v -> %d %s", c.method, c.path, c.body, code, b)
		}
	}
	// conflicts
	a.do("POST", "/api/users", map[string]any{"username": "dup"}, nil)
	a.expect(400, "POST", "/api/users", map[string]any{"username": "dup"})
	e.createInbound("one", "vless", map[string]any{"listen": "127.0.0.1", "listen_port": freePort(t)}, nil)
	var ins []struct {
		Port int `json:"port"`
	}
	a.do("GET", "/api/inbounds", nil, &ins)
	a.expect(400, "POST", "/api/inbounds", map[string]any{"node_id": e.nodeID, "tag": "two", "type": "vless", "options": map[string]any{"listen_port": ins[0].Port}})
	a.expect(400, "POST", "/api/inbounds", map[string]any{"node_id": e.nodeID, "tag": "one", "type": "vless", "options": map[string]any{"listen_port": freePort(t)}})
	// templates: last one cannot be deleted; one in use cannot be deleted
	var tpls []struct{ ID int64 }
	a.do("GET", "/api/templates", nil, &tpls)
	a.expect(400, "DELETE", fmt.Sprintf("/api/templates/%d", tpls[0].ID), nil)

	// bulk create naming
	var bulk struct{ IDs []int64 }
	a.do("POST", "/api/users/bulk", map[string]any{"prefix": "trial", "count": 12, "start": 1, "traffic_limit": 1 << 30, "reset_strategy": "month"}, &bulk)
	var us []struct {
		Username string  `json:"username"`
		GroupIDs []int64 `json:"group_ids"`
	}
	a.do("GET", "/api/users", nil, &us)
	names := map[string]bool{}
	for _, u := range us {
		names[u.Username] = true
		if strings.HasPrefix(u.Username, "trial") && len(u.GroupIDs) == 0 {
			t.Errorf("%s has no default group", u.Username)
		}
	}
	if len(bulk.IDs) != 12 || !names["trial01"] || !names["trial12"] {
		t.Fatalf("bulk names: %v", names)
	}
	a.expect(400, "POST", "/api/users/bulk", map[string]any{"prefix": "trial", "count": 1, "start": 5}) // trial05 exists -> rolled back
	var after []json.RawMessage
	a.do("GET", "/api/users", nil, &after)
	if len(after) != len(us) {
		t.Fatalf("failed bulk create left %d users behind", len(after)-len(us))
	}
}

func TestAPIBatchUndo(t *testing.T) {
	e := newEnv(t)
	a := e.createUser(map[string]any{"username": "ba", "traffic_limit": 1 << 30})
	b := e.createUser(map[string]any{"username": "bb"})
	var r struct {
		Affected int64             `json:"affected"`
		Undo     []json.RawMessage `json:"undo"`
	}
	e.api.do("POST", "/api/users/batch", map[string]any{"ids": []int64{a, b}, "action": "disable"}, &r)
	if r.Affected != 2 || len(r.Undo) != 2 {
		t.Fatalf("batch: %+v", r)
	}
	e.api.do("POST", "/api/users/batch", map[string]any{"ids": []int64{a, b}, "action": "restore", "value": r.Undo}, nil)
	var us []struct {
		Username string `json:"username"`
		Enabled  bool   `json:"enabled"`
	}
	e.api.do("GET", "/api/users", nil, &us)
	for _, u := range us {
		if !u.Enabled {
			t.Fatalf("%s not restored", u.Username)
		}
	}
	e.api.expect(400, "POST", "/api/users/batch", map[string]any{"ids": []int64{}, "action": "enable"})
	var audit []struct{ Action string }
	e.api.do("GET", "/api/audit", nil, &audit)
	if audit[0].Action != "user.batch.restore" {
		t.Fatalf("audit %+v", audit[0])
	}
}
