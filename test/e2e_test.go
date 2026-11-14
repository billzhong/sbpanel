package test

import (
	"strconv"
	"testing"
	"time"
)

// TestAccountingAndOutage: byte-exact accounting through VLESS REALITY, and no loss
// or double counting across a master outage.
func TestAccountingAndOutage(t *testing.T) {
	e := newEnv(t)
	uid := e.createUser(map[string]any{"username": "alice"})
	port := freePort(t)
	e.createInbound("vless-reality", "vless", e.realityOpts(port), nil)
	e.waitApplied()
	outs := e.subOutbounds(uid)
	ob, ok := outs["local · vless-reality"]
	if !ok {
		t.Fatalf("subscription has no outbound for the inbound: %v", keys(outs))
	}
	proxy := client(t, ob)
	target := blob(t)

	const size = 100 << 20
	if _, err := fetch(proxy, target, size, "", 120*time.Second); err != nil {
		t.Fatal(err)
	}
	e.settle(uid)
	d1 := e.user(uid).User.UsedDown
	t.Logf("100 MiB via REALITY: master down=%d (overhead %d B)", d1, d1-size)
	if d1 < size || d1 > size+size/100 {
		t.Fatalf("down %d outside [payload, payload+1%%]", d1)
	}

	e.m.stop()
	if _, err := fetch(proxy, target, 50<<20, "", 60*time.Second); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2500 * time.Millisecond)
	if e.agent.a.Backlog() == 0 {
		t.Fatal("expected spooled reports while master is down")
	}
	t.Logf("master down: node backlog=%d reports", e.agent.a.Backlog())
	e.m = startMaster(t, e.dir+"/master", e.webPort, e.grpcPort)
	e.login()
	e.settle(uid)
	d2 := e.user(uid).User.UsedDown
	if d2-d1 < 50<<20 || d2-d1 > 50<<20+(50<<20)/100 {
		t.Fatalf("outage delta %d", d2-d1)
	}

	var top []struct {
		Key  string `json:"key"`
		Down int64  `json:"down"`
	}
	e.api.do("GET", "/api/traffic/top?dim=host", nil, &top)
	if len(top) == 0 || top[0].Key != "127.0.0.1" || top[0].Down != d2 {
		t.Fatalf("host ranking: %+v", top)
	}
	var series struct {
		Series []struct {
			Down int64 `json:"down"`
		} `json:"series"`
	}
	e.api.do("GET", "/api/traffic/series?step=60&group=user&from="+strconv.FormatInt(time.Now().Add(-time.Hour).Unix(), 10), nil, &series)
	if len(series.Series) != 1 || series.Series[0].Down != d2 {
		t.Fatalf("series mismatch: %+v", series)
	}
}

func keys[V any](m map[string]V) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	return out
}
