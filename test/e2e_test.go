package test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
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
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

type api struct {
	t    *testing.T
	base string
	hc   *http.Client
}

func (a *api) do(method, path string, body any, out any) {
	a.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, a.base+path, r)
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.hc.Do(req)
	if err != nil {
		a.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		a.t.Fatalf("%s %s: %d %s", method, path, resp.StatusCode, b)
	}
	if out != nil {
		if err := json.Unmarshal(b, out); err != nil {
			a.t.Fatalf("decode %s: %v (%s)", path, err, b)
		}
	}
}

type masterProc struct {
	cancel context.CancelFunc
	done   chan error
}

func startMaster(t *testing.T, dir string, webPort, grpcPort int) *masterProc {
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
	// wait for web port
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
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

// realityTarget is a local TLS 1.3 server that REALITY borrows a handshake from,
// so the test needs no internet access.
func realityTarget(t *testing.T) (port int, stop func()) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "target.test"},
		DNSNames: []string{"target.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{MinVersion: tls.VersionTLS13,
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}})
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })}
	go srv.Serve(ln)
	return ln.Addr().(*net.TCPAddr).Port, func() { srv.Close() }
}

func TestEndToEnd(t *testing.T) {
	dir := t.TempDir()
	webPort, grpcPort, inPort, clientPort := freePort(t), freePort(t), freePort(t), freePort(t)
	mp := startMaster(t, dir+"/master", webPort, grpcPort)
	defer func() { mp.stop() }()

	jar, _ := cookiejar.New(nil)
	a := &api{t: t, base: fmt.Sprintf("http://127.0.0.1:%d", webPort), hc: &http.Client{Jar: jar, Timeout: 30 * time.Second}}
	a.do("POST", "/api/auth/login", map[string]string{"username": "admin", "password": "test-pass"}, nil)

	// M0: enroll a node over mTLS
	var en struct {
		NodeID   string `json:"node_id"`
		Token    string `json:"token"`
		Master   string `json:"master"`
		CASHA256 string `json:"ca_sha256"`
	}
	a.do("POST", "/api/nodes", map[string]string{"name": "local"}, &en)
	ndir := dir + "/node"
	if err := node.Enroll(ndir, en.Master, en.Token, en.CASHA256); err != nil {
		t.Fatal(err)
	}
	if err := node.Enroll(dir+"/node2", en.Master, en.Token, en.CASHA256); err == nil {
		t.Fatal("token reuse must fail")
	}
	agent, err := node.NewAgent(node.Config{Dir: ndir, Window: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	actx, acancel := context.WithCancel(context.Background())
	adone := make(chan struct{})
	go func() { agent.Run(actx); close(adone) }()
	defer func() { acancel(); <-adone }()

	type nodeRow struct {
		ID              string `json:"id"`
		Online          bool   `json:"online"`
		Revision        uint64 `json:"revision"`
		AppliedRevision uint64 `json:"applied_revision"`
		ApplyError      string `json:"apply_error"`
	}
	nodeState := func() nodeRow {
		var ns []nodeRow
		a.do("GET", "/api/nodes", nil, &ns)
		return ns[0]
	}
	waitFor(t, "node online", 10*time.Second, func() bool { return nodeState().Online })

	// user + VLESS REALITY inbound
	var u struct{ ID int64 }
	a.do("POST", "/api/users", map[string]any{"username": "alice"}, &u)
	var kp struct{ PrivateKey, PublicKey, ShortID string }
	var kpRaw map[string]string
	a.do("POST", "/api/tools/reality-keypair", nil, &kpRaw)
	kp.PrivateKey, kp.PublicKey, kp.ShortID = kpRaw["private_key"], kpRaw["public_key"], kpRaw["short_id"]
	tgtPort, stopTgt := realityTarget(t)
	defer stopTgt()
	a.do("POST", "/api/inbounds", map[string]any{
		"node_id": en.NodeID, "tag": "vless-reality", "type": "vless",
		"options": map[string]any{
			"listen": "127.0.0.1", "listen_port": inPort, "_flow": "xtls-rprx-vision",
			"tls": map[string]any{"enabled": true, "server_name": "target.test",
				"reality": map[string]any{"enabled": true, "private_key": kp.PrivateKey, "short_id": []string{kp.ShortID},
					"handshake": map[string]any{"server": "127.0.0.1", "server_port": tgtPort}}},
		},
	}, nil)
	waitFor(t, "spec applied", 15*time.Second, func() bool {
		s := nodeState()
		if s.ApplyError != "" {
			t.Fatalf("apply error: %s", s.ApplyError)
		}
		return s.Revision > 0 && s.AppliedRevision == s.Revision
	})
	var ud struct {
		User struct {
			UUID     string `json:"uuid"`
			UsedUp   int64  `json:"used_up"`
			UsedDown int64  `json:"used_down"`
		} `json:"user"`
	}
	a.do("GET", "/api/users/"+strconv.FormatInt(u.ID, 10), nil, &ud)

	// client: mixed proxy -> vless reality
	cctx := include.Context(context.Background())
	var copts option.Options
	ccfg := fmt.Sprintf(`{"log":{"level":"error"},
	  "inbounds":[{"type":"mixed","listen":"127.0.0.1","listen_port":%d}],
	  "outbounds":[{"type":"vless","server":"127.0.0.1","server_port":%d,"uuid":%q,"flow":"xtls-rprx-vision",
	    "tls":{"enabled":true,"server_name":"target.test","utls":{"enabled":true,"fingerprint":"chrome"},
	      "reality":{"enabled":true,"public_key":%q,"short_id":%q}}}]}`, clientPort, inPort, ud.User.UUID, kp.PublicKey, kp.ShortID)
	if err := sjson.UnmarshalContext(cctx, []byte(ccfg), &copts); err != nil {
		t.Fatal(err)
	}
	client, err := box.New(box.Options{Context: cctx, Options: copts})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Start(); err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	blob := http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("n"))
		w.Header().Set("Content-Length", strconv.Itoa(n))
		buf := make([]byte, 64<<10)
		for n > 0 {
			k := min(n, len(buf))
			w.Write(buf[:k])
			n -= k
		}
	})}
	bl, _ := net.Listen("tcp", "127.0.0.1:0")
	go blob.Serve(bl)
	defer blob.Close()
	pu, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", clientPort))
	fetchIP := func(n int) {
		hc := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(pu), DisableKeepAlives: true}, Timeout: 120 * time.Second}
		resp, err := hc.Get(fmt.Sprintf("http://127.0.0.1:%d/?n=%d", bl.Addr().(*net.TCPAddr).Port, n))
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if got != int64(n) {
			t.Fatalf("got %d bytes, want %d", got, n)
		}
	}

	const size = 100 << 20
	fetchIP(size)
	usage := func() (int64, int64) {
		a.do("GET", "/api/users/"+strconv.FormatInt(u.ID, 10), nil, &ud)
		return ud.User.UsedUp, ud.User.UsedDown
	}
	settle := func(what string) {
		waitFor(t, what, 20*time.Second, func() bool {
			nu, nd := agent.Totals()
			mu, md := usage()
			return agent.Backlog() == 0 && mu == nu && md == nd && nd > 0
		})
	}
	settle("master usage == node counters")
	up1, down1 := usage()
	t.Logf("after 100MiB: master up=%d down=%d (payload %d, overhead %d)", up1, down1, size, down1-size)
	if down1 < size || down1 > size+size/100 {
		t.Fatalf("down %d not within [payload, payload+1%%]", down1)
	}

	// master outage: traffic keeps flowing, reports spool on the node, nothing is lost
	mp.stop()
	fetchIP(50 << 20)
	time.Sleep(3 * time.Second)
	if agent.Backlog() == 0 {
		t.Fatal("expected spooled reports while master is down")
	}
	t.Logf("master down, node backlog=%d", agent.Backlog())
	mp = startMaster(t, dir+"/master", webPort, grpcPort)
	a.do("POST", "/api/auth/login", map[string]string{"username": "admin", "password": "test-pass"}, nil)
	settle("backlog drained after master restart")
	up2, down2 := usage()
	nu, nd := agent.Totals()
	t.Logf("after outage: master up=%d down=%d, node up=%d down=%d", up2, down2, nu, nd)
	if down2-down1 < 50<<20 {
		t.Fatalf("lost traffic during outage: delta %d", down2-down1)
	}

	// analysis dimensions: destination host recorded with bytes
	var top []struct {
		Key  string `json:"key"`
		Down int64  `json:"down"`
	}
	a.do("GET", "/api/traffic/top?dim=host", nil, &top)
	if len(top) == 0 || top[0].Key != "127.0.0.1" || top[0].Down != down2 {
		t.Fatalf("unexpected host ranking: %+v", top)
	}
	var series struct {
		Series []struct {
			Down int64 `json:"down"`
		} `json:"series"`
	}
	a.do("GET", "/api/traffic/series?step=60&group=user&from="+strconv.FormatInt(time.Now().Add(-time.Hour).Unix(), 10), nil, &series)
	if len(series.Series) != 1 || series.Series[0].Down != down2 {
		t.Fatalf("series mismatch: %+v", series)
	}

	// quota: limit below current usage -> user removed from the node, live conns cut
	a.do("PATCH", "/api/users/"+strconv.FormatInt(u.ID, 10), map[string]any{"traffic_limit": 1 << 20}, nil)
	waitFor(t, "user disabled on node", 15*time.Second, func() bool {
		s := nodeState()
		return s.AppliedRevision == s.Revision
	})
	hc := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(pu), DisableKeepAlives: true}, Timeout: 5 * time.Second}
	if resp, err := hc.Get(fmt.Sprintf("http://127.0.0.1:%d/?n=10", bl.Addr().(*net.TCPAddr).Port)); err == nil {
		resp.Body.Close()
		if resp.StatusCode == 200 {
			t.Fatal("limited user still has access")
		}
	}
	var evs []struct{ Kind string }
	a.do("GET", "/api/events", nil, &evs)
	found := false
	for _, e := range evs {
		found = found || e.Kind == "quota_exceeded"
	}
	if !found {
		t.Fatal("no quota_exceeded event")
	}
}
