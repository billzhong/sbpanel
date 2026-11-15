package test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func pemPair(t *testing.T, name string, days int) (certPEM, keyPEM, fp string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Duration(days) * 24 * time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	kd, _ := x509.MarshalPKCS8PrivateKey(key)
	sum := sha256.Sum256(der)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kd})), hex.EncodeToString(sum[:])
}

// presented returns the fingerprint of the certificate a TLS server presents.
func presented(t *testing.T, port int, sni string) string {
	t.Helper()
	c, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port), &tls.Config{ServerName: sni, InsecureSkipVerify: true})
	if err != nil {
		return "dial: " + err.Error()
	}
	defer c.Close()
	sum := sha256.Sum256(c.ConnectionState().PeerCertificates[0].Raw)
	return hex.EncodeToString(sum[:])
}

type probeRes struct {
	InboundID int64  `json:"inbound_id"`
	Endpoint  string `json:"endpoint"`
	OK        bool   `json:"ok"`
	Stage     string `json:"stage"`
	Error     string `json:"error"`
	Raw       string `json:"raw"`
	TotalMs   int64  `json:"total_ms"`
	Stages    []struct {
		Name string `json:"name"`
		OK   bool   `json:"ok"`
		Ms   int64  `json:"ms"`
	} `json:"stages"`
}

func (e *env) probe(inbound int64) []probeRes {
	e.t.Helper()
	var rs []probeRes
	e.api.do("POST", "/api/probe", map[string]any{"inbound_id": inbound}, &rs)
	return rs
}

// TestPanelCertRotation: an uploaded certificate is distributed to the node; replacing
// it swaps the files without rebuilding the inbound, and new handshakes see the new
// certificate.
func TestPanelCertRotation(t *testing.T) {
	e := newEnv(t)
	target := blob(t)
	c1, k1, fp1 := pemPair(t, "sb.test", 90)

	// validation errors are explained
	_, kOther, _ := pemPair(t, "sb.test", 90)
	if body := e.api.expect(400, "POST", "/api/certs/upload", map[string]any{"cert_pem": c1, "key_pem": kOther}); !strings.Contains(body, "不匹配") {
		t.Fatalf("mismatch: %s", body)
	}
	var preview struct {
		SANs     []string `json:"sans"`
		NotAfter int64    `json:"not_after"`
	}
	e.api.do("POST", "/api/certs/upload", map[string]any{"cert_pem": c1, "key_pem": k1, "dry_run": true}, &preview)
	if len(preview.SANs) != 1 || preview.SANs[0] != "sb.test" {
		t.Fatalf("preview %+v", preview)
	}
	var up struct{ ID string }
	e.api.do("POST", "/api/certs/upload", map[string]any{"name": "test", "cert_pem": c1, "key_pem": k1}, &up)

	uid := e.createUser(map[string]any{"username": "certuser"})
	port := freePort(t)
	e.createInbound("tj", "trojan", map[string]any{"listen": "127.0.0.1", "listen_port": port, "_cert": up.ID,
		"tls": map[string]any{"enabled": true, "server_name": "sb.test"}}, map[string]any{"insecure": true})
	e.waitApplied()

	certFile := filepath.Join(e.agent.dir, "certs", up.ID+".crt")
	if fi, err := os.Stat(filepath.Join(e.agent.dir, "certs", up.ID+".key")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v", err)
	}
	if got := presented(t, port, "sb.test"); got != fp1 {
		t.Fatalf("serving %s, want %s", got, fp1)
	}
	ob := e.subOutbounds(uid)
	var tag string
	for k := range ob {
		if strings.Contains(k, "tj") {
			tag = k
		}
	}
	proxy := client(t, ob[tag])
	if _, err := fetch(proxy, target, 300000, "", 20*time.Second); err != nil {
		t.Fatalf("traffic through panel cert: %v", err)
	}
	_, rebuilds0 := e.agent.a.CoreStats()
	writes0 := e.agent.a.CertWrites()

	// rotate: upload a new PEM over the same certificate id
	c2, k2, fp2 := pemPair(t, "sb.test", 60)
	e.api.do("PATCH", "/api/certs/"+up.ID, map[string]any{"cert_pem": c2, "key_pem": k2}, nil)
	e.waitApplied()
	waitFor(t, "certificate file swapped", 10*time.Second, func() bool {
		b, _ := os.ReadFile(certFile)
		return string(b) == c2
	})
	waitFor(t, "new handshakes present the new certificate", 10*time.Second, func() bool { return presented(t, port, "sb.test") == fp2 })
	if _, rebuilds := e.agent.a.CoreStats(); rebuilds != rebuilds0 {
		t.Fatalf("inbound rebuilt on certificate rotation (%d -> %d)", rebuilds0, rebuilds)
	}
	if e.agent.a.CertWrites() != writes0+1 {
		t.Fatalf("cert writes %d -> %d", writes0, e.agent.a.CertWrites())
	}
	if _, err := fetch(proxy, target, 300000, "", 20*time.Second); err != nil {
		t.Fatalf("traffic after rotation: %v", err)
	}
	// in use: can't delete
	e.api.expect(409, "DELETE", "/api/certs/"+up.ID, nil)
	var list []struct {
		ID   string `json:"id"`
		Uses []struct {
			Tag string `json:"tag"`
		} `json:"uses"`
		Fingerprint string `json:"fingerprint"`
	}
	e.api.do("GET", "/api/certs", nil, &list)
	if len(list) != 1 || len(list[0].Uses) != 1 || list[0].Uses[0].Tag != "tj" || list[0].Fingerprint != fp2 {
		t.Fatalf("list %+v", list)
	}
	// node-local certificate files are reported back by the node
	lc, lk, lfp := pemPair(t, "local.test", 30)
	os.WriteFile(filepath.Join(e.dir, "local.crt"), []byte(lc), 0o600)
	os.WriteFile(filepath.Join(e.dir, "local.key"), []byte(lk), 0o600)
	var nc struct{ ID string }
	e.api.do("POST", "/api/certs/node", map[string]any{"node_id": e.nodeID, "cert_path": filepath.Join(e.dir, "local.crt"), "key_path": filepath.Join(e.dir, "local.key")}, &nc)
	waitFor(t, "node reports its local certificate", 15*time.Second, func() bool {
		var c struct {
			Fingerprint string   `json:"fingerprint"`
			SANs        []string `json:"sans"`
			Status      string   `json:"status"`
		}
		e.api.do("GET", "/api/certs/"+nc.ID, nil, &c)
		return c.Fingerprint == lfp && len(c.SANs) == 1 && c.SANs[0] == "local.test" && c.Status == "ok"
	})
}

