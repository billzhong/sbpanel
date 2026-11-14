package master

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/libdns/libdns"
	"google.golang.org/protobuf/proto"

	"sbpanel/internal/pb"
)

// ---------- helpers ----------

type testCert struct {
	certPEM, keyPEM string
	leaf            *x509.Certificate
}

func mkCert(t *testing.T, names []string, notBefore, notAfter time.Time) testCert {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: names[0]},
		NotBefore: notBefore, NotAfter: notAfter}
	for _, n := range names {
		if ip := net.ParseIP(n); ip != nil {
			tpl.IPAddresses = append(tpl.IPAddresses, ip)
		} else {
			tpl.DNSNames = append(tpl.DNSNames, n)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kd, _ := x509.MarshalPKCS8PrivateKey(key)
	leaf, _ := x509.ParseCertificate(der)
	return testCert{string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kd})), leaf}
}

func (m *Master) eventCount(kind string) int {
	var n int
	m.db.QueryRow(`SELECT COUNT(*) FROM events WHERE kind=?`, kind).Scan(&n)
	return n
}

// ---------- encryption at rest ----------

func TestSecretBox(t *testing.T) {
	dir := t.TempDir()
	b, err := loadSecretBox(dir)
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, secretKeyFile))
	if err != nil || fi.Mode().Perm() != 0o600 || fi.Size() != 32 {
		t.Fatalf("key file: %v %v", fi.Mode(), err)
	}
	ct := b.seal([]byte("cf-token-123"), "dns_token:1")
	if !strings.HasPrefix(ct, "v1:") || strings.Contains(ct, "cf-token") {
		t.Fatalf("ciphertext %q", ct)
	}
	if ct == b.seal([]byte("cf-token-123"), "dns_token:1") {
		t.Fatal("nonce reuse")
	}
	pt, err := b.open(ct, "dns_token:1")
	if err != nil || string(pt) != "cf-token-123" {
		t.Fatalf("open: %q %v", pt, err)
	}
	if _, err := b.open(ct, "dns_token:2"); err == nil {
		t.Fatal("ciphertext moved to another row must not decrypt")
	}
	// same key after reload; another key can't read it
	b2, _ := loadSecretBox(dir)
	if pt, err := b2.open(ct, "dns_token:1"); err != nil || string(pt) != "cf-token-123" {
		t.Fatal("reload lost the key")
	}
	other, _ := loadSecretBox(t.TempDir())
	if _, err := other.open(ct, "dns_token:1"); err == nil {
		t.Fatal("decrypted with a different key")
	}
	if _, err := b.open(ct[:10], "dns_token:1"); err == nil {
		t.Fatal("truncated ciphertext accepted")
	}
}

// ---------- PEM validation ----------

