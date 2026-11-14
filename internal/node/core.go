package node

import (
	"context"
	stdjson "encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"syscall"
	"time"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter"
	C "github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/include"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common/json"
	"github.com/sagernet/sing/service"

	"sbpanel/internal/pb"
)

// SingboxVersion is the embedded core version.
func SingboxVersion() string { return C.Version }

type slot struct {
	spec  *pb.InboundSpec
	scope *adapter.Scope
	users map[string]bool
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
}

func NewCore(t *Tracker, l *log.Logger) *Core {
	return &Core{tracker: t, log: l, slots: map[string]*slot{}}
}

func (c *Core) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeAllLocked()
}

func (c *Core) closeAllLocked() {
	for tag, s := range c.slots {
		s.scope.Close()
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

	want := map[string]*pb.InboundSpec{}
	for _, in := range spec.Inbounds {
		want[in.Tag] = in
	}
	var errs []error
	for tag, s := range c.slots {
		w, ok := want[tag]
		if ok && w.OptionsHash == s.spec.OptionsHash && w.UsersHash == s.spec.UsersHash {
			continue
		}
		if err := s.scope.Close(); err != nil {
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
	t, _ := stdjson.Marshal(in.Type)
	g, _ := stdjson.Marshal(in.Tag)
	o["type"], o["tag"], o["users"] = t, g, in.UsersJson
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
	return &slot{spec: in, scope: sc, users: userSet(in.UserNames)}, nil
}

func (c *Core) Inbounds() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.slots)
}
