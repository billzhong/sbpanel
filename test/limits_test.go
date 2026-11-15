package test

import (
	"strings"
	"testing"
	"time"
)

// A traffic limit preset closes its inbounds to a user who used it up: the node refuses
// their connections there (including a long download that crosses the limit), their other
// inbounds keep working, the subscription keeps every node, and resetting the limit opens
// the line again without a new subscription.
func TestTrafficLimitEndToEnd(t *testing.T) {
	e := newEnv(t)
	uid := e.createUser(map[string]any{"username": "carol"})
	other := e.createUser(map[string]any{"username": "dave"})
	home := e.createInbound("home", "vless", map[string]any{"listen": "127.0.0.1", "listen_port": freePort(t)}, nil)
	e.createInbound("main", "vless", map[string]any{"listen": "127.0.0.1", "listen_port": freePort(t)}, nil)
	var lim struct{ ID int64 }
	e.api.do("POST", "/api/limits", map[string]any{"name": "Home", "traffic_limit": 1 << 20, "inbound_ids": []int64{home}}, &lim)
	e.api.do("PUT", "/api/users/"+itoa(uid)+"/limits/"+itoa(lim.ID), map[string]any{"attach": true}, nil)
	e.waitApplied()

	pick := func(id int64, tag string) string {
		for k, ob := range e.subOutbounds(id) {
			if strings.HasSuffix(k, "· "+tag) {
				return client(t, ob)
			}
		}
		t.Fatalf("no %s outbound for user %d", tag, id)
		return ""
	}
	homeP, mainP, otherHome := pick(uid, "home"), pick(uid, "main"), pick(other, "home")
	target := blob(t)

	// a slow download that runs past the limit is cut off once the master sees it
	if n, err := fetch(homeP, target, 8<<20, "&slow=40", 60*time.Second); err == nil {
		t.Fatalf("download past the limit finished (%d bytes)", n)
	}
	waitFor(t, "limit enforced", 20*time.Second, func() bool {
		_, err := fetch(homeP, target, 64<<10, "", 3*time.Second)
		return err != nil
	})
	if _, err := fetch(mainP, target, 256<<10, "", 10*time.Second); err != nil {
		t.Fatalf("other inbound must keep working: %v", err)
	}
	if _, err := fetch(otherHome, target, 2<<20, "", 10*time.Second); err != nil {
		t.Fatalf("a user without the preset must not be limited: %v", err)
	}
	// still in the subscription
	if _, ok := func() (string, bool) {
		for k := range e.subOutbounds(uid) {
			if strings.HasSuffix(k, "· home") {
				return k, true
			}
		}
		return "", false
	}(); !ok {
		t.Fatal("the closed line disappeared from the subscription")
	}

	// reset: the same client (no new subscription) works again
	e.api.do("PUT", "/api/users/"+itoa(uid)+"/limits/"+itoa(lim.ID), map[string]any{"reset_usage": true}, nil)
	waitFor(t, "line reopened", 20*time.Second, func() bool {
		_, err := fetch(homeP, target, 64<<10, "", 3*time.Second)
		return err == nil
	})
}
