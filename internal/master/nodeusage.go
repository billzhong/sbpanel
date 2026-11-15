package master

import (
	"fmt"
	"time"

	"sbpanel/internal/pb"
)

// Server traffic: what the provider meters on the machine's uplink, counted per billing
// period (the node's reset day) from the uplink byte counters the node reports in every
// heartbeat. Providers count differently, so traffic_mode picks the measure compared with
// traffic_limit; an admin can set the period's used amount to match the provider's panel,
// stored as an offset (adj) so counting carries on from there.

var trafficModes = map[string]bool{"both": true, "out": true, "in": true, "max": true}

func meteredUsed(mode string, rx, tx int64) int64 {
	switch mode {
	case "out":
		return tx
	case "in":
		return rx
	case "max":
		return max(rx, tx)
	}
	return rx + tx
}

// recordWan adds the uplink bytes since the previous heartbeat to the current period.
// A reboot (boot time moved, or a counter went backwards) restarts from zero.
func (m *Master) recordWan(nodeID string, s *pb.SysInfo) {
	if s == nil || (s.WanRx == 0 && s.WanTx == 0) {
		return // an older node, or no uplink found
	}
	rx, tx := int64(s.WanRx), int64(s.WanTx)
	boot := now() - int64(s.Uptime)
	var day, lrx, ltx, lboot int64
	if m.db.QueryRow(`SELECT reset_day, wan_last_rx, wan_last_tx, wan_boot FROM nodes WHERE id=?`, nodeID).Scan(&day, &lrx, &ltx, &lboot) != nil {
		return
	}
	var drx, dtx int64
	switch {
	case lboot == 0: // first report: nothing to compare with yet
	case abs64(boot-lboot) > 120 || rx < lrx || tx < ltx:
		drx, dtx = rx, tx
	default:
		drx, dtx = rx-lrx, tx-ltx
	}
	if drx > 0 || dtx > 0 {
		m.db.Exec(`INSERT INTO node_usage(node_id, period, rx, tx) VALUES(?,?,?,?)
			ON CONFLICT(node_id, period) DO UPDATE SET rx=rx+excluded.rx, tx=tx+excluded.tx`,
			nodeID, m.monthStart(time.Now(), int(day)), drx, dtx)
	}
	if lboot == 0 || abs64(boot-lboot) > 120 {
		lboot = boot
	}
	m.db.Exec(`UPDATE nodes SET wan_last_rx=?, wan_last_tx=?, wan_boot=? WHERE id=?`, rx, tx, lboot, nodeID)
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

type serverUsage struct {
	Tracked bool  `json:"tracked"` // the node reports uplink counters
	Rx      int64 `json:"rx"`      // counted this period
	Tx      int64 `json:"tx"`
	Adj     int64 `json:"adj"`  // admin correction included in used
	Used    int64 `json:"used"` // by the node's traffic_mode, with the correction
	Start   int64 `json:"period_start"`
	End     int64 `json:"period_end"`
}

func (m *Master) serverUsage(nodeID, mode string, resetDay int, t time.Time) serverUsage {
	st := m.monthStart(t, resetDay)
	u := serverUsage{Start: st, End: time.Unix(st, 0).In(m.loc).AddDate(0, 1, 0).Unix()}
	var boot int64
	m.db.QueryRow(`SELECT wan_boot FROM nodes WHERE id=?`, nodeID).Scan(&boot)
	m.db.QueryRow(`SELECT rx, tx, adj FROM node_usage WHERE node_id=? AND period=?`, nodeID, st).Scan(&u.Rx, &u.Tx, &u.Adj)
	u.Tracked = boot > 0 || u.Rx > 0 || u.Tx > 0 || u.Adj != 0
	u.Used = max(0, meteredUsed(mode, u.Rx, u.Tx)+u.Adj)
	return u
}

// setServerUsed makes this period's used amount equal to the provider's figure.
func (m *Master) setServerUsed(nodeID string, used int64) error {
	if used < 0 {
		return fmt.Errorf("traffic_used must be >= 0")
	}
	var mode string
	var day int
	if err := m.db.QueryRow(`SELECT traffic_mode, reset_day FROM nodes WHERE id=?`, nodeID).Scan(&mode, &day); err != nil {
		return err
	}
	st := m.monthStart(time.Now(), day)
	var rx, tx int64
	m.db.QueryRow(`SELECT rx, tx FROM node_usage WHERE node_id=? AND period=?`, nodeID, st).Scan(&rx, &tx)
	_, err := m.db.Exec(`INSERT INTO node_usage(node_id, period, adj) VALUES(?,?,?)
		ON CONFLICT(node_id, period) DO UPDATE SET adj=excluded.adj`, nodeID, st, used-meteredUsed(mode, rx, tx))
	m.db.Exec(`UPDATE nodes SET notified_quota=0 WHERE id=?`, nodeID)
	return err
}
