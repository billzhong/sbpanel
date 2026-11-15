package test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
)

// TestSubscriptionThemes covers the themed subscription page end to end: the default theme with
// real nodes, the JSON contract, uploading/activating/deleting a theme, and the sandbox headers.
func TestSubscriptionThemes(t *testing.T) {
	e := newEnv(t)
	e.createInbound("one", "vless", map[string]any{"listen": "127.0.0.1", "listen_port": freePort(t)}, nil)
	id := e.createUser(map[string]any{"username": "theme-user", "traffic_limit": 10 << 30})
	var s struct {
		URL string `json:"url"`
	}
	e.api.do("GET", "/api/users/"+itoa64(id)+"/sub", nil, &s)
	path := s.URL[strings.Index(s.URL, "/s/"):]

	get := func(p string) (*http.Response, string) {
		resp, err := http.Get(e.api.base + p)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, string(b)
	}

	resp, body := get(path + "?format=json")
	var d struct {
		API  int `json:"api"`
		User struct {
			Name   string `json:"name"`
			Status string `json:"status"`
			Total  int64  `json:"total"`
		} `json:"user"`
		Nodes []struct {
			Protocol, URI, QR string
		} `json:"nodes"`
		Clients []struct{ ID, URL string } `json:"clients"`
	}
	if err := json.Unmarshal([]byte(body), &d); err != nil || resp.StatusCode != 200 {
		t.Fatalf("json: %d %v", resp.StatusCode, err)
	}
	if d.API != 1 || d.User.Name != "theme-user" || d.User.Total != 10<<30 || len(d.Nodes) != 1 || d.Nodes[0].Protocol != "vless" ||
		!strings.HasPrefix(d.Nodes[0].URI, "vless://") || !strings.HasPrefix(d.Nodes[0].QR, "data:image/png") || len(d.Clients) == 0 {
		t.Fatalf("contract: %s", body)
	}

	resp, body = get(path + "?format=html")
	csp := resp.Header.Get("Content-Security-Policy")
	if !strings.HasPrefix(csp, "sandbox ") || strings.Contains(csp, "allow-same-origin") || resp.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("html headers: %v", resp.Header)
	}
	if !strings.Contains(body, `id="sbp-data"`) || !strings.Contains(body, "theme-user") {
		t.Fatal("data not embedded")
	}
	// language: English by default, the browser's zh* locale, or ?lang= (the theme's switcher)
	if !strings.Contains(body, `<html lang="en"`) || !strings.Contains(body, `"lang":"en"`) || resp.Header.Get("Content-Language") != "en" {
		t.Fatalf("default language: %s", resp.Header.Get("Content-Language"))
	}
	req, _ := http.NewRequest("GET", e.api.base+path+"?format=html", nil)
	req.Header.Set("Accept-Language", "zh-TW,zh;q=0.9,en;q=0.5")
	zr, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	zb0, _ := io.ReadAll(zr.Body)
	zr.Body.Close()
	if !strings.Contains(string(zb0), `<html lang="zh-CN"`) || !strings.Contains(string(zb0), `"lang":"zh"`) {
		t.Fatal("zh-TW browser should get the Chinese page")
	}
	if _, body := get(path + "?format=html&lang=zh&profile=x"); !strings.Contains(body, `"locale":"zh-CN"`) {
		t.Fatal("?lang=zh")
	}

	// upload a minimal theme, activate it, and render with it
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	for name, content := range map[string]string{
		"mini/sbp-theme.json": `{"api":1,"id":"mini","name":"Mini","version":"0.1.0","settings":[{"key":"greeting","type":"text","default":"你好"}]}`,
		"mini/index.html":     `<!doctype html><title>mini</title><body>MINI %SBP_DATA%<script src="%SBP_ASSETS%/m.js"></script></body>`,
		"mini/m.js":           `document.title = JSON.parse(document.getElementById('sbp-data').textContent).theme.settings.greeting`,
	} {
		w, _ := zw.Create(name)
		w.Write([]byte(content))
	}
	zw.Close()
	var mb bytes.Buffer
	mw := multipart.NewWriter(&mb)
	fw, _ := mw.CreateFormFile("file", "mini.zip")
	fw.Write(zb.Bytes())
	mw.Close()
	req, _ = http.NewRequest("POST", e.api.base+"/api/sub-themes", &mb)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	up, err := e.api.hc.Do(req)
	if err != nil || up.StatusCode != 200 {
		b, _ := io.ReadAll(up.Body)
		t.Fatalf("upload: %v %s", err, b)
	}
	up.Body.Close()
	e.api.do("PUT", "/api/sub-themes/active", map[string]string{"id": "mini"}, nil)
	e.api.do("PUT", "/api/sub-themes/mini/settings", map[string]any{"greeting": "欢迎"}, nil)
	_, body = get(path + "?format=html")
	if !strings.Contains(body, "MINI") || !strings.Contains(body, `"greeting":"欢迎"`) || !strings.Contains(body, "<script nonce=") {
		t.Fatalf("custom theme: %s", body)
	}
	// sandboxed pages cannot write to the admin API (Origin: null)
	req, _ = http.NewRequest("PUT", e.api.base+"/api/settings", strings.NewReader(`{"sub_title":"x"}`))
	req.Header.Set("Origin", "null")
	req.Header.Set("Content-Type", "application/json")
	if r, _ := e.api.hc.Do(req); r == nil || r.StatusCode != 403 {
		t.Fatal("Origin: null write accepted")
	}
	e.api.do("DELETE", "/api/sub-themes/mini", nil, nil)
	if _, body = get(path + "?format=html"); strings.Contains(body, "MINI") {
		t.Fatal("deleted theme still served")
	}
}

func itoa64(n int64) string { b, _ := json.Marshal(n); return string(b) }
