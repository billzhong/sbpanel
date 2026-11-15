package master

import (
	"net/http"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"sbpanel/internal/pb"
	"sbpanel/internal/procstat"
)

// Node and panel health history: one row per node per minute (averaged over the
// heartbeats in it), kept for metricsKeep. The master's own process is stored under
// masterMetricsID.
const (
	metricsKeep     = 24 * time.Hour
	masterMetricsID = "_master"
)

type masterMetrics struct {
	host string // os.Hostname(): a node reporting the same hostname runs next to the panel
	proc *procstat.Sampler
	last atomic.Pointer[pb.ProcInfo]
}

func newMasterMetrics() *masterMetrics {
	h, _ := os.Hostname()
	mm := &masterMetrics{host: h, proc: procstat.New()}
	mm.last.Store(mm.proc.Sample())
	return mm
}

// recordHeartbeat folds one heartbeat into its minute's row.
func (m *Master) recordHeartbeat(nodeID string, hb *pb.Heartbeat) {
	s := hb.GetSys()
	p := hb.GetProc()
	t := now()
	var hasProc int
	if p != nil {
		hasProc = 1
	}
	m.db.Exec(`INSERT INTO node_metrics(node_id, ts, n, cpu, mem_used, mem_total, proc, proc_cpu, proc_rss, rate_up, rate_down, net_rx, net_tx, conns)
		VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(node_id, ts) DO UPDATE SET n=n+1, cpu=(cpu*n+excluded.cpu)/(n+1),
		  mem_used=(mem_used*n+excluded.mem_used)/(n+1), mem_total=excluded.mem_total, proc=excluded.proc,
		  proc_cpu=(proc_cpu*n+excluded.proc_cpu)/(n+1), proc_rss=(proc_rss*n+excluded.proc_rss)/(n+1),
		  rate_up=(rate_up*n+excluded.rate_up)/(n+1), rate_down=(rate_down*n+excluded.rate_down)/(n+1),
		  net_rx=excluded.net_rx, net_tx=excluded.net_tx, conns=(conns*n+excluded.conns)/(n+1)`,
		nodeID, t-t%60, s.GetCpuPct(), s.GetMemUsed(), s.GetMemTotal(), hasProc, p.GetCpuPct(), p.GetRss(),
		hb.RateUp, hb.RateDown, s.GetNetRx(), s.GetNetTx(), hb.ActiveConns)
}

// metricsLoop samples the master's own process every 10 s and prunes old rows.
func (m *Master) metricsLoop(stop <-chan struct{}) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	m.db.Exec(`DELETE FROM node_metrics WHERE ts<?`, now()-int64(metricsKeep/time.Second))
	for i := 1; ; i++ {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		p := m.metrics.proc.Sample()
		m.metrics.last.Store(p)
		m.recordHeartbeat(masterMetricsID, &pb.Heartbeat{Proc: p})
		if i%360 == 0 { // hourly
			m.db.Exec(`DELETE FROM node_metrics WHERE ts<?`, now()-int64(metricsKeep/time.Second))
		}
	}
}

// hostsMaster reports whether the node runs on the panel's machine (same hostname).
func (m *Master) hostsMaster(s *session) bool {
	if s == nil || m.metrics.host == "" {
		return false
	}
	hello, _, _, _ := s.snapshot()
	return hello != nil && hello.Hostname == m.metrics.host
}

var nodeMetricSchema = tObj(js{"ts": tTS("Bucket start"), "cpu": tNum("Machine CPU %"), "mem_used": tBytes(""), "mem_total": tBytes(""),
	"proc_cpu": tNum("sbnode CPU, % of the machine; null for nodes too old to report it"), "proc_rss": tBytes("sbnode resident memory"),
	"rate_up": tInt("bytes/s through the proxy core"), "rate_down": tInt("bytes/s"), "nic_rx": tInt("Whole-machine network, bytes/s"), "nic_tx": tInt("bytes/s"),
	"conns": tInt("Active connections")})

