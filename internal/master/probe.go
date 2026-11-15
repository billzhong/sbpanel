package master

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/sagernet/quic-go"
	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/include"
	"github.com/sagernet/sing-box/option"
	sjson "github.com/sagernet/sing/common/json"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"

	"sbpanel/internal/subgen"
)

// The master links sing-box only for this: it runs a throw-away client per probe
// that speaks exactly what a subscription hands out (protocol, TLS/REALITY,
// transport) and fetches a URL through the inbound. The probe signs in as a
// hidden per-node user that buildSpec injects into every inbound.

// probeUser is the reserved sing-box user name of the probe (node.ProbeUser). It is
// not numeric, so it can never collide with a panel user id.
const probeUser = "__probe"

const (
	defaultProbeURL      = "https://www.gstatic.com/generate_204"
	defaultProbeFallback = "https://cp.cloudflare.com/generate_204"
)

// probeCreds derives the probe user's UUID and password for a node from a secret
// kept in settings, so they are stable across restarts without another table.
func probeCreds(db *sql.DB, nodeID string) (uuid, password string) {
	sec, ok := getSetting(db, "probe_secret")
	if !ok || sec == "" {
		sec = randHex(32)
		db.Exec(`INSERT INTO settings(k,v) VALUES('probe_secret',?) ON CONFLICT(k) DO NOTHING`, sec)
		sec, _ = getSetting(db, "probe_secret")
	}
	mac := hmac.New(sha256.New, []byte(sec))
	mac.Write([]byte("probe:" + nodeID))
	b := mac.Sum(nil)
	u := b[:16]
	u[6] = (u[6] & 0x0f) | 0x40
	u[8] = (u[8] & 0x3f) | 0x80
	h := hex.EncodeToString(u)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32], hex.EncodeToString(b[16:32])
}

// ---------- results ----------

type probeStage struct {
	Name   string `json:"name"`  // dns | tcp | quic | tls | handshake | proxy
	Label  string `json:"label"` // shown in the timeline
	OK     bool   `json:"ok"`
	Skip   bool   `json:"skip,omitempty"`
	Ms     int64  `json:"ms"`
	Detail string `json:"detail,omitempty"`
}

type probeResult struct {
	InboundID int64        `json:"inbound_id"`
	Tag       string       `json:"tag"`
	NodeID    string       `json:"node_id"`
	Node      string       `json:"node"`
	Endpoint  string       `json:"endpoint"` // address:port as in the subscription
	Remark    string       `json:"remark"`
	Type      string       `json:"type"`
	Security  string       `json:"security"`
	SNI       string       `json:"sni"`
	OK        bool         `json:"ok"`
	Stage     string       `json:"stage,omitempty"` // first failed stage
	Error     string       `json:"error,omitempty"` // explanation (English; localized per request by localizeProbe)
	Raw       string       `json:"raw,omitempty"`   // underlying error
	Stages    []probeStage `json:"stages"`
	TotalMs   int64        `json:"total_ms"`
	URL       string       `json:"url"`
	TS        int64        `json:"ts"`
}

// ---------- error explanations ----------

func isTimeout(err error) bool {
	var ne net.Error
	return errors.Is(err, context.DeadlineExceeded) || errors.As(err, &ne) && ne.Timeout() ||
		strings.Contains(err.Error(), "timeout") || strings.Contains(err.Error(), "deadline exceeded")
}

func explainDial(err error, ep string) string {
	switch {
	case errors.Is(err, syscall.ECONNREFUSED) || strings.Contains(err.Error(), "connection refused"):
		return fmt.Sprintf("Port closed: %s refused the connection (the inbound isn't listening, or the port is wrong)", ep)
	case isTimeout(err):
		return fmt.Sprintf("Connection timed out: %s didn't respond; a firewall / security group may be filtering the port, or the address is unreachable", ep)
	case strings.Contains(err.Error(), "no route") || strings.Contains(err.Error(), "unreachable"):
		return fmt.Sprintf("Network unreachable: no route from the master to %s", ep)
	}
	return fmt.Sprintf("Connection failed: %v", err)
}