func TestParsePEMPair(t *testing.T) {
	n := time.Now()
	c := mkCert(t, []string{"a.example.com", "*.example.com", "203.0.113.7"}, n.Add(-time.Hour), n.Add(90*24*time.Hour))
	in, chain, key, err := parsePEMPair(c.certPEM, c.keyPEM, n)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(in.SANs, ",") != "a.example.com,*.example.com,203.0.113.7" || !in.SelfSigned || len(in.Fingerprint) != 64 {
		t.Fatalf("info %+v", in)
	}
	if len(chain) == 0 || len(key) == 0 || in.NotAfter.Unix() != c.leaf.NotAfter.Unix() {
		t.Fatal("material")
	}
	// mismatched key
	other := mkCert(t, []string{"b.example.com"}, n.Add(-time.Hour), n.Add(time.Hour))
	if _, _, _, err := parsePEMPair(c.certPEM, other.keyPEM, n); err == nil || !strings.Contains(err.Error(), "不匹配") {
		t.Fatalf("mismatch: %v", err)
	}
	// expired
	old := mkCert(t, []string{"old.example.com"}, n.Add(-48*time.Hour), n.Add(-time.Hour))
	if in, _, _, err := parsePEMPair(old.certPEM, old.keyPEM, n); err == nil || !strings.Contains(err.Error(), "过期") || in.SANs[0] != "old.example.com" {
		t.Fatalf("expired: %v", err)
	}
	// garbage
	if _, _, _, err := parsePEMPair("hello", c.keyPEM, n); err == nil {
		t.Fatal("no cert accepted")
	}
	if _, _, _, err := parsePEMPair(c.certPEM, "nope", n); err == nil {
		t.Fatal("no key accepted")
	}
	// chain order and extra blocks: leaf first, private key blocks in the chain field ignored
	ca := mkCert(t, []string{"ca.example.com"}, n.Add(-time.Hour), n.Add(time.Hour))
	in, chain, _, err = parsePEMPair(c.certPEM+"\n"+ca.certPEM+"\n"+c.keyPEM, c.keyPEM, n)
	if err != nil || strings.Count(string(chain), "BEGIN CERTIFICATE") != 2 || in.SANs[0] != "a.example.com" {
		t.Fatalf("chain: %v", err)
	}
	// SAN coverage
	for host, want := range map[string]bool{"a.example.com": true, "x.example.com": true, "example.com": false, "a.b.example.com": false, "A.EXAMPLE.COM.": true} {
		if certCovers(in.SANs, host) != want {
			t.Errorf("covers(%s) != %v", host, want)
		}
	}
	if primaryName([]string{"*.x.com", "y.x.com"}) != "y.x.com" {
		t.Fatal("primaryName")
	}
}

// ---------- renewal scheduling ----------

type fakeIssuer struct {
	m     *Master
	t     *testing.T
	calls int
	fail  error
	clock func() time.Time
}

func (f *fakeIssuer) Issue(ctx context.Context, req IssueRequest) ([]byte, []byte, error) {
	f.calls++
	if f.fail != nil {
		return nil, nil, f.fail
	}
	n := f.clock()
	c := mkCert(f.t, req.Domains, n.Add(-time.Hour), n.Add(90*24*time.Hour))
	return []byte(c.certPEM), []byte(c.keyPEM), nil
}

