package subgen

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"strings"
	"testing"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/include"
	"github.com/sagernet/sing-box/option"
	sjson "github.com/sagernet/sing/common/json"
	"gopkg.in/yaml.v3"
)

var update = flag.Bool("update", false, "rewrite golden files")

var meta = Meta{User: "alice", SubURL: "https://panel.example.com/s/tok123", Title: "sbpanel"}

func mustRender(t *testing.T, client string, p *Profile, eps []Endpoint) *Result {
	t.Helper()
	r, err := Render(client, p, eps, meta)
	if err != nil {
		t.Fatalf("%s: %v", client, err)
	}
	if err := ValidateOutput(client, r.Body); err != nil {
		t.Fatalf("%s invalid: %v\n%s", client, err, r.Body)
	}
	return r
}

// boxCheck runs the real sing-box option parser and instance constructor.
func boxCheck(t *testing.T, b []byte) {
	t.Helper()
	ctx := include.Context(context.Background())
	var opts option.Options
	if err := sjson.UnmarshalContext(ctx, b, &opts); err != nil {
		t.Fatalf("sing-box rejects: %v\n%s", err, b)
	}
	opts.Inbounds = nil     // tun needs privileges
	opts.Experimental = nil // cache_file would write to cwd
	inst, err := box.New(box.Options{Context: ctx, Options: opts})
	if err != nil {
		t.Fatalf("box.New: %v", err)
	}
	inst.Close()
}

func TestPresetsAllClients(t *testing.T) {
	for _, ps := range Presets {
		for _, eps := range [][]Endpoint{SampleEndpoints(), nil} {
			for _, c := range []string{"mihomo", "singbox", "surge"} {
				r := mustRender(t, c, ps.Build(), eps)
				if c == "singbox" {
					boxCheck(t, r.Body)
				}
			}
		}
		if _, err := Check(ps.Build()); err != nil {
			t.Fatalf("%s: %v", ps.Slug, err)
		}
	}
}

func TestMihomoStructure(t *testing.T) {
	r := mustRender(t, "mihomo", StandardPreset(), SampleEndpoints())
	var cfg struct {
		Proxies     []map[string]any `yaml:"proxies"`
		ProxyGroups []struct {
			Name    string   `yaml:"name"`
			Type    string   `yaml:"type"`
			Proxies []string `yaml:"proxies"`
		} `yaml:"proxy-groups"`
		RuleProviders map[string]map[string]any `yaml:"rule-providers"`
		Rules         []string                  `yaml:"rules"`
		DNS           map[string]any            `yaml:"dns"`
		MixedPort     int                       `yaml:"mixed-port"`
	}
	if err := yaml.Unmarshal(r.Body, &cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Proxies) != 5 || cfg.MixedPort != 7890 || cfg.DNS["enhanced-mode"] != "fake-ip" {
		t.Fatalf("structure: %d proxies, port %d", len(cfg.Proxies), cfg.MixedPort)
	}
	groups := map[string][]string{}
	for _, g := range cfg.ProxyGroups {
		groups[g.Name] = g.Proxies
	}
	if _, ok := groups["🇹🇼 台湾"]; ok {
		t.Fatal("empty region group not hidden")
	}
	if g := groups["🇺🇸 美国"]; len(g) != 2 {
		t.Fatalf("US filter = %v", g)
	}
	if p := cfg.RuleProviders["ai-site"]; p["format"] != "mrs" || !strings.HasSuffix(p["url"].(string), "category-ai-!cn.mrs") {
		t.Fatalf("ai provider %v", p)
	}
	var cnIP string
	for _, rl := range cfg.Rules {
		if strings.HasPrefix(rl, "RULE-SET,cn-ip,") {
			cnIP = rl
		}
		if strings.HasPrefix(rl, "RULE-SET,bahamut-site,") && !strings.HasSuffix(rl, "🐟 漏网之鱼") {
			t.Fatalf("hidden target must fall back to final: %s", rl)
		}
	}
	if cnIP != "RULE-SET,cn-ip,DIRECT" { // resolve_ip → no no-resolve
		t.Fatalf("cn-ip rule %q", cnIP)
	}
	if !strings.Contains(strings.Join(r.Warnings, "\n"), "台湾") {
		t.Fatalf("warnings %v", r.Warnings)
	}
}