func explainTLS(err error, sni string) string {
	var he x509.HostnameError
	var ue x509.UnknownAuthorityError
	var ce x509.CertificateInvalidError
	switch {
	case errors.As(err, &he):
		names := strings.Join(he.Certificate.DNSNames, ", ")
		if names == "" {
			names = he.Certificate.Subject.CommonName
		}
		return fmt.Sprintf("SNI doesn't match the certificate: it doesn't cover %s (certificate names: %s)", sni, names)
	case errors.As(err, &ue):
		return "Untrusted certificate: self-signed or missing intermediates (import the certificate into the panel, or allow insecure in the client)"
	case errors.As(err, &ce) && ce.Reason == x509.Expired:
		return "The certificate has expired or is not valid yet"
	case isTimeout(err):
		return "TLS handshake timed out: the port accepts connections but doesn't answer TLS (wrong protocol or port?)"
	case strings.Contains(err.Error(), "first record does not look like a TLS handshake"):
		return "Not TLS: the service on this port doesn't speak TLS"
	case strings.Contains(err.Error(), "EOF") || strings.Contains(err.Error(), "reset"):
		return "TLS handshake closed by the server: the SNI isn't accepted, or the inbound isn't TLS"
	}
	return fmt.Sprintf("TLS handshake failed: %v", err)
}

func explainProxy(err error, e subEntry) string {
	s := err.Error()
	switch {
	case e.Security == "reality" && (strings.Contains(s, "reality") || strings.Contains(s, "REALITY") || strings.Contains(s, "x509") || strings.Contains(s, "certificate")):
		// a failed REALITY auth makes the server relay the camouflage site, whose real
		// certificate the client then rejects
		return "REALITY authentication failed: public key / short_id mismatch, or the SNI isn't in the server's server_names (the server relayed the connection to the camouflage site)"
	case strings.Contains(s, "x509") || strings.Contains(s, "certificate"):
		return explainTLS(err, e.SNI)
	case isTimeout(err):
		return "Proxy request timed out: connected to the inbound, but the probe URL didn't respond through the node (restricted egress on the node, or silently dropped after failed authentication)"
	case strings.Contains(s, "EOF") || strings.Contains(s, "reset by peer") || strings.Contains(s, "closed"):
		return "The inbound closed the connection: authentication failed (probe user not deployed to the node yet?) or the protocol / transport settings differ from the client's"
	case strings.Contains(s, "no such host"):
		return "The node can't resolve the probe URL's domain (DNS problem on the node)"
	}
	return fmt.Sprintf("Proxy request failed: %s", s)
}

// ---------- the probe ----------

type prober struct {
	m        *Master
	running  atomic.Bool // periodic run in progress
	lastAuto time.Time
	mu       sync.Mutex
	// test hooks
	timeout time.Duration
}

func newProber(m *Master) *prober { return &prober{m: m, timeout: 12 * time.Second} }

func (p *prober) urls() []string {
	u := settingOr(p.m.db, "probe_url", defaultProbeURL)
	f := settingOr(p.m.db, "probe_fallback_url", defaultProbeFallback)
	out := []string{u}
	if f != "" && f != u {
		out = append(out, f)
	}
	return out
}

func since(t time.Time) int64 { return time.Since(t).Milliseconds() }

var udpTypes = map[string]bool{"hysteria2": true, "tuic": true}

