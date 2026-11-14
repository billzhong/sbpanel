package test

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	"sbpanel/internal/pb"
	"sbpanel/internal/pki"
)

func TestFeatures(t *testing.T) {
	e := newEnv(t)
	alice := e.createUser(map[string]any{"username": "alice"})
	port := freePort(t)
	e.createInbound("main", "vless", e.realityOpts(port), nil)
	e.waitApplied()
	proxy := client(t, e.subOutbounds(alice)["local · main"])
	target := blob(t)
	if _, err := fetch(proxy, target, 1<<20, "", 20*time.Second); err != nil {
		t.Fatal(err)
	}

	t.Run("group isolation", func(t *testing.T) {
		var g struct{ ID int64 }
		e.api.do("POST", "/api/groups", map[string]any{"name": "empty"}, &g)
		bob := e.createUser(map[string]any{"username": "bob", "group_ids": []int64{g.ID}})
		e.waitApplied()
		if outs := e.subOutbounds(bob); outs["local · main"] != nil { // only groups and direct remain
			t.Fatalf("bob sees inbounds outside his groups: %v", keys(outs))
		}
		// bob's credentials on alice's inbound are rejected
		ob := strings.Replace(string(e.subOutbounds(alice)["local · main"]), e.user(alice).User.UUID, e.user(bob).User.UUID, 1)
		if _, err := fetch(client(t, []byte(ob)), target, 1024, "", 5*time.Second); err == nil {
			t.Fatal("user outside the inbound's groups got through")
		}
		// adding the inbound to bob's group grants access
		var ins []struct{ ID int64 }
		e.api.do("GET", "/api/inbounds", nil, &ins)
		e.api.do("PATCH", fmt.Sprintf("/api/groups/%d", g.ID), map[string]any{"inbound_ids": []int64{ins[0].ID}}, nil)
		e.waitApplied()
		if _, err := fetch(client(t, e.subOutbounds(bob)["local · main"]), target, 1024, "", 10*time.Second); err != nil {
			t.Fatalf("bob after joining: %v", err)
		}
	})

	t.Run("hot user update keeps connections", func(t *testing.T) {
		hot0, rebuild0 := e.agent.a.CoreStats()
		errc := make(chan error, 1)
		go func() { // ~2.5 s stream: 40 chunks x 64 KiB, 60 ms apart
			_, err := fetch(proxy, target, 40<<16, "&slow=60", 30*time.Second)
			errc <- err
		}()
		time.Sleep(400 * time.Millisecond)
		carol := e.createUser(map[string]any{"username": "carol"})
		e.waitApplied()
		if err := <-errc; err != nil {
			t.Fatalf("alice's stream broke during a user change: %v", err)
		}
		hot1, rebuild1 := e.agent.a.CoreStats()
		if hot1 <= hot0 || rebuild1 != rebuild0 {
			t.Fatalf("expected in-place update: hot %d->%d rebuild %d->%d", hot0, hot1, rebuild0, rebuild1)
		}
		if _, err := fetch(client(t, e.subOutbounds(carol)["local · main"]), target, 1024, "", 10*time.Second); err != nil {
			t.Fatalf("new user cannot connect: %v", err)
		}
	})

	t.Run("speed limit", func(t *testing.T) {
		e.api.do("PATCH", fmt.Sprintf("/api/users/%d", alice), map[string]any{"speed_down": 512 << 10}, nil)
		e.waitApplied()
		start := time.Now()
		if _, err := fetch(proxy, target, 1536<<10, "", 30*time.Second); err != nil {
			t.Fatal(err)
		}
		limited := time.Since(start)
		e.api.do("PATCH", fmt.Sprintf("/api/users/%d", alice), map[string]any{"speed_down": 0}, nil)
		e.waitApplied()
		start = time.Now()
		fetch(proxy, target, 1536<<10, "", 30*time.Second)
		free := time.Since(start)
		t.Logf("1.5 MiB at 512 KiB/s: %s, unlimited: %s", limited, free)
		if limited < 1800*time.Millisecond || free > limited/3 {
			t.Fatalf("limit not enforced: limited=%s free=%s", limited, free)
		}
	})

	t.Run("live connections and close", func(t *testing.T) {
		errc := make(chan error, 1)
		go func() { _, err := fetch(proxy, target, 200<<16, "&slow=50", 30*time.Second); errc <- err }()
		var conns struct {
			Ready bool `json:"ready"`
			Conns []struct {
				ID       uint64 `json:"id"`
				Username string `json:"username"`
				Host     string `json:"host"`
			} `json:"conns"`
		}
		waitFor(t, "live snapshot with alice", 10*time.Second, func() bool {
			e.api.do("GET", "/api/nodes/"+e.nodeID+"/conns", nil, &conns)
			for _, c := range conns.Conns {
				if c.Username == "alice" && c.Host == "127.0.0.1" {
					return true
				}
			}
			return false
		})
		var ids []uint64
		for _, c := range conns.Conns {
			ids = append(ids, c.ID)
		}
		e.api.do("POST", "/api/nodes/"+e.nodeID+"/conns/close", map[string]any{"ids": ids}, nil)
		select {
		case err := <-errc:
			if err == nil {
				t.Fatal("closed connection still completed")
			}
		case <-time.After(8 * time.Second):
			t.Fatal("closing the connection did not stop the transfer")
		}
	})

	t.Run("expiry cuts access", func(t *testing.T) {
		dave := e.createUser(map[string]any{"username": "dave"})
		e.waitApplied()
		dp := client(t, e.subOutbounds(dave)["local · main"])
		if _, err := fetch(dp, target, 1024, "", 10*time.Second); err != nil {
			t.Fatal(err)
		}
		e.api.do("PATCH", fmt.Sprintf("/api/users/%d", dave), map[string]any{"expire_at": time.Now().Add(-time.Minute).Unix()}, nil)
		if st := e.user(dave).User.Status; st != "expired" {
			t.Fatalf("status %s", st)
		}
		e.waitApplied()
		if _, err := fetch(dp, target, 1024, "", 5*time.Second); err == nil {
			t.Fatal("expired user still has access")
		}
		var evs []struct{ Kind string }
		e.api.do("GET", "/api/events", nil, &evs)
		if !hasKind(evs, "user_expired") {
			t.Fatal("no user_expired event")
		}
		// extending the expiry restores access
		e.api.do("PATCH", fmt.Sprintf("/api/users/%d", dave), map[string]any{"expire_at": 0}, nil)
		e.waitApplied()
		if _, err := fetch(dp, target, 1024, "", 10*time.Second); err != nil {
			t.Fatalf("after extension: %v", err)
		}
	})

	t.Run("reset usage", func(t *testing.T) {
		e.settle(alice, mustID(t, e, "bob"), mustID(t, e, "carol"), mustID(t, e, "dave"))
		before := e.user(alice).User
		e.api.do("PATCH", fmt.Sprintf("/api/users/%d", alice), map[string]any{"reset_usage": true}, nil)
		after := e.user(alice).User
		if after.UsedDown != 0 || after.LifeDown != before.LifeDown {
			t.Fatalf("reset: used %d life %d->%d", after.UsedDown, before.LifeDown, after.LifeDown)
		}
	})

	t.Run("template publish and rollback", func(t *testing.T) {
		blocked := blob(t)
		bport := blocked[strings.LastIndex(blocked, ":")+1:]
		var tpls []struct {
			ID   int64  `json:"id"`
			JSON string `json:"json"`
		}
		e.api.do("GET", "/api/templates", nil, &tpls)
		tpl := tpls[0]
		draft := strings.Replace(tpl.JSON, `{
        "action": "sniff"
      }`, `{
        "action": "sniff"
      },
      {
        "port": [`+bport+`],
        "action": "reject"
      }`, 1)
		if draft == tpl.JSON {
			t.Fatalf("could not patch template:\n%s", tpl.JSON)
		}
		e.api.do("PATCH", fmt.Sprintf("/api/templates/%d", tpl.ID), map[string]any{"draft": draft}, nil)
		// a saved draft changes nothing on the node yet
		if _, err := fetch(proxy, blocked, 1024, "", 5*time.Second); err != nil {
			t.Fatalf("draft affected the node: %v", err)
		}
		e.api.do("POST", fmt.Sprintf("/api/templates/%d/apply", tpl.ID), nil, nil)
		e.waitApplied()
		time.Sleep(300 * time.Millisecond)
		if _, err := fetch(proxy, blocked, 1024, "", 5*time.Second); err == nil {
			t.Fatal("reject rule not applied")
		}
		if _, err := fetch(proxy, target, 1024, "", 5*time.Second); err != nil {
			t.Fatalf("other traffic broken after publish: %v", err)
		}
		// the panel rejects structurally invalid drafts
		e.api.expect(400, "PATCH", fmt.Sprintf("/api/templates/%d", tpl.ID), map[string]any{"draft": `{"inbounds":[]}`})
		// a draft sing-box itself rejects: node keeps the old config and reports the error
		bad := strings.Replace(draft, `"type": "direct"`, `"type": "nonexistent-outbound"`, 1)
		e.api.do("PATCH", fmt.Sprintf("/api/templates/%d", tpl.ID), map[string]any{"draft": bad}, nil)
		e.api.do("POST", fmt.Sprintf("/api/templates/%d/apply", tpl.ID), nil, nil)
		waitFor(t, "apply error reported", 15*time.Second, func() bool { return e.node(e.nodeID).ApplyError != "" })
		if _, err := fetch(proxy, target, 1024, "", 10*time.Second); err != nil {
			t.Fatalf("node stopped serving after a bad publish: %v", err)
		}
		// fixing the template recovers
		e.api.do("PATCH", fmt.Sprintf("/api/templates/%d", tpl.ID), map[string]any{"draft": tpl.JSON}, nil)
		e.api.do("POST", fmt.Sprintf("/api/templates/%d/apply", tpl.ID), nil, nil)
		e.waitApplied()
		if n := e.node(e.nodeID); n.ApplyError != "" {
			t.Fatalf("error not cleared: %s", n.ApplyError)
		}
	})

	t.Run("node revocation", func(t *testing.T) {
		var en enrollInfo
		e.api.do("POST", "/api/nodes", map[string]string{"name": "second"}, &en)
		a2 := e.startAgent(en, "node2")
		defer a2.stop()
		e.waitOnline(en.NodeID)
		e.api.do("DELETE", "/api/nodes/"+en.NodeID, nil, nil)
		// the node's certificate is no longer accepted
		cc := dialAsNode(t, a2.dir, en.Master)
		defer cc.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := pb.NewNodeHubClient(cc).FetchSpec(ctx, &pb.FetchSpecRequest{}); err == nil || !strings.Contains(err.Error(), "unknown node") {
			t.Fatalf("revoked node still accepted: %v", err)
		}
		// a stranger without a client certificate cannot call the hub either
		anon := dialAnon(t, a2.dir, en.Master)
		defer anon.Close()
		if _, err := pb.NewNodeHubClient(anon).FetchSpec(ctx, &pb.FetchSpecRequest{}); err == nil {
			t.Fatal("anonymous hub call accepted")
		}
	})

	t.Run("concurrent users accounting", func(t *testing.T) {
		var ids []int64
		for i := 0; i < 5; i++ {
			ids = append(ids, e.createUser(map[string]any{"username": fmt.Sprintf("c%d", i)}))
		}
		e.waitApplied()
		var wg sync.WaitGroup
		for _, id := range ids {
			p := client(t, e.subOutbounds(id)["local · main"])
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 4; j++ {
					if _, err := fetch(p, target, 2<<20, "", 30*time.Second); err != nil {
						t.Error(err)
					}
				}
			}()
		}
		wg.Wait()
		all := append([]int64{alice, mustID(t, e, "bob"), mustID(t, e, "carol"), mustID(t, e, "dave")}, ids...)
		e.settle(all...)
		for _, id := range ids {
			if d := e.user(id).User.LifeDown; d < 8<<20 || d > 8<<20+4096 {
				t.Errorf("user %d down %d, want ~%d", id, d, 8<<20)
			}
		}
	})
}

