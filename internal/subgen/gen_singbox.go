package subgen

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// ---------------- sing-box ----------------

var singField = map[string]string{"domain": "domain", "domain_suffix": "domain_suffix", "domain_keyword": "domain_keyword",
	"domain_regex": "domain_regex", "ip_cidr": "ip_cidr", "process_name": "process_name", "port": "port", "network": "network"}

func singboxSections(c *Compiled) map[string]string {
	tag := func(n string) string {
		if n == "DIRECT" {
			return "direct"
		}
		return n
	}
	var outs []any
	// A group whose default (first) member is REJECT acts as a block list: sing-box
	// has no reject outbound, so rules aimed at it become reject actions.
	rejecting := map[string]bool{}
	for _, g := range c.Groups {
		if len(g.Out) > 0 && g.Out[0] == "REJECT" {
			rejecting[g.Name] = true
		}
	}
	for _, g := range c.Groups {
		var members []string
		for _, m := range g.Out {
			if m == "REJECT" {
				continue // sing-box has no reject outbound (block removed in 1.13); use rule actions
			}
			members = append(members, tag(m))
		}
		if len(members) == 0 {
			members = []string{"direct"}
		}
		switch g.Type {
		case "select":
			outs = append(outs, map[string]any{"type": "selector", "tag": g.Name, "outbounds": members, "interrupt_exist_connections": true})
		default: // url-test; sing-box has no fallback/load-balance, url-test is closest
			if g.Type != "url-test" {
				c.warn("sing-box doesn't support %s; group %s is emitted as urltest", g.Type, g.Name)
			}
			outs = append(outs, map[string]any{"type": "urltest", "tag": g.Name, "outbounds": members,
				"url": or(g.TestURL, "https://www.gstatic.com/generate_204"), "interval": fmt.Sprintf("%ds", orI(g.Interval, 300)), "tolerance": orI(g.Tolerance, 50)})
		}
	}
	for _, e := range c.Nodes {
		outs = append(outs, e.SingboxConfigOutbound())
	}
	outs = append(outs, map[string]any{"type": "direct", "tag": "direct"})

	rules := []any{
		map[string]any{"action": "sniff"},
		map[string]any{"protocol": "dns", "action": "hijack-dns"},
	}
	var sets []any
	resolved := false
	var cur CRule
	emit := func(r map[string]any, target string, ip bool) {
		// one resolve action before the first IP rule that asks for it; later
		// rules then see the resolved destination (sing-box 1.11+ semantics)
		if ip && cur.ResolveIP && !resolved {
			rules = append(rules, map[string]any{"action": "resolve"})
			resolved = true
		}
		if target == "REJECT" || rejecting[target] {
			r["action"] = "reject"
		} else {
			r["outbound"] = tag(target)
		}
		rules = append(rules, r)
	}
	for _, r := range c.Rules {
		cur = r
		if r.Set.Remote != nil {
			refs := remotesFor("singbox", r.Set, c.Mirror)
			if len(refs) == 0 {
				c.warn("Rule set %s has no sing-box source; skipped", r.Set.Name)
			}
			for _, ref := range refs {
				sets = append(sets, map[string]any{"type": "remote", "tag": ref.Tag, "format": ref.Format, "url": ref.URL,
					"download_detour": "direct", "update_interval": fmt.Sprintf("%dh", orI(r.Set.Remote.Interval, 86400)/3600)})
				emit(map[string]any{"rule_set": []string{ref.Tag}}, r.Target, ref.IPRule)
			}
		}
		if len(r.Set.Inline) == 0 {
			continue
		}
		// inline: one headless rule per matcher type, OR'd together in an inline rule set
		var hl []any
		ip := false
		for _, m := range r.Set.Inline {
			switch m.Type {
			case "geosite", "geoip":
				// sing-box 1.12 dropped geosite/geoip DBs: map onto remote srs
				kind := m.Type
				for _, v := range m.Values {
					t := r.Set.ID + "-" + kind + "-" + v
					sets = append(sets, map[string]any{"type": "remote", "tag": t, "format": "binary",
						"url": Mirrored(c.Mirror, fmt.Sprintf("%s/%s/%s.srs", singBase, kind, strings.ToLower(v))), "download_detour": "direct"})
					emit(map[string]any{"rule_set": []string{t}}, r.Target, kind == "geoip")
				}
			default:
				if m.Type == "ip_cidr" {
					ip = true
				}
				var v any = m.Values
				if m.Type == "port" {
					var ps []int
					for _, s := range m.Values {
						n, _ := strconv.Atoi(s)
						ps = append(ps, n)
					}
					v = ps
				}
				if m.Type == "network" {
					v = m.Values[0]
				}
				hl = append(hl, map[string]any{singField[m.Type]: v})
			}
		}
		if len(hl) > 0 {
			t := r.Set.ID + "-inline"
			sets = append(sets, map[string]any{"type": "inline", "tag": t, "rules": hl})
			emit(map[string]any{"rule_set": []string{t}}, r.Target, ip)
		}
	}
	if sets == nil {
		sets = []any{}
	}
	final := tag(c.Final)
	// DNS: remote via the final group, domestic direct for DirectSets
	var servers []any
	for i, s := range c.DNS.Remote {
		servers = append(servers, dnsServer(fmt.Sprintf("remote%d", i), s, final))
	}
	servers = append(servers, map[string]any{"type": "local", "tag": "local"})
	for i, s := range c.DNS.Domestic {
		servers = append(servers, dnsServer(fmt.Sprintf("domestic%d", i), s, ""))
	}
	var dnsRules []any
	if len(c.DNS.Domestic) > 0 {
		var tags []string
		for _, id := range c.DNS.DirectSets {
			if gs := c.dnsGeosite(id); gs != "" {
				tags = append(tags, id+"-dns")
				sets = append(sets, map[string]any{"type": "remote", "tag": id + "-dns", "format": "binary",
					"url": Mirrored(c.Mirror, fmt.Sprintf("%s/geosite/%s.srs", singBase, gs)), "download_detour": "direct"})
			}
		}
		if len(tags) > 0 {
			dnsRules = append(dnsRules, map[string]any{"rule_set": tags, "server": "domestic0"})
		}
	}
	dns := map[string]any{"servers": servers, "rules": orA(dnsRules), "final": "local", "strategy": map[bool]string{true: "prefer_ipv4", false: "ipv4_only"}[c.DNS.IPv6]}
	if len(c.DNS.Remote) > 0 {
		dns["final"] = "remote0"
	}
	ind := func(v any) string { b, _ := json.MarshalIndent(v, "", "  "); return string(b) }
	return map[string]string{"outbounds": ind(outs), "route_rules": ind(rules), "rule_set": ind(sets), "final": jstr(final), "dns": ind(dns)}
}

func dnsServer(tag, s, detour string) map[string]any {
	m := map[string]any{"tag": tag}
	switch {
	case strings.HasPrefix(s, "https://"):
		rest := strings.TrimPrefix(s, "https://")
		host, path, _ := strings.Cut(rest, "/")
		m["type"], m["server"] = "https", host
		if path != "" && path != "dns-query" {
			m["path"] = "/" + path
		}
	case strings.HasPrefix(s, "tls://"):
		m["type"], m["server"] = "tls", strings.TrimPrefix(s, "tls://")
	default:
		m["type"], m["server"] = "udp", s
	}
	if detour != "" && detour != "direct" {
		m["detour"] = detour
	}
	return m
}
