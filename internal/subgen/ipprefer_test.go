package subgen

import (
	"strings"
	"testing"
)

func TestIPPrefer(t *testing.T) {
	e := Endpoint{Remark: "z", Type: "shadowsocks", Address: "z.example.com", Port: 1, SSMethod: "aes-128-gcm", Password: "p", IPPrefer: "ipv6"}
	if r, _ := e.SingboxConfigOutbound()["domain_resolver"].(map[string]any); r["strategy"] != "prefer_ipv6" || r["server"] != "local" {
		t.Fatalf("sing-box: %v", e.SingboxConfigOutbound())
	}
	if _, ok := e.SingboxOutbound()["domain_resolver"]; ok {
		t.Fatal("a bare outbound must not name a DNS server")
	}
	if e.MihomoProxy()["ip-version"] != "ipv6-prefer" {
		t.Fatal("mihomo")
	}
	if !strings.Contains(e.surgeProxy(), "ip-version=prefer-v6") {
		t.Fatal(e.surgeProxy())
	}
	e.Address = "2001:db8::1" // a literal address leaves nothing to choose
	if _, ok := e.SingboxConfigOutbound()["domain_resolver"]; ok || strings.Contains(e.surgeProxy(), "ip-version") {
		t.Fatal("literal address")
	}
	e.Address, e.IPPrefer = "z.example.com", ""
	if _, ok := e.MihomoProxy()["ip-version"]; ok {
		t.Fatal("default")
	}
}
