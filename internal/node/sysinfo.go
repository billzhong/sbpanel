package node

import (
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"

	"sbpanel/internal/pb"
)

func sysInfo() *pb.SysInfo {
	s := &pb.SysInfo{}
	if p, err := cpu.Percent(0, false); err == nil && len(p) > 0 {
		s.CpuPct = p[0]
	}
	if v, err := mem.VirtualMemory(); err == nil {
		s.MemUsed, s.MemTotal = v.Used, v.Total
	}
	if l, err := load.Avg(); err == nil {
		s.Load1 = l.Load1
	}
	if u, err := host.Uptime(); err == nil {
		s.Uptime = u
	}
	if n, err := gnet.IOCounters(false); err == nil && len(n) > 0 {
		s.NetRx, s.NetTx = n[0].BytesRecv, n[0].BytesSent
	}
	if d, err := disk.Usage("/"); err == nil {
		s.DiskUsed, s.DiskTotal = d.Used, d.Total
	}
	return s
}