// probeEntry tests one client endpoint stage by stage. pinPEM, when set, is the
// panel certificate the inbound serves; it is trusted as-is (self-signed or
// staging certificates are fine), while the SNI must still match it.
// static inbounds (own key, no probe user) are only tested up to the transport.
func (p *prober) probeEntry(ctx context.Context, e subEntry, pinPEM []byte, urls []string, static bool) probeResult {
	start := time.Now()
	ep := hostPort(e.Address, e.Port)
	r := probeResult{Endpoint: ep, Remark: e.Remark, Type: e.Type, Security: e.Security, SNI: e.SNI, TS: now()}
	fail := func(stage, msg string, err error) probeResult {
		r.Stage, r.Error = stage, msg
		if err != nil {
			r.Raw = err.Error()
		}
		r.TotalMs = since(start)
		return r
	}
	add := func(s probeStage) { r.Stages = append(r.Stages, s) }
	if e.Address == "" {
		return fail("dns", "The node has no usable address: set a public address in the node settings, or add a host to the inbound", nil)
	}

	// 1. DNS
	ip := e.Address
	if net.ParseIP(strings.Trim(e.Address, "[]")) != nil {
		add(probeStage{Name: "dns", Label: "DNS", OK: true, Skip: true, Detail: "IP address, no lookup needed"})
	} else {
		t := time.Now()
		dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		addrs, err := net.DefaultResolver.LookupIPAddr(dctx, e.Address)
		cancel()
		if err != nil || len(addrs) == 0 {
			add(probeStage{Name: "dns", Label: "DNS", Ms: since(t)})
			msg := fmt.Sprintf("DNS lookup failed: %s has no A/AAAA record (check that the DNS record exists and has propagated)", e.Address)
			if err != nil && isTimeout(err) {
				msg = fmt.Sprintf("DNS lookup timed out: %s", e.Address)
			}
			return fail("dns", msg, err)
		}
		ip = addrs[0].IP.String()
		var list []string
		for _, a := range addrs {
			list = append(list, a.IP.String())
		}
		detail := strings.Join(list, ", ")
		if a := addrs[0].IP; a.To4() != nil && a[len(a)-4] == 198 && a[len(a)-3]&0xfe == 18 {
			detail += " · " + "This is a fake-ip address: the master's machine runs a proxy in TUN / fake-ip mode, so results don't reflect the real route"
		}
		add(probeStage{Name: "dns", Label: "DNS", OK: true, Ms: since(t), Detail: detail})
	}
	target := hostPort(ip, e.Port)

	// 2. transport: TCP connect, or a QUIC handshake for QUIC-based protocols
	var pool *x509.CertPool
	var pinFP string
	if len(pinPEM) > 0 {
		pool = x509.NewCertPool()
		pool.AppendCertsFromPEM(pinPEM)
		if blk, _ := pem.Decode(pinPEM); blk != nil {
			sum := sha256.Sum256(blk.Bytes)
			pinFP = hex.EncodeToString(sum[:])
		}
	}
	sni := e.SNI
	if sni == "" && net.ParseIP(e.Address) == nil {
		sni = e.Address
	}
	tlsConf := &tls.Config{ServerName: sni, NextProtos: e.ALPN, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}
	var certDetail string
	verify := func(cs tls.ConnectionState) error {
		if len(cs.PeerCertificates) == 0 {
			return errors.New("no certificate")
		}
		leaf := cs.PeerCertificates[0]
		sum := sha256.Sum256(leaf.Raw)
		pinned := pinFP != "" && hex.EncodeToString(sum[:]) == pinFP
		left := int(time.Until(leaf.NotAfter).Hours() / 24)
		certDetail = fmt.Sprintf("Certificate %s", strings.Join(leafInfo(leaf).SANs, ", ")) + " · " + fmt.Sprintf("%d days left", left)
		if !pinned && !e.Insecure {
			inter := x509.NewCertPool()
			for _, c := range cs.PeerCertificates[1:] {
				inter.AddCert(c)
			}
			if _, err := leaf.Verify(x509.VerifyOptions{Intermediates: inter, Roots: nil}); err != nil {
				if pool == nil {
					return err
				}
				if _, err2 := leaf.Verify(x509.VerifyOptions{Intermediates: inter, Roots: pool}); err2 != nil {
					return err
				}
			}
		}
		if sni != "" && net.ParseIP(sni) == nil {
			if err := leaf.VerifyHostname(sni); err != nil {
				if e.Insecure {
					certDetail += " · " + "Certificate doesn't cover this SNI (the client skips verification)"
					return nil
				}
				return err
			}
		}
		return nil
	}
	tlsConf.VerifyConnection = verify

	if udpTypes[e.Type] {
		t := time.Now()
		qctx, cancel := context.WithTimeout(ctx, 6*time.Second)
		alpn := e.ALPN
		if len(alpn) == 0 {
			alpn = []string{"h3"}
		}
		qc := tlsConf.Clone()
		qc.NextProtos, qc.MinVersion = alpn, tls.VersionTLS13
		conn, err := quic.DialAddr(qctx, target, qc, &quic.Config{HandshakeIdleTimeout: 5 * time.Second})
		cancel()
		if err != nil {
			add(probeStage{Name: "quic", Label: "QUIC handshake", Ms: since(t)})
			s := err.Error()
			msg := fmt.Sprintf("QUIC handshake failed: %s", s)
			switch {
			case isTimeout(err) || strings.Contains(s, "no recent network activity"):
				msg = fmt.Sprintf("QUIC handshake timed out: UDP %s didn't respond (port closed, or UDP is filtered by a firewall)", ep)
			case strings.Contains(s, "x509") || strings.Contains(s, "certificate"):
				msg = explainTLS(err, sni)
			case strings.Contains(s, "refused"):
				msg = fmt.Sprintf("Port closed: UDP %s refused the connection", ep)
			}
			return fail("quic", msg, err)
		}
		conn.CloseWithError(0, "")
		add(probeStage{Name: "quic", Label: "QUIC handshake", OK: true, Ms: since(t), Detail: certDetail})
	} else {
		t := time.Now()
		var d net.Dialer
		dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		c, err := d.DialContext(dctx, "tcp", target)
		cancel()
		if err != nil {
			add(probeStage{Name: "tcp", Label: "TCP connect", Ms: since(t)})
			return fail("tcp", explainDial(err, ep), err)
		}
		add(probeStage{Name: "tcp", Label: "TCP connect", OK: true, Ms: since(t), Detail: target})
		// 3. TLS (REALITY is checked by the real client below: a plain handshake would
		// only reach the camouflage site)
		if e.Security == "tls" {
			t = time.Now()
			c.SetDeadline(time.Now().Add(6 * time.Second))
			tc := tls.Client(c, tlsConf)
			err := tc.HandshakeContext(ctx)
			if err != nil {
				c.Close()
				add(probeStage{Name: "tls", Label: "TLS handshake", Ms: since(t), Detail: certDetail})
				return fail("tls", explainTLS(err, sni), err)
			}
			tc.Close()
			add(probeStage{Name: "tls", Label: "TLS handshake", OK: true, Ms: since(t), Detail: certDetail})
		} else {
			c.Close()
		}
	}

	if static {
		add(probeStage{Name: "proxy", Label: "Proxy request", OK: true, Skip: true, Detail: msgStaticProbe})
		r.OK = true
		r.TotalMs = since(start)
		return r
	}

	// 4. a real client through the inbound
	// dial the address resolved above, so the client doesn't depend on a second
	// resolver; the TLS name and HTTP Host keep the original domain
	ce := e
	if ip != e.Address {
		ce.Address = ip
		if ce.SNI == "" && ce.Security != "" {
			ce.SNI = e.Address
		}
		if ce.Host == "" && (ce.Network == "ws" || ce.Network == "httpupgrade" || ce.Network == "http") {
			ce.Host = e.Address
		}
	}
	ob := subgen.Endpoint(ce).SingboxOutbound()
	ob["tag"] = "probe"
	if t, ok := ob["tls"].(map[string]any); ok && len(pinPEM) > 0 && e.Security == "tls" {
		t["certificate"] = []string{string(pinPEM)}
	}
	hc, closeFn, err := probeClient(ctx, ob)
	if err != nil {
		return fail("proxy", fmt.Sprintf("Can't create the probe client: %v", err), err)
	}
	defer closeFn()
	var last error
	for i, u := range urls {
		t := time.Now()
		var dialMs atomic.Int64
		hc.dialHook = func(d time.Duration) { dialMs.CompareAndSwap(0, d.Milliseconds()+1) }
		code, err := hc.get(ctx, u, p.timeout)
		if err == nil && code < 400 {
			label := "Handshake + tunnel"
			if e.Security == "reality" {
				label = "REALITY handshake"
			}
			if dm := dialMs.Load(); dm > 0 {
				add(probeStage{Name: "handshake", Label: label, OK: true, Ms: dm - 1})
			}
			detail := fmt.Sprintf("HTTP %d · %s", code, u)
			if i > 0 {
				detail += " · " + "primary probe URL failed, used the fallback"
			}
			add(probeStage{Name: "proxy", Label: "Proxy request", OK: true, Ms: since(t), Detail: detail})
			r.OK, r.URL = true, u
			r.TotalMs = since(start)
			return r
		}
		if err == nil {
			err = fmt.Errorf("HTTP %d", code)
		}
		last = err
		if dialMs.Load() == 0 && !isTimeout(err) {
			break // the tunnel itself failed: another URL won't help
		}
	}
	add(probeStage{Name: "proxy", Label: "Proxy request", Ms: since(start) - sumMs(r.Stages)})
	msg := explainProxy(last, e)
	if strings.HasPrefix(last.Error(), "HTTP ") {
		msg = fmt.Sprintf("The probe URL returned %s (the tunnel works, but the target site rejected the request)", last.Error())
	}
	return fail("proxy", msg, last)
}

