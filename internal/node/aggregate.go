package node

import (
	"sort"

	"google.golang.org/protobuf/proto"

	"sbpanel/internal/pb"
)

// Collect turns the byte movement since the previous call into one report window.
// It is the only reader/writer of connRec.last*, so it needs no per-conn locking:
// counters only grow, and a closed connection is drained once and forgotten.
func (t *Tracker) Collect(windowStart, windowEnd int64, maxHostsPerUser int) *pb.TrafficReport {
	t.mu.Lock()
	recs := make([]*connRec, 0, len(t.active)+len(t.closed))
	for _, r := range t.active {
		recs = append(recs, r)
	}
	recs = append(recs, t.closed...)
	t.closed = nil
	t.mu.Unlock()

	type uk struct{ user, inbound, outbound string }
	type dk struct {
		user, inbound, outbound, host, srcIP, network, rule string
		port                                                uint16
	}
	users := map[uk]*pb.UserStat{}
	dims := map[dk]*pb.DimStat{}
	for _, r := range recs {
		up, down := r.up.Load(), r.down.Load()
		du, dd := up-r.lastUp, down-r.lastDown
		r.lastUp, r.lastDown = up, down
		var nc int64
		if !r.counted {
			r.counted = true
			nc = 1
		}
		if du == 0 && dd == 0 && nc == 0 {
			continue
		}
		k := uk{r.user, r.inbound, r.outbound}
		u := users[k]
		if u == nil {
			u = &pb.UserStat{User: r.user, Inbound: r.inbound, Outbound: r.outbound}
			users[k] = u
		}
		u.Up += du
		u.Down += dd
		u.Conns += nc
		d2 := dk{r.user, r.inbound, r.outbound, r.host, r.srcIP, r.network, r.rule, r.port}
		d := dims[d2]
		if d == nil {
			d = &pb.DimStat{User: r.user, Inbound: r.inbound, Outbound: r.outbound, Host: r.host, Port: uint32(r.port),
				SrcIp: r.srcIP, Network: r.network, Rule: r.rule}
			dims[d2] = d
		}
		d.Up += du
		d.Down += dd
		d.Conns += nc
	}
	if len(users) == 0 {
		return nil
	}
	rep := &pb.TrafficReport{WindowStart: windowStart, WindowEnd: windowEnd}
	for _, u := range users {
		rep.Users = append(rep.Users, u)
	}
	rep.Dims = capDims(dims, maxHostsPerUser)
	return rep
}

// capDims keeps the top-N (by bytes) dimension rows per user and folds the rest
// into "(other)" so cardinality stays bounded under scanning or P2P traffic.
func capDims[K comparable](dims map[K]*pb.DimStat, n int) []*pb.DimStat {
	byUser := map[string][]*pb.DimStat{}
	for _, d := range dims {
		byUser[d.User] = append(byUser[d.User], d)
	}
	var out []*pb.DimStat
	for _, ds := range byUser {
		if n <= 0 || len(ds) <= n {
			out = append(out, ds...)
			continue
		}
		sort.Slice(ds, func(i, j int) bool { return ds[i].Up+ds[i].Down > ds[j].Up+ds[j].Down })
		out = append(out, ds[:n]...)
		other := map[[2]string]*pb.DimStat{}
		for _, d := range ds[n:] {
			k := [2]string{d.Inbound, d.Outbound}
			o := other[k]
			if o == nil {
				o = &pb.DimStat{User: d.User, Inbound: d.Inbound, Outbound: d.Outbound, Host: "(other)", Rule: "(other)"}
				other[k] = o
			}
			o.Up += d.Up
			o.Down += d.Down
			o.Conns += d.Conns
		}
		for _, o := range other {
			out = append(out, o)
		}
	}
	return out
}

// mergeReports sums several reports into one (used to compact an oversized spool).
func mergeReports(rs []*pb.TrafficReport) *pb.TrafficReport {
	out := &pb.TrafficReport{}
	type uk struct{ a, b, c string }
	users := map[uk]*pb.UserStat{}
	type dk struct {
		a, b, c, h, s, n, r string
		p                   uint32
	}
	dims := map[dk]*pb.DimStat{}
	for i, r := range rs {
		if i == 0 || r.WindowStart < out.WindowStart {
			out.WindowStart = r.WindowStart
		}
		if r.WindowEnd > out.WindowEnd {
			out.WindowEnd = r.WindowEnd
		}
		for _, u := range r.Users {
			k := uk{u.User, u.Inbound, u.Outbound}
			if x := users[k]; x != nil {
				x.Up += u.Up
				x.Down += u.Down
				x.Conns += u.Conns
			} else {
				users[k] = proto.Clone(u).(*pb.UserStat)
			}
		}
		for _, d := range r.Dims {
			k := dk{d.User, d.Inbound, d.Outbound, d.Host, d.SrcIp, d.Network, d.Rule, d.Port}
			if x := dims[k]; x != nil {
				x.Up += d.Up
				x.Down += d.Down
				x.Conns += d.Conns
			} else {
				dims[k] = proto.Clone(d).(*pb.DimStat)
			}
		}
	}
	for _, u := range users {
		out.Users = append(out.Users, u)
	}
	for _, d := range dims {
		out.Dims = append(out.Dims, d)
	}
	return out
}