func TestRenewalSchedule(t *testing.T) {
	m := newTestMaster(t)
	t0 := time.Now()
	clock := t0
	cm := m.certs
	cm.now = func() time.Time { return clock }
	fi := &fakeIssuer{m: m, t: t, clock: func() time.Time { return clock }}
	cm.issuer = fi

	m.db.Exec(`INSERT INTO certs(id, name, source, acme_json, auto_renew, created_at, updated_at) VALUES('cacme','hk','acme',?,1,0,0)`,
		`{"provider_id":1,"domains":["hk.example.com"]}`)
	// a pending certificate (never issued) is due right away
	cm.tick(context.Background())
	if fi.calls != 1 {
		t.Fatalf("first issuance: %d calls", fi.calls)
	}
	c, _ := m.getCert("cacme")
	if !c.HasMaterial || c.SANs[0] != "hk.example.com" || m.eventCount("cert_renewed") != 1 {
		t.Fatalf("issued: %+v", c)
	}
	firstAfter := c.NotAfter

	// 60 days left: nothing to do
	clock = t0.Add(30 * 24 * time.Hour)
	cm.tick(context.Background())
	if fi.calls != 1 {
		t.Fatal("renewed too early")
	}
	// 29 days left: renew
	clock = t0.Add(61 * 24 * time.Hour)
	cm.tick(context.Background())
	c, _ = m.getCert("cacme")
	if fi.calls != 2 || c.NotAfter <= firstAfter || c.RenewedAt != clock.Unix() || m.eventCount("cert_renewed") != 2 {
		t.Fatalf("renewal: calls=%d %+v", fi.calls, c)
	}

	// failures back off
	fi.fail = errors.New("dns propagation timeout")
	clock = time.Unix(c.NotAfter, 0).Add(-20 * 24 * time.Hour)
	cm.tick(context.Background())
	c, _ = m.getCert("cacme")
	if fi.calls != 3 || c.Attempts != 1 || c.NextAttempt != clock.Add(10*time.Minute).Unix() || !strings.Contains(c.LastError, "propagation") {
		t.Fatalf("failure 1: %+v", c)
	}
	if m.eventCount("cert_renew_failed") != 1 {
		t.Fatal("no cert_renew_failed event")
	}
	clock = clock.Add(5 * time.Minute) // inside the backoff window
	cm.tick(context.Background())
	if fi.calls != 3 {
		t.Fatal("retried inside backoff")
	}
	clock = clock.Add(6 * time.Minute)
	cm.tick(context.Background())
	c, _ = m.getCert("cacme")
	if fi.calls != 4 || c.Attempts != 2 || c.NextAttempt != clock.Add(20*time.Minute).Unix() {
		t.Fatalf("failure 2: %+v", c)
	}
	if retryDelay(1) != 10*time.Minute || retryDelay(4) != 80*time.Minute || retryDelay(20) != 24*time.Hour {
		t.Fatal("retryDelay")
	}

	// manual renewal still works when auto renew is off; success clears the backoff
	m.db.Exec(`UPDATE certs SET auto_renew=0 WHERE id='cacme'`)
	clock = clock.Add(2 * time.Hour)
	cm.tick(context.Background())
	if fi.calls != 4 {
		t.Fatal("auto renew off but renewed")
	}
	fi.fail = nil
	if err := cm.renew(context.Background(), "cacme"); err != nil {
		t.Fatal(err)
	}
	c, _ = m.getCert("cacme")
	if c.Attempts != 0 || c.NextAttempt != 0 || c.LastError != "" {
		t.Fatalf("backoff not cleared: %+v", c)
	}

	// expiry warnings for any source, at most once a day
	up := mkCert(t, []string{"up.example.com"}, t0.Add(-time.Hour), t0.Add(10*24*time.Hour))
	in, chain, key, _ := parsePEMPair(up.certPEM, up.keyPEM, t0)
	m.db.Exec(`INSERT INTO certs(id, name, source, auto_renew, created_at, updated_at) VALUES('cup','up','upload',0,0,0)`)
	m.storeMaterial("cup", in, chain, key)
	clock = t0.Add(time.Hour)
	before := m.eventCount("cert_expiring")
	cm.tick(context.Background())
	cm.tick(context.Background())
	if m.eventCount("cert_expiring") != before+1 {
		t.Fatalf("expiring events: %d", m.eventCount("cert_expiring")-before)
	}
	clock = clock.Add(25 * time.Hour)
	cm.tick(context.Background())
	if m.eventCount("cert_expiring") != before+2 {
		t.Fatal("no daily reminder")
	}
	var detail string
	m.db.QueryRow(`SELECT detail FROM events WHERE kind='cert_expiring' ORDER BY id DESC LIMIT 1`).Scan(&detail)
	if !strings.Contains(detail, "up.example.com") || !strings.Contains(detail, "手动替换") {
		t.Fatalf("detail %q", detail)
	}
	if fi.calls != 5 {
		t.Fatal("uploaded certificate must never be sent to the issuer")
	}
}

// ---------- probe user ----------

func seedNodeInbound(t *testing.T, m *Master, node, tag, typ, opts string) int64 {
	t.Helper()
	m.db.Exec(`INSERT OR IGNORE INTO nodes(id, name, address, created_at) VALUES(?,?,?,0)`, node, node, "198.51.100.1")
	res, err := m.db.Exec(`INSERT INTO inbounds(node_id, tag, type, port, options_json, created_at) VALUES(?,?,?,443,?,0)`, node, tag, typ, opts)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	m.db.Exec(`INSERT INTO group_inbounds(group_id, inbound_id) SELECT id, ? FROM groups WHERE is_default=1`, id)
	return id
}

