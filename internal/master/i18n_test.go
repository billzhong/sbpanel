package master

import (
	"errors"
	"net/http/httptest"
	"testing"
)

func TestLangSelection(t *testing.T) {
	for _, c := range []struct{ xlang, accept, want string }{
		{"", "", langEN}, {"zh", "", langZH}, {"zh-CN", "", langZH}, {"en", "zh-CN", langEN},
		{"", "zh-HK,en;q=0.5", langZH}, {"", "zh-Hant-TW", langZH}, {"", "en-US,zh;q=0.9", langEN}, {"", "fr", langEN},
	} {
		r := httptest.NewRequest("GET", "/api/x", nil)
		r.Header.Set("X-Lang", c.xlang)
		r.Header.Set("Accept-Language", c.accept)
		if got := reqLang(r); got != c.want {
			t.Errorf("X-Lang %q Accept-Language %q: %s, want %s", c.xlang, c.accept, got, c.want)
		}
	}
	r := httptest.NewRequest("GET", "/s/tok?lang=zh&profile=a", nil)
	r.Header.Set("Accept-Language", "en")
	if subLang(r) != langZH {
		t.Error("?lang=zh should win over Accept-Language")
	}
}

func TestCatalog(t *testing.T) {
	// exact, formatted, wrapped and " · "-joined messages
	for in, want := range map[string]string{
		"Node not found": "节点不存在",
		"Port 443 is already used by inbound vless-in": "端口 443 已被入站 vless-in 使用",
		"ACME issuance: Invalid domain: *.x":           "ACME 签发：域名格式不正确：*.x",
		"Certificate a.com · 12 days left":             "证书 a.com · 剩余 12 天",
		"not in the catalog":                           "not in the catalog",
	} {
		if got := L(langZH, in); got != want {
			t.Errorf("L(%q) = %q, want %q", in, got, want)
		}
		if got := L(langEN, in); got != in {
			t.Errorf("L(en, %q) changed it to %q", in, got)
		}
	}
	w := httptest.NewRecorder()
	w.Header().Set("Content-Language", "zh-CN")
	writeErrf(w, 400, "Setting %s: %v", "x", errors.New("Invalid version"))
	if want := `{"error":"设置项 x：version 格式无效"}` + "\n"; w.Body.String() != want {
		t.Errorf("writeErrf: %s", w.Body)
	}
	// every catalog format must render with the same number of verbs as its English key
	for en, zh := range zhCatalog {
		if a, b := len(verbRe.FindAllString(en, -1)), len(verbRe.FindAllString(zh, -1)); a != b {
			t.Errorf("verb count differs: %q (%d) vs %q (%d)", en, a, zh, b)
		}
	}
}

// Rows stored in Chinese before the backend was localized read back in English.
func TestLegacyChineseToEnglish(t *testing.T) {
	for in, want := range map[string]string{
		"自签名":                        "Self-signed",
		"mac-local / trojan-tls 已恢复": "mac-local / trojan-tls recovered",
		"plain English":              "plain English",
	} {
		if got := L(langEN, in); got != want {
			t.Errorf("L(en, %q) = %q, want %q", in, got, want)
		}
	}
	if got := L(langZH, "自签名"); got != "自签名" {
		t.Errorf("zh text in zh changed: %q", got)
	}
}
