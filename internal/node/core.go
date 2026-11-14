package node

import (
	"context"
	stdjson "encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/pires/go-proxyproto"
	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/adapter/inbound"
	C "github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/include"
	sblog "github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common/json"
	M "github.com/sagernet/sing/common/metadata"
	"github.com/sagernet/sing/service"

	hottrojan "sbpanel/internal/node/hot/trojan"
	hotvless "sbpanel/internal/node/hot/vless"
	hotvmess "sbpanel/internal/node/hot/vmess"
	"sbpanel/internal/pb"
)

// SingboxVersion is the embedded core version.
func SingboxVersion() string { return C.Version }

type slot struct {
	spec  *pb.InboundSpec
	scope *adapter.Scope
	in    adapter.Inbound
	users map[string]bool
	pp    net.Listener // our PROXY-protocol listener, when enabled
}

func (s *slot) close() error {
	if s.pp != nil {
		s.pp.Close()
	}
	return s.scope.Close()
}

// hotUsers is implemented by the patched vless/vmess/trojan inbounds.
type hotUsers interface {
	UpdateUsersJSON(ctx context.Context, data []byte) error
}

// updateUsers swaps users in place when the inbound supports it.
func (c *Core) updateUsers(s *slot, in *pb.InboundSpec) bool {
	switch x := s.in.(type) {
	case hotUsers:
		if err := x.UpdateUsersJSON(c.ctx, in.UsersJson); err != nil {
			c.log.Printf("inbound %s: hot update failed, rebuilding: %v", in.Tag, err)
			return false
		}
		return true
	case adapter.ManagedSSMServer:
		var us []struct{ Name, Password string }
		if stdjson.Unmarshal(in.UsersJson, &us) != nil {
			return false
		}
		names, keys := make([]string, len(us)), make([]string, len(us))
		for i, u := range us {
			names[i], keys[i] = u.Name, u.Password
		}
		if err := x.UpdateUsers(names, keys); err != nil {
			c.log.Printf("inbound %s: hot update failed, rebuilding: %v", in.Tag, err)
			return false
		}
		return true
	}
	return false
}

// Core owns the embedded sing-box instance. The "skeleton" (route, dns, outbounds)
// lives in one box; every inbound runs in its own scope so it can be replaced
// without touching the others.
type Core struct {
	mu           sync.Mutex
	tracker      *Tracker
	log          *log.Logger
	ctx          context.Context
	box          *box.Box
	skeletonHash string
	slots        map[string]*slot
	hotUpdates   int // users swapped without rebuilding (for tests/metrics)
	rebuilds     int // inbounds recreated
	certDir      string
	certHashes   map[string]string
	certWrites   int // panel certificate files written (for tests/metrics)
}

func NewCore(t *Tracker, l *log.Logger) *Core {
	return &Core{tracker: t, log: l, slots: map[string]*slot{}, certHashes: map[string]string{}}
}

// SetCertDir sets where panel certificates are written (an absolute path, since
// sing-box's file watcher needs one).
func (c *Core) SetCertDir(dir string) {
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	c.mu.Lock()
	c.certDir = dir
	c.mu.Unlock()
}

func (c *Core) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeAllLocked()
}

func (c *Core) closeAllLocked() {
	for tag, s := range c.slots {
		s.close()
		delete(c.slots, tag)
	}
	if c.box != nil {
		c.box.Close()
		c.box = nil
	}
	c.skeletonHash = ""
}

func (c *Core) buildBox(skeleton []byte) (*box.Box, context.Context, error) {
	ctx := include.Context(context.Background())
	var opts option.Options
	if err := json.UnmarshalContext(ctx, skeleton, &opts); err != nil {
		return nil, nil, fmt.Errorf("skeleton: %w", err)
	}
	opts.Inbounds = nil
	if reg, ok := service.FromContext[adapter.InboundRegistry](ctx).(*inbound.Registry); ok {
		// name-keyed inbounds that can swap users without restarting
		hotvless.RegisterInbound(reg)
		hotvmess.RegisterInbound(reg)
		hottrojan.RegisterInbound(reg)
	}
	b, err := box.New(box.Options{Context: ctx, Options: opts})
	if err != nil {
		return nil, nil, err
	}
	b.Router().AppendTracker(c.tracker)
	return b, ctx, nil
}

