package master

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/caddyserver/certmagic"
	"github.com/mholt/acmez/v3"
	"github.com/mholt/acmez/v3/acme"
)

// Renewal policy.
const (
	renewBefore   = 30 * 24 * time.Hour // renew ACME certificates this long before expiry
	warnBefore    = 14 * 24 * time.Hour // cert_expiring events from here on
	warnEvery     = 24 * time.Hour
	issueTimeout  = 10 * time.Minute
	maxRenewDelay = 24 * time.Hour
)

// IssueRequest is everything an issuer needs for one certificate.
type IssueRequest struct {
	CertID     string
	Domains    []string
	CA         string // letsencrypt | zerossl
	Staging    bool
	Email      string
	ProviderID int64
}

// Issuer obtains a certificate. The ACME implementation solves DNS-01 through the
// Cloudflare provider; tests inject a fake.
type Issuer interface {
	Issue(ctx context.Context, req IssueRequest) (chainPEM, keyPEM []byte, err error)
}

type certManager struct {
	m        *Master
	now      func() time.Time
	issuer   Issuer
	mu       sync.Mutex
	inflight map[string]bool
	ticking  atomic.Bool
}

func newCertManager(m *Master) *certManager {
	cm := &certManager{m: m, now: time.Now, inflight: map[string]bool{}}
	cm.issuer = &acmeIssuer{m: m}
	return cm
}

func (cm *certManager) isRenewing(id string) bool {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	return cm.inflight[id]
}

// retryDelay is the backoff after n consecutive failures: 10m, 20m, 40m ... 24h.
func retryDelay(n int) time.Duration {
	if n < 1 {
		n = 1
	}
	d := 10 * time.Minute
	for i := 1; i < n && d < maxRenewDelay; i++ {
		d *= 2
	}
	return min(d, maxRenewDelay)
}

// renewDue decides whether an ACME certificate should be (re)issued now.
func renewDue(c certRow, t time.Time) bool {
	if c.Source != certACME {
		return false
	}
	if c.NextAttempt > 0 && t.Unix() < c.NextAttempt {
		return false
	}
	if !c.HasMaterial {
		return true // not issued yet (first attempt failed, or the master restarted mid-issue)
	}
	return c.AutoRenew && time.Unix(c.NotAfter, 0).Sub(t) <= renewBefore
}

func (cm *certManager) loop(stop <-chan struct{}) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	cm.tickAsync()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			cm.tickAsync()
		}
	}
}

func (cm *certManager) tickAsync() {
	if !cm.ticking.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer cm.ticking.Store(false)
		cm.tick(context.Background())
	}()
}

// tick renews due certificates (sequentially, in the caller) and emits expiry
// warnings. It is safe to call with a fake clock.
func (cm *certManager) tick(ctx context.Context) {
	cs, err := cm.m.listCerts()
	if err != nil {
		return
	}
	t := cm.now()
	for _, c := range cs {
		if renewDue(c, t) {
			cm.renew(ctx, c.ID)
			if nc, err := cm.m.getCert(c.ID); err == nil {
				c = nc
			}
		}
		cm.warn(c, t)
	}
}

func (cm *certManager) warn(c certRow, t time.Time) {
	if c.NotAfter == 0 {
		return
	}
	left := time.Unix(c.NotAfter, 0).Sub(t)
	if left > warnBefore || t.Unix()-c.WarnedAt < int64(warnEvery.Seconds()) {
		return
	}
	days := int(left.Hours() / 24)
	detail := fmt.Sprintf("%s（%s）· 剩余 %d 天，%s 到期", c.Name, strings.Join(c.SANs, ", "), days,
		time.Unix(c.NotAfter, 0).In(cm.m.loc).Format(time.DateOnly))
	if left <= 0 {
		detail = fmt.Sprintf("%s（%s）· 已于 %s 过期", c.Name, strings.Join(c.SANs, ", "), time.Unix(c.NotAfter, 0).In(cm.m.loc).Format(time.DateOnly))
	}
	switch c.Source {
	case certNode:
		detail += " · 请检查节点上的 certbot 续期任务"
	case certUpload:
		detail += " · 上传的证书需要手动替换"
	}
	cm.m.db.Exec(`UPDATE certs SET warned_at=? WHERE id=?`, t.Unix(), c.ID)
	addEvent(cm.m.db, "cert_expiring", 0, c.NodeID, detail)
}

// renewAsync starts a (re)issue in the background; false when one is running.
func (cm *certManager) renewAsync(id string) bool {
	cm.mu.Lock()
	busy := cm.inflight[id]
	cm.mu.Unlock()
	if busy {
		return false
	}
	go cm.renew(context.Background(), id)
	return true
}

