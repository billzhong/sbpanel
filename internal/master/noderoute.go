package master

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/include"
	"github.com/sagernet/sing-box/option"
	sjson "github.com/sagernet/sing/common/json"
)

// Per-node route rules. A node's sing-box route is its template's route with the node's
// own rules spliced in after the template's leading non-routing rules (sniff, hijack-dns,
// resolve) and before the template's routing rules, so they take precedence without
// breaking sniffing; the node may also replace route.final. Outbounds and rule sets stay
// the template's: node rules reference them by tag. Stored in node_routes (v12), merged in
// buildSpec, never written into the template.

type nodeRoute struct {
	Rules []map[string]any `json:"rules"`
	Final string           `json:"final"` // "" = the template's
}

func loadNodeRoute(db *sql.DB, nodeID string) (nodeRoute, int64) {
	var js string
	var at int64
	var nr nodeRoute
	if db.QueryRow(`SELECT json, updated_at FROM node_routes WHERE node_id=?`, nodeID).Scan(&js, &at) == nil {
		json.Unmarshal([]byte(js), &nr)
	}
	return nr, at
}

// leadingRules is where node rules go: after the template's run of non-routing rules.
func leadingRules(rules []any) int {
	for i, r := range rules {
		switch str(r.(map[string]any), "action") {
		case "sniff", "hijack-dns", "resolve":
		default:
			return i
		}
	}
	return len(rules)
}

func tagsOf(list []any) map[string]bool {
	out := map[string]bool{}
	for _, x := range list {
		if m, ok := x.(map[string]any); ok && str(m, "tag") != "" {
			out[str(m, "tag")] = true
		}
	}
	return out
}

// ruleMatchers are the sing-box (default rule) match fields a node rule may use. sing-box
// itself silently ignores unknown fields on reject rules, so they are checked here.
var ruleMatchers = map[string]bool{
	"inbound": true, "ip_version": true, "network": true, "auth_user": true, "protocol": true, "client": true,
	"domain": true, "domain_suffix": true, "domain_keyword": true, "domain_regex": true,
	"source_ip_cidr": true, "source_ip_is_private": true, "ip_cidr": true, "ip_is_private": true,
	"source_port": true, "source_port_range": true, "port": true, "port_range": true,
	"rule_set": true, "rule_set_ip_cidr_match_source": true, "user": true, "invert": true,
}

// checkNodeRule reports why a node rule can't be used with this template ("" = fine).
func checkNodeRule(r map[string]any, outs, sets map[string]bool) string {
	if len(r) == 0 {
		return "Empty rule"
	}
	matchers := 0
	for k := range r {
		switch {
		case k == "action" || k == "outbound" || k == "method" || k == "no_drop":
		case !ruleMatchers[k]:
			return "Unsupported rule field: " + k
		case k != "invert":
			matchers++
		}
	}
	if matchers == 0 {
		return "A rule needs at least one match condition"
	}
	switch a := str(r, "action"); a {
	case "", "route":
		if ob := str(r, "outbound"); ob == "" {
			return "A route rule needs an outbound"
		} else if !outs[ob] {
			return "A route rule references a missing outbound: " + ob
		}
	case "reject":
	default:
		return "Unsupported rule action: " + a
	}
	if rs, ok := r["rule_set"]; ok {
		list, _ := rs.([]any)
		if s, ok := rs.(string); ok {
			list = []any{s}
		}
		for _, x := range list {
			if s, _ := x.(string); !sets[s] {
				return fmt.Sprintf("Unknown rule set: %v", x)
			}
		}
	}
	return ""
}

// mergeNodeRoute splices the node's rules into the template skeleton. strict returns the
// first problem as an error; otherwise unusable rules (e.g. the template dropped their
// outbound) are left out and reported as warnings, so a template change never blocks a node.
func mergeNodeRoute(skeleton string, nr nodeRoute, strict bool) (merged string, insertAt int, warnings []string, err error) {
	var sk map[string]any
	if err := json.Unmarshal([]byte(skeleton), &sk); err != nil {
		return "", 0, nil, fmt.Errorf("skeleton: %w", err)
	}
	route := obj(sk, "route")
	if route == nil {
		route = map[string]any{}
		sk["route"] = route
	}
	rules, _ := route["rules"].([]any)
	insertAt = leadingRules(rules)
	if len(nr.Rules) == 0 && nr.Final == "" {
		return skeleton, insertAt, nil, nil
	}
	outs, _ := sk["outbounds"].([]any)
	sets, _ := route["rule_set"].([]any)
	ot, st := tagsOf(outs), tagsOf(sets)
	var mine []any
	for i, r := range nr.Rules {
		if msg := checkNodeRule(r, ot, st); msg != "" {
			if strict {
				return "", 0, nil, fmt.Errorf("Rule %d: %s", i+1, msg)
			}
			warnings = append(warnings, fmt.Sprintf("Rule %d skipped: %s", i+1, msg))
			continue
		}
		mine = append(mine, r)
	}
	out := append(append(append([]any{}, rules[:insertAt]...), mine...), rules[insertAt:]...)
	route["rules"] = out
	if nr.Final != "" {
		if ot[nr.Final] {
			route["final"] = nr.Final
		} else if strict {
			return "", 0, nil, fmt.Errorf("route.final points to a missing outbound: %s", nr.Final)
		} else {
			warnings = append(warnings, "Final outbound skipped: missing outbound "+nr.Final)
		}
	}
	b, _ := json.Marshal(sk)
	return string(b), insertAt, warnings, nil
}