func userSet(names []string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}

// Apply converges the running core to spec. Inbound errors do not stop the other
// inbounds from being applied; they are returned joined.
func (c *Core) Apply(spec *pb.NodeSpec) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.box == nil || spec.SkeletonHash != c.skeletonHash {
		nb, ctx, err := c.buildBox(spec.SkeletonJson)
		if err != nil {
			return err // keep the old instance running
		}
		c.closeAllLocked() // frees listening ports for the new instance
		if err := nb.Start(); err != nil {
			nb.Close()
			return fmt.Errorf("start core: %w", err)
		}
		c.box, c.ctx, c.skeletonHash = nb, ctx, spec.SkeletonHash
		c.log.Printf("core started (skeleton %s)", spec.SkeletonHash)
	}

	c.tracker.SetPolicies(spec.Policies)
	var errs []error
	if err := c.syncCerts(spec.Certs); err != nil {
		errs = append(errs, err)
	}
	want := map[string]*pb.InboundSpec{}
	for _, in := range spec.Inbounds {
		want[in.Tag] = in
	}
	for tag, s := range c.slots {
		w, ok := want[tag]
		if ok && w.OptionsHash == s.spec.OptionsHash && w.UsersHash == s.spec.UsersHash {
			continue
		}
		if ok && w.OptionsHash == s.spec.OptionsHash && c.updateUsers(s, w) {
			keep := userSet(w.UserNames)
			n := c.tracker.Kick(func(r *connRec) bool { return r.inbound == tag && !keep[r.user] })
			c.log.Printf("inbound %s: users updated in place (%d), closed %d conns of removed users", tag, len(w.UserNames), n)
			s.spec, s.users = w, keep
			c.hotUpdates++
			continue
		}
		if err := s.close(); err != nil {
			c.log.Printf("close inbound %s: %v", tag, err)
		}
		delete(c.slots, tag)
		if !ok {
			// inbound removed: its existing connections go too
			n := c.tracker.Kick(func(r *connRec) bool { return r.inbound == tag })
			c.log.Printf("inbound %s removed, closed %d conns", tag, n)
			continue
		}
		if w.OptionsHash == s.spec.OptionsHash {
			// only users changed: drop connections of users that are gone
			keep := userSet(w.UserNames)
			n := c.tracker.Kick(func(r *connRec) bool { return r.inbound == tag && !keep[r.user] })
			if n > 0 {
				c.log.Printf("inbound %s: closed %d conns of removed users", tag, n)
			}
		}
	}
	for tag, in := range want {
		if _, ok := c.slots[tag]; ok {
			continue
		}
		var s *slot
		var err error
		// The old listener was closed a moment ago; the port can be briefly taken
		// (e.g. reused as an ephemeral source port), so retry a few times.
		for attempt := 0; attempt < 10; attempt++ {
			if s, err = c.startInbound(in); err == nil || !errors.Is(err, syscall.EADDRINUSE) {
				if err == nil {
					c.rebuilds++
				}
				break
			}
			time.Sleep(300 * time.Millisecond)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("inbound %s: %w", tag, err))
			continue
		}
		c.slots[tag] = s
	}
	return errors.Join(errs...)
}