// TestConnectivityProbe runs the panel probe through REALITY, TLS and QUIC inbounds and
// checks the failure explanations for a closed port and a wrong SNI.
func TestConnectivityProbe(t *testing.T) {
	e := newEnv(t)
	target := blob(t)
	e.api.do("PUT", "/api/probe/settings", map[string]any{"url": "http://" + target + "/?n=204", "fallback_url": ""}, nil)
	e.createUser(map[string]any{"username": "probe-bystander"})

	c, k, _ := pemPair(t, "sb.test", 90)
	var up struct{ ID string }
	e.api.do("POST", "/api/certs/upload", map[string]any{"cert_pem": c, "key_pem": k}, &up)

	reality := e.createInbound("vr", "vless", e.realityOpts(freePort(t)), nil)
	tj := e.createInbound("tj", "trojan", map[string]any{"listen": "127.0.0.1", "listen_port": freePort(t), "_cert": up.ID,
		"tls": map[string]any{"enabled": true, "server_name": "sb.test"}}, nil)
	hy := e.createInbound("hy", "hysteria2", map[string]any{"listen": "127.0.0.1", "listen_port": freeUDPPort(t), "_cert": up.ID,
		"tls": map[string]any{"enabled": true, "server_name": "sb.test", "alpn": []string{"h3"}}}, nil)
	bad := e.createInbound("tj-bad", "trojan", map[string]any{"listen": "127.0.0.1", "listen_port": freePort(t), "_cert": up.ID,
		"tls": map[string]any{"enabled": true, "server_name": "sb.test"}}, nil)
	closed := freePort(t)
	e.api.do("POST", "/api/hosts", map[string]any{"inbound_id": bad, "remark": "closed", "port": closed}, nil)
	e.api.do("POST", "/api/hosts", map[string]any{"inbound_id": bad, "remark": "wrong-sni", "sni": "wrong.test"}, nil)
	e.waitApplied()

	for name, id := range map[string]int64{"reality": reality, "tls": tj, "hysteria2": hy} {
		rs := e.probe(id)
		if len(rs) != 1 || !rs[0].OK || rs[0].TotalMs <= 0 {
			t.Fatalf("%s probe: %+v", name, rs)
		}
		last := rs[0].Stages[len(rs[0].Stages)-1]
		if last.Name != "proxy" || !last.OK {
			t.Fatalf("%s stages %+v", name, rs[0].Stages)
		}
		t.Logf("%s: %d ms %+v", name, rs[0].TotalMs, rs[0].Stages)
	}
	rs := e.probe(bad)
	if len(rs) != 2 {
		t.Fatalf("bad endpoints %+v", rs)
	}
	for _, r := range rs {
		switch {
		case strings.HasSuffix(r.Endpoint, fmt.Sprint(closed)):
			if r.OK || r.Stage != "tcp" || !strings.Contains(r.Error, "端口未开放") {
				t.Fatalf("closed port: %+v", r)
			}
		default:
			if r.OK || r.Stage != "tls" || !strings.Contains(r.Error, "SNI 与证书不匹配") || !strings.Contains(r.Error, "wrong.test") {
				t.Fatalf("wrong sni: %+v", r)
			}
		}
		t.Logf("%s: %s", r.Endpoint, r.Error)
	}
	// REALITY with a client SNI the server doesn't accept
	e.api.do("POST", "/api/hosts", map[string]any{"inbound_id": reality, "remark": "bad-sni", "sni": "not-allowed.test"}, nil)
	rs = e.probe(reality)
	if len(rs) != 1 || rs[0].OK || !strings.Contains(rs[0].Error, "REALITY") {
		t.Fatalf("reality wrong sni: %+v", rs)
	}
	t.Logf("reality bad sni: %s (%s)", rs[0].Error, rs[0].Raw)

	// results are cached; the probe user never shows up as a user, online or in traffic
	var cached []probeRes
	e.api.do("GET", "/api/probe/results", nil, &cached)
	if len(cached) != 5 {
		t.Fatalf("cached %d", len(cached))
	}
	var users []map[string]any
	e.api.do("GET", "/api/users", nil, &users)
	b, _ := json.Marshal(users)
	if len(users) != 1 || strings.Contains(string(b), "__probe") {
		t.Fatalf("users %s", b)
	}
	var evs []struct{ Kind, Detail string }
	e.api.do("GET", "/api/events", nil, &evs)
	unreachable := false
	for _, ev := range evs {
		if ev.Kind == "inbound_unreachable" && strings.Contains(ev.Detail, "vr") {
			unreachable = true
		}
	}
	if !unreachable {
		t.Fatalf("no inbound_unreachable event: %+v", evs)
	}
}

