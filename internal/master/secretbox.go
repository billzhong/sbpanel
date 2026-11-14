package master

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// secretBox encrypts secrets at rest (DNS API tokens, certificate private keys,
// ACME account keys) with AES-256-GCM. The key lives in {DataDir}/secret.key
// (0600), outside the database, so a leaked database or backup alone does not
// reveal them. Losing the key file makes those secrets unrecoverable: back it up
// together with the database.
type secretBox struct {
	aead cipher.AEAD
}

const secretKeyFile = "secret.key"

func loadSecretBox(dir string) (*secretBox, error) {
	p := filepath.Join(dir, secretKeyFile)
	key, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		key = make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return nil, fmt.Errorf("create %s: %w", p, err)
		}
		if _, err := f.Write(key); err != nil {
			f.Close()
			return nil, err
		}
		if err := f.Close(); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("%s: want 32 bytes, got %d", p, len(key))
	}
	if fi, err := os.Stat(p); err == nil && fi.Mode().Perm()&0o077 != 0 {
		os.Chmod(p, 0o600)
	}
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	return &secretBox{aead: aead}, nil
}

const sealPrefix = "v1:"

// seal returns "v1:" + base64(nonce || ciphertext). An empty input stays empty.
// aad binds the ciphertext to its purpose (e.g. "dns_token:3") so a value can't be
// moved to another row.
func (b *secretBox) seal(plain []byte, aad string) string {
	if len(plain) == 0 {
		return ""
	}
	nonce := make([]byte, b.aead.NonceSize())
	rand.Read(nonce)
	out := b.aead.Seal(nonce, nonce, plain, []byte(aad))
	return sealPrefix + base64.RawStdEncoding.EncodeToString(out)
}

func (b *secretBox) open(s, aad string) ([]byte, error) {
	if s == "" {
		return nil, nil
	}
	if !strings.HasPrefix(s, sealPrefix) {
		return nil, errors.New("secret: unknown format")
	}
	raw, err := base64.RawStdEncoding.DecodeString(s[len(sealPrefix):])
	if err != nil {
		return nil, fmt.Errorf("secret: %w", err)
	}
	n := b.aead.NonceSize()
	if len(raw) < n {
		return nil, errors.New("secret: truncated")
	}
	plain, err := b.aead.Open(nil, raw[:n], raw[n:], []byte(aad))
	if err != nil {
		return nil, errors.New("secret: decryption failed (wrong secret.key?)")
	}
	return plain, nil
}