func TestProbeUserExcluded(t *testing.T) {
	m := newTestMaster(t)
	seedNodeInbound(t, m, "n1", "vl", "vless", `{"listen_port":443}`)
	m.db.Exec(`INSERT INTO users(id, username, sub_token, uuid, password, created_at) VALUES(5,'alice','tok5','11111111-1111-4111-8111-111111111111','pw',0)`)
	m.db.Exec(`INSERT INTO user_groups(user_id, group_id) SELECT 5, id FROM groups WHERE is_default=1`)
	spec, err := buildSpec(m.db, "n1")
	if err != nil {
		t.Fatal(err)
	}
	pu, pp := probeCreds(m.db, "n1")
	if pu2, _ := probeCreds(m.db, "n1"); pu2 != pu {
		t.Fatal("probe credentials not stable")
	}
	if pu3, _ := probeCreds(m.db, "n2"); pu3 == pu {
		t.Fatal("probe credentials must differ per node")
	}
	in := spec.Inbounds[0]
	var users []map[string]any
	json.Unmarshal(in.UsersJson, &users)
	if len(users) != 2 || users[1]["name"] != probeUser || users[1]["uuid"] != pu {
		t.Fatalf("users %s", in.UsersJson)
	}
	if strings.Join(in.UserNames, ",") != "5" {
		t.Fatalf("user names %v", in.UserNames)
	}
	// ingest ignores the probe
	_, err = m.ingest("n1", &pb.TrafficReport{Seq: 1, WindowStart: now(),
		Users: []*pb.UserStat{{User: probeUser, Inbound: "vl", Outbound: "direct", Up: 999, Down: 999, Conns: 1}, {User: "5", Inbound: "vl", Outbound: "direct", Up: 10, Down: 20, Conns: 1}},
		Dims:  []*pb.DimStat{{User: probeUser, Host: "www.gstatic.com", Up: 999, Down: 999}}})
	if err != nil {
		t.Fatal(err)
	}
	var rows, sum int64
	m.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(up+down),0) FROM traffic_minute`).Scan(&rows, &sum)
	var dims int64
	m.db.QueryRow(`SELECT COUNT(*) FROM dim_hour WHERE host='www.gstatic.com'`).Scan(&dims)
	if rows != 1 || sum != 30 || dims != 0 {
		t.Fatalf("probe traffic counted: rows=%d sum=%d dims=%d", rows, sum, dims)
	}
	// subscriptions never carry it
	u, _ := m.loadSubUser("tok5")
	es, _ := m.subEntries(u)
	admin, _ := m.subEntries(subUser{ID: -1})
	for _, e := range append(es, admin...) {
		if e.UUID == pu || e.Password == pp {
			t.Fatal("probe credentials leaked into a subscription")
		}
	}
	if len(es) != 1 || es[0].UUID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("entries %+v", es)
	}
}

// ---------- spec certificate distribution ----------

func TestSpecCertDistribution(t *testing.T) {
	m := newTestMaster(t)
	n := time.Now()
	c1 := mkCert(t, []string{"hk.example.com"}, n.Add(-time.Hour), n.Add(90*24*time.Hour))
	in, chain, key, _ := parsePEMPair(c1.certPEM, c1.keyPEM, n)
	m.db.Exec(`INSERT INTO certs(id, name, source, auto_renew, created_at, updated_at) VALUES('cpanel','hk','upload',0,0,0)`)
	if err := m.storeMaterial("cpanel", in, chain, key); err != nil {
		t.Fatal(err)
	}
	m.db.Exec(`INSERT INTO certs(id, name, source, node_id, cert_path, key_path, created_at, updated_at)
		VALUES('clocal','certbot','node','n1','/etc/letsencrypt/live/a/fullchain.pem','/etc/letsencrypt/live/a/privkey.pem',0,0)`)
	seedNodeInbound(t, m, "n1", "tj", "trojan", `{"listen_port":443,"_cert":"cpanel","tls":{"enabled":true,"server_name":"hk.example.com","certificate_path":"/old.crt"}}`)
	seedNodeInbound(t, m, "n1", "tj2", "trojan", `{"listen_port":8443,"_cert":"clocal","tls":{"enabled":true}}`)
	seedNodeInbound(t, m, "n2", "plain", "vless", `{"listen_port":443}`)

	spec, err := buildSpec(m.db, "n1")
	if err != nil {
		t.Fatal(err)
	}
	byTag := map[string]*pb.InboundSpec{}
	for _, i := range spec.Inbounds {
		byTag[i.Tag] = i
	}
	var o map[string]any
	json.Unmarshal(byTag["tj"].OptionsJson, &o)
	if byTag["tj"].CertId != "cpanel" || obj(o, "tls")["certificate_path"] != nil || o["_cert"] != nil {
		t.Fatalf("panel cert inbound: %s", byTag["tj"].OptionsJson)
	}
	json.Unmarshal(byTag["tj2"].OptionsJson, &o)
	if byTag["tj2"].CertId != "" || obj(o, "tls")["certificate_path"] != "/etc/letsencrypt/live/a/fullchain.pem" {
		t.Fatalf("node-local inbound: %s", byTag["tj2"].OptionsJson)
	}
	if len(spec.Certs) != 1 || spec.Certs[0].Id != "cpanel" || spec.Certs[0].Hash == "" || len(spec.Certs[0].KeyPem) != 0 {
		t.Fatalf("bundles %v", spec.Certs)
	}
	if len(spec.WatchCerts) != 1 || spec.WatchCerts[0].Id != "clocal" {
		t.Fatalf("watches %v", spec.WatchCerts)
	}
	// only nodes that use it get it
	s2, _ := buildSpec(m.db, "n2")
	if len(s2.Certs) != 0 || len(s2.WatchCerts) != 0 {
		t.Fatal("cert sent to a node that doesn't use it")
	}
	// the stored spec never holds key material; serving fills it in
	m.reconcile("n1")
	var blob []byte
	m.db.QueryRow(`SELECT spec_pb FROM nodes WHERE id='n1'`).Scan(&blob)
	if strings.Contains(string(blob), "PRIVATE KEY") {
		t.Fatal("private key stored in spec_pb")
	}
	served, _ := m.loadSpec("n1")
	if err := m.fillCertMaterial(served); err != nil || !strings.Contains(string(served.Certs[0].KeyPem), "PRIVATE KEY") {
		t.Fatalf("fill: %v", err)
	}
	var keyEnc string
	m.db.QueryRow(`SELECT key_enc FROM certs WHERE id='cpanel'`).Scan(&keyEnc)
	if strings.Contains(keyEnc, "PRIVATE") {
		t.Fatal("key stored unencrypted")
	}

	// renewal: new material changes the bundle hash and the spec, not the inbound options
	var rev0 uint64
	m.db.QueryRow(`SELECT revision FROM nodes WHERE id='n1'`).Scan(&rev0)
	c2 := mkCert(t, []string{"hk.example.com"}, n.Add(-time.Hour), n.Add(80*24*time.Hour))
	in2, chain2, key2, _ := parsePEMPair(c2.certPEM, c2.keyPEM, n)
	m.storeMaterial("cpanel", in2, chain2, key2)
	m.reconcile("n1")
	spec2, _ := m.loadSpec("n1")
	var rev1 uint64
	m.db.QueryRow(`SELECT revision FROM nodes WHERE id='n1'`).Scan(&rev1)
	tj2 := func(s *pb.NodeSpec) *pb.InboundSpec {
		for _, i := range s.Inbounds {
			if i.Tag == "tj" {
				return i
			}
		}
		return nil
	}
	if rev1 != rev0+1 || spec2.Certs[0].Hash == spec.Certs[0].Hash || tj2(spec2).OptionsHash != byTag["tj"].OptionsHash {
		t.Fatalf("renewal: rev %d->%d, hash %s->%s, options %s->%s", rev0, rev1, spec.Certs[0].Hash, spec2.Certs[0].Hash,
			byTag["tj"].OptionsHash, tj2(spec2).OptionsHash)
	}
	// subscriptions default the SNI to the certificate name when the inbound has none
	m.db.Exec(`UPDATE inbounds SET options_json=? WHERE tag='tj'`, `{"listen_port":443,"_cert":"cpanel","tls":{"enabled":true}}`)
	es, _ := m.subEntries(subUser{ID: -1})
	found := false
	for _, e := range es {
		if e.Type == "trojan" && e.Port == 443 {
			found = e.SNI == "hk.example.com" && e.Security == "tls"
		}
	}
	if !found {
		t.Fatalf("sub entries %+v", es)
	}
	_ = proto.Marshal
}

// ---------- Cloudflare (fake API) ----------

type fakeCloudflare struct {
	mu      sync.Mutex
	token   string
	zones   []cfZone
	records map[string][]cfRecord // zone id -> records
	nextID  int
	calls   []string
}

func newFakeCF(t *testing.T, token string) (*fakeCloudflare, string) {
	f := &fakeCloudflare{token: token, records: map[string][]cfRecord{}}
	for i := 0; i < 55; i++ { // two pages
		f.zones = append(f.zones, cfZone{ID: fmt.Sprintf("z%02d", i), Name: fmt.Sprintf("zone%02d.test", i), Status: "active"})
	}
	f.zones = append(f.zones, cfZone{ID: "zex", Name: "example.com", Status: "active"})
	f.records["zex"] = []cfRecord{
		{ID: "r-mx", Type: "MX", Name: "example.com", Content: "mail.example.com"},
		{ID: "r-www", Type: "A", Name: "www.example.com", Content: "192.0.2.80", Proxied: true},
		{ID: "r-old", Type: "A", Name: "old.example.com", Content: "192.0.2.1"},
	}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv.URL + "/client/v4"
}

func (f *fakeCloudflare) reply(w http.ResponseWriter, code int, result any, page, pages int) {
	w.WriteHeader(code)
	body := map[string]any{"success": code < 300, "errors": []any{}, "result": result,
		"result_info": map[string]int{"page": page, "total_pages": pages}}
	if code >= 300 {
		body["errors"] = []map[string]any{{"code": 1000, "message": "Invalid API Token"}}
	}
	json.NewEncoder(w).Encode(body)
}

func (f *fakeCloudflare) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	if r.Header.Get("Authorization") != "Bearer "+f.token {
		f.reply(w, 401, nil, 1, 1)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/client/v4")
	parts := strings.Split(strings.Trim(p, "/"), "/")
	page := 1
	fmt.Sscan(r.URL.Query().Get("page"), &page)
	switch {
	case p == "/user/tokens/verify":
		f.reply(w, 200, map[string]string{"status": "active"}, 1, 1)
	case p == "/zones":
		per := 50
		lo, hi := (page-1)*per, min(page*per, len(f.zones))
		f.reply(w, 200, f.zones[lo:hi], page, (len(f.zones)+per-1)/per)
	case len(parts) >= 3 && parts[0] == "zones" && parts[2] == "dns_records":
		z := parts[1]
		switch {
		case r.Method == "GET":
			out := []cfRecord{}
			for _, x := range f.records[z] {
				if (r.URL.Query().Get("name") == "" || x.Name == r.URL.Query().Get("name")) && (r.URL.Query().Get("type") == "" || x.Type == r.URL.Query().Get("type")) {
					out = append(out, x)
				}
			}
			f.reply(w, 200, out, 1, 1)
		case r.Method == "POST":
			var rec cfRecord
			json.NewDecoder(r.Body).Decode(&rec)
			f.nextID++
			rec.ID = fmt.Sprintf("new%d", f.nextID)
			f.records[z] = append(f.records[z], rec)
			f.reply(w, 200, rec, 1, 1)
		case r.Method == "PATCH" && len(parts) == 4:
			var patch map[string]any
			json.NewDecoder(r.Body).Decode(&patch)
			for i, x := range f.records[z] {
				if x.ID == parts[3] {
					x.Content, x.Proxied = patch["content"].(string), patch["proxied"].(bool)
					f.records[z][i] = x
					f.reply(w, 200, x, 1, 1)
					return
				}
			}
			f.reply(w, 404, nil, 1, 1)
		case r.Method == "DELETE" && len(parts) == 4:
			rs := f.records[z][:0]
			for _, x := range f.records[z] {
				if x.ID != parts[3] {
					rs = append(rs, x)
				}
			}
			f.records[z] = rs
			f.reply(w, 200, map[string]string{"id": parts[3]}, 1, 1)
		}
	default:
		f.reply(w, 404, nil, 1, 1)
	}
}

func (f *fakeCloudflare) record(zone, id string) cfRecord {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, x := range f.records[zone] {
		if x.ID == id {
			return x
		}
	}
	return cfRecord{}
}

func TestCloudflareProviderAndDNS(t *testing.T) {
	const token = "cf-test-token-0123456789abcdef"
	fake, base := newFakeCF(t, token)
	m, err := New(Config{DataDir: t.TempDir(), AdminPassword: "pw-12345678", CloudflareAPI: base})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.db.Close() })
	h := m.routes()
	sess := func(method, path string, body any) *httptest.ResponseRecorder {
		var b []byte
		if body != nil {
			b, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, path, strings.NewReader(string(b)))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: m.newSession("admin")})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	if w := sess("POST", "/api/dns/providers", map[string]string{"token": "wrong-token-0123456789"}); w.Code != 400 || !strings.Contains(w.Body.String(), "令牌") {
		t.Fatalf("bad token: %d %s", w.Code, w.Body)
	}
	w := sess("POST", "/api/dns/providers", map[string]string{"token": token, "name": "主账号"})
	if w.Code != 200 {
		t.Fatalf("create provider: %d %s", w.Code, w.Body)
	}
	var cp struct {
		ID    int64    `json:"id"`
		Zones []cfZone `json:"zones"`
	}
	json.Unmarshal(w.Body.Bytes(), &cp)
	if len(cp.Zones) != 56 {
		t.Fatalf("zones (paginated) = %d", len(cp.Zones))
	}
	// never stored or returned in clear
	var enc string
	m.db.QueryRow(`SELECT token_enc FROM dns_providers WHERE id=?`, cp.ID).Scan(&enc)
	list := sess("GET", "/api/dns/providers", nil).Body.String()
	if strings.Contains(enc, token) || strings.Contains(list, token) || !strings.Contains(list, `"token_set":true`) {
		t.Fatalf("token leaked: %s / %s", enc, list)
	}
	if got, _ := m.providerToken(cp.ID); got != token {
		t.Fatal("token round trip")
	}

	// a domain for a node
	m.db.Exec(`INSERT INTO nodes(id, name, address, public_address, created_at) VALUES('n1','hk','10.0.0.2','203.0.113.9',0)`)
	w = sess("POST", "/api/domains", map[string]any{"fqdn": "hk.example.com", "provider_id": cp.ID, "node_id": "n1"})
	if w.Code != 200 {
		t.Fatalf("domain: %s", w.Body)
	}
	if sess("POST", "/api/domains", map[string]any{"fqdn": "hk.nope.org", "provider_id": cp.ID}).Code != 400 {
		t.Fatal("domain outside the token's zones accepted")
	}
	var ds []domainOut
	json.Unmarshal(sess("GET", "/api/domains", nil).Body.Bytes(), &ds)
	if len(ds) != 1 || ds[0].Zone != "example.com" || ds[0].NodeIP != "203.0.113.9" {
		t.Fatalf("domains %+v", ds)
	}
	did := ds[0].ID
	before := len(fake.calls)

	// plan is read-only
	var plan dnsPlan
	json.Unmarshal(sess("POST", "/api/dns/plan", map[string]any{"domain_id": did, "type": "A", "content": "203.0.113.9"}).Body.Bytes(), &plan)
	if plan.Action != "create" || plan.After.Name != "hk.example.com" {
		t.Fatalf("plan %+v", plan)
	}
	for _, c := range fake.calls[before:] {
		if !strings.HasPrefix(c, "GET ") {
			t.Fatalf("plan made a change: %s", c)
		}
	}
	w = sess("POST", "/api/dns/apply", map[string]any{"domain_id": did, "type": "A", "content": "203.0.113.9"})
	if w.Code != 200 {
		t.Fatalf("apply: %s", w.Body)
	}
	json.Unmarshal(sess("POST", "/api/dns/plan", map[string]any{"domain_id": did, "type": "A", "content": "203.0.113.9"}).Body.Bytes(), &plan)
	if plan.Action != "noop" || plan.RecordID == "" {
		t.Fatalf("second plan %+v", plan)
	}
	// update: the plan names the record; a stale record id is refused
	json.Unmarshal(sess("POST", "/api/dns/plan", map[string]any{"domain_id": did, "type": "A", "content": "203.0.113.10", "proxied": true}).Body.Bytes(), &plan)
	if plan.Action != "update" || plan.Before.Content != "203.0.113.9" || !strings.Contains(plan.Warning, "REALITY") {
		t.Fatalf("update plan %+v", plan)
	}
	if w := sess("POST", "/api/dns/apply", map[string]any{"domain_id": did, "type": "A", "content": "203.0.113.10", "record_id": "r-www"}); w.Code != 409 {
		t.Fatalf("stale apply: %d", w.Code)
	}
	if w := sess("POST", "/api/dns/apply", map[string]any{"domain_id": did, "type": "A", "content": "203.0.113.10", "proxied": true, "record_id": plan.RecordID}); w.Code != 200 {
		t.Fatalf("update apply: %s", w.Body)
	}
	if r := fake.record("zex", plan.RecordID); r.Content != "203.0.113.10" || !r.Proxied {
		t.Fatalf("record %+v", r)
	}
	// records the user didn't select are untouched
	if fake.record("zex", "r-www").Content != "192.0.2.80" || fake.record("zex", "r-old").Content != "192.0.2.1" || fake.record("zex", "r-mx").ID == "" {
		t.Fatal("unrelated records changed")
	}
	if sess("POST", "/api/dns/plan", map[string]any{"domain_id": did, "type": "A", "content": "::1"}).Code != 400 {
		t.Fatal("A record with IPv6 accepted")
	}

	// ACME DNS-01 adapter adds and removes only its TXT record
	prov := &cfDNS{c: m.cfClient(token)}
	txt := libdns.TXT{Name: "_acme-challenge.hk", Text: "tok-abc", TTL: time.Minute}
	if _, err := prov.AppendRecords(context.Background(), "example.com.", []libdns.Record{txt}); err != nil {
		t.Fatal(err)
	}
	rs, _ := m.cfClient(token).Records(context.Background(), "zex", "_acme-challenge.hk.example.com", "TXT")
	if len(rs) != 1 || strings.Trim(rs[0].Content, `"`) != "tok-abc" {
		t.Fatalf("txt %+v", rs)
	}
	if _, err := prov.DeleteRecords(context.Background(), "example.com.", []libdns.Record{txt}); err != nil {
		t.Fatal(err)
	}
	rs, _ = m.cfClient(token).Records(context.Background(), "zex", "_acme-challenge.hk.example.com", "TXT")
	if len(rs) != 0 || len(fake.records["zex"]) != 4 {
		t.Fatalf("after cleanup %+v / %d", rs, len(fake.records["zex"]))
	}
	if err := m.providerCovers(cp.ID, []string{"*.example.com", "a.zone03.test"}); err != nil {
		t.Fatal(err)
	}
	if err := m.providerCovers(cp.ID, []string{"x.other.org"}); err == nil {
		t.Fatal("uncovered domain accepted")
	}
}
