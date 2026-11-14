package test

import (
	"fmt"
	"io"
	"net"
	"regexp"
	"testing"
	"time"
)

// ppFront mimics nginx stream with `proxy_protocol on`: it prepends a PROXY v1
// header claiming the client is fakeIP, then pipes bytes both ways.
func ppFront(t *testing.T, backend int, fakeIP string) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				b, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", backend))
				if err != nil {
					return
				}
				defer b.Close()
				fmt.Fprintf(b, "PROXY TCP4 %s 127.0.0.1 40000 %d\r\n", fakeIP, backend)
				go io.Copy(b, c)
				io.Copy(c, b)
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestProxyProtocolInbound(t *testing.T) {
	e := newEnv(t)
	uid := e.createUser(map[string]any{"username": "pp"})
	port := freePort(t)
	opts := e.realityOpts(port)
	opts["_proxy_protocol"] = true
	e.createInbound("reality-pp", "vless", opts, nil)
	e.waitApplied()

	front := ppFront(t, port, "203.0.113.7")
	ob := []byte(fmt.Sprintf("%s", e.subOutbounds(uid)["local · reality-pp"]))
	// clients reach the inbound through the "nginx" front, as on a shared :443
	ob = []byte(replacePort(string(ob), port, front))
	target := blob(t)
	if _, err := fetch(client(t, ob), target, 1<<20, "", 20*time.Second); err != nil {
		t.Fatalf("through PROXY-protocol front: %v", err)
	}
	e.settle(uid)
	var top []struct{ Key string }
	e.api.do("GET", "/api/traffic/top?dim=src_ip", nil, &top)
	if len(top) == 0 || top[0].Key != "203.0.113.7" {
		t.Fatalf("source IP from PROXY header not used: %+v", top)
	}
	// without the header (bypassing the front) the connection is refused
	if _, err := fetch(client(t, e.subOutbounds(uid)["local · reality-pp"]), target, 1024, "", 5*time.Second); err == nil {
		t.Fatal("connection without PROXY header was accepted")
	}
	// a non-loopback listen address is rejected by the node
	bad := e.realityOpts(freePort(t))
	bad["_proxy_protocol"] = true
	bad["listen"] = "0.0.0.0"
	e.createInbound("pp-public", "vless", bad, nil)
	waitFor(t, "apply error for public PP listener", 15*time.Second, func() bool {
		n := e.node(e.nodeID)
		return n.ApplyError != "" && containsStr(n.ApplyError, "loopback")
	})
}

func replacePort(s string, from, to int) string {
	re := regexp.MustCompile(fmt.Sprintf(`"server_port":\s*%d\b`, from))
	out := re.ReplaceAllString(s, fmt.Sprintf(`"server_port": %d`, to))
	if out == s {
		panic("port not found in outbound: " + s)
	}
	return out
}