// A relay inbound whose upstream is down must be reported as an outbound /
// upstream failure, not as the inbound rejecting the probe.
func TestProbeUpstreamDown(t *testing.T) {
	e := newEnv(t)
	target := blob(t)
	e.api.do("PUT", "/api/probe/settings", map[string]any{"url": "http://" + target + "/?n=204", "fallback_url": ""}, nil)
	c, k, _ := pemPair(t, "sb.test", 90)
	var up struct{ ID string }
	e.api.do("POST", "/api/certs/upload", map[string]any{"cert_pem": c, "key_pem": k}, &up)
	relay := e.createInbound("tj-up", "trojan", map[string]any{"listen": "127.0.0.1", "listen_port": freePort(t), "_cert": up.ID,
		"tls": map[string]any{"enabled": true, "server_name": "sb.test"}}, nil)

	var tpls []struct {
		ID   int64  `json:"id"`
		JSON string `json:"json"`
	}
	e.api.do("GET", "/api/templates", nil, &tpls)
	var tpl map[string]any
	if err := json.Unmarshal([]byte(tpls[0].JSON), &tpl); err != nil {
		t.Fatal(err)
	}
	tpl["outbounds"] = append(tpl["outbounds"].([]any), map[string]any{"type": "socks", "tag": "dead-up", "server": "127.0.0.1", "server_port": freePort(t)})
	route := tpl["route"].(map[string]any)
	rules, _ := route["rules"].([]any)
	route["rules"] = append([]any{map[string]any{"inbound": []string{"tj-up"}, "outbound": "dead-up"}}, rules...)
	draft, _ := json.Marshal(tpl)
	e.api.do("PATCH", fmt.Sprintf("/api/templates/%d", tpls[0].ID), map[string]any{"draft": string(draft)}, nil)
	e.api.do("POST", fmt.Sprintf("/api/templates/%d/apply", tpls[0].ID), nil, nil)
	e.waitApplied()

	rs := e.probe(relay)
	if len(rs) != 1 || rs[0].OK || rs[0].Stage != "proxy" || !strings.Contains(rs[0].Error, "出站「dead-up」") {
		t.Fatalf("upstream down: %+v", rs)
	}
	t.Logf("upstream down: %s", rs[0].Error)
	// the probe's sightings stay out of the live connection list
	var conns struct {
		Conns []map[string]any `json:"conns"`
	}
	e.api.do("GET", "/api/nodes/"+e.nodeID+"/conns", nil, &conns)
	if b, _ := json.Marshal(conns); strings.Contains(string(b), "__probe") {
		t.Fatalf("probe in conns: %s", b)
	}
}
