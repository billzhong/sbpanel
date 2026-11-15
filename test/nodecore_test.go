package test

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"runtime/debug"
	"strings"
	"testing"
	"time"
)

func (e *env) pickOutbound(uid int64, suffix string) json.RawMessage {
	e.t.Helper()
	for k, ob := range e.subOutbounds(uid) {
		if strings.HasSuffix(k, suffix) {
			return ob
		}
	}
	e.t.Fatalf("no outbound ending in %q", suffix)
	return nil
}

func (e *env) waitRevisionAfter(rev uint64) {
	e.t.Helper()
	waitFor(e.t, "new revision applied", 20*time.Second, func() bool {
		n := e.node(e.nodeID)
		return n.Revision > rev && n.AppliedRevision == n.Revision
	})
	if n := e.node(e.nodeID); n.ApplyError != "" {
		e.t.Fatalf("apply error: %s", n.ApplyError)
	}
}

// Node core settings reach the running node: the listener options and log level are
// applied without breaking traffic, the Go runtime of the node process is tuned, and
// clearing the setting puts the defaults back.
func TestNodeCoreSettings(t *testing.T) {
	e := newEnv(t)
	uid := e.createUser(map[string]any{"username": "core"})
	e.createInbound("main", "vless", map[string]any{"listen": "127.0.0.1", "listen_port": freePort(t)}, nil)
	e.waitApplied()
	target := blob(t)
	px := client(t, e.pickOutbound(uid, "· main"))
	if _, err := fetch(px, target, 256<<10, "", 10*time.Second); err != nil {
		t.Fatalf("before: %v", err)
	}

	for _, bad := range []string{`{"udp_timeout":"1s"}`, `{"log_level":"loud"}`, `{"gogc":5}`, `{"mem_limit_mb":8}`, `not json`} {
		e.api.expect(400, "PUT", "/api/settings", map[string]string{"node_core": bad})
	}

	rev := e.node(e.nodeID).Revision
	e.api.do("PUT", "/api/settings", map[string]string{"node_core": `{"log_level":"info","tcp_fast_open":true,"tcp_multi_path":true,"udp_timeout":"2m","gogc":150,"mem_limit_mb":256}`}, nil)
	e.waitRevisionAfter(rev)

	var spec struct {
		SkeletonJson string `json:"skeletonJson"`
		Inbounds     []struct {
			OptionsJson string `json:"optionsJson"`
		} `json:"inbounds"`
		Runtime struct {
			Gogc        int32  `json:"gogc"`
			MemoryLimit string `json:"memoryLimit"`
		} `json:"runtime"`
	}
	e.api.do("GET", "/api/nodes/"+e.nodeID+"/spec", nil, &spec)
	if !strings.Contains(b64(t, spec.SkeletonJson), `"level":"info"`) {
		t.Fatalf("log level not in the skeleton: %s", b64(t, spec.SkeletonJson))
	}
	if o := b64(t, spec.Inbounds[0].OptionsJson); !strings.Contains(o, `"tcp_fast_open":true`) || !strings.Contains(o, `"udp_timeout":"2m"`) || !strings.Contains(o, `"tcp_multi_path":true`) {
		t.Fatalf("listener options: %s", o)
	}
	// the agent runs in this process: its Go runtime now has the panel's values
	waitFor(t, "runtime applied", 10*time.Second, func() bool {
		return debug.SetMemoryLimit(-1) == 256<<20
	})
	if g := debug.SetGCPercent(150); g != 150 {
		t.Fatalf("GOGC = %d", g)
	}
	// traffic still flows through the rebuilt core (the same client, same subscription)
	waitFor(t, "traffic after apply", 15*time.Second, func() bool {
		_, err := fetch(px, target, 256<<10, "", 5*time.Second)
		return err == nil
	})

	rev = e.node(e.nodeID).Revision
	e.api.do("PUT", "/api/settings", map[string]string{"node_core": ""}, nil)
	e.waitRevisionAfter(rev)
	waitFor(t, "runtime defaults", 10*time.Second, func() bool { return debug.SetMemoryLimit(-1) == math.MaxInt64 })
	if g := debug.SetGCPercent(100); g != 100 {
		t.Fatalf("GOGC after clearing = %d", g)
	}
	var s map[string]any
	e.api.do("GET", "/api/settings", nil, &s)
	if s["node_core"] != "" {
		t.Fatalf("node_core = %v", s["node_core"])
	}
}

// A node set to "IPv6 first" hands clients its hostname with that preference in every
// format, and a client using it really connects (over ::1) and moves traffic.
func TestClientIPPreference(t *testing.T) {
	e := newEnv(t)
	uid := e.createUser(map[string]any{"username": "v6"})
	e.createInbound("ss", "shadowsocks", map[string]any{"listen": "::", "listen_port": freePort(t), "method": "2022-blake3-aes-128-gcm", "password": "dGVzdHRlc3R0ZXN0dGVzdA=="}, nil)
	e.api.expect(400, "PATCH", "/api/nodes/"+e.nodeID, map[string]any{"client_ip": "ipv5"})
	e.api.do("PATCH", "/api/nodes/"+e.nodeID, map[string]any{"public_address": "localhost", "client_ip": "ipv6"}, nil)
	e.waitApplied()

	ob := e.pickOutbound(uid, "· ss")
	var o struct {
		DomainResolver struct{ Server, Strategy string } `json:"domain_resolver"`
	}
	json.Unmarshal(ob, &o)
	if o.DomainResolver.Server != "local" || o.DomainResolver.Strategy != "prefer_ipv6" {
		t.Fatalf("sing-box outbound: %s", ob)
	}
	if _, err := fetch(client(t, ob), blob(t), 256<<10, "", 10*time.Second); err != nil {
		t.Fatalf("through an IPv6-first outbound: %v", err)
	}
	if s := e.subText(uid, "surge"); !strings.Contains(s, "ip-version=prefer-v6") {
		t.Fatalf("surge: %s", s)
	}
	if s := e.subText(uid, "clash"); !strings.Contains(s, "ipv6-prefer") {
		t.Fatalf("clash: %s", s)
	}
	// back to the client's default: nothing in any format
	e.api.do("PATCH", "/api/nodes/"+e.nodeID, map[string]any{"client_ip": ""}, nil)
	if s := e.subText(uid, "surge") + e.subText(uid, "clash") + e.subText(uid, "singbox"); strings.Contains(s, "prefer-v6") || strings.Contains(s, "ipv6-prefer") || strings.Contains(s, "prefer_ipv6") {
		t.Fatal("preference left in the subscription")
	}
}