// refineProxy uses the node's view to say which side failed: if the node routed
// the probe's connection, the inbound authenticated it and the failure is past
// it (the outbound, an upstream relay, or the node's own network).
func (p *prober) refineProxy(r *probeResult, nodeID, tag string, began time.Time) {
	if strings.HasPrefix(r.Error, "The probe URL returned") || strings.HasPrefix(r.Error, "REALITY") {
		return
	}
	ps, seen, known := p.m.hub.probeSighting(nodeID, tag, began, 2500*time.Millisecond)
	switch {
	case seen && (ps.outbound == "" || ps.outbound == "direct"):
		r.Error = "The inbound works (the node accepted and authenticated the probe, via the direct outbound), but the node can't reach the probe URL: restricted egress, or a DNS / routing problem on the node"
	case seen:
		r.Error = fmt.Sprintf("The inbound works (the node accepted and authenticated the probe), but outbound \"%s\" can't connect: the upstream / relay server is unreachable, or that outbound's address, port or password is wrong", ps.outbound)
	case known && strings.HasPrefix(r.Error, "The inbound closed the connection"):
		r.Error = "The inbound rejected the probe (the node saw no authenticated connection): the probe user isn't deployed to the node yet, or the protocol / transport / key settings differ from the client's"
	case known && strings.HasPrefix(r.Error, "Proxy request timed out"):
		r.Error = "Proxy request timed out and the node saw no authenticated connection: silently dropped after failed authentication, or the protocol / transport settings differ between inbound and client"
	}
}

