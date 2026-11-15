package subgen

import (
	"encoding/json"
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// Limits keep one profile from turning every subscription fetch into megabytes.
const (
	MaxInlineValues = 20000
	MaxTemplate     = 64 << 10
)

// ValidateOutput structurally checks a rendered config: it parses and every
// reference (group members, rule targets, providers, rule sets) resolves. The
// master doesn't link sing-box, so the full box.New check lives in tests.
func ValidateOutput(client string, body []byte) error {
	switch client {
	case "mihomo":
		return checkMihomo(body)
	case "singbox":
		return checkSingbox(body)
	case "surge":
		return checkSurge(body)
	}
	return fmt.Errorf("unknown client %s", client)
}

func checkMihomo(b []byte) error {
	var cfg struct {
		Proxies     []map[string]any `yaml:"proxies"`
		ProxyGroups []struct {
			Name    string   `yaml:"name"`
			Proxies []string `yaml:"proxies"`
		} `yaml:"proxy-groups"`
		RuleProviders map[string]map[string]any `yaml:"rule-providers"`
		Rules         []string                  `yaml:"rules"`
	}
	if err := yaml.Unmarshal(b, &cfg); err != nil {
		return fmt.Errorf("YAML parse error: %v", err)
	}
	known := map[string]bool{"DIRECT": true, "REJECT": true}
	for _, p := range cfg.Proxies {
		n, _ := p["name"].(string)
		if known[n] {
			return fmt.Errorf("Duplicate node name: %s", n)
		}
		known[n] = true
	}
	for _, g := range cfg.ProxyGroups {
		if known[g.Name] {
			return fmt.Errorf("Duplicate group name: %s", g.Name)
		}
		known[g.Name] = true
	}
	for _, g := range cfg.ProxyGroups {
		if len(g.Proxies) == 0 {
			return fmt.Errorf("Group %s is empty", g.Name)
		}
		for _, m := range g.Proxies {
			if !known[m] {
				return fmt.Errorf("Group %s references missing %s", g.Name, m)
			}
		}
	}
	if len(cfg.Rules) == 0 || !strings.HasPrefix(cfg.Rules[len(cfg.Rules)-1], "MATCH,") {
		return fmt.Errorf("rules must end with MATCH")
	}
	for _, r := range cfg.Rules {
		f := strings.Split(r, ",")
		if len(f) < 2 {
			return fmt.Errorf("Malformed rule: %s", r)
		}
		tgt := f[len(f)-1]
		if tgt == "no-resolve" {
			tgt = f[len(f)-2]
		}
		if !known[tgt] {
			return fmt.Errorf("Rule target doesn't exist: %s", r)
		}
		if f[0] == "RULE-SET" && cfg.RuleProviders[f[1]] == nil {
			return fmt.Errorf("Rule set not defined: %s", f[1])
		}
	}
	return nil
}

func checkSingbox(b []byte) error {
	var cfg struct {
		DNS struct {
			Servers []struct {
				Tag    string `json:"tag"`
				Detour string `json:"detour"`
			} `json:"servers"`
			Rules []struct {
				RuleSet []string `json:"rule_set"`
				Server  string   `json:"server"`
			} `json:"rules"`
			Final string `json:"final"`
		} `json:"dns"`
		Outbounds []struct {
			Type      string   `json:"type"`
			Tag       string   `json:"tag"`
			Outbounds []string `json:"outbounds"`
		} `json:"outbounds"`
		Route struct {
			Rules []struct {
				RuleSet  []string `json:"rule_set"`
				Outbound string   `json:"outbound"`
			} `json:"rules"`
			RuleSet []struct {
				Tag string `json:"tag"`
			} `json:"rule_set"`
			Final string `json:"final"`
		} `json:"route"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return fmt.Errorf("JSON parse error: %v", err)
	}
	outs, sets, servers := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, o := range cfg.Outbounds {
		if o.Tag == "" || outs[o.Tag] {
			return fmt.Errorf("Outbound tag is empty or duplicated: %q", o.Tag)
		}
		outs[o.Tag] = true
	}
	for _, o := range cfg.Outbounds {
		if (o.Type == "selector" || o.Type == "urltest") && len(o.Outbounds) == 0 {
			return fmt.Errorf("Group %s is empty", o.Tag)
		}
		for _, m := range o.Outbounds {
			if !outs[m] {
				return fmt.Errorf("Group %s references missing outbound %s", o.Tag, m)
			}
		}
	}
	for _, s := range cfg.Route.RuleSet {
		if sets[s.Tag] {
			return fmt.Errorf("Duplicate rule set tag: %s", s.Tag)
		}
		sets[s.Tag] = true
	}
	for _, r := range cfg.Route.Rules {
		if r.Outbound != "" && !outs[r.Outbound] {
			return fmt.Errorf("A route rule references missing outbound %s", r.Outbound)
		}
		for _, t := range r.RuleSet {
			if !sets[t] {
				return fmt.Errorf("Rule set not defined: %s", t)
			}
		}
	}
	if cfg.Route.Final != "" && !outs[cfg.Route.Final] {
		return fmt.Errorf("route.final doesn't exist: %s", cfg.Route.Final)
	}
	for _, s := range cfg.DNS.Servers {
		servers[s.Tag] = true
		if s.Detour != "" && !outs[s.Detour] {
			return fmt.Errorf("The detour of DNS server %s doesn't exist", s.Tag)
		}
	}
	for _, r := range cfg.DNS.Rules {
		if !servers[r.Server] {
			return fmt.Errorf("A DNS rule references missing server %s", r.Server)
		}
		for _, t := range r.RuleSet {
			if !sets[t] {
				return fmt.Errorf("DNS rule set not defined: %s", t)
			}
		}
	}
	if cfg.DNS.Final != "" && !servers[cfg.DNS.Final] {
		return fmt.Errorf("dns.final doesn't exist: %s", cfg.DNS.Final)
	}
	return nil
}

// SurgeSections splits a Surge profile into sections (exported for tests).
func SurgeSections(s string) (map[string][]string, error) {
	sections := map[string][]string{}
	cur := ""
	for _, ln := range strings.Split(s, "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" || strings.HasPrefix(ln, "#") {
			continue
		}
		if strings.HasPrefix(ln, "[") && strings.HasSuffix(ln, "]") {
			if _, dup := sections[ln]; dup {
				return nil, fmt.Errorf("Duplicate section: %s", ln)
			}
			cur = ln
			sections[cur] = nil
			continue
		}
		if cur == "" {
			return nil, fmt.Errorf("Content outside any section: %s", ln)
		}
		sections[cur] = append(sections[cur], ln)
	}
	return sections, nil
}

func checkSurge(b []byte) error {
	secs, err := SurgeSections(string(b))
	if err != nil {
		return err
	}
	for _, s := range []string{"[General]", "[Proxy]", "[Proxy Group]", "[Rule]"} {
		if _, ok := secs[s]; !ok {
			return fmt.Errorf("Missing %s section", s)
		}
	}
	names := map[string]bool{"DIRECT": true, "REJECT": true}
	for _, sec := range []string{"[Proxy]", "[Proxy Group]"} {
		for _, ln := range secs[sec] {
			n, _, ok := strings.Cut(ln, " = ")
			if !ok {
				return fmt.Errorf("Malformed %s line: %s", sec, ln)
			}
			names[n] = true
		}
	}
	for _, ln := range secs["[Proxy Group]"] {
		_, rest, _ := strings.Cut(ln, " = ")
		for _, m := range strings.Split(rest, ", ")[1:] {
			if !strings.Contains(m, "=") && !names[m] {
				return fmt.Errorf("Group member doesn't exist: %q", m)
			}
		}
	}
	rules := secs["[Rule]"]
	if len(rules) == 0 || !strings.HasPrefix(rules[len(rules)-1], "FINAL,") {
		return fmt.Errorf("[Rule] must end with FINAL")
	}
	for _, ln := range rules {
		f := strings.Split(ln, ",")
		tgt := f[len(f)-1]
		if tgt == "no-resolve" || tgt == "dns-failed" {
			tgt = f[len(f)-2]
		}
		if !names[tgt] {
			return fmt.Errorf("Rule target doesn't exist: %s", ln)
		}
	}
	return nil
}

// Sample endpoints cover every protocol/transport so a dry run exercises the
// capability filter of each client.
func SampleEndpoints() []Endpoint {
	return []Endpoint{
		{Remark: "🇭🇰 香港 Reality", Node: "hk", Type: "vless", Address: "hk.example.com", Port: 443, UUID: "11111111-1111-4111-8111-111111111111",
			Flow: "xtls-rprx-vision", Security: "reality", SNI: "www.microsoft.com", FP: "chrome", PBK: "jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0", SID: "6ba85179e30d4fc2", Network: "tcp"},
		{Remark: "🇯🇵 日本 Trojan", Node: "jp", Type: "trojan", Address: "jp.example.com", Port: 443, Password: "p@ss,word", Security: "tls", SNI: "jp.example.com", Network: "ws", Path: "/tr", Host: "jp.example.com"},
		{Remark: "🇺🇸 美国 Hysteria2", Node: "us", Type: "hysteria2", Address: "us.example.com", Port: 8443, Password: "hy2pass", Security: "tls", SNI: "us.example.com"},
		{Remark: "🇺🇸 美国 SS2022", Node: "us", Type: "shadowsocks", Address: "us.example.com", Port: 8388, SSMethod: "2022-blake3-aes-128-gcm", Password: "AAAAAAAAAAAAAAAAAAAAAA==:BBBBBBBBBBBBBBBBBBBBBB=="},
		{Remark: "🇸🇬 新加坡 VMess gRPC", Node: "sg", Type: "vmess", Address: "sg.example.com", Port: 443, UUID: "22222222-2222-4222-8222-222222222222", Security: "tls", SNI: "sg.example.com", Network: "grpc", Service: "grpc"},
	}
}

// Check renders every enabled client of p with sample endpoints and validates
// the output. Returns per-client warnings.
func Check(p *Profile) (map[string][]string, error) {
	if err := Validate(p); err != nil {
		return nil, err
	}
	out := map[string][]string{}
	n := 0
	for c, ct := range p.Clients {
		if _, ok := ClientCaps[c]; !ok {
			return nil, fmt.Errorf("Unknown client %s", c)
		}
		if !ct.Enabled {
			continue
		}
		n++
		r, err := Render(c, p, SampleEndpoints(), Meta{SubURL: "https://sub.example.com/s/sample"})
		if err != nil {
			return nil, fmt.Errorf("%s: %v", ClientNames[c], err)
		}
		if err := ValidateOutput(c, r.Body); err != nil {
			return nil, fmt.Errorf("Invalid %s output: %v", ClientNames[c], err)
		}
		out[c] = r.Warnings
	}
	if n == 0 {
		return nil, fmt.Errorf("Enable at least one client template")
	}
	return out, nil
}

var ClientNames = map[string]string{"mihomo": "Clash / mihomo", "singbox": "sing-box", "surge": "Surge"}