// singboxCheck builds (without starting) a sing-box instance from a skeleton: the same
// parsing and rule construction the node runs before it swaps its core.
func singboxCheck(skeleton string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("sing-box: %v", r)
		}
	}()
	ctx := include.Context(context.Background())
	// strict, like `sing-box check`: unknown fields are errors (the node would ignore them)
	opts, err := sjson.UnmarshalExtendedContext[option.Options](ctx, []byte(skeleton))
	if err != nil {
		return fmt.Errorf("sing-box: %w", err)
	}
	opts.Inbounds = nil
	opts.Log = &option.LogOptions{Disabled: true}
	opts.Experimental = nil // no clash API / cache file side effects
	inst, err := box.New(box.Options{Context: ctx, Options: opts})
	if err != nil {
		return fmt.Errorf("sing-box: %w", err)
	}
	return inst.Close()
}

type routeRuleOut struct {
	Rule   map[string]any `json:"rule"`
	Source string         `json:"source"` // template | node
}

func (m *Master) nodeRouteView(nodeID string) (map[string]any, error) {
	var tid int64
	if err := m.db.QueryRow(`SELECT template_id FROM nodes WHERE id=?`, nodeID).Scan(&tid); err != nil {
		return nil, err
	}
	skeleton, err := nodeSkeleton(m.db, nodeID)
	if err != nil {
		return nil, err
	}
	var tname string
	m.db.QueryRow(`SELECT name FROM templates WHERE id=?`, tid).Scan(&tname)
	nr, at := loadNodeRoute(m.db, nodeID)
	merged, insertAt, warnings, err := mergeNodeRoute(skeleton, nr, false)
	if err != nil {
		return nil, err
	}
	var sk, eff map[string]any
	json.Unmarshal([]byte(skeleton), &sk)
	json.Unmarshal([]byte(merged), &eff)
	troute := obj(sk, "route")
	trules, _ := troute["rules"].([]any)
	type tagType struct {
		Tag  string `json:"tag"`
		Type string `json:"type"`
	}
	list := func(v any) []tagType {
		out := []tagType{}
		l, _ := v.([]any)
		for _, x := range l {
			if mm, ok := x.(map[string]any); ok {
				out = append(out, tagType{str(mm, "tag"), str(mm, "type")})
			}
		}
		return out
	}
	erules, _ := obj(eff, "route")["rules"].([]any)
	nKept := len(erules) - len(trules)
	effective := make([]routeRuleOut, 0, len(erules))
	for i, r := range erules {
		src := "template"
		if i >= insertAt && i < insertAt+nKept {
			src = "node"
		}
		effective = append(effective, routeRuleOut{r.(map[string]any), src})
	}
	finalSrc := "template"
	if nr.Final != "" && str(obj(eff, "route"), "final") == nr.Final {
		finalSrc = "node"
	}
	tags := []string{}
	rows, _ := m.db.Query(`SELECT tag FROM inbounds WHERE node_id=? ORDER BY tag`, nodeID)
	if rows != nil {
		for rows.Next() {
			var t string
			rows.Scan(&t)
			tags = append(tags, t)
		}
		rows.Close()
	}
	if nr.Rules == nil {
		nr.Rules = []map[string]any{}
	}
	if warnings == nil {
		warnings = []string{}
	}
	return map[string]any{
		"template":       map[string]any{"id": tid, "name": tname},
		"outbounds":      list(sk["outbounds"]),
		"rule_sets":      list(troute["rule_set"]),
		"inbounds":       tags,
		"template_rules": trules,
		"template_final": str(troute, "final"),
		"insert_at":      insertAt,
		"node":           map[string]any{"rules": nr.Rules, "final": nr.Final, "updated_at": at},
		"effective":      map[string]any{"rules": effective, "final": str(obj(eff, "route"), "final"), "final_source": finalSrc},
		"warnings":       warnings,
	}, nil
}

func (m *Master) nodeExists(w http.ResponseWriter, id string) bool {
	var n int
	if m.db.QueryRow(`SELECT COUNT(*) FROM nodes WHERE id=?`, id).Scan(&n); n == 0 {
		writeErr(w, 404, "Node not found")
		return false
	}
	return true
}

// GET /api/nodes/{id}/route
func (m *Master) apiNodeRoute(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !m.nodeExists(w, id) {
		return
	}
	v, err := m.nodeRouteView(id)
	if errf(w, err) {
		return
	}
	writeJSON(w, 200, v)
}

// validateNodeRoute merges strictly and runs the template checks plus a sing-box build.
func (m *Master) validateNodeRoute(nodeID string, nr nodeRoute) error {
	skeleton, err := nodeSkeleton(m.db, nodeID)
	if err != nil {
		return err
	}
	merged, _, _, err := mergeNodeRoute(skeleton, nr, true)
	if err != nil {
		return err
	}
	if _, err := validateSkeleton(merged); err != nil {
		return err
	}
	return singboxCheck(merged)
}

