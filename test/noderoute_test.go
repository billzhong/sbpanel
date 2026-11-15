package test

import (
	"net"
	"strings"
	"testing"
	"time"
)

// A node's own route rule changes how that node routes real traffic: a reject rule for
// one destination port stops it while another port keeps working, a config sing-box
// would refuse never reaches the node, and resetting to the template opens it again.
func TestNodeRouteEndToEnd(t *testing.T) {
	e := newEnv(t)
	uid := e.createUser(map[string]any{"username": "erin"})
	e.createInbound("plain", "vless", map[string]any{"listen": "127.0.0.1", "listen_port": freePort(t)}, nil)
	e.waitApplied()
	var proxy string
	for k, ob := range e.subOutbounds(uid) {
		if strings.HasSuffix(k, "· plain") {
			proxy = client(t, ob)
		}
	}
	if proxy == "" {
		t.Fatal("no outbound in the subscription")
	}
	blocked, open := blob(t), blob(t)
	_, bport, _ := net.SplitHostPort(blocked)
	if _, err := fetch(proxy, blocked, 64<<10, "", 10*time.Second); err != nil {
		t.Fatalf("before the rule: %v", err)
	}
	path := "/api/nodes/" + e.nodeID + "/route"

	// invalid: never saved, the node keeps its revision
	before := e.node(e.nodeID).Revision
	if msg := e.api.expect(400, "PUT", path, map[string]any{"rules": []any{map[string]any{"ip_cidr": []string{"bad"}, "action": "reject"}}}); !strings.Contains(msg, "sing-box") {
		t.Fatalf("bad rule: %s", msg)
	}
	if e.node(e.nodeID).Revision != before {
		t.Fatal("a rejected route reached the node")
	}

	e.api.expect(200, "PUT", path, map[string]any{"rules": []any{
		map[string]any{"inbound": []string{"plain"}, "ip_cidr": []string{"127.0.0.1/32"}, "port": []any{atoi(t, bport)}, "action": "reject"},
	}})
	e.waitApplied()
	waitFor(t, "node rule rejects the port", 15*time.Second, func() bool {
		_, err := fetch(proxy, blocked, 64<<10, "", 3*time.Second)
		return err != nil
	})
	if _, err := fetch(proxy, open, 64<<10, "", 10*time.Second); err != nil {
		t.Fatalf("other destinations must keep working: %v", err)
	}

	e.api.expect(200, "DELETE", path, nil)
	e.waitApplied()
	waitFor(t, "reset reopens the port", 15*time.Second, func() bool {
		_, err := fetch(proxy, blocked, 64<<10, "", 3*time.Second)
		return err == nil
	})
}

func atoi(t *testing.T, s string) int {
	var n int
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}