func hasKind(evs []struct{ Kind string }, k string) bool {
	for _, e := range evs {
		if e.Kind == k {
			return true
		}
	}
	return false
}

func mustID(t *testing.T, e *env, name string) int64 {
	var us []struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	}
	e.api.do("GET", "/api/users", nil, &us)
	for _, u := range us {
		if u.Username == name {
			return u.ID
		}
	}
	t.Fatalf("user %s not found", name)
	return 0
}

func nodeTLS(t *testing.T, dir string, withCert bool) *tls.Config {
	caPEM, _ := os.ReadFile(filepath.Join(dir, "ca.crt"))
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caPEM)
	tc := &tls.Config{RootCAs: pool, ServerName: pki.ServerName, MinVersion: tls.VersionTLS13}
	if withCert {
		c, err := tls.LoadX509KeyPair(filepath.Join(dir, "node.crt"), filepath.Join(dir, "node.key"))
		if err != nil {
			t.Fatal(err)
		}
		tc.Certificates = []tls.Certificate{c}
	}
	return tc
}

func dialAsNode(t *testing.T, dir, addr string) *grpc.ClientConn {
	cc, err := grpc.NewClient(addr, grpc.WithTransportCredentials(credentials.NewTLS(nodeTLS(t, dir, true))))
	if err != nil {
		t.Fatal(err)
	}
	return cc
}

func dialAnon(t *testing.T, dir, addr string) *grpc.ClientConn {
	cc, err := grpc.NewClient(addr, grpc.WithTransportCredentials(credentials.NewTLS(nodeTLS(t, dir, false))))
	if err != nil {
		t.Fatal(err)
	}
	return cc
}