const msgStaticProbe = "Standalone inbound with its own key: only reachability is tested"

func sumMs(ss []probeStage) int64 {
	var n int64
	for _, s := range ss {
		n += s.Ms
	}
	return n
}

// probeHTTP sends the probe request through a loopback mixed inbound of the probe
// sing-box, i.e. through the router exactly like a real client app. Dialing the
// outbound directly from net/http is not equivalent: QUIC-based outbounds
// (hysteria2, tuic) then fail TLS-inside-tunnel requests with EOF.
type probeHTTP struct {
	proxy    *url.URL
	dialer   N.Dialer // the outbound itself, used only to diagnose failures
	dialHook func(time.Duration)
}

// diagnose dials the target through the outbound directly: the local proxy hides
// the real reason (REALITY auth failure, refused, ...) behind a reset.
func (c *probeHTTP) diagnose(ctx context.Context, u string, orig error) error {
	if c.dialer == nil {
		return orig
	}
	pu, err := url.Parse(u)
	if err != nil {
		return orig
	}
	port := pu.Port()
	if port == "" {
		port = map[string]string{"https": "443"}[pu.Scheme]
		if port == "" {
			port = "80"
		}
	}
	dctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	conn, err := c.dialer.DialContext(dctx, "tcp", M.ParseSocksaddr(net.JoinHostPort(pu.Hostname(), port)))
	if err != nil {
		return err
	}
	conn.Close()
	return orig
}

