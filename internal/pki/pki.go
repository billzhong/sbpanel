// Package pki implements the panel-owned CA used for master<->node mTLS.
//
// The master holds a self-signed CA. Its gRPC server certificate is issued for the
// fixed name ServerName, so nodes trust the CA (pinned at enrollment) rather than a
// hostname. Each node gets a client certificate with CN "node:<id>".
package pki

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
)

const (
	ServerName   = "sbmaster"
	NodeCNPrefix = "node:"
)

type CA struct {
	Cert *x509.Certificate
	Key  crypto.Signer
}

func serial() *big.Int {
	n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	return n
}

func NewCA() (*CA, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tpl := &x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: "sbpanel CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(20, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &CA{Cert: cert, Key: key}, nil
}

func (c *CA) PEM() (certPEM, keyPEM string, err error) {
	kd, err := x509.MarshalPKCS8PrivateKey(c.Key)
	if err != nil {
		return "", "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Cert.Raw})),
		string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kd})), nil
}

func LoadCA(certPEM, keyPEM string) (*CA, error) {
	cb, _ := pem.Decode([]byte(certPEM))
	kb, _ := pem.Decode([]byte(keyPEM))
	if cb == nil || kb == nil {
		return nil, errors.New("pki: bad CA pem")
	}
	cert, err := x509.ParseCertificate(cb.Bytes)
	if err != nil {
		return nil, err
	}
	k, err := x509.ParsePKCS8PrivateKey(kb.Bytes)
	if err != nil {
		return nil, err
	}
	s, ok := k.(crypto.Signer)
	if !ok {
		return nil, errors.New("pki: CA key is not a signer")
	}
	return &CA{Cert: cert, Key: s}, nil
}

// ServerCert issues the master's gRPC server certificate.
func (c *CA) ServerCert() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tpl := &x509.Certificate{
		SerialNumber: serial(),
		Subject:      pkix.Name{CommonName: ServerName},
		DNSNames:     []string{ServerName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(1, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, c.Cert, &key.PublicKey, c.Key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der, c.Cert.Raw}, PrivateKey: key}, nil
}

// SignNodeCSR issues a client certificate for nodeID from a DER CSR.
func (c *CA) SignNodeCSR(csrDER []byte, nodeID string, validity time.Duration) (*x509.Certificate, error) {
	csr, err := x509.ParseCertificateRequest(csrDER)
	if err != nil {
		return nil, err
	}
	if err := csr.CheckSignature(); err != nil {
		return nil, err
	}
	tpl := &x509.Certificate{
		SerialNumber: serial(),
		Subject:      pkix.Name{CommonName: NodeCNPrefix + nodeID},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(validity),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, c.Cert, csr.PublicKey, c.Key)
	if err != nil {
		return nil, err
	}
	return x509.ParseCertificate(der)
}

// NodeIDFromCert extracts the node id from a verified client certificate.
func NodeIDFromCert(cert *x509.Certificate) (string, bool) {
	cn := cert.Subject.CommonName
	if !strings.HasPrefix(cn, NodeCNPrefix) {
		return "", false
	}
	return cn[len(NodeCNPrefix):], true
}

// NewKeyAndCSR creates a node key and a CSR for it.
func NewKeyAndCSR(cn string) (keyPEM []byte, csrDER []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	csrDER, err = x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: cn}}, key)
	if err != nil {
		return nil, nil, err
	}
	kd, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kd}), csrDER, nil
}

func CertPEM(der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

// Fingerprint is the lowercase hex SHA-256 of a DER certificate.
func Fingerprint(der []byte) string {
	h := sha256.Sum256(der)
	return hex.EncodeToString(h[:])
}

// PinVerifier returns a VerifyPeerCertificate func that accepts the chain only if it
// contains a CA with the given fingerprint and the leaf is signed by it.
func PinVerifier(fp string) func([][]byte, [][]*x509.Certificate) error {
	fp = strings.ToLower(strings.ReplaceAll(fp, ":", ""))
	return func(raw [][]byte, _ [][]*x509.Certificate) error {
		if len(raw) < 2 {
			return errors.New("pki: server sent no CA in chain")
		}
		leaf, err := x509.ParseCertificate(raw[0])
		if err != nil {
			return err
		}
		for _, r := range raw[1:] {
			if Fingerprint(r) != fp {
				continue
			}
			ca, err := x509.ParseCertificate(r)
			if err != nil {
				return err
			}
			pool := x509.NewCertPool()
			pool.AddCert(ca)
			_, err = leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: ServerName})
			return err
		}
		return fmt.Errorf("pki: CA fingerprint mismatch (want %s)", fp)
	}
}