// PUT /api/nodes/{id}/route {rules, final, dry_run}
func (m *Master) apiSetNodeRoute(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !m.nodeExists(w, id) {
		return
	}
	var req struct {
		nodeRoute
		DryRun bool `json:"dry_run"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	nr := req.nodeRoute
	if nr.Rules == nil {
		nr.Rules = []map[string]any{}
	}
	nr.Final = strings.TrimSpace(nr.Final)
	if err := m.validateNodeRoute(id, nr); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if req.DryRun {
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	if len(nr.Rules) == 0 && nr.Final == "" {
		m.db.Exec(`DELETE FROM node_routes WHERE node_id=?`, id)
	} else {
		b, _ := json.Marshal(nr)
		if _, err := m.db.Exec(`INSERT INTO node_routes(node_id, json, updated_at) VALUES(?,?,?)
			ON CONFLICT(node_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`, id, string(b), now()); errf(w, err) {
			return
		}
	}
	m.audit(r, "node.route", id, fmt.Sprintf("%d rules, final %q", len(nr.Rules), nr.Final))
	m.reconcile(id)
	v, err := m.nodeRouteView(id)
	if errf(w, err) {
		return
	}
	writeJSON(w, 200, v)
}

// DELETE /api/nodes/{id}/route: back to the template's route.
func (m *Master) apiResetNodeRoute(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !m.nodeExists(w, id) {
		return
	}
	res, err := m.db.Exec(`DELETE FROM node_routes WHERE node_id=?`, id)
	if errf(w, err) {
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		m.audit(r, "node.route.reset", id, "")
		m.reconcile(id)
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

var nodeRouteBody = js{
	"rules": arr(tMap("A sing-box route rule (domain_suffix, ip_cidr, rule_set, inbound, network, port, …) with action route+outbound or reject")),
	"final": tStr("Outbound tag replacing the template's route.final; empty = the template's"),
}

var nodeRouteDocs = map[string]opDoc{
	"GET /api/nodes/{id}/route": {Tag: "nodes", Summary: "A node's route: template rules, the node's own rules and the effective result",
		Desc: "Node rules are placed after the template's leading sniff / hijack-dns / resolve rules (insert_at) and before its routing rules."},
	"PUT /api/nodes/{id}/route": {Tag: "nodes", Summary: "Set the node's own route rules (only this node)",
		Desc: "Validated against the template and with sing-box before saving; dry_run=true only validates. A route change restarts the node's proxy core, dropping its connections.",
		Body: tObj(js{"rules": nodeRouteBody["rules"], "final": nodeRouteBody["final"], "dry_run": tBool("Validate only")})},
	"DELETE /api/nodes/{id}/route": {Tag: "nodes", Summary: "Reset the node's route to its template"},
}

func init() {
	for k, v := range nodeRouteDocs {
		apiDocs[k] = v
	}
	for en, zh := range map[string]string{
		"A node's route: template rules, the node's own rules and the effective result":                                                                                         "节点路由：模板规则、节点自有规则与最终生效结果",
		"Node rules are placed after the template's leading sniff / hijack-dns / resolve rules (insert_at) and before its routing rules.":                                       "节点规则位于模板开头的 sniff / hijack-dns / resolve 规则之后（insert_at）、模板路由规则之前。",
		"Set the node's own route rules (only this node)":                                                                                                                       "设置节点自有路由规则（只影响该节点）",
		"Validated against the template and with sing-box before saving; dry_run=true only validates. A route change restarts the node's proxy core, dropping its connections.": "保存前按模板与 sing-box 校验；dry_run=true 只校验。路由变更会重启该节点的代理内核并断开其连接。",
		"Validate only":                          "仅校验",
		"Reset the node's route to its template": "节点路由恢复为模板",
		"A sing-box route rule (domain_suffix, ip_cidr, rule_set, inbound, network, port, …) with action route+outbound or reject": "sing-box 路由规则（domain_suffix、ip_cidr、rule_set、inbound、network、port…），动作为 route+outbound 或 reject",
		"Outbound tag replacing the template's route.final; empty = the template's":                                                "替换模板 route.final 的出站标签；留空沿用模板",
	} {
		if _, ok := zhAPIDocs[en]; !ok {
			zhAPIDocs[en] = zh
		}
	}
	for en, zh := range map[string]string{
		"Empty rule": "空规则",
		"A rule needs at least one match condition": "规则至少需要一个匹配条件",
		"A route rule needs an outbound":            "路由规则需要选择出站",
		"Rule %d: %s":                               "第 %d 条规则：%s",
		"Unsupported rule action: %s":               "不支持的规则动作：%s",
		"Unsupported rule field: %s":                "不支持的规则字段：%s",
		"Unknown rule set: %v":                      "未知规则集：%v",
		"sing-box: %v":                              "sing-box：%v",
	} {
		if _, ok := zhCatalog[en]; !ok {
			zhCatalog[en] = zh
		}
	}
}