func (c *probeHTTP) get(ctx context.Context, u string, timeout time.Duration) (int, error) {
	tr := &http.Transport{
		Proxy:               http.ProxyURL(c.proxy),
		DisableKeepAlives:   true,
		TLSHandshakeTimeout: timeout,
	}
	defer tr.CloseIdleConnections()
	hc := &http.Client{Transport: tr, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return 0, err
	}
	// the tunnel is up once the proxied connection is handed to the client
	t := time.Now()
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
		GotConn: func(httptrace.GotConnInfo) {
			if c.dialHook != nil {
				c.dialHook(time.Since(t))
			}
		},
	}))
	req.Header.Set("User-Agent", "sbpanel-probe")
	resp, err := hc.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return 0, c.diagnose(ctx, u, err)
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	return resp.StatusCode, nil
}

// probeClient starts a minimal sing-box (loopback mixed inbound -> one outbound)
// and returns an HTTP client that goes through it.
func probeClient(ctx context.Context, outbound map[string]any) (*probeHTTP, func(), error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	cfg := map[string]any{
		"log":       map[string]any{"disabled": true},
		"dns":       map[string]any{"servers": []any{map[string]any{"type": "local", "tag": "local"}}},
		"inbounds":  []any{map[string]any{"type": "mixed", "tag": "probe-in", "listen": "127.0.0.1", "listen_port": port}},
		"route":     map[string]any{"default_domain_resolver": "local", "final": "probe"},
		"outbounds": []any{outbound},
	}
	raw, _ := json.Marshal(cfg)
	bctx := include.Context(context.Background())
	var opts option.Options
	if err := sjson.UnmarshalContext(bctx, raw, &opts); err != nil {
		return nil, nil, err
	}
	inst, err := box.New(box.Options{Context: bctx, Options: opts})
	if err != nil {
		return nil, nil, err
	}
	if err := inst.Start(); err != nil {
		inst.Close()
		return nil, nil, err
	}
	pu, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port))
	ph := &probeHTTP{proxy: pu}
	if o, ok := inst.Outbound().Outbound("probe"); ok {
		ph.dialer = o
	}
	return ph, func() { inst.Close() }, nil
}

// ---------- running probes ----------

type probeTarget struct {
	in     subInbound
	nodeID string
	opts   map[string]any
}