// New users reset monthly on their creation day unless told otherwise, and an admin can
// move that day by correcting created_at (not into the future).
func TestUserResetDefaultsAndAnchor(t *testing.T) {
	e := newEnv(t)
	uid := e.createUser(map[string]any{"username": "anchor"})
	other := e.createUser(map[string]any{"username": "internal", "reset_strategy": "month"})
	var users []struct {
		ID            int64  `json:"id"`
		ResetStrategy string `json:"reset_strategy"`
		CreatedAt     int64  `json:"created_at"`
	}
	get := func(id int64) (string, int64) {
		e.api.do("GET", "/api/users", nil, &users)
		for _, u := range users {
			if u.ID == id {
				return u.ResetStrategy, u.CreatedAt
			}
		}
		t.Fatalf("user %d missing", id)
		return "", 0
	}
	if s, _ := get(uid); s != "month_rolling" {
		t.Fatalf("default reset = %q", s)
	}
	if s, _ := get(other); s != "month" {
		t.Fatalf("explicit reset = %q", s)
	}
	var bulk struct{ IDs []int64 }
	e.api.do("POST", "/api/users/bulk", map[string]any{"prefix": "b", "count": 1}, &bulk)
	if s, _ := get(bulk.IDs[0]); s != "month_rolling" {
		t.Fatalf("bulk default reset = %q", s)
	}

	e.api.expect(400, "PATCH", "/api/users/"+itoa(uid), map[string]any{"created_at": time.Now().Add(time.Hour).Unix()})
	e.api.expect(400, "PATCH", "/api/users/"+itoa(uid), map[string]any{"created_at": 0})
	anchor := time.Now().AddDate(0, -2, 0)
	e.api.do("PATCH", "/api/users/"+itoa(uid), map[string]any{"created_at": anchor.Unix()}, nil)
	if _, c := get(uid); c != anchor.Unix() {
		t.Fatalf("created_at = %d", c)
	}
	// the next reset falls on the anchor's day of the month, within a month from now
	var sj struct {
		User struct {
			Reset struct {
				NextAt int64 `json:"next_at"`
			} `json:"reset"`
		} `json:"user"`
	}
	json.Unmarshal([]byte(e.subText(uid, "json")), &sj)
	loc := e.panelTZ()
	anchor = anchor.In(loc)
	next := time.Unix(sj.User.Reset.NextAt, 0).In(loc)
	if d := time.Until(next); d <= 0 || d > 32*24*time.Hour {
		t.Fatalf("next reset %v", next)
	}
	if next.Day() != anchor.Day() && next.Day() < 28 { // short months clamp the anchor
		t.Fatalf("next reset on day %d, anchor day %d", next.Day(), anchor.Day())
	}
}

// Server traffic settings on a node: validation, billing mode and correcting the used amount.
func TestNodeServerTraffic(t *testing.T) {
	e := newEnv(t)
	path := "/api/nodes/" + e.nodeID
	e.api.expect(400, "PATCH", path, map[string]any{"traffic_mode": "sideways"})
	e.api.expect(400, "PATCH", path, map[string]any{"reset_day": 31})
	e.api.expect(400, "PATCH", path, map[string]any{"traffic_used": -1})
	e.api.do("PATCH", path, map[string]any{"traffic_limit": 2 << 40, "reset_day": 9, "traffic_mode": "out"}, nil)
	e.api.do("PATCH", path, map[string]any{"traffic_used": 500 << 30}, nil)
	var ns []struct {
		ID          string `json:"id"`
		TrafficMode string `json:"traffic_mode"`
		Server      struct {
			Used        int64 `json:"used"`
			PeriodStart int64 `json:"period_start"`
		} `json:"server"`
	}
	waitFor(t, "server usage", 10*time.Second, func() bool {
		e.api.do("GET", "/api/nodes", nil, &ns)
		return len(ns) == 1 && ns[0].Server.Used >= 500<<30
	})
	if ns[0].TrafficMode != "out" || time.Unix(ns[0].Server.PeriodStart, 0).In(e.panelTZ()).Day() != 9 {
		t.Fatalf("%+v", ns[0])
	}
}

func (e *env) subText(uid int64, format string) string {
	e.t.Helper()
	var s struct {
		URL string `json:"url"`
	}
	e.api.do("GET", "/api/users/"+itoa(uid)+"/sub", nil, &s)
	resp, err := http.Get(s.URL + "?format=" + format)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

func b64(t *testing.T, s string) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("base64: %v", err)
	}
	return string(b)
}

// panelTZ is the master's time zone: billing periods start at its midnight.
func (e *env) panelTZ() *time.Location {
	e.t.Helper()
	var s struct {
		TZ string `json:"tz"`
	}
	e.api.do("GET", "/api/settings", nil, &s)
	loc, err := time.LoadLocation(s.TZ)
	if err != nil {
		e.t.Fatalf("tz %q: %v", s.TZ, err)
	}
	return loc
}
