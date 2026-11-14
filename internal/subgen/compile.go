package subgen

import (
	"fmt"
	"regexp"
	"strings"
)

// Caps describes what a client can consume.
type Caps struct {
	Protocols  map[string]bool // vless, vmess, trojan, shadowsocks, hysteria2, tuic, anytls
	Reality    bool
	Transports map[string]bool // "", ws, grpc, http, httpupgrade
	SSMethods  map[string]bool // nil = any
}

func set(xs ...string) map[string]bool {
	m := map[string]bool{}
	for _, x := range xs {
		m[x] = true
	}
	return m
}

var ClientCaps = map[string]Caps{
	"mihomo":  {Protocols: set("vless", "vmess", "trojan", "shadowsocks", "hysteria2", "tuic", "anytls"), Reality: true, Transports: set("", "tcp", "ws", "grpc", "http", "httpupgrade")},
	"singbox": {Protocols: set("vless", "vmess", "trojan", "shadowsocks", "hysteria2", "tuic", "anytls"), Reality: true, Transports: set("", "tcp", "ws", "grpc", "http", "httpupgrade")},
	// Surge 5: no VLESS, no REALITY, no gRPC/h2/httpupgrade; ws only for vmess/trojan.
	"surge": {Protocols: set("vmess", "trojan", "shadowsocks", "hysteria2", "tuic"), Transports: set("", "tcp", "ws"),
		SSMethods: set("aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305", "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305")},
}

// Supported reports whether client c can use endpoint e, with a reason if not.
func Supported(client string, e Endpoint) (bool, string) {
	c, ok := ClientCaps[client]
	if !ok {
		return true, ""
	}
	if !c.Protocols[e.Type] {
		return false, client + " 不支持 " + e.Type
	}
	if e.Security == "reality" && !c.Reality {
		return false, client + " 不支持 REALITY"
	}
	if !c.Transports[e.Network] {
		return false, client + " 不支持传输 " + e.Network
	}
	if e.Type == "shadowsocks" && c.SSMethods != nil && !c.SSMethods[e.SSMethod] {
		return false, client + " 不支持加密 " + e.SSMethod
	}
	return true, ""
}

// CGroup is a resolved group: concrete member names.
type CGroup struct {
	Group
	Out []string // member names as the client sees them (nodes, group names, DIRECT, REJECT)
}

// CRule is a resolved rule: rule set + target name.
type CRule struct {
	Set       RuleSet
	Target    string // client-visible name, "DIRECT" or "REJECT"
	ResolveIP bool
}

// Compiled is the client-specific, fully resolved model.
type Compiled struct {
	Client   string
	Nodes    []Endpoint
	Groups   []CGroup
	Rules    []CRule
	Final    string
	DNS      DNSPolicy
	Sets     map[string]RuleSet
	Mirror   string
	Warnings []string
}

// dnsGeosite returns the geosite name behind a rule set id, for DNS policy.
func (c *Compiled) dnsGeosite(id string) string {
	rs, ok := c.Sets[id]
	if !ok || rs.Remote == nil {
		return ""
	}
	return Catalog[rs.Remote.Catalog].Geosite
}

func (c *Compiled) warn(f string, a ...any) { c.Warnings = append(c.Warnings, fmt.Sprintf(f, a...)) }

