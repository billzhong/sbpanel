package master

import (
	"encoding/json"
	"strings"
	"testing"
)

const routeTpl = `{"log":{"level":"warn"},"dns":{"servers":[{"type":"local","tag":"local"}]},
"route":{"rules":[{"action":"sniff"},{"protocol":"dns","action":"hijack-dns"},{"domain_suffix":["ads.example"],"action":"reject"}],
"rule_set":[{"type":"inline","tag":"cn","rules":[{"domain_suffix":["cn"]}]}],"final":"direct","default_domain_resolver":"local"},
"outbounds":[{"type":"direct","tag":"direct"},{"type":"direct","tag":"alt"},{"type":"block","tag":"block"}]}`

func TestMergeNodeRoute(t *testing.T) {
	nr := nodeRoute{Rules: []map[string]any{
		{"domain_suffix": []any{"example.org"}, "action": "route", "outbound": "alt"},
		{"rule_set": []any{"cn"}, "action": "reject"},
	}, Final: "alt"}
	merged, at, warn, err := mergeNodeRoute(routeTpl, nr, true)
	if err != nil || at != 2 || len(warn) != 0 {
		t.Fatalf("merge: %v at=%d warn=%v", err, at, warn)
	}
	var sk map[string]any
	json.Unmarshal([]byte(merged), &sk)
	rules := obj(sk, "route")["rules"].([]any)
	if len(rules) != 5 || str(rules[2].(map[string]any), "outbound") != "alt" || str(rules[4].(map[string]any), "action") != "reject" ||
		str(obj(sk, "route"), "final") != "alt" {
		t.Fatalf("order/final: %s", merged)
	}
	if _, err := validateSkeleton(merged); err != nil {
		t.Fatal(err)
	}
	if err := singboxCheck(merged); err != nil {
		t.Fatal(err)
	}
	// strict rejects, lenient drops with a warning
	bad := nodeRoute{Rules: []map[string]any{{"domain": []any{"x.com"}, "outbound": "gone"}, {"port": []any{443}, "action": "reject"}}}
	if _, _, _, err := mergeNodeRoute(routeTpl, bad, true); err == nil || !strings.Contains(err.Error(), "missing outbound: gone") {
		t.Fatalf("strict: %v", err)
	}
	merged, _, warn, err = mergeNodeRoute(routeTpl, bad, false)
	if err != nil || len(warn) != 1 || strings.Count(merged, `"port"`) != 1 {
		t.Fatalf("lenient: %v %v", err, warn)
	}
	for _, r := range []map[string]any{
		{"action": "reject"},                            // no matcher
		{"domain": []any{"a"}, "action": "hijack-dns"},  // unsupported action
		{"rule_set": []any{"nope"}, "action": "reject"}, // unknown rule set
		{"domain": []any{"a"}, "action": "route"},       // no outbound
	} {
		if _, _, _, err := mergeNodeRoute(routeTpl, nodeRoute{Rules: []map[string]any{r}}, true); err == nil {
			t.Errorf("accepted %v", r)
		}
	}
	// sing-box itself catches what the shape check can't
	m2, _, _, _ := mergeNodeRoute(routeTpl, nodeRoute{Rules: []map[string]any{{"ip_cidr": []any{"not-a-cidr"}, "action": "reject"}}}, true)
	if err := singboxCheck(m2); err == nil {
		t.Error("sing-box accepted a bad CIDR")
	}
	// sing-box ignores unknown fields on reject rules; the field list catches them
	if _, _, _, err := mergeNodeRoute(routeTpl, nodeRoute{Rules: []map[string]any{{"network": []any{"tcp"}, "bogus_field": 1, "action": "reject"}}}, true); err == nil {
		t.Error("accepted an unknown field")
	}
	// nothing to merge: the template untouched
	if s, _, _, _ := mergeNodeRoute(routeTpl, nodeRoute{}, true); s != routeTpl {
		t.Error("empty override changed the skeleton")
	}
}

func TestNodeRouteAPI(t *testing.T) {
	m := newTestMaster(t)
	h := m.routes()
	m.db.Exec(`INSERT INTO nodes(id, name, created_at) VALUES('n1','hk',0)`)
	m.reconcile("n1")
	var rev0 uint64
	m.db.QueryRow(`SELECT revision FROM nodes WHERE id='n1'`).Scan(&rev0)
	put := func(body any) (int, string) {
		w := call(h, "PUT", "/api/nodes/n1/route", body, sessionOpt(m))
		return w.Code, w.Body.String()
	}
	rule := map[string]any{"domain_suffix": []string{"blocked.example"}, "action": "reject"}
	if c, b := put(map[string]any{"rules": []any{rule}, "dry_run": true}); c != 200 {
		t.Fatalf("dry run: %d %s", c, b)
	}
	var rev uint64
	if m.db.QueryRow(`SELECT revision FROM nodes WHERE id='n1'`).Scan(&rev); rev != rev0 {
		t.Fatal("dry run changed the spec")
	}
	if c, b := put(map[string]any{"rules": []any{map[string]any{"domain": []string{"x"}, "outbound": "nope"}}}); c != 400 || !strings.Contains(b, "missing outbound") {
		t.Fatalf("bad outbound: %d %s", c, b)
	}
	if c, b := put(map[string]any{"rules": []any{map[string]any{"ip_cidr": []string{"zzz"}, "action": "reject"}}}); c != 400 || !strings.Contains(b, "sing-box") {
		t.Fatalf("bad cidr: %d %s", c, b)
	}
	if m.db.QueryRow(`SELECT revision FROM nodes WHERE id='n1'`).Scan(&rev); rev != rev0 {
		t.Fatal("a rejected route changed the spec")
	}
	if c, b := put(map[string]any{"rules": []any{rule}}); c != 200 {
		t.Fatalf("save: %d %s", c, b)
	}
	spec, _ := m.loadSpec("n1")
	if spec.Revision <= rev0 || !strings.Contains(string(spec.SkeletonJson), "blocked.example") {
		t.Fatalf("spec not updated: r%d %s", spec.Revision, spec.SkeletonJson)
	}
	var v struct {
		Effective struct {
			Rules []routeRuleOut `json:"rules"`
		} `json:"effective"`
		InsertAt int `json:"insert_at"`
	}
	w := call(h, "GET", "/api/nodes/n1/route", nil, sessionOpt(m))
	json.Unmarshal(w.Body.Bytes(), &v)
	if len(v.Effective.Rules) != 2 || v.Effective.Rules[0].Source != "template" || v.Effective.Rules[1].Source != "node" || v.InsertAt != 1 {
		t.Fatalf("view: %s", w.Body)
	}
	// the template is untouched; reset brings the template route back
	var tpl string
	m.db.QueryRow(`SELECT json FROM templates ORDER BY id LIMIT 1`).Scan(&tpl)
	if strings.Contains(tpl, "blocked.example") {
		t.Fatal("node rule leaked into the template")
	}
	if w := call(h, "DELETE", "/api/nodes/n1/route", nil, sessionOpt(m)); w.Code != 200 {
		t.Fatal(w.Body)
	}
	spec, _ = m.loadSpec("n1")
	if strings.Contains(string(spec.SkeletonJson), "blocked.example") {
		t.Fatal("reset kept the node rule")
	}
}