func (p *prober) targets(inboundID int64, nodeID string) ([]probeTarget, error) {
	q := `SELECT i.id, i.type, i.tag, i.remark, i.options_json, i.client_json, n.name, n.public_address, n.address, n.id
		FROM inbounds i JOIN nodes n ON n.id=i.node_id WHERE i.enabled=1`
	var args []any
	if inboundID > 0 {
		q += ` AND i.id=?`
		args = append(args, inboundID)
	}
	if nodeID != "" {
		q += ` AND i.node_id=?`
		args = append(args, nodeID)
	}
	return scanRows(p.m, q+` ORDER BY n.created_at, i.sort, i.port`, args, func(s func(...any) error) (probeTarget, error) {
		var t probeTarget
		err := s(&t.in.id, &t.in.typ, &t.in.tag, &t.in.remark, &t.in.opts, &t.in.client, &t.in.node, &t.in.pub, &t.in.addr, &t.nodeID)
		json.Unmarshal([]byte(t.in.opts), &t.opts)
		return t, err
	})
}

// run probes the selected inbounds (all when both are zero) and stores results.
func (p *prober) run(ctx context.Context, inboundID int64, nodeID string) ([]probeResult, error) {
	ts, err := p.targets(inboundID, nodeID)
	if err != nil {
		return nil, err
	}
	urls := p.urls()
	type job struct {
		t probeTarget
		e subEntry
	}
	var jobs []job
	for _, t := range ts {
		u, pw := probeCreds(p.m.db, t.nodeID)
		es, err := p.m.expandInbound(t.in, u, pw)
		if err != nil {
			return nil, err
		}
		for _, e := range es {
			jobs = append(jobs, job{t, e})
		}
	}
	// let nodes report the probe's routed connections, so a failed proxy stage
	// can tell "inbound rejected the probe" from "inbound fine, upstream down"
	for _, t := range ts {
		p.m.hub.watchFor(t.nodeID, 2*time.Minute)
	}
	out := make([]probeResult, len(jobs))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			var pin []byte
			if id := str(j.t.opts, "_cert"); id != "" {
				if c, _, err := p.m.certMaterial(id); err == nil {
					pin = c
				}
			}
			began := time.Now()
			r := p.probeEntry(ctx, j.e, pin, urls, isStatic(j.t.opts))
			if !r.OK && r.Stage == "proxy" {
				p.refineProxy(&r, j.t.nodeID, j.t.in.tag, began)
			}
			r.InboundID, r.Tag, r.NodeID, r.Node = j.t.in.id, j.t.in.tag, j.t.nodeID, j.t.in.node
			out[i] = r
		}()
	}
	wg.Wait()
	p.store(ts, out)
	return out, nil
}

