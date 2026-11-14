package test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/include"
	"github.com/sagernet/sing-box/option"
	sjson "github.com/sagernet/sing/common/json"

	"sbpanel/internal/master"
	"sbpanel/internal/node"
)

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// freeUDPPort finds a port free for both TCP and UDP (QUIC inbounds).
func freeUDPPort(t *testing.T) int {
	t.Helper()
	for i := 0; i < 20; i++ {
		p := freePort(t)
		u, err := net.ListenPacket("udp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			u.Close()
			return p
		}
	}
	t.Fatal("no free udp port")
	return 0
}

type api struct {
	t    *testing.T
	base string
	hc   *http.Client
	auth string
}

// call returns status and body without failing the test.
func (a *api) call(method, path string, body any) (int, []byte) {
	a.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, a.base+path, r)
	req.Header.Set("Content-Type", "application/json")
	if a.auth != "" {
		req.Header.Set("Authorization", a.auth)
	}
	resp, err := a.hc.Do(req)
	if err != nil {
		a.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func (a *api) do(method, path string, body any, out any) {
	a.t.Helper()
	code, b := a.call(method, path, body)
	if code != 200 {
		a.t.Fatalf("%s %s: %d %s", method, path, code, b)
	}
	if out != nil {
		if err := json.Unmarshal(b, out); err != nil {
			a.t.Fatalf("decode %s: %v (%s)", path, err, b)
		}
	}
}

func (a *api) expect(code int, method, path string, body any) string {
	a.t.Helper()
	got, b := a.call(method, path, body)
	if got != code {
		a.t.Fatalf("%s %s: got %d want %d: %s", method, path, got, code, b)
	}
	return string(b)
}

type masterProc struct {
	cancel context.CancelFunc
	done   chan error
}

func startMaster(t *testing.T, dir string, webPort, grpcPort int) *masterProc {
	t.Helper()
	m, err := master.New(master.Config{
		DataDir: dir, WebListen: fmt.Sprintf("127.0.0.1:%d", webPort), GRPCListen: fmt.Sprintf("127.0.0.1:%d", grpcPort),
		AdminPassword: "test-pass",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &masterProc{cancel: cancel, done: make(chan error, 1)}
	go func() { p.done <- m.Run(ctx) }()
	for i := 0; i < 100; i++ {
		if c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", webPort)); err == nil {
			c.Close()
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	return p
}

func (p *masterProc) stop() { p.cancel(); <-p.done }

func waitFor(t *testing.T, what string, timeout time.Duration, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

type agentProc struct {
	a      *node.Agent
	dir    string
	cancel context.CancelFunc
	done   chan struct{}
}

func (p *agentProc) stop() { p.cancel(); <-p.done }

type env struct {
	t                 *testing.T
	dir               string
	webPort, grpcPort int
	m                 *masterProc
	api               *api
	nodeID            string
	agent             *agentProc
	cert, key         string // self-signed for sb.test
}

type enrollInfo struct {
	NodeID   string `json:"node_id"`
	Token    string `json:"token"`
	Master   string `json:"master"`
	CASHA256 string `json:"ca_sha256"`
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{t: t, dir: t.TempDir(), webPort: freePort(t), grpcPort: freePort(t)}
	e.m = startMaster(t, e.dir+"/master", e.webPort, e.grpcPort)
	t.Cleanup(func() { e.m.stop() })
	jar, _ := cookiejar.New(nil)
	e.api = &api{t: t, base: fmt.Sprintf("http://127.0.0.1:%d", e.webPort), hc: &http.Client{Jar: jar, Timeout: 60 * time.Second}}
	e.login()
	var en enrollInfo
	e.api.do("POST", "/api/nodes", map[string]string{"name": "local"}, &en)
	e.nodeID = en.NodeID
	e.agent = e.startAgent(en, "node")
	t.Cleanup(func() { e.agent.stop() })
	e.waitOnline(e.nodeID)
	e.cert, e.key = selfSigned(t, e.dir, "sb.test")
	return e
}

func (e *env) login() {
	e.api.do("POST", "/api/auth/login", map[string]string{"username": "admin", "password": "test-pass"}, nil)
}

func (e *env) startAgent(en enrollInfo, name string) *agentProc {
	e.t.Helper()
	dir := filepath.Join(e.dir, name)
	if err := node.Enroll(dir, en.Master, en.Token, en.CASHA256); err != nil {
		e.t.Fatal(err)
	}
	a, err := node.NewAgent(node.Config{Dir: dir, Window: time.Second})
	if err != nil {
		e.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &agentProc{a: a, dir: dir, cancel: cancel, done: make(chan struct{})}
	go func() { a.Run(ctx); close(p.done) }()
	return p
}

type nodeRow struct {
	ID              string `json:"id"`
	Online          bool   `json:"online"`
	Revision        uint64 `json:"revision"`
	AppliedRevision uint64 `json:"applied_revision"`
	ApplyError      string `json:"apply_error"`
}

func (e *env) node(id string) nodeRow {
	var ns []nodeRow
	e.api.do("GET", "/api/nodes", nil, &ns)
	for _, n := range ns {
		if n.ID == id {
			return n
		}
	}
	return nodeRow{}
}

func (e *env) waitOnline(id string) {
	waitFor(e.t, "node online", 15*time.Second, func() bool { return e.node(id).Online })
}

// waitApplied waits until the node runs the newest revision (fails on apply errors).
func (e *env) waitApplied() {
	e.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		n := e.node(e.nodeID)
		if n.Revision > 0 && n.AppliedRevision == n.Revision {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
	e.t.Fatalf("spec not applied: %+v", e.node(e.nodeID))
}

func (e *env) createUser(body map[string]any) int64 {
	e.t.Helper()
	var r struct{ ID int64 }
	e.api.do("POST", "/api/users", body, &r)
	return r.ID
}

func (e *env) createInbound(tag, typ string, opts map[string]any, client map[string]any) int64 {
	e.t.Helper()
	var r struct{ ID int64 }
	if client == nil {
		client = map[string]any{}
	}
	e.api.do("POST", "/api/inbounds", map[string]any{"node_id": e.nodeID, "tag": tag, "type": typ, "options": opts, "client": client}, &r)
	return r.ID
}

func (e *env) tlsFiles() map[string]any {
	return map[string]any{"enabled": true, "server_name": "sb.test", "certificate_path": e.cert, "key_path": e.key}
}

type userDetail struct {
	User struct {
		UUID     string `json:"uuid"`
		Status   string `json:"status"`
		UsedUp   int64  `json:"used_up"`
		UsedDown int64  `json:"used_down"`
		LifeUp   int64  `json:"life_up"`
		LifeDown int64  `json:"life_down"`
	} `json:"user"`
}

func (e *env) user(id int64) userDetail {
	var d userDetail
	e.api.do("GET", "/api/users/"+strconv.FormatInt(id, 10), nil, &d)
	return d
}

// subOutbounds fetches the user's sing-box subscription and returns outbounds by tag.
func (e *env) subOutbounds(id int64) map[string]json.RawMessage {
	e.t.Helper()
	var s struct {
		URL   string `json:"url"`
		Links []struct {
			Remark string `json:"remark"`
		} `json:"links"`
	}
	e.api.do("GET", fmt.Sprintf("/api/users/%d/sub", id), nil, &s)
	resp, err := http.Get(s.URL + "?format=singbox")
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var cfg struct {
		Outbounds []json.RawMessage `json:"outbounds"`
	}
	json.NewDecoder(resp.Body).Decode(&cfg)
	out := map[string]json.RawMessage{}
	for _, o := range cfg.Outbounds {
		var h struct{ Tag string }
		json.Unmarshal(o, &h)
		out[h.Tag] = o
	}
	return out
}

// client runs a local sing-box with a mixed inbound and one outbound; returns the proxy URL.
func client(t *testing.T, outbound json.RawMessage) string {
	t.Helper()
	port := freePort(t)
	cfg := fmt.Sprintf(`{"log":{"level":"error"},"inbounds":[{"type":"mixed","listen":"127.0.0.1","listen_port":%d}],"outbounds":[%s]}`, port, outbound)
	ctx := include.Context(context.Background())
	var opts option.Options
	if err := sjson.UnmarshalContext(ctx, []byte(cfg), &opts); err != nil {
		t.Fatalf("client config: %v\n%s", err, cfg)
	}
	inst, err := box.New(box.Options{Context: ctx, Options: opts})
	if err != nil {
		t.Fatal(err)
	}
	if err := inst.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inst.Close() })
	return fmt.Sprintf("http://127.0.0.1:%d", port)
}

// blob serves ?n=bytes, optionally slowly (?slow=ms per 64 KiB chunk).
func blob(t *testing.T) string {
	t.Helper()
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("n"))
		slow, _ := strconv.Atoi(r.URL.Query().Get("slow"))
		w.Header().Set("Content-Length", strconv.Itoa(n))
		buf := make([]byte, 64<<10)
		for n > 0 {
			k := min(n, len(buf))
			if _, err := w.Write(buf[:k]); err != nil {
				return
			}
			n -= k
			if slow > 0 {
				w.(http.Flusher).Flush()
				time.Sleep(time.Duration(slow) * time.Millisecond)
			}
		}
	})}
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	go srv.Serve(l)
	t.Cleanup(func() { srv.Close() })
	return l.Addr().String()
}

// fetch downloads through proxy and returns bytes read.
func fetch(proxy, target string, n int, extra string, timeout time.Duration) (int64, error) {
	pu, _ := url.Parse(proxy)
	hc := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(pu), DisableKeepAlives: true}, Timeout: timeout}
	resp, err := hc.Get(fmt.Sprintf("http://%s/?n=%d%s", target, n, extra))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("status %d", resp.StatusCode)
	}
	got, err := io.Copy(io.Discard, resp.Body)
	if err == nil && got != int64(n) {
		err = fmt.Errorf("short read %d/%d", got, n)
	}
	return got, err
}