var nodeMetricsDoc = opDoc{Tag: "nodes", Summary: "Node health history (machine, sbnode process, network, traffic)",
	Desc: "Per-minute samples for the last 24 hours. `master` (the sbmaster process) is present when the panel runs on this node's machine.",
	Query: []oaParam{qp("from", "Start time (unix seconds); default 1 hour ago, at most 24 hours", js{"type": "integer"}),
		qp("step", "Bucket size in seconds, multiple of 60; default 60", js{"type": "integer"})},
	Resp: tObj(js{"from": tTS(""), "to": tTS(""), "step": tInt(""), "points": arr("$NodeMetric"),
		"traffic": arr(js{"type": "array", "description": "[ts, up, down] user traffic through the node", "items": js{"type": "integer"}}),
		"master":  arr(tObj(js{"ts": tTS(""), "cpu": tNum("% of the machine"), "rss": tBytes("")}))})}

func init() {
	for en, zh := range map[string]string{
		"Node health history (machine, sbnode process, network, traffic)":                                                                  "节点运行历史（整机、sbnode 进程、网络、流量）",
		"Per-minute samples for the last 24 hours. `master` (the sbmaster process) is present when the panel runs on this node's machine.": "最近 24 小时的每分钟采样。面板与该节点在同一台机器上时附带 `master`（sbmaster 进程）。",
		"Start time (unix seconds); default 1 hour ago, at most 24 hours":                                                                  "开始时间（unix 秒）；默认 1 小时前，最多 24 小时",
		"Bucket size in seconds, multiple of 60; default 60":                                                                               "采样粒度（秒，60 的倍数）；默认 60",
		"[ts, up, down] user traffic through the node":                                                                                     "[ts, up, down] 经过该节点的用户流量",
		"% of the machine": "占整机 %",
		"Bucket start":     "时间桶起点",
		"Machine CPU %":    "整机 CPU %",
		"sbnode CPU, % of the machine; null for nodes too old to report it": "sbnode CPU（占整机 %）；旧版节点不上报时为 null",
		"sbnode resident memory":         "sbnode 常驻内存",
		"bytes/s through the proxy core": "经代理内核的字节/秒",
		"Whole-machine network, bytes/s": "整机网络，字节/秒",
		"Active connections":             "活动连接",
		"The sbnode process: cpu_pct (% of the machine), rss, heap, goroutines, threads, started": "sbnode 进程：cpu_pct（占整机 %）、rss、heap、goroutines、threads、started",
		"The sbmaster process, on the node that runs the panel":                                   "sbmaster 进程，仅在运行面板的节点上",
	} {
		if _, ok := zhAPIDocs[en]; !ok {
			zhAPIDocs[en] = zh
		}
	}
}

type metricPoint struct {
	TS       int64    `json:"ts"`
	CPU      float64  `json:"cpu"`
	MemUsed  int64    `json:"mem_used"`
	MemTotal int64    `json:"mem_total"`
	ProcCPU  *float64 `json:"proc_cpu"` // null: the node is too old to report its process
	ProcRSS  *int64   `json:"proc_rss"`
	RateUp   int64    `json:"rate_up"`
	RateDown int64    `json:"rate_down"`
	NICRx    int64    `json:"nic_rx"` // whole-machine network, bytes/s
	NICTx    int64    `json:"nic_tx"`
	Conns    int64    `json:"conns"`
}

type procPoint struct {
	TS  int64   `json:"ts"`
	CPU float64 `json:"cpu"`
	RSS int64   `json:"rss"`
}

