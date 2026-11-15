package test

import (
	"encoding/json"
	"testing"
	"time"
)

// A static inbound (a relay hop between nodes) uses its own key, carries no panel
// users and never appears in subscriptions, even inside the default group.
func TestStaticInbound(t *testing.T) {
	e := newEnv(t)
	target := blob(t)
	uid := e.createUser(map[string]any{"username": "regular"})
	port := freePort(t)
	psk := "MTIzNDU2Nzg5MDEyMzQ1Ng==" // 16 bytes, 2022-blake3-aes-128-gcm
	e.createInbound("relay-in", "shadowsocks", map[string]any{"listen": "127.0.0.1", "listen_port": port,
		"method": "2022-blake3-aes-128-gcm", "password": psk, "_static": true}, nil)
	e.waitApplied()

	for tag, raw := range e.subOutbounds(uid) {
		var o struct {
			Type       string `json:"type"`
			ServerPort int    `json:"server_port"`
		}
		json.Unmarshal(raw, &o)
		if o.Type == "shadowsocks" || o.ServerPort == port {
			t.Fatalf("static inbound leaked into a subscription: %s %s", tag, raw)
		}
	}
	ob, _ := json.Marshal(map[string]any{"type": "shadowsocks", "tag": "proxy", "server": "127.0.0.1", "server_port": port,
		"method": "2022-blake3-aes-128-gcm", "password": psk})
	proxy := client(t, ob)
	if n, err := fetch(proxy, target, 64<<10, "", 10*time.Second); err != nil || n != 64<<10 {
		t.Fatalf("relay through static inbound: n=%d err=%v", n, err)
	}
	// a wrong key is rejected
	bad, _ := json.Marshal(map[string]any{"type": "shadowsocks", "tag": "proxy", "server": "127.0.0.1", "server_port": port,
		"method": "2022-blake3-aes-128-gcm", "password": "AAAAAAAAAAAAAAAAAAAAAA=="})
	if _, err := fetch(client(t, bad), target, 1024, "", 3*time.Second); err == nil {
		t.Fatal("wrong key accepted")
	}
}