func TestSingboxSemantics(t *testing.T) {
	r := mustRender(t, "singbox", StandardPreset(), SampleEndpoints())
	boxCheck(t, r.Body)
	var cfg struct {
		Route struct {
			Rules []map[string]any `json:"rules"`
			Final string           `json:"final"`
		} `json:"route"`
	}
	json.Unmarshal(r.Body, &cfg)
	if cfg.Route.Final != "🐟 漏网之鱼" {
		t.Fatal("final", cfg.Route.Final)
	}
	var sawAdsReject, sawResolveBeforeCN bool
	for i, rl := range cfg.Route.Rules {
		rs, _ := rl["rule_set"].([]any)
		if len(rs) == 1 && rs[0] == "ads-site" && rl["action"] == "reject" {
			sawAdsReject = true
		}
		if len(rs) == 1 && rs[0] == "cn-ip" && cfg.Route.Rules[i-1]["action"] == "resolve" {
			sawResolveBeforeCN = true
		}
	}
	if !sawAdsReject || !sawResolveBeforeCN {
		t.Fatalf("ads reject %v, resolve before cn-ip %v", sawAdsReject, sawResolveBeforeCN)
	}
}

func TestSurgeGolden(t *testing.T) {
	r := mustRender(t, "surge", StandardPreset(), SampleEndpoints())
	s := string(r.Body)
	if *update {
		os.WriteFile("testdata/standard.surge.golden", r.Body, 0o644)
	}
	want, err := os.ReadFile("testdata/standard.surge.golden")
	if err != nil {
		t.Fatal(err)
	}
	if s != string(want) {
		t.Fatalf("surge output changed (go test -run Surge -update):\n%s", s)
	}
	secs, _ := SurgeSections(s)
	for _, ln := range secs["[Proxy]"] {
		if strings.Contains(ln, "vless") || strings.Contains(ln, "grpc") || strings.Contains(ln, "Reality") {
			t.Fatalf("unsupported node leaked into Surge: %s", ln)
		}
	}
	if len(secs["[Proxy]"]) != 3 {
		t.Fatalf("proxies %v", secs["[Proxy]"])
	}
	if !strings.Contains(s, `password="p@ss,word"`) {
		t.Fatal("comma in password must be quoted")
	}
	if !strings.HasPrefix(s, "#!MANAGED-CONFIG https://panel.example.com/s/tok123 interval=43200 strict=false") {
		t.Fatal("managed header")
	}
}

func TestValidateRejects(t *testing.T) {
	cases := map[string]func(p *Profile){
		"cycle": func(p *Profile) {
			p.Groups[0].Members = append(p.Groups[0].Members, Member{Kind: "group", Ref: "final"})
		},
		"http(s)": func(p *Profile) {
			p.RuleSets = append(p.RuleSets, RuleSet{ID: "x", Name: "x", Remote: &Source{URLs: map[string]string{"mihomo": "file:///etc/passwd"}}})
		},
		"fallback":      func(p *Profile) { p.Final = "REJECT" },
		"bad regex":     func(p *Profile) { p.Groups[9].Members[0].Include = "(" },
		"doesn't exist": func(p *Profile) { p.Rules[0].Target = "nope" },
		"mirror":        func(p *Profile) { p.Mirror = "javascript:alert(1)" },
		"invalid characters": func(p *Profile) {
			p.RuleSets[0].Inline[0].Values = append(p.RuleSets[0].Inline[0].Values, "a.com,DIRECT\nMATCH")
		},
	}
	for want, mut := range cases {
		p := StandardPreset()
		mut(p)
		if err := Validate(p); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v", want, err)
		}
	}
}

