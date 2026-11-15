// Package procstat samples the current process's own CPU and memory, so the panel can
// tell "sbnode / sbmaster is busy" apart from "the machine is busy".
package procstat

import (
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/process"

	"sbpanel/internal/pb"
)

// Sampler reports CPU as the share of the whole machine used since the previous call.
type Sampler struct {
	mu      sync.Mutex
	p       *process.Process
	lastCPU float64 // user+system seconds
	lastAt  time.Time
	started int64
}

func New() *Sampler {
	s := &Sampler{}
	if p, err := process.NewProcess(int32(os.Getpid())); err == nil {
		s.p = p
		if ms, err := p.CreateTime(); err == nil {
			s.started = ms / 1000
		}
		if t, err := p.Times(); err == nil {
			s.lastCPU, s.lastAt = t.User+t.System, time.Now()
		}
	}
	return s
}

func (s *Sampler) Sample() *pb.ProcInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	out := &pb.ProcInfo{Heap: ms.HeapInuse, Goroutines: uint32(runtime.NumGoroutine()), Started: s.started}
	if s.p == nil {
		out.Rss = ms.Sys
		return out
	}
	if t, err := s.p.Times(); err == nil {
		cpu, at := t.User+t.System, time.Now()
		if dt := at.Sub(s.lastAt).Seconds(); s.lastAt.IsZero() || dt > 0.5 {
			if v := (cpu - s.lastCPU) / dt / float64(runtime.NumCPU()) * 100; !s.lastAt.IsZero() && v >= 0 {
				out.CpuPct = v
			}
			s.lastCPU, s.lastAt = cpu, at
		}
	}
	if m, err := s.p.MemoryInfo(); err == nil {
		out.Rss = m.RSS
	} else {
		out.Rss = ms.Sys
	}
	if n, err := s.p.NumThreads(); err == nil {
		out.Threads = uint32(n)
	}
	return out
}
