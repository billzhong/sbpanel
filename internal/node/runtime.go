package node

import (
	"log"
	"math"
	"runtime/debug"
	"sync"
)

// The panel may tune this process's Go runtime (sing-box runs in it). Values the
// panel never set are left as the environment (GOGC / GOMEMLIMIT) made them.
var rt struct {
	sync.Mutex
	gogc, limit int64
	set         bool
}

func applyRuntime(r interface {
	GetGogc() int32
	GetMemoryLimit() int64
}) {
	gogc, limit := int64(r.GetGogc()), r.GetMemoryLimit()
	rt.Lock()
	defer rt.Unlock()
	if !rt.set && gogc == 0 && limit == 0 {
		return
	}
	if rt.set && gogc == rt.gogc && limit == rt.limit {
		return
	}
	g := int(gogc)
	if g == 0 {
		g = 100
	}
	debug.SetGCPercent(g)
	l := limit
	if l == 0 {
		l = math.MaxInt64
	}
	debug.SetMemoryLimit(l)
	rt.gogc, rt.limit, rt.set = gogc, limit, true
	log.Printf("runtime: GOGC=%d memory limit=%d MB", g, limit>>20)
}