// renew issues a certificate now and distributes it. Failures back off.
func (cm *certManager) renew(ctx context.Context, id string) error {
	cm.mu.Lock()
	if cm.inflight[id] {
		cm.mu.Unlock()
		return errors.New("already renewing")
	}
	cm.inflight[id] = true
	cm.mu.Unlock()
	defer func() {
		cm.mu.Lock()
		delete(cm.inflight, id)
		cm.mu.Unlock()
	}()
	c, err := cm.m.getCert(id)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, issueTimeout)
	defer cancel()
	req := IssueRequest{CertID: id, Domains: c.ACME.Domains, CA: c.ACME.CA, Staging: c.ACME.Staging, Email: c.ACME.Email, ProviderID: c.ACME.ProviderID}
	if len(req.Domains) == 0 {
		req.Domains = c.SANs
	}
	chain, key, err := cm.issuer.Issue(ctx, req)
	var in certInfo
	if err == nil {
		in, chain, key, err = parsePEMPair(string(chain), string(key), cm.now())
	}
	if err != nil {
		n := c.Attempts + 1
		next := cm.now().Add(retryDelay(n))
		cm.m.db.Exec(`UPDATE certs SET last_error=?, attempts=?, next_attempt=?, updated_at=? WHERE id=?`, err.Error(), n, next.Unix(), now(), id)
		cm.m.log.Printf("cert %s: issue failed (attempt %d, retry %s): %v", id, n, next.Format(time.DateTime), err)
		addEvent(cm.m.db, "cert_renew_failed", 0, "", fmt.Sprintf("%s（%s）· 第 %d 次失败，%s 重试：%v",
			c.Name, strings.Join(req.Domains, ", "), n, next.In(cm.m.loc).Format("01-02 15:04"), err))
		return err
	}
	if err := cm.m.storeMaterial(id, in, chain, key); err != nil {
		return err
	}
	cm.m.db.Exec(`UPDATE certs SET renewed_at=? WHERE id=?`, cm.now().Unix(), id)
	verb := "已续期"
	if !c.HasMaterial {
		verb = "已签发"
	}
	addEvent(cm.m.db, "cert_renewed", 0, "", fmt.Sprintf("%s（%s）%s，%s 到期", c.Name, strings.Join(in.SANs, ", "), verb,
		in.NotAfter.In(cm.m.loc).Format(time.DateOnly)))
	if nodes := cm.m.certNodes(id); len(nodes) > 0 {
		cm.m.reconcile(nodes...) // only the cert bundle hash changes: files are swapped, inbounds stay up
	}
	return nil
}

// ---------- ACME (DNS-01 via Cloudflare) ----------

type acmeIssuer struct{ m *Master }

func acmeDirectory(ca string, staging bool) string {
	switch {
	case ca == "zerossl":
		return certmagic.ZeroSSLProductionCA
	case staging:
		return certmagic.LetsEncryptStagingCA
	}
	return certmagic.LetsEncryptProductionCA
}

// accountKey loads (or creates) the ACME account key for a directory + email.
func (a *acmeIssuer) accountKey(dir, email string) (crypto.Signer, error) {
	k := "acme_account:" + dir + "|" + email
	if v, ok := getSetting(a.m.db, k); ok {
		b, err := a.m.box.open(v, k)
		if err != nil {
			return nil, err
		}
		blk, _ := pem.Decode(b)
		if blk == nil {
			return nil, errors.New("bad stored ACME account key")
		}
		key, err := x509.ParseECPrivateKey(blk.Bytes)
		if err != nil {
			return nil, err
		}
		return key, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, _ := x509.MarshalECPrivateKey(key)
	setSetting(a.m.db, k, a.m.box.seal(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), k))
	return key, nil
}

// zeroSSLEAB fetches external account binding credentials for an email.
func zeroSSLEAB(ctx context.Context, email string) (acme.EAB, error) {
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.zerossl.com/acme/eab-credentials-email",
		strings.NewReader(url.Values{"email": {email}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return acme.EAB{}, fmt.Errorf("ZeroSSL EAB: %w", err)
	}
	defer resp.Body.Close()
	var r struct {
		Success bool   `json:"success"`
		KID     string `json:"eab_kid"`
		HMAC    string `json:"eab_hmac_key"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil || !r.Success {
		return acme.EAB{}, fmt.Errorf("ZeroSSL EAB: HTTP %d", resp.StatusCode)
	}
	return acme.EAB{KeyID: r.KID, MACKey: r.HMAC}, nil
}

func (a *acmeIssuer) Issue(ctx context.Context, req IssueRequest) ([]byte, []byte, error) {
	token, err := a.m.providerToken(req.ProviderID)
	if err != nil {
		return nil, nil, err
	}
	dir := acmeDirectory(req.CA, req.Staging)
	akey, err := a.accountKey(dir, req.Email)
	if err != nil {
		return nil, nil, err
	}
	solver := &certmagic.DNS01Solver{DNSManager: certmagic.DNSManager{
		DNSProvider:        &cfDNS{c: a.m.cfClient(token)},
		PropagationTimeout: 3 * time.Minute,
	}}
	client := acmez.Client{
		Client:           &acme.Client{Directory: dir, HTTPClient: &http.Client{Timeout: 60 * time.Second}, UserAgent: "sbpanel/" + Version},
		ChallengeSolvers: map[string]acmez.Solver{acme.ChallengeTypeDNS01: solver},
	}
	acct := acme.Account{TermsOfServiceAgreed: true, PrivateKey: akey}
	if req.Email != "" {
		acct.Contact = []string{"mailto:" + req.Email}
	}
	if req.CA == "zerossl" {
		eab, err := zeroSSLEAB(ctx, req.Email)
		if err != nil {
			return nil, nil, err
		}
		if err := acct.SetExternalAccountBinding(ctx, client.Client, eab); err != nil {
			return nil, nil, err
		}
	}
	acct, err = client.NewAccount(ctx, acct)
	if err != nil {
		return nil, nil, fmt.Errorf("ACME 账户：%w", err)
	}
	ckey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	certs, err := client.ObtainCertificateForSANs(ctx, acct, ckey, req.Domains)
	if err != nil {
		return nil, nil, fmt.Errorf("ACME 签发：%w", err)
	}
	if len(certs) == 0 {
		return nil, nil, errors.New("ACME 没有返回证书")
	}
	der, _ := x509.MarshalPKCS8PrivateKey(ckey)
	return certs[0].ChainPEM, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}
