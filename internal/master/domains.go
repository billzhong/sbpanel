package master

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
)

// ---------- DNS providers ----------

type providerOut struct {
	ID         int64    `json:"id"`
	Kind       string   `json:"kind"`
	Name       string   `json:"name"`
	TokenSet   bool     `json:"token_set"`
	Zones      []cfZone `json:"zones"`
	VerifiedAt int64    `json:"verified_at"`
	LastError  string   `json:"last_error"`
	CreatedAt  int64    `json:"created_at"`
}

func (m *Master) listProviders() ([]providerOut, error) {
	return scanRows(m, `SELECT id, kind, name, token_enc<>'', zones_json, verified_at, last_error, created_at FROM dns_providers ORDER BY id`, nil,
		func(s func(...any) error) (providerOut, error) {
			var p providerOut
			var zs string
			err := s(&p.ID, &p.Kind, &p.Name, &p.TokenSet, &zs, &p.VerifiedAt, &p.LastError, &p.CreatedAt)
			json.Unmarshal([]byte(zs), &p.Zones)
			if p.Zones == nil {
				p.Zones = []cfZone{}
			}
			return p, err
		})
}

func (m *Master) providerToken(id int64) (string, error) {
	var enc string
	if err := m.db.QueryRow(`SELECT token_enc FROM dns_providers WHERE id=?`, id).Scan(&enc); err != nil {
		return "", errors.New("DNS provider not found")
	}
	b, err := m.box.open(enc, fmt.Sprintf("dns_token:%d", id))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (m *Master) providerZones(id int64) []cfZone {
	var zs string
	m.db.QueryRow(`SELECT zones_json FROM dns_providers WHERE id=?`, id).Scan(&zs)
	var out []cfZone
	json.Unmarshal([]byte(zs), &out)
	return out
}

// zoneFor finds the most specific zone containing fqdn.
func zoneFor(zones []cfZone, fqdn string) (cfZone, bool) {
	fqdn = strings.TrimPrefix(strings.ToLower(fqdn), "*.")
	var best cfZone
	for _, z := range zones {
		n := strings.ToLower(z.Name)
		if (fqdn == n || strings.HasSuffix(fqdn, "."+n)) && len(n) > len(best.Name) {
			best = z
		}
	}
	return best, best.ID != ""
}

func (m *Master) providerCovers(id int64, domains []string) error {
	zs := m.providerZones(id)
	for _, d := range domains {
		if _, ok := zoneFor(zs, d); !ok {
			return fmt.Errorf("%s is not in a zone this token can access (check that the token has Zone permissions for it)", d)
		}
	}
	return nil
}

// verifyToken checks a Cloudflare token and lists the zones it can access.
func (m *Master) verifyToken(ctx context.Context, token string) ([]cfZone, error) {
	c := m.cfClient(token)
	if err := c.Verify(ctx); err != nil {
		return nil, err
	}
	zs, err := c.Zones(ctx)
	if err != nil {
		return nil, err
	}
	if len(zs) == 0 {
		return nil, errors.New("The token is valid but sees no zones: set its Zone Resources to include your domain")
	}
	sort.Slice(zs, func(i, j int) bool { return zs[i].Name < zs[j].Name })
	return zs, nil
}

func (m *Master) apiProviders(w http.ResponseWriter, r *http.Request) {
	ps, err := m.listProviders()
	if errf(w, err) {
		return
	}
	for i := range ps {
		ps[i].LastError = L(langOf(w), ps[i].LastError)
	}
	writeJSON(w, 200, ps)
}

func (m *Master) apiCreateProvider(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Kind  string `json:"kind"`
		Name  string `json:"name"`
		Token string `json:"token"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if req.Kind == "" {
		req.Kind = "cloudflare"
	}
	if req.Kind != "cloudflare" {
		writeErr(w, 400, "Only Cloudflare is supported for now")
		return
	}
	req.Token = strings.TrimSpace(req.Token)
	if len(req.Token) < 20 {
		writeErr(w, 400, "Paste the full API token")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	zs, err := m.verifyToken(ctx, req.Token)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	zj, _ := json.Marshal(zs)
	res, err := m.db.Exec(`INSERT INTO dns_providers(kind, name, token_enc, zones_json, verified_at, created_at) VALUES(?,?,'',?,?,?)`,
		req.Kind, nz(strings.TrimSpace(req.Name), "Cloudflare"), string(zj), now(), now())
	if errf(w, err) {
		return
	}
	id, _ := res.LastInsertId()
	m.db.Exec(`UPDATE dns_providers SET token_enc=? WHERE id=?`, m.box.seal([]byte(req.Token), fmt.Sprintf("dns_token:%d", id)), id)
	m.audit(r, "dns.provider.create", fmtID(id), req.Kind)
	writeJSON(w, 200, map[string]any{"id": id, "zones": zs})
}

func (m *Master) apiUpdateProvider(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var req struct {
		Name  *string `json:"name"`
		Token string  `json:"token"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if req.Name != nil {
		m.db.Exec(`UPDATE dns_providers SET name=? WHERE id=?`, nz(strings.TrimSpace(*req.Name), "Cloudflare"), id)
	}
	if t := strings.TrimSpace(req.Token); t != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		zs, err := m.verifyToken(ctx, t)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		zj, _ := json.Marshal(zs)
		m.db.Exec(`UPDATE dns_providers SET token_enc=?, zones_json=?, verified_at=?, last_error='' WHERE id=?`,
			m.box.seal([]byte(t), fmt.Sprintf("dns_token:%d", id)), string(zj), now(), id)
	}
	m.audit(r, "dns.provider.update", fmtID(id), "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiVerifyProvider(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	tok, err := m.providerToken(id)
	if err != nil {
		writeErr(w, 404, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	zs, err := m.verifyToken(ctx, tok)
	if err != nil {
		m.db.Exec(`UPDATE dns_providers SET last_error=? WHERE id=?`, err.Error(), id)
		writeErr(w, 400, err.Error())
		return
	}
	zj, _ := json.Marshal(zs)
	m.db.Exec(`UPDATE dns_providers SET zones_json=?, verified_at=?, last_error='' WHERE id=?`, string(zj), now(), id)
	writeJSON(w, 200, map[string]any{"zones": zs})
}

func (m *Master) apiDeleteProvider(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var n int
	m.db.QueryRow(`SELECT COUNT(*) FROM certs WHERE source='acme' AND json_extract(acme_json,'$.provider_id')=?`, id).Scan(&n)
	if n > 0 {
		writeErr(w, 409, fmt.Sprintf("%d ACME certificate(s) still renew with this token; delete them or switch their source first", n))
		return
	}
	m.db.Exec(`DELETE FROM dns_providers WHERE id=?`, id)
	m.db.Exec(`UPDATE domains SET provider_id=0 WHERE provider_id=?`, id)
	m.audit(r, "dns.provider.delete", fmtID(id), "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---------- domains ----------

type domainOut struct {
	ID            int64    `json:"id"`
	FQDN          string   `json:"fqdn"`
	ProviderID    int64    `json:"provider_id"`
	ZoneID        string   `json:"zone_id"`
	Zone          string   `json:"zone"`
	NodeID        string   `json:"node_id"`
	Node          string   `json:"node"`
	RecordType    string   `json:"record_type"`
	RecordID      string   `json:"record_id"`
	RecordContent string   `json:"record_content"`
	Proxied       bool     `json:"proxied"`
	SyncedAt      int64    `json:"synced_at"`
	NodeIP        string   `json:"node_ip"` // suggested record content
	Certs         []string `json:"certs"`   // certificate ids covering it
}

// nodeIP is the address a DNS record for the node should point to.
func (m *Master) nodeIP(nodeID string) string {
	var pub, addr string
	m.db.QueryRow(`SELECT public_address, address FROM nodes WHERE id=?`, nodeID).Scan(&pub, &addr)
	if ip := net.ParseIP(pub); ip != nil {
		return ip.String()
	}
	if ip := net.ParseIP(addr); ip != nil && !ip.IsLoopback() && !ip.IsPrivate() {
		return ip.String()
	}
	if pub == "" && addr != "" {
		return addr
	}
	return ""
}

func (m *Master) listDomains() ([]domainOut, error) {
	out, err := scanRows(m, `SELECT d.id, d.fqdn, d.provider_id, d.zone_id, d.zone, d.node_id, COALESCE(n.name,''), d.record_type, d.record_id,
		d.record_content, d.proxied, d.synced_at FROM domains d LEFT JOIN nodes n ON n.id=d.node_id ORDER BY d.fqdn`, nil,
		func(s func(...any) error) (domainOut, error) {
			var d domainOut
			return d, s(&d.ID, &d.FQDN, &d.ProviderID, &d.ZoneID, &d.Zone, &d.NodeID, &d.Node, &d.RecordType, &d.RecordID, &d.RecordContent, &d.Proxied, &d.SyncedAt)
		})
	if err != nil {
		return nil, err
	}
	cs, _ := m.listCerts()
	for i := range out {
		if out[i].NodeID != "" {
			out[i].NodeIP = m.nodeIP(out[i].NodeID)
		}
		out[i].Certs = []string{}
		for _, c := range cs {
			if certCovers(c.SANs, out[i].FQDN) {
				out[i].Certs = append(out[i].Certs, c.ID)
			}
		}
	}
	return out, nil
}

func (m *Master) apiDomains(w http.ResponseWriter, r *http.Request) {
	ds, err := m.listDomains()
	if errf(w, err) {
		return
	}
	writeJSON(w, 200, ds)
}

func (m *Master) apiCreateDomain(w http.ResponseWriter, r *http.Request) {
	var req struct {
		FQDN       string `json:"fqdn"`
		ProviderID int64  `json:"provider_id"`
		NodeID     string `json:"node_id"`
		Proxied    bool   `json:"proxied"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	ds, err := normDomains([]string{req.FQDN})
	if err != nil || strings.HasPrefix(ds[0], "*.") {
		writeErr(w, 400, "Enter a full domain name, e.g. hk.example.com")
		return
	}
	fqdn := ds[0]
	var zone cfZone
	if req.ProviderID > 0 {
		z, ok := zoneFor(m.providerZones(req.ProviderID), fqdn)
		if !ok {
			writeErrf(w, 400, "%s is not in a zone this token can access", fqdn)
			return
		}
		zone = z
	}
	res, err := m.db.Exec(`INSERT INTO domains(fqdn, provider_id, zone_id, zone, node_id, proxied, created_at) VALUES(?,?,?,?,?,?,?)`,
		fqdn, req.ProviderID, zone.ID, zone.Name, req.NodeID, req.Proxied, now())
	if err != nil {
		writeErr(w, 400, "This domain already exists")
		return
	}
	id, _ := res.LastInsertId()
	m.audit(r, "domain.create", fmtID(id), fqdn)
	writeJSON(w, 200, map[string]int64{"id": id})
}

func (m *Master) apiUpdateDomain(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var req struct {
		NodeID  *string `json:"node_id"`
		Proxied *bool   `json:"proxied"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if req.NodeID != nil {
		m.db.Exec(`UPDATE domains SET node_id=? WHERE id=?`, *req.NodeID, id)
	}
	if req.Proxied != nil {
		m.db.Exec(`UPDATE domains SET proxied=? WHERE id=?`, *req.Proxied, id)
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// apiDeleteDomain forgets the domain in the panel. DNS records are left alone.
func (m *Master) apiDeleteDomain(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	m.db.Exec(`DELETE FROM domains WHERE id=?`, id)
	m.audit(r, "domain.delete", fmtID(id), "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

type domainRow struct {
	ID         int64
	FQDN       string
	ProviderID int64
	ZoneID     string
}

func (m *Master) domainForDNS(id int64) (domainRow, *cfClient, error) {
	var d domainRow
	if err := m.db.QueryRow(`SELECT id, fqdn, provider_id, zone_id FROM domains WHERE id=?`, id).Scan(&d.ID, &d.FQDN, &d.ProviderID, &d.ZoneID); err != nil {
		return d, nil, errors.New("Domain not found")
	}
	if d.ProviderID == 0 || d.ZoneID == "" {
		return d, nil, errors.New("This domain has no DNS provider, so its records can't be managed")
	}
	tok, err := m.providerToken(d.ProviderID)
	if err != nil {
		return d, nil, err
	}
	return d, m.cfClient(tok), nil
}

// apiDNSRecords lists the existing records of a domain (read-only).
func (m *Master) apiDNSRecords(w http.ResponseWriter, r *http.Request) {
	d, c, err := m.domainForDNS(qInt(r, "domain_id", 0))
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	rs, err := c.Records(ctx, d.ZoneID, d.FQDN, "")
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	if rs == nil {
		rs = []cfRecord{}
	}
	writeJSON(w, 200, rs)
}

type dnsChange struct {
	DomainID int64  `json:"domain_id"`
	Type     string `json:"type"`
	Content  string `json:"content"`
	Proxied  bool   `json:"proxied"`
	RecordID string `json:"record_id"` // apply: the existing record the plan chose to update ("" = create)
}

func (c *dnsChange) check() error {
	c.Type = strings.ToUpper(c.Type)
	ip := net.ParseIP(c.Content)
	switch {
	case c.Type == "A" && (ip == nil || ip.To4() == nil):
		return errors.New("An A record needs an IPv4 address")
	case c.Type == "AAAA" && (ip == nil || ip.To4() != nil):
		return errors.New("An AAAA record needs an IPv6 address")
	case c.Type != "A" && c.Type != "AAAA":
		return errors.New("Only A / AAAA records can be managed")
	}
	return nil
}

type dnsPlan struct {
	FQDN     string     `json:"fqdn"`
	Zone     string     `json:"zone"`
	Action   string     `json:"action"` // create | update | noop | conflict
	RecordID string     `json:"record_id"`
	Before   *cfRecord  `json:"before"`
	After    cfRecord   `json:"after"`
	Existing []cfRecord `json:"existing"` // every record with this name (shown, never touched)
	Warning  string     `json:"warning,omitempty"`
}

func (m *Master) planDNS(ctx context.Context, d domainRow, c *cfClient, ch dnsChange) (dnsPlan, error) {
	p := dnsPlan{FQDN: d.FQDN, After: cfRecord{Type: ch.Type, Name: d.FQDN, Content: ch.Content, Proxied: ch.Proxied, TTL: 1}}
	m.db.QueryRow(`SELECT zone FROM domains WHERE id=?`, d.ID).Scan(&p.Zone)
	rs, err := c.Records(ctx, d.ZoneID, d.FQDN, "")
	if err != nil {
		return p, err
	}
	p.Existing = rs
	if p.Existing == nil {
		p.Existing = []cfRecord{}
	}
	var same []cfRecord
	for _, r := range rs {
		if r.Type == "CNAME" {
			p.Action, p.Warning = "conflict", "This name has a CNAME record, which can't coexist with A/AAAA. Delete the CNAME in Cloudflare first."
			return p, nil
		}
		if r.Type == ch.Type {
			same = append(same, r)
		}
	}
	switch len(same) {
	case 0:
		p.Action = "create"
	case 1:
		b := same[0]
		p.Before, p.RecordID = &b, b.ID
		if b.Content == ch.Content && b.Proxied == ch.Proxied {
			p.Action = "noop"
		} else {
			p.Action = "update"
		}
	default:
		p.Action, p.Warning = "conflict", fmt.Sprintf("This name already has %d %s records (load balancing?). The panel won't touch them; handle them in Cloudflare.", len(same), ch.Type)
	}
	if ch.Proxied {
		if p.Warning != "" {
			p.Warning += " · "
		}
		p.Warning += cfProxiedWarning
	}
	return p, nil
}

const cfProxiedWarning = "With the orange cloud on, traffic goes through Cloudflare: only WS / gRPC / HTTPUpgrade + TLS inbounds work; REALITY, Hysteria2, TUIC and plain TCP will break."

func (m *Master) apiDNSPlan(w http.ResponseWriter, r *http.Request) {
	var ch dnsChange
	if err := readJSON(r, &ch); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if err := ch.check(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	d, c, err := m.domainForDNS(ch.DomainID)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	p, err := m.planDNS(ctx, d, c, ch)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	p.Warning = L(langOf(w), p.Warning)
	writeJSON(w, 200, p)
}

// apiDNSApply performs exactly the change a plan showed: it re-plans and refuses
// when the records changed in between, and touches at most one record.
func (m *Master) apiDNSApply(w http.ResponseWriter, r *http.Request) {
	var ch dnsChange
	if err := readJSON(r, &ch); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if err := ch.check(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	d, c, err := m.domainForDNS(ch.DomainID)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	p, err := m.planDNS(ctx, d, c, ch)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	if p.RecordID != ch.RecordID || p.Action == "conflict" {
		writeErr(w, 409, "The DNS record changed after the preview; preview again")
		return
	}
	var rec cfRecord
	switch p.Action {
	case "noop":
		rec = *p.Before
	case "create":
		rec, err = c.CreateRecord(ctx, d.ZoneID, cfRecord{Type: ch.Type, Name: d.FQDN, Content: ch.Content, Proxied: ch.Proxied, TTL: 1, Comment: "managed by sbpanel"})
	case "update":
		rec, err = c.UpdateRecord(ctx, d.ZoneID, p.RecordID, ch.Content, ch.Proxied)
	}
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	m.db.Exec(`UPDATE domains SET record_type=?, record_id=?, record_content=?, proxied=?, synced_at=? WHERE id=?`,
		ch.Type, rec.ID, ch.Content, ch.Proxied, now(), d.ID)
	m.audit(r, "dns."+p.Action, d.FQDN, fmt.Sprintf("%s %s proxied=%v", ch.Type, ch.Content, ch.Proxied))
	writeJSON(w, 200, map[string]any{"action": p.Action, "record": rec})
}