// Validate checks the profile is self-consistent (ids, references, cycles, regexes, URLs).
func Validate(p *Profile) error {
	total := 0
	for _, rs := range p.RuleSets {
		for _, m := range rs.Inline {
			total += len(m.Values)
		}
	}
	if total > MaxInlineValues {
		return fmt.Errorf("内联规则共 %d 条，超过上限 %d，请改用远程规则集", total, MaxInlineValues)
	}
	for c, ct := range p.Clients {
		if len(ct.Base) > MaxTemplate {
			return fmt.Errorf("%s 模板超过 64 KB", c)
		}
	}
	if len(p.Groups) == 0 {
		return fmt.Errorf("至少需要一个策略组")
	}
	sets := map[string]bool{}
	for _, rs := range p.RuleSets {
		if rs.ID == "" || sets[rs.ID] {
			return fmt.Errorf("规则集 id 为空或重复: %q", rs.ID)
		}
		sets[rs.ID] = true
		if rs.Remote == nil && len(rs.Inline) == 0 {
			return fmt.Errorf("规则集 %s 为空", rs.ID)
		}
		if rs.Remote != nil {
			for k, u := range rs.Remote.URLs {
				if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
					return fmt.Errorf("规则集 %s 的 %s 地址只能是 http(s)", rs.ID, k)
				}
			}
			if rs.Remote.Catalog != "" {
				if _, ok := Catalog[rs.Remote.Catalog]; !ok {
					return fmt.Errorf("规则集 %s: 未知分类 %s", rs.ID, rs.Remote.Catalog)
				}
			}
		}
		for _, m := range rs.Inline {
			if !matcherTypes[m.Type] {
				return fmt.Errorf("规则集 %s: 未知匹配类型 %s", rs.ID, m.Type)
			}
			for _, v := range m.Values {
				if strings.ContainsAny(v, ",\n\r\"") {
					return fmt.Errorf("规则集 %s: 值含非法字符: %q", rs.ID, v)
				}
				if m.Type == "domain_regex" {
					if _, err := regexp.Compile(v); err != nil {
						return fmt.Errorf("规则集 %s: 正则错误 %v", rs.ID, err)
					}
				}
			}
		}
	}
	if p.Mirror != "" && !((strings.HasPrefix(p.Mirror, "https://") || strings.HasPrefix(p.Mirror, "http://")) && strings.HasSuffix(p.Mirror, "/")) {
		return fmt.Errorf("镜像前缀必须是以 / 结尾的 http(s) 地址")
	}
	groups := map[string]Group{}
	names := map[string]bool{"DIRECT": true, "REJECT": true}
	for _, g := range p.Groups {
		if g.ID == "" || groups[g.ID].ID != "" || names[g.Name] || g.Name == "" {
			return fmt.Errorf("分组 id/名称为空或重复: %q", g.ID)
		}
		if strings.ContainsAny(g.Name, ",=\n\"") {
			return fmt.Errorf("分组名 %q 含非法字符", g.Name)
		}
		switch g.Type {
		case "select", "url-test", "fallback", "load-balance":
		default:
			return fmt.Errorf("分组 %s: 未知类型 %s", g.ID, g.Type)
		}
		groups[g.ID], names[g.Name] = g, true
		for _, m := range g.Members {
			for _, re := range []string{m.Include, m.Exclude} {
				if _, err := regexp.Compile(re); err != nil {
					return fmt.Errorf("分组 %s: 正则错误 %v", g.ID, err)
				}
			}
		}
	}
	// cycles among group references
	state := map[string]int{}
	var visit func(id string) error
	visit = func(id string) error {
		switch state[id] {
		case 1:
			return fmt.Errorf("分组循环引用: %s", id)
		case 2:
			return nil
		}
		state[id] = 1
		for _, m := range groups[id].Members {
			if m.Kind == "group" {
				if _, ok := groups[m.Ref]; !ok {
					return fmt.Errorf("分组 %s 引用了不存在的分组 %s", id, m.Ref)
				}
				if err := visit(m.Ref); err != nil {
					return err
				}
			}
		}
		state[id] = 2
		return nil
	}
	for id := range groups {
		if err := visit(id); err != nil {
			return err
		}
	}
	target := func(t string) bool { _, ok := groups[t]; return ok || t == "DIRECT" || t == "REJECT" }
	for _, r := range p.Rules {
		if !sets[r.RuleSet] {
			return fmt.Errorf("路由引用了不存在的规则集 %s", r.RuleSet)
		}
		if !target(r.Target) {
			return fmt.Errorf("路由目标不存在: %s", r.Target)
		}
	}
	if p.Final == "REJECT" || !target(p.Final) {
		return fmt.Errorf("兜底目标无效: %s", p.Final)
	}
	return nil
}

var matcherTypes = set("domain", "domain_suffix", "domain_keyword", "domain_regex", "ip_cidr", "geosite", "geoip", "process_name", "port", "network")

