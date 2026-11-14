package node

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sagernet/sing-box/adapter"
	tun "github.com/sagernet/sing-tun"
	"github.com/sagernet/sing/common/bufio"
	N "github.com/sagernet/sing/common/network"
)

// connRec is one routed connection. Byte counters are updated lock-free by the
// copy loop; the aggregator diffs them against last* every window.
type connRec struct {
	id                         uint64
	user, inbound, outbound    string
	network, host, srcIP, rule string
	port                       uint16
	start                      time.Time
	up, down                   atomic.Int64
	closer                     interface{ Close() error }

	// aggregator-owned
	lastUp, lastDown int64
	counted          bool
}

// Tracker implements adapter.ConnectionTracker. It is the single place where the
// node counts traffic, sees who is online and can drop connections.
type Tracker struct {
	mu     sync.Mutex
	active map[uint64]*connRec
	closed []*connRec
	nextID atomic.Uint64

	totalUp, totalDown atomic.Int64
}

func NewTracker() *Tracker {
	return &Tracker{active: map[uint64]*connRec{}}
}

var _ adapter.ConnectionTracker = (*Tracker)(nil)

func (t *Tracker) newRec(m adapter.InboundContext, rule adapter.Rule, out adapter.Outbound) *connRec {
	r := &connRec{
		id:      t.nextID.Add(1),
		user:    m.User,
		inbound: m.Inbound,
		network: m.Network,
		port:    m.Destination.Port,
		start:   time.Now(),
		rule:    "final",
	}
	if n := len(m.OutboundChain); n > 0 {
		r.outbound = m.OutboundChain[n-1].Tag()
	} else if out != nil {
		r.outbound = out.Tag()
	}
	if rule != nil {
		r.rule = rule.String()
	}
	switch {
	case m.Domain != "":
		r.host = m.Domain
	case m.Destination.IsFqdn():
		r.host = m.Destination.Fqdn
	case m.Destination.Addr.IsValid():
		r.host = m.Destination.Addr.Unmap().String()
	}
	if m.Source.Addr.IsValid() {
		r.srcIP = m.Source.Addr.Unmap().String()
	}
	return r
}

func (t *Tracker) join(r *connRec) {
	t.mu.Lock()
	t.active[r.id] = r
	t.mu.Unlock()
}

func (t *Tracker) leave(r *connRec) {
	t.mu.Lock()
	if _, ok := t.active[r.id]; ok {
		delete(t.active, r.id)
		t.closed = append(t.closed, r)
	}
	t.mu.Unlock()
}

func (t *Tracker) RoutedConnection(ctx context.Context, conn net.Conn, m adapter.InboundContext, rule adapter.Rule, out adapter.Outbound) net.Conn {
	r := t.newRec(m, rule, out)
	c := &trackedConn{
		ExtendedConn: bufio.NewInt64CounterConn(conn, []*atomic.Int64{&r.up, &t.totalUp}, []*atomic.Int64{&r.down, &t.totalDown}),
		t:            t, r: r,
	}
	r.closer = c
	t.join(r)
	return c
}

func (t *Tracker) RoutedPacketConnection(ctx context.Context, conn N.PacketConn, m adapter.InboundContext, rule adapter.Rule, out adapter.Outbound) N.PacketConn {
	r := t.newRec(m, rule, out)
	c := &trackedPacketConn{
		PacketConn: bufio.NewInt64CounterPacketConn(conn, []*atomic.Int64{&r.up, &t.totalUp}, nil, []*atomic.Int64{&r.down, &t.totalDown}, nil),
		t:          t, r: r,
	}
	r.closer = c
	t.join(r)
	return c
}

// RoutedFlow covers TUN fast-path flows, which a server node does not use.
func (t *Tracker) RoutedFlow(ctx context.Context, m adapter.InboundContext, rule adapter.Rule, out adapter.Outbound) tun.FlowTracker {
	return nil
}

// Kick closes every active connection matching fn.
func (t *Tracker) Kick(fn func(r *connRec) bool) int {
	t.mu.Lock()
	var hit []*connRec
	for _, r := range t.active {
		if fn(r) {
			hit = append(hit, r)
		}
	}
	t.mu.Unlock()
	for _, r := range hit {
		if r.closer != nil {
			r.closer.Close()
		}
	}
	return len(hit)
}

// Online returns user -> distinct source IPs of active connections.
func (t *Tracker) Online() map[string]map[string]struct{} {
	out := map[string]map[string]struct{}{}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, r := range t.active {
		if r.user == "" {
			continue
		}
		s := out[r.user]
		if s == nil {
			s = map[string]struct{}{}
			out[r.user] = s
		}
		s[r.srcIP] = struct{}{}
	}
	return out
}

func (t *Tracker) ActiveCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.active)
}

type trackedConn struct {
	N.ExtendedConn
	t    *Tracker
	r    *connRec
	once sync.Once
}

func (c *trackedConn) Close() error {
	c.once.Do(func() { c.t.leave(c.r) })
	return c.ExtendedConn.Close()
}

func (c *trackedConn) Upstream() any           { return c.ExtendedConn }
func (c *trackedConn) ReaderReplaceable() bool { return true }
func (c *trackedConn) WriterReplaceable() bool { return true }

type trackedPacketConn struct {
	N.PacketConn
	t    *Tracker
	r    *connRec
	once sync.Once
}

func (c *trackedPacketConn) Close() error {
	c.once.Do(func() { c.t.leave(c.r) })
	return c.PacketConn.Close()
}

func (c *trackedPacketConn) Upstream() any           { return c.PacketConn }
func (c *trackedPacketConn) ReaderReplaceable() bool { return true }
func (c *trackedPacketConn) WriterReplaceable() bool { return true }
