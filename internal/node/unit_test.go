package node

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/time/rate"

	"sbpanel/internal/pb"
)

func rec(t *Tracker, user, host, src string) *connRec {
	r := &connRec{id: t.nextID.Add(1), user: user, inbound: "in", outbound: "direct", host: host, srcIP: src, port: 443, network: "tcp", rule: "final", start: time.Now()}
	t.join(r)
	return r
}

func TestCollectDeltas(t *testing.T) {
	tr := NewTracker()
	a := rec(tr, "1", "a.com", "1.1.1.1")
	a.up.Add(10)
	a.down.Add(100)
	r1 := tr.Collect(0, 10, 100)
	if r1 == nil || len(r1.Users) != 1 || r1.Users[0].Down != 100 || r1.Users[0].Conns != 1 {
		t.Fatalf("first window %+v", r1)
	}
	if r := tr.Collect(10, 20, 100); r != nil {
		t.Fatalf("idle window should be nil, got %+v", r)
	}
	a.down.Add(5)
	tr.leave(a) // closed: drained once more, then forgotten
	r3 := tr.Collect(20, 30, 100)
	if r3.Users[0].Down != 5 || r3.Users[0].Conns != 0 {
		t.Fatalf("closed window %+v", r3.Users[0])
	}
	if r := tr.Collect(30, 40, 100); r != nil {
		t.Fatal("closed conn counted twice")
	}
}

func TestCapDims(t *testing.T) {
	tr := NewTracker()
	for i := 0; i < 50; i++ {
		r := rec(tr, "1", "h"+string(rune('a'+i%26))+string(rune('a'+i/26)), "1.1.1.1")
		r.down.Add(int64(1000 + i))
	}
	rep := tr.Collect(0, 10, 10)
	var total, other int64
	for _, d := range rep.Dims {
		total += d.Down
		if d.Host == "(other)" {
			other++
		}
	}
	if len(rep.Dims) != 11 || other != 1 {
		t.Fatalf("dims = %d other=%d", len(rep.Dims), other)
	}
	if total != rep.Users[0].Down {
		t.Fatalf("capped dims lost bytes: %d vs %d", total, rep.Users[0].Down)
	}
}

func TestSpoolDurableSeq(t *testing.T) {
	path := filepath.Join(t.TempDir(), "spool.db")
	s, err := OpenSpool(path, 5)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		s.Append(&pb.TrafficReport{Users: []*pb.UserStat{{User: "1", Down: 10}}})
	}
	r, _ := s.Oldest()
	if r.Seq != 1 {
		t.Fatalf("oldest seq %d", r.Seq)
	}
	s.Delete(1)
	s.Close()
	s, _ = OpenSpool(path, 5) // restart: seq continues, pending reports survive
	s.Append(&pb.TrafficReport{Users: []*pb.UserStat{{User: "1", Down: 10}}})
	r, _ = s.Oldest()
	if r.Seq != 2 || s.Len() != 3 {
		t.Fatalf("after reopen oldest=%d len=%d", r.Seq, s.Len())
	}
	// overflow: compaction merges but keeps every byte and the newest seq
	for i := 0; i < 6; i++ {
		s.Append(&pb.TrafficReport{WindowStart: int64(i), Users: []*pb.UserStat{{User: "1", Down: 10}}})
	}
	did, err := s.Compact(60)
	if err != nil || !did {
		t.Fatalf("compact %v %v", did, err)
	}
	var sum int64
	var last uint64
	for s.Len() > 0 {
		r, _ := s.Oldest()
		if r.Seq <= last {
			t.Fatalf("seq not increasing: %d after %d", r.Seq, last)
		}
		last = r.Seq
		for _, u := range r.Users {
			sum += u.Down
		}
		s.Delete(r.Seq)
	}
	if sum != 90 || last != 10 {
		t.Fatalf("sum=%d last=%d", sum, last)
	}
	s.Close()
}

func TestPolicyDeviceLimit(t *testing.T) {
	tr := NewTracker()
	tr.SetPolicies([]*pb.UserPolicy{{User: "1", DeviceLimit: 2}})
	rec(tr, "1", "a", "10.0.0.1")
	rec(tr, "1", "a", "10.0.0.2")
	p := tr.policy("1")
	if tr.overDeviceLimit("1", "10.0.0.1", p.deviceLimit) {
		t.Fatal("existing device rejected")
	}
	if !tr.overDeviceLimit("1", "10.0.0.3", p.deviceLimit) {
		t.Fatal("third device allowed")
	}
	if tr.overDeviceLimit("2", "10.0.0.3", 0) {
		t.Fatal("unlimited user rejected")
	}
	// limiter objects survive a policy refresh with the same rate
	tr.SetPolicies([]*pb.UserPolicy{{User: "1", SpeedDown: 1 << 20}})
	l1 := tr.policy("1").down
	tr.SetPolicies([]*pb.UserPolicy{{User: "1", SpeedDown: 1 << 20, DeviceLimit: 3}})
	if tr.policy("1").down != l1 {
		t.Fatal("limiter recreated on unrelated change")
	}
}