func TestTemplateSafety(t *testing.T) {
	p := MinimalPreset()
	ct := p.Clients["mihomo"]
	for base, want := range map[string]string{
		"a: {{opt.nope}}\n{{proxies}}\n{{proxy_groups}}\n{{rules}}": "Undefined option",
		"{{proxies}}\n{{proxy_groups}}":                             "Missing required placeholder {{rules}}",
		"{{proxies}}\n{{proxy_groups}}\n{{rules}}\n{{ .Env }}":      "",
		"{{proxies}}\n{{proxy_groups}}\n{{rules}}\n{{exec}}":        "Unknown placeholder",
	} {
		ct.Base = base
		p.Clients["mihomo"] = ct
		_, err := Render("mihomo", p, SampleEndpoints(), meta)
		if want == "" {
			if err != nil {
				t.Fatalf("%q: %v", base, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%q: got %v", base, err)
		}
	}
	p = MinimalPreset()
	ct = p.Clients["mihomo"]
	ct.Options = map[string]string{"mixed_port": "7890\nexternal-controller: 0.0.0.0:9090"}
	p.Clients["mihomo"] = ct
	if _, err := Render("mihomo", p, SampleEndpoints(), meta); err == nil {
		t.Fatal("option newline accepted")
	}
	// node names cannot inject placeholders or YAML
	eps := SampleEndpoints()
	eps[0].Remark = "{{rules}}\n- MATCH,DIRECT"
	r := mustRender(t, "mihomo", MinimalPreset(), eps)
	if strings.Count(string(r.Body), "MATCH,") != 1 {
		t.Fatalf("injection:\n%s", r.Body)
	}
}

func TestLargeInlineAndMirror(t *testing.T) {
	p := StandardPreset()
	var vs []string
	for i := 0; i < 500; i++ {
		vs = append(vs, "d"+strings.Repeat("x", i%7)+string(rune('a'+i%26))+".example.org")
	}
	p.RuleSets = append(p.RuleSets, RuleSet{ID: "big", Name: "big", Inline: []Matcher{{Type: "domain_suffix", Values: vs}}})
	p.Rules = append([]Rule{{RuleSet: "big", Target: "DIRECT"}}, p.Rules...)
	p.Mirror = "https://ghproxy.example/"
	r := mustRender(t, "mihomo", p, SampleEndpoints())
	if !strings.Contains(string(r.Body), `"big-inline": {"behavior":"classical","payload"`) {
		t.Fatal("inline provider missing")
	}
	if !strings.Contains(string(r.Body), `"url":"https://ghproxy.example/https://github.com/MetaCubeX/`) {
		t.Fatal("mirror not applied")
	}
	sb := mustRender(t, "singbox", p, SampleEndpoints())
	boxCheck(t, sb.Body)
	if !strings.Contains(string(sb.Body), "https://ghproxy.example/https://raw.githubusercontent.com/") {
		t.Fatal("mirror not applied to sing-box")
	}
	// global mirror applies when the profile has none
	p.Mirror = ""
	r2, _ := Render("surge", p, SampleEndpoints(), Meta{Mirror: "https://m.example/"})
	if !strings.Contains(string(r2.Body), "RULE-SET,https://m.example/https://raw.githubusercontent.com/blackmatrix7") {
		t.Fatal("global mirror")
	}
	p.RuleSets[len(p.RuleSets)-1].Inline[0].Values = make([]string, MaxInlineValues+1)
	if err := Validate(p); err == nil {
		t.Fatal("inline limit")
	}
}

func TestNameDedupAndCaps(t *testing.T) {
	eps := SampleEndpoints()
	eps[1].Remark = "🚀 节点选择" // collides with a group
	eps[2].Remark = "a,b=c"
	eps[3].Remark = "a,b=c"
	r := mustRender(t, "surge", MinimalPreset(), eps)
	s := string(r.Body)
	if !strings.Contains(s, "🚀 节点选择 2 = trojan") || !strings.Contains(s, "a b-c = hysteria2") || !strings.Contains(s, "a b-c 2 = ss") {
		t.Fatalf("names:\n%s", s)
	}
	if ok, _ := Supported("surge", Endpoint{Type: "vmess", Network: "grpc"}); ok {
		t.Fatal("surge grpc")
	}
	if ok, _ := Supported("mihomo", Endpoint{Type: "vless", Security: "reality"}); !ok {
		t.Fatal("mihomo reality")
	}
}