// Compile resolves a profile for one client against the user's endpoints.
func Compile(p *Profile, client string, eps []Endpoint) (*Compiled, error) {
	if err := Validate(p); err != nil {
		return nil, err
	}
	c := &Compiled{Client: client, DNS: p.DNS}
	reserved := map[string]bool{"DIRECT": true, "REJECT": true}
	for _, g := range p.Groups {
		reserved[g.Name] = true
	}
	// 1. capability filter + name sanitising/dedup
	seen := map[string]int{}
	for _, e := range eps {
		if ok, why := Supported(client, e); !ok {
			c.warn("已跳过节点 %s：%s", e.Remark, why)
			continue
		}
		n := strings.NewReplacer(",", " ", "=", "-", "\n", " ", "\"", "'").Replace(strings.TrimSpace(e.Remark))
		if n == "" {
			n = e.Type
		}
		base := n
		for k := 2; reserved[n] || seen[n] > 0; k++ {
			n = fmt.Sprintf("%s %d", base, k)
		}
		seen[n]++
		e.Remark = n
		c.Nodes = append(c.Nodes, e)
	}
	// 2. resolve groups (depth-first so referenced groups are known first)
	byID := map[string]Group{}
	for _, g := range p.Groups {
		byID[g.ID] = g
	}
	resolved := map[string][]string{} // id -> members; nil entry + present = dropped
	dropped := map[string]bool{}
	var resolve func(id string) []string
	resolve = func(id string) []string {
		if out, ok := resolved[id]; ok {
			return out
		}
		g := byID[id]
		var out []string
		dup := map[string]bool{}
		add := func(n string) {
			if !dup[n] {
				dup[n] = true
				out = append(out, n)
			}
		}
		hasNode := false
		for _, m := range g.Members {
			switch m.Kind {
			case "all", "filter":
				inc, _ := regexp.Compile(m.Include)
				var exc *regexp.Regexp
				if m.Exclude != "" {
					exc, _ = regexp.Compile(m.Exclude)
				}
				for _, e := range c.Nodes {
					hay := e.Remark + "\x00" + e.Node
					if m.Kind == "filter" && !inc.MatchString(hay) {
						continue
					}
					if exc != nil && exc.MatchString(hay) {
						continue
					}
					add(e.Remark)
					hasNode = true
				}
			case "group":
				sub := resolve(m.Ref)
				if dropped[m.Ref] {
					continue
				}
				add(byID[m.Ref].Name)
				if len(sub) > 0 {
					hasNode = true
				}
			case "direct":
				add("DIRECT")
			case "reject":
				add("REJECT")
			}
		}
		if !hasNode && g.HideIfEmpty {
			dropped[id] = true
			c.warn("分组 %s 没有可用节点，已隐藏", g.Name)
		}
		if len(out) == 0 {
			out = []string{"DIRECT"} // clients reject empty groups
			if !dropped[id] {
				c.warn("分组 %s 没有成员，已用 DIRECT 占位", g.Name)
			}
		}
		// url-test/fallback/load-balance can't contain REJECT meaningfully; keep as-is but avoid groups-only DIRECT confusion.
		resolved[id] = out
		return out
	}
	for _, g := range p.Groups {
		out := resolve(g.ID)
		if !dropped[g.ID] {
			c.Groups = append(c.Groups, CGroup{Group: g, Out: out})
		}
	}
	name := func(t string) string {
		if t == "DIRECT" || t == "REJECT" {
			return t
		}
		if dropped[t] {
			return ""
		}
		return byID[t].Name
	}
	c.Final = name(p.Final)
	if c.Final == "" {
		c.Final = "DIRECT"
		c.warn("兜底分组被隐藏，改为 DIRECT")
	}
	// 3. rules
	sets := map[string]RuleSet{}
	for _, rs := range p.RuleSets {
		sets[rs.ID] = rs
	}
	c.Sets = sets
	for _, r := range p.Rules {
		if r.Disabled {
			continue
		}
		t := name(r.Target)
		if t == "" {
			t = c.Final
			c.warn("规则 %s 的目标分组被隐藏，改走兜底 %s", r.RuleSet, c.Final)
		}
		c.Rules = append(c.Rules, CRule{Set: sets[r.RuleSet], Target: t, ResolveIP: r.ResolveIP})
	}
	return c, nil
}
