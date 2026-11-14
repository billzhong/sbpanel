package test

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestImport3XUIEndToEnd: a client configured for the old 3x-ui server (original UUID,
// REALITY key and short id) keeps working after migration, and so does the 3x-ui
// subscription link /sub/<subId>.
func TestImport3XUIEndToEnd(t *testing.T) {
	e := newEnv(t)
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	priv := base64.RawURLEncoding.EncodeToString(k.Bytes())
	pub := base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes())
	tgt := realityTarget(t)
	port := freePort(t)
	uuid := "5a3f0c2e-8b1d-4c6a-9e7f-112233445566"
	settings, _ := json.Marshal(map[string]any{"clients": []map[string]any{{"id": uuid, "email": "olduser", "flow": "xtls-rprx-vision",
		"totalGB": 10 << 30, "expiryTime": 0, "enable": true, "subId": "legacysub01", "limitIp": 0}}, "decryption": "none"})
	stream, _ := json.Marshal(map[string]any{"network": "tcp", "security": "reality", "realitySettings": map[string]any{
		"dest": fmt.Sprintf("127.0.0.1:%d", tgt), "serverNames": []string{"target.test"}, "privateKey": priv, "shortIds": []string{"c0ffee"}}})
	export, _ := json.Marshal(map[string]any{"success": true, "obj": []map[string]any{{
		"id": 1, "remark": "old reality", "enable": true, "listen": "127.0.0.1", "port": port, "protocol": "vless", "tag": "inbound-old",
		"settings": string(settings), "streamSettings": string(stream),
		"clientStats": []map[string]any{{"email": "olduser", "up": 5, "down": 500}},
	}}})

	var rep struct {
		DryRun bool `json:"dry_run"`
		Users  int  `json:"users"`
	}
	e.api.do("POST", "/api/import/3xui", map[string]any{"node_id": e.nodeID, "data": string(export), "dry_run": true}, &rep)
	if !rep.DryRun || rep.Users != 1 {
		t.Fatalf("dry run %+v", rep)
	}
	e.api.do("POST", "/api/import/3xui", map[string]any{"node_id": e.nodeID, "data": json.RawMessage(export)}, &rep)
	e.waitApplied()

	// the unchanged old client config
	old := fmt.Sprintf(`{"type":"vless","tag":"old","server":"127.0.0.1","server_port":%d,"uuid":%q,"flow":"xtls-rprx-vision",
	  "tls":{"enabled":true,"server_name":"target.test","utls":{"enabled":true,"fingerprint":"chrome"},"reality":{"enabled":true,"public_key":%q,"short_id":"c0ffee"}}}`, port, uuid, pub)
	target := blob(t)
	if _, err := fetch(client(t, json.RawMessage(old)), target, 1<<20, "", 20*time.Second); err != nil {
		t.Fatalf("old 3x-ui client after migration: %v", err)
	}
	// the old subscription path still serves this user
	resp, err := http.Get(e.api.base + "/sub/legacysub01?format=links")
	if err != nil {
		t.Fatal(err)
	}
	var sb strings.Builder
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	sb.Write(buf[:n])
	resp.Body.Close()
	if !strings.Contains(sb.String(), uuid) || !strings.Contains(sb.String(), "pbk="+pub) || !strings.Contains(sb.String(), "sid=c0ffee") {
		t.Fatalf("legacy subscription content: %s", sb.String())
	}
	if ui := resp.Header.Get("Subscription-Userinfo"); !strings.Contains(ui, "download=500") || !strings.Contains(ui, fmt.Sprintf("total=%d", 10<<30)) {
		t.Fatalf("userinfo %q", ui)
	}
}
