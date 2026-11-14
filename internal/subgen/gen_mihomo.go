package subgen

import (
	"strconv"
	"strings"
)

// ---------------- mihomo ----------------

var mihomoType = map[string]string{"domain": "DOMAIN", "domain_suffix": "DOMAIN-SUFFIX", "domain_keyword": "DOMAIN-KEYWORD",
	"domain_regex": "DOMAIN-REGEX", "geosite": "GEOSITE", "geoip": "GEOIP", "process_name": "PROCESS-NAME", "port": "DST-PORT", "network": "NETWORK"}

func mihomoMatch(m Matcher, v string) string {
	t := mihomoType[m.Type]
	if m.Type == "ip_cidr" {
		t = "IP-CIDR"
		if strings.Contains(v, ":") {
			t = "IP-CIDR6"
		}
	}
	if m.Type == "geoip" {
		v = strings.ToUpper(v)
	}
	return t + "," + v
}

func mihomoSections(c *Compiled) map[string]string {
	var px, gs, rp, rs strings.Builder
	px.WriteString("proxies:\n")
	for _, e := range c.Nodes {
		px.WriteString("  - " + jstr(e.MihomoProxy()) + "\n")
	}
	if len(c.Nodes) == 0 {
		px.Reset()
		px.WriteString("proxies: []\n")
	}
	gs.WriteString("proxy-groups:\n")
	for _, g := range c.Groups {
		m := map[string]any{"name": g.Name, "type": g.Type, "proxies": g.Out}
		if g.Type != "select" {
			m["url"], m["interval"] = or(g.TestURL, "https://www.gstatic.com/generate_204"), orI(g.Interval, 300)
			if g.Type == "url-test" {
				m["tolerance"] = orI(g.Tolerance, 50)
			}
			if g.Type == "load-balance" {
				m["strategy"] = "consistent-hashing"
			}
		}
		gs.WriteString("  - " + jstr(m) + "\n")
	}
	providers := 0
	rs.WriteString("rules:\n")
	rule := func(s string) { rs.WriteString("  - " + jstr(s) + "\n") }
	for _, r := range c.Rules {
		if r.Set.Remote != nil {
			refs := remotesFor("mihomo", r.Set, c.Mirror)
			if len(refs) == 0 {
				c.warn("规则集 %s 没有 mihomo 源，已跳过", r.Set.Name)
			}
			for _, ref := range refs {
				if providers == 0 {
					rp.WriteString("rule-providers:\n")
				}
				providers++
				m := map[string]any{"type": "http", "behavior": ref.Behavior, "format": ref.Format, "url": ref.URL,
					"interval": orI(r.Set.Remote.Interval, 86400), "proxy": "DIRECT"}
				rp.WriteString("  " + jstr(ref.Tag) + ": " + jstr(m) + "\n")
				s := "RULE-SET," + ref.Tag + "," + r.Target
				if ref.IPRule && !r.ResolveIP {
					s += ",no-resolve"
				}
				rule(s)
			}
		}
		n := 0
		for _, m := range r.Set.Inline {
			n += len(m.Values)
		}
		if n > InlineExpandMax {
			// one inline classical provider keeps the rules list readable
			if providers == 0 {
				rp.WriteString("rule-providers:\n")
			}
			providers++
			var payload []string
			for _, m := range r.Set.Inline {
				for _, v := range m.Values {
					payload = append(payload, mihomoMatch(m, v))
				}
			}
			rp.WriteString("  " + jstr(r.Set.ID+"-inline") + ": " + jstr(map[string]any{"type": "inline", "behavior": "classical", "payload": payload}) + "\n")
			rule("RULE-SET," + r.Set.ID + "-inline," + r.Target)
			continue
		}
		for _, m := range r.Set.Inline {
			for _, v := range m.Values {
				s := mihomoMatch(m, v) + "," + r.Target
				if (m.Type == "ip_cidr" || m.Type == "geoip") && m.NoResolve {
					s += ",no-resolve"
				}
				rule(s)
			}
		}
	}
	rule("MATCH," + c.Final)
	dns := "dns:\n  enable: true\n  ipv6: " + strconv.FormatBool(c.DNS.IPv6) + "\n  enhanced-mode: " + or(c.DNS.Mode, "fake-ip") + "\n"
	if c.DNS.Mode != "real-ip" {
		dns += "  fake-ip-range: 198.18.0.1/16\n  fake-ip-filter: [\"*.lan\", \"+.local\", \"+.msftconnecttest.com\"]\n"
	}
	dns += "  default-nameserver: [223.5.5.5, 119.29.29.29]\n"
	dns += "  nameserver: " + jstr(c.DNS.Remote) + "\n"
	if len(c.DNS.DirectSets) > 0 && len(c.DNS.Domestic) > 0 {
		dns += "  nameserver-policy:\n"
		for _, id := range c.DNS.DirectSets {
			if gs := c.dnsGeosite(id); gs != "" {
				dns += "    " + jstr("geosite:"+gs) + ": " + jstr(c.DNS.Domestic) + "\n"
			}
		}
	}
	return map[string]string{"proxies": px.String(), "proxy_groups": gs.String(), "rule_providers": rp.String(), "rules": rs.String(), "dns": dns}
}
