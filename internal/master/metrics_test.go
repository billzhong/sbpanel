package master

import (
	"encoding/json"
	"testing"

	"sbpanel/internal/pb"
)

func TestNodeMetrics(t *testing.T) {
	m := newTestMaster(t)
	h := m.routes()
	m.db.Exec(`INSERT INTO nodes(id, name, created_at) VALUES('n1','hk',0)`)
	hb := func(cpu float64, rx uint64, proc *pb.ProcInfo) *pb.Heartbeat {
		return &pb.Heartbeat{Sys: &pb.SysInfo{CpuPct: cpu, MemUsed: 100, MemTotal: 400, NetRx: rx, NetTx: rx / 2}, RateUp: 10, RateDown: 20, ActiveConns: 3, Proc: proc}
	}
	// two heartbeats in one minute average; an old node (no proc) gives proc_cpu null
	m.recordHeartbeat("n1", hb(10, 6000, &pb.ProcInfo{CpuPct: 2, Rss: 1000}))
	m.recordHeartbeat("n1", hb(30, 12000, &pb.ProcInfo{CpuPct: 4, Rss: 3000}))
	t0 := now() - now()%60
	m.db.Exec(`INSERT INTO node_metrics(node_id, ts, n, cpu, mem_used, mem_total, proc, proc_cpu, proc_rss, rate_up, rate_down, net_rx, net_tx, conns)
		VALUES('n1', ?, 1, 50, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0)`, t0-120)
	m.db.Exec(`INSERT INTO node_metrics(node_id, ts, n, cpu, mem_used, mem_total, proc, proc_cpu, proc_rss, rate_up, rate_down, net_rx, net_tx, conns)
		VALUES('n1', ?, 1, 50, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0)`, t0-90000) // past the 24 h window

	w := call(h, "GET", "/api/nodes/n1/metrics?from=1", nil, sessionOpt(m))
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var r struct {
		Points []metricPoint `json:"points"`
		Master []procPoint   `json:"master"`
	}
	json.Unmarshal(w.Body.Bytes(), &r)
	if len(r.Points) != 2 {
		t.Fatalf("points: %+v", r.Points)
	}
	old, cur := r.Points[0], r.Points[1]
	if old.ProcCPU != nil || cur.ProcCPU == nil || *cur.ProcCPU != 3 || *cur.ProcRSS != 2000 || cur.CPU != 20 || cur.MemTotal != 400 || cur.Conns != 3 {
		t.Fatalf("averaging: old %+v cur %+v", old, cur)
	}
	if r.Master != nil {
		t.Fatal("master series on a node that does not run the panel")
	}
	if w := call(h, "GET", "/api/nodes/nope/metrics", nil, sessionOpt(m)); w.Code != 404 {
		t.Fatalf("unknown node: %d", w.Code)
	}
}