// GET /api/nodes/{id}/metrics?from=&step=
func (m *Master) apiNodeMetrics(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var exists int
	if m.db.QueryRow(`SELECT COUNT(*) FROM nodes WHERE id=?`, id).Scan(&exists); exists == 0 {
		writeErr(w, 404, "Node not found")
		return
	}
	to := now()
	from, _ := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
	if from <= 0 || from > to {
		from = to - 3600
	}
	if min := to - int64(metricsKeep/time.Second); from < min {
		from = min
	}
	step, _ := strconv.ParseInt(r.URL.Query().Get("step"), 10, 64)
	if step < 60 {
		step = 60
	}
	step -= step % 60
	from -= from % step

	pts, err := scanRows(m, `SELECT ts-ts%?1 AS b, AVG(cpu), AVG(mem_used), MAX(mem_total), MAX(proc), AVG(proc_cpu), AVG(proc_rss),
		AVG(rate_up), AVG(rate_down), MAX(net_rx), MAX(net_tx), MIN(net_rx), MIN(net_tx), AVG(conns)
		FROM node_metrics WHERE node_id=?2 AND ts>=?3 GROUP BY b ORDER BY b`, []any{step, id, from},
		func(s func(...any) error) (struct {
			metricPoint
			rx, tx, rx0, tx0 int64
		}, error) {
			var p struct {
				metricPoint
				rx, tx, rx0, tx0 int64
			}
			var mu, ru, rd, rss, conns, pcpu float64
			var hasProc int
			err := s(&p.TS, &p.CPU, &mu, &p.MemTotal, &hasProc, &pcpu, &rss, &ru, &rd, &p.rx, &p.tx, &p.rx0, &p.tx0, &conns)
			p.MemUsed, p.RateUp, p.RateDown, p.Conns = int64(mu), int64(ru), int64(rd), int64(conns+0.5)
			if hasProc == 1 {
				r := int64(rss)
				p.ProcCPU, p.ProcRSS = &pcpu, &r
			}
			return p, err
		})
	if errf(w, err) {
		return
	}
	out := make([]metricPoint, len(pts))
	for i, p := range pts {
		// NIC rate: growth of the cumulative counters since the previous bucket (or within
		// the first one); a counter that went backwards (reboot) counts as no data.
		prx, ptx, pts0 := p.rx0, p.tx0, p.TS
		if i > 0 {
			prx, ptx, pts0 = pts[i-1].rx, pts[i-1].tx, pts[i-1].TS
		}
		if dt := p.TS - pts0; dt > 0 && dt <= 3*step {
			if p.rx >= prx {
				p.NICRx = (p.rx - prx) / dt
			}
			if p.tx >= ptx {
				p.NICTx = (p.tx - ptx) / dt
			}
		} else if i == 0 && step > 0 {
			p.NICRx, p.NICTx = (p.rx-p.rx0)/step, (p.tx-p.tx0)/step
		}
		out[i] = p.metricPoint
	}

	traffic, err := scanRows(m, `SELECT ts-ts%?1 AS b, SUM(up), SUM(down) FROM traffic_minute WHERE node_id=?2 AND ts>=?3 GROUP BY b ORDER BY b`,
		[]any{step, id, from}, func(s func(...any) error) ([3]int64, error) {
			var v [3]int64
			return v, s(&v[0], &v[1], &v[2])
		})
	if errf(w, err) {
		return
	}
	resp := map[string]any{"from": from, "to": to, "step": step, "points": out, "traffic": traffic}
	if m.hostsMaster(m.hub.session(id)) {
		mp, err := m.procSeries(masterMetricsID, from, step)
		if errf(w, err) {
			return
		}
		resp["master"] = mp
	}
	writeJSON(w, 200, resp)
}

func (m *Master) procSeries(id string, from, step int64) ([]procPoint, error) {
	return scanRows(m, `SELECT ts-ts%?1 AS b, AVG(proc_cpu), AVG(proc_rss) FROM node_metrics WHERE node_id=?2 AND ts>=?3 GROUP BY b ORDER BY b`,
		[]any{step, id, from}, func(s func(...any) error) (procPoint, error) {
			var p procPoint
			var rss float64
			err := s(&p.TS, &p.CPU, &rss)
			p.RSS = int64(rss)
			return p, err
		})
}