func (c *Core) startInbound(in *pb.InboundSpec) (*slot, error) {
	var o map[string]stdjson.RawMessage
	if err := stdjson.Unmarshal(in.OptionsJson, &o); err != nil {
		return nil, err
	}
	if o == nil {
		o = map[string]stdjson.RawMessage{}
	}
	if in.CertId != "" {
		tl, err := c.withCertPaths(o["tls"], in.CertId)
		if err != nil {
			return nil, err
		}
		o["tls"] = tl
	}
	t, _ := stdjson.Marshal(in.Type)
	g, _ := stdjson.Marshal(in.Tag)
	o["type"], o["tag"], o["users"] = t, g, in.UsersJson
	var ppAddr string
	if in.ProxyProtocol {
		// sing-box dropped PROXY protocol; we listen ourselves and inject connections
		// with the real client address. sing-box's own listener moves to a random
		// loopback port that nothing uses.
		var host string
		var port int
		stdjson.Unmarshal(o["listen"], &host)
		stdjson.Unmarshal(o["listen_port"], &port)
		if host == "" {
			host = "127.0.0.1"
		}
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			return nil, fmt.Errorf("proxy_protocol needs a loopback listen address (got %q): only the local reverse proxy may send PROXY headers", host)
		}
		ppAddr = net.JoinHostPort(host, fmt.Sprint(port))
		o["listen"], _ = stdjson.Marshal("127.0.0.1")
		o["listen_port"], _ = stdjson.Marshal(0)
	}
	full, _ := stdjson.Marshal(o)
	var ib option.Inbound
	if err := json.UnmarshalContext(c.ctx, full, &ib); err != nil {
		return nil, err
	}
	reg := service.FromContext[adapter.InboundRegistry](c.ctx)
	if reg == nil {
		return nil, errors.New("inbound registry missing")
	}
	name := "inbound/" + in.Type + "[" + in.Tag + "]"
	lg := c.box.LogFactory().NewLogger(name)
	inb, err := reg.Create(c.ctx, c.box.Router(), lg, in.Tag, in.Type, ib.Options)
	if err != nil {
		return nil, err
	}
	lc, ok := inb.(adapter.Lifecycle)
	if !ok {
		return nil, fmt.Errorf("inbound type %s has no lifecycle", in.Type)
	}
	sc := adapter.NewScope(c.ctx, lg)
	for _, st := range adapter.ListStartStages {
		if err := sc.Start(name, lc, st); err != nil {
			sc.Close()
			return nil, err
		}
	}
	s := &slot{spec: in, scope: sc, in: inb, users: userSet(in.UserNames)}
	if ppAddr != "" {
		h, ok := inb.(adapter.ConnectionHandler)
		if !ok {
			sc.Close()
			return nil, fmt.Errorf("inbound type %s cannot accept injected connections", in.Type)
		}
		ln, err := net.Listen("tcp", ppAddr)
		if err != nil {
			sc.Close()
			return nil, err
		}
		s.pp = &proxyproto.Listener{Listener: ln, ReadHeaderTimeout: 10 * time.Second,
			Policy: func(net.Addr) (proxyproto.Policy, error) { return proxyproto.REQUIRE, nil }}
		go c.servePP(sc.Context(), s.pp, h, lg)
	}
	return s, nil
}

// servePP accepts PROXY-protocol connections and hands them to the inbound with the
// client address from the header as the source.
func (c *Core) servePP(ctx context.Context, ln net.Listener, h adapter.ConnectionHandler, lg sblog.ContextLogger) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) || ctx.Err() != nil {
				return
			}
			lg.Error("proxy protocol accept: ", err)
			time.Sleep(50 * time.Millisecond)
			continue
		}
		go func() {
			src := conn.RemoteAddr()
			if pc, ok := conn.(*proxyproto.Conn); ok {
				// reads the header; with REQUIRE a connection without one is dropped
				if pc.ProxyHeader() == nil {
					conn.Close()
					return
				}
				src = pc.RemoteAddr()
			}
			var md adapter.InboundContext
			md.Source = M.SocksaddrFromNet(src).Unwrap()
			md.OriginDestination = M.SocksaddrFromNet(conn.LocalAddr()).Unwrap()
			cctx := sblog.ContextWithNewID(ctx)
			lg.InfoContext(cctx, "inbound connection from ", md.Source, " (proxy protocol)")
			h.NewConnection(cctx, conn, md, nil)
		}()
	}
}

// CertWrites counts panel certificate files written to disk.
func (c *Core) CertWrites() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.certWrites
}

// Stats returns (in-place user updates, inbound (re)creations).
func (c *Core) Stats() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hotUpdates, c.rebuilds
}

func (c *Core) Inbounds() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.slots)
}