// settle waits until every byte the node counted is in the master.
func (e *env) settle(ids ...int64) {
	e.t.Helper()
	waitFor(e.t, "master usage == node counters", 30*time.Second, func() bool {
		nu, nd := e.agent.a.Totals()
		var mu, md int64
		for _, id := range ids {
			u := e.user(id).User
			mu += u.LifeUp
			md += u.LifeDown
		}
		return e.agent.a.Backlog() == 0 && mu == nu && md == nd && nd > 0
	})
}

func selfSigned(t *testing.T, dir, name string) (certPath, keyPath string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	kd, _ := x509.MarshalPKCS8PrivateKey(key)
	certPath, keyPath = filepath.Join(dir, name+".crt"), filepath.Join(dir, name+".key")
	os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kd}), 0o600)
	return
}

// realityTarget is a local TLS 1.3 server that REALITY borrows a handshake from.
func realityTarget(t *testing.T) int {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "target.test"},
		DNSNames: []string{"target.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{MinVersion: tls.VersionTLS13,
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}})
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) }), ErrorLog: nullLog}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return ln.Addr().(*net.TCPAddr).Port
}

func (e *env) realityOpts(port int) map[string]any {
	var kp map[string]string
	e.api.do("POST", "/api/tools/reality-keypair", nil, &kp)
	tgt := realityTarget(e.t)
	return map[string]any{
		"listen": "127.0.0.1", "listen_port": port, "_flow": "xtls-rprx-vision",
		"tls": map[string]any{"enabled": true, "server_name": "target.test",
			"reality": map[string]any{"enabled": true, "private_key": kp["private_key"], "short_id": []string{kp["short_id"]},
				"handshake": map[string]any{"server": "127.0.0.1", "server_port": tgt}}},
	}
}

var nullLog = log.New(io.Discard, "", 0)

func containsStr(s, sub string) bool { return strings.Contains(s, sub) }
func replaceAll(s, a, b string) string  { return strings.ReplaceAll(s, a, b) }