// store replaces the cached results of the probed inbounds and records state
// changes (an inbound is reachable when every endpoint passed).
func (p *prober) store(ts []probeTarget, rs []probeResult) {
	p.mu.Lock()
	defer p.mu.Unlock()
	db := p.m.db
	by := map[int64][]probeResult{}
	for _, r := range rs {
		by[r.InboundID] = append(by[r.InboundID], r)
	}
	for _, t := range ts {
		var prevN, prevOK int
		db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(ok),0) FROM probe_results WHERE inbound_id=?`, t.in.id).Scan(&prevN, &prevOK)
		db.Exec(`DELETE FROM probe_results WHERE inbound_id=?`, t.in.id)
		cur := by[t.in.id]
		okN := 0
		var firstErr string
		for _, r := range cur {
			b, _ := json.Marshal(r)
			db.Exec(`INSERT OR REPLACE INTO probe_results(inbound_id, endpoint, ts, ok, result_json) VALUES(?,?,?,?,?)`,
				r.InboundID, r.Endpoint, r.TS, r.OK, string(b))
			if r.OK {
				okN++
			} else if firstErr == "" {
				firstErr = r.Endpoint + " · " + r.Error
			}
		}
		if prevN == 0 || len(cur) == 0 {
			continue
		}
		wasOK, isOK := prevOK == prevN, okN == len(cur)
		label := t.in.node + " / " + t.in.tag
		switch {
		case wasOK && !isOK:
			addEvent(db, "inbound_unreachable", 0, t.nodeID, label+": "+firstErr)
		case !wasOK && isOK:
			addEvent(db, "inbound_recovered", 0, t.nodeID, fmt.Sprintf("%s recovered", label))
		}
	}
}

func (p *prober) results() []probeResult {
	out := []probeResult{}
	rows, err := p.m.db.Query(`SELECT result_json FROM probe_results ORDER BY inbound_id, endpoint`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var s string
		var r probeResult
		if rows.Scan(&s) == nil && json.Unmarshal([]byte(s), &r) == nil {
			out = append(out, r)
		}
	}
	return out
}

// loop runs the optional periodic check (probe_interval minutes, 0 = off).
func (p *prober) loop(stop <-chan struct{}) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		mins, _ := strconv.Atoi(settingOr(p.m.db, "probe_interval", "0"))
		if mins <= 0 || time.Since(p.lastAuto) < time.Duration(mins)*time.Minute || !p.running.CompareAndSwap(false, true) {
			continue
		}
		p.lastAuto = time.Now()
		go func() {
			defer p.running.Store(false)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			if _, err := p.run(ctx, 0, ""); err != nil {
				p.m.log.Printf("probe: %v", err)
			}
		}()
	}
}

// ---------- API ----------

func (m *Master) apiProbe(w http.ResponseWriter, r *http.Request) {
	var req struct {
		InboundID int64  `json:"inbound_id"`
		NodeID    string `json:"node_id"`
		All       bool   `json:"all"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if req.InboundID == 0 && req.NodeID == "" && !req.All {
		writeErr(w, 400, "Pass inbound_id, node_id or all")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	rs, err := m.probes.run(ctx, req.InboundID, req.NodeID)
	if errf(w, err) {
		return
	}
	sort.SliceStable(rs, func(i, j int) bool { return rs[i].InboundID < rs[j].InboundID })
	writeJSON(w, 200, localizeProbe(reqLang(r), rs))
}

func (m *Master) apiProbeResults(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, localizeProbe(reqLang(r), m.probes.results()))
}

// localizeProbe translates the stored (English) explanations, stage labels and details
// (for English it only maps results stored in Chinese by older versions back).
func localizeProbe(lang string, rs []probeResult) []probeResult {
	for i := range rs {
		rs[i].Error = L(lang, rs[i].Error)
		st := make([]probeStage, len(rs[i].Stages))
		for j, s := range rs[i].Stages {
			s.Label, s.Detail = L(lang, s.Label), L(lang, s.Detail)
			st[j] = s
		}
		rs[i].Stages = st
	}
	return rs
}

func (m *Master) apiProbeSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPut {
		var req struct {
			URL      *string `json:"url"`
			Fallback *string `json:"fallback_url"`
			Interval *int    `json:"interval"`
		}
		if err := readJSON(r, &req); err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		for _, u := range []*string{req.URL, req.Fallback} {
			if u != nil && *u != "" {
				pu, err := url.Parse(*u)
				if err != nil || (pu.Scheme != "http" && pu.Scheme != "https") || pu.Host == "" {
					writeErr(w, 400, "The probe URL must be an http(s) URL")
					return
				}
			}
		}
		if req.URL != nil {
			setSetting(m.db, "probe_url", nz(*req.URL, defaultProbeURL))
		}
		if req.Fallback != nil {
			setSetting(m.db, "probe_fallback_url", *req.Fallback)
		}
		if req.Interval != nil {
			if *req.Interval < 0 || *req.Interval > 1440 {
				writeErr(w, 400, "Interval must be 0–1440 minutes")
				return
			}
			setSetting(m.db, "probe_interval", strconv.Itoa(*req.Interval))
		}
		m.audit(r, "probe.settings", "", "")
	}
	iv, _ := strconv.Atoi(settingOr(m.db, "probe_interval", "0"))
	writeJSON(w, 200, map[string]any{
		"url": settingOr(m.db, "probe_url", defaultProbeURL), "fallback_url": settingOr(m.db, "probe_fallback_url", defaultProbeFallback),
		"interval": iv,
	})
}
