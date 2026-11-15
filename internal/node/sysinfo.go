package node

import (
	"bufio"
	"os"
	"strings"

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
	if per, err := gnet.IOCounters(true); err == nil {
		up := uplinks()
		for _, c := range per {
			if up[c.Name] || (len(up) == 0 && !virtualIface(c.Name)) {
				s.WanRx += c.BytesRecv
				s.WanTx += c.BytesSent
			}
		}
	}
	if d, err := disk.Usage("/"); err == nil {
		s.DiskUsed, s.DiskTotal = d.Used, d.Total
	}
	return s
}

// uplinks are the interfaces holding a default route (IPv4 or IPv6): the provider's
// metered link. Empty where /proc is unavailable; the caller then falls back to every
// non-virtual interface.
func uplinks() map[string]bool {
	up := map[string]bool{}
	scan := func(path string, ok func([]string) (string, bool)) {
		f, err := os.Open(path)
		if err != nil {
			return
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if name, yes := ok(strings.Fields(sc.Text())); yes {
				up[name] = true
			}
		}
	}
	// Iface Destination Gateway Flags RefCnt Use Metric Mask ...
	scan("/proc/net/route", func(f []string) (string, bool) {
		return f[0], len(f) > 7 && f[1] == "00000000" && f[7] == "00000000"
	})
	// dest destlen src srclen nexthop metric refcnt use flags iface
	scan("/proc/net/ipv6_route", func(f []string) (string, bool) {
		if len(f) < 10 || f[1] != "00" || f[0] != strings.Repeat("0", 32) || f[9] == "lo" {
			return "", false
		}
		return f[9], true
	})
	for n := range up {
		if virtualIface(n) {
			delete(up, n)
		}
	}
	return up
}

func virtualIface(n string) bool {
	for _, p := range []string{"lo", "docker", "veth", "br-", "virbr", "tun", "tap", "wg", "tailscale", "zt", "utun",
		"cali", "flannel", "cni", "kube", "vxlan", "dummy", "ifb", "sing", "awdl", "llw", "bridge", "gif", "stf", "anpi", "ap"} {
		if strings.HasPrefix(n, p) {
			return true
		}
	}
	return false
}