func TestLimitedConnThroughput(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	lim := rate.NewLimiter(rate.Limit(256<<10), 64<<10) // 256 KiB/s
	c := &limitedConn{Conn: a, ctx: context.Background(), write: lim}
	go io.Copy(io.Discard, b)
	start := time.Now()
	buf := make([]byte, 32<<10)
	for i := 0; i < 16; i++ { // 512 KiB
		if _, err := c.Write(buf); err != nil {
			t.Fatal(err)
		}
	}
	el := time.Since(start)
	// 512 KiB at 256 KiB/s with a 64 KiB burst: ~1.75 s
	if el < 1400*time.Millisecond || el > 3*time.Second {
		t.Fatalf("elapsed %s", el)
	}
}

// A traffic limit closes one inbound to a user: new connections there are refused and open
// ones closed, while the user's connections on other inbounds and other users are untouched.
func TestPolicyBlockedInbounds(t *testing.T) {
	tr := NewTracker()
	open := func(user, inbound string) *connRec {
		r := &connRec{id: tr.nextID.Add(1), user: user, inbound: inbound, start: time.Now()}
		c := &fakeCloser{}
		r.closer = c
		tr.join(r)
		return r
	}
	a := open("1", "home")
	b := open("1", "main")
	c := open("2", "home")
	tr.SetPolicies([]*pb.UserPolicy{{User: "1", BlockedInbounds: []string{"home"}}})
	if !a.closer.(*fakeCloser).closed || b.closer.(*fakeCloser).closed || c.closer.(*fakeCloser).closed {
		t.Fatalf("kick: home/1=%v main/1=%v home/2=%v", a.closer.(*fakeCloser).closed, b.closer.(*fakeCloser).closed, c.closer.(*fakeCloser).closed)
	}
	p := tr.policy("1")
	if !tr.refuse(&connRec{user: "1", inbound: "home"}, p) || tr.refuse(&connRec{user: "1", inbound: "main"}, p) {
		t.Fatal("refuse")
	}
	tr.SetPolicies(nil)
	if tr.refuse(&connRec{user: "1", inbound: "home"}, tr.policy("1")) {
		t.Fatal("still refused after the limit reset")
	}
}

type fakeCloser struct{ closed bool }

func (f *fakeCloser) Close() error { f.closed = true; return nil }

// The master can point the agent at certificate files; device files and huge files must
// not be read into memory.
func TestReadPEMFileBounds(t *testing.T) {
	if _, err := readPEMFile("/dev/zero"); err == nil {
		t.Fatal("/dev/zero read")
	}
	big := filepath.Join(t.TempDir(), "big.pem")
	if err := os.WriteFile(big, make([]byte, maxPEMFile+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readPEMFile(big); err == nil {
		t.Fatal("oversized file read")
	}
	ok := filepath.Join(t.TempDir(), "ok.pem")
	os.WriteFile(ok, []byte("x"), 0o600)
	if b, err := readPEMFile(ok); err != nil || string(b) != "x" {
		t.Fatalf("regular file: %q %v", b, err)
	}
}

// Device limits use per-user IP refcounts kept by join / leave.
func TestDeviceLimitRefcount(t *testing.T) {
	tr := NewTracker()
	r1 := &connRec{id: 1, user: "u", srcIP: "1.1.1.1"}
	r2 := &connRec{id: 2, user: "u", srcIP: "1.1.1.1"}
	tr.join(r1)
	tr.join(r2)
	if tr.overDeviceLimit("u", "1.1.1.1", 1) || !tr.overDeviceLimit("u", "2.2.2.2", 1) {
		t.Fatal("limit 1 with one IP")
	}
	tr.leave(r1)
	if !tr.overDeviceLimit("u", "2.2.2.2", 1) {
		t.Fatal("IP freed while a connection remains")
	}
	tr.leave(r2)
	if tr.overDeviceLimit("u", "2.2.2.2", 1) || len(tr.ips) != 0 {
		t.Fatalf("IP not freed: %v", tr.ips)
	}
}
