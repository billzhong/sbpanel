package node

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	stdjson "encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"sbpanel/internal/pb"
)

// ProbeUser is the hidden per-node user the master's connectivity probe signs in
// as. Its traffic is not counted, reported or shown as online.
const ProbeUser = "__probe"

// certbotLive is where certbot keeps the current certificate of each lineage.
var certbotLive = "/etc/letsencrypt/live"

// certFiles returns the local paths of a panel certificate.
func (c *Core) certFiles(id string) (string, string) {
	return filepath.Join(c.certDir, id+".crt"), filepath.Join(c.certDir, id+".key")
}

func validCertID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// syncCerts writes panel certificates to disk. Files are replaced atomically
// (write + rename in the same directory), so sing-box's file watcher reloads the
// new pair and running inbounds are never rebuilt for a renewal.
func (c *Core) syncCerts(bundles []*pb.CertBundle) error {
	if c.certDir == "" {
		if len(bundles) == 0 {
			return nil
		}
		return errors.New("certificate directory not configured")
	}
	if err := os.MkdirAll(c.certDir, 0o700); err != nil {
		return err
	}
	keep := map[string]bool{}
	var errs []error
	for _, b := range bundles {
		if !validCertID(b.Id) {
			errs = append(errs, fmt.Errorf("cert %q: bad id", b.Id))
			continue
		}
		keep[b.Id] = true
		if c.certHashes[b.Id] == b.Hash && b.Hash != "" {
			if _, err := os.Stat(filepath.Join(c.certDir, b.Id+".crt")); err == nil {
				continue
			}
		}
		if len(b.CertPem) == 0 || len(b.KeyPem) == 0 {
			errs = append(errs, fmt.Errorf("cert %s: empty material", b.Id))
			continue
		}
		if _, err := tls.X509KeyPair(b.CertPem, b.KeyPem); err != nil {
			errs = append(errs, fmt.Errorf("cert %s: %w", b.Id, err))
			continue
		}
		crt, key := c.certFiles(b.Id)
		// key first: the watcher reloads when the second file lands, and by then
		// both halves on disk belong together
		if err := writeAtomic(key, b.KeyPem); err != nil {
			errs = append(errs, err)
			continue
		}
		if err := writeAtomic(crt, b.CertPem); err != nil {
			errs = append(errs, err)
			continue
		}
		c.certHashes[b.Id] = b.Hash
		c.certWrites++
		c.log.Printf("certificate %s written (%s)", b.Id, b.Hash)
	}
	// drop files of certificates no longer used on this node
	if ents, err := os.ReadDir(c.certDir); err == nil {
		for _, e := range ents {
			n := e.Name()
			id := strings.TrimSuffix(strings.TrimSuffix(n, ".crt"), ".key")
			if id != n && !keep[id] {
				os.Remove(filepath.Join(c.certDir, n))
				delete(c.certHashes, id)
			}
		}
	}
	return errors.Join(errs...)
}

// withCertPaths points the inbound's TLS at the local copy of a panel certificate.
func (c *Core) withCertPaths(tlsRaw stdjson.RawMessage, id string) (stdjson.RawMessage, error) {
	if !validCertID(id) {
		return nil, fmt.Errorf("bad certificate id %q", id)
	}
	var t map[string]any
	if len(tlsRaw) > 0 {
		if err := stdjson.Unmarshal(tlsRaw, &t); err != nil {
			return nil, err
		}
	}
	if t == nil {
		t = map[string]any{"enabled": true}
	}
	crt, key := c.certFiles(id)
	if _, err := os.Stat(crt); err != nil {
		return nil, fmt.Errorf("certificate %s not on disk yet", id)
	}
	delete(t, "certificate")
	delete(t, "key")
	delete(t, "acme")
	t["certificate_path"], t["key_path"] = crt, key
	return stdjson.Marshal(t)
}

// inspectCert reads a node-local certificate pair (e.g. certbot) for the report.
func inspectCert(w *pb.CertWatch) *pb.CertStatus {
	st := &pb.CertStatus{Id: w.Id, CertPath: w.CertPath}
	cb, err := os.ReadFile(w.CertPath)
	if err != nil {
		st.Error = "Can't read the certificate: " + err.Error()
		return st
	}
	var leaf *x509.Certificate
	for rest := cb; ; {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			break
		}
		if blk.Type == "CERTIFICATE" {
			if leaf, err = x509.ParseCertificate(blk.Bytes); err != nil {
				st.Error = "Can't parse the certificate: " + err.Error()
				return st
			}
			break
		}
	}
	if leaf == nil {
		st.Error = "No PEM certificate in the file"
		return st
	}
	st.NotBefore, st.NotAfter = leaf.NotBefore.Unix(), leaf.NotAfter.Unix()
	st.Sans = append([]string{}, leaf.DNSNames...)
	for _, ip := range leaf.IPAddresses {
		st.Sans = append(st.Sans, ip.String())
	}
	if len(st.Sans) == 0 && leaf.Subject.CommonName != "" {
		st.Sans = []string{leaf.Subject.CommonName}
	}
	st.Issuer = leaf.Issuer.CommonName
	if st.Issuer == "" && len(leaf.Issuer.Organization) > 0 {
		st.Issuer = leaf.Issuer.Organization[0]
	}
	sum := sha256.Sum256(leaf.Raw)
	st.Fingerprint = hex.EncodeToString(sum[:])
	if w.KeyPath != "" {
		kb, err := os.ReadFile(w.KeyPath)
		if err != nil {
			st.Error = "Can't read the private key: " + err.Error()
		} else if _, err := tls.X509KeyPair(cb, kb); err != nil {
			st.Error = "The certificate and private key don't match: " + err.Error()
		}
	}
	return st
}

func certbotNames() []string {
	ents, err := os.ReadDir(certbotLive)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		if e.IsDir() || e.Type()&os.ModeSymlink != 0 {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// CertReport inspects the watched node-local certificates.
func certReport(ws []*pb.CertWatch) *pb.CertReport {
	r := &pb.CertReport{CertbotNames: certbotNames()}
	for _, w := range ws {
		r.Certs = append(r.Certs, inspectCert(w))
	}
	return r
}
