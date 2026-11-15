package master

import (
	"strconv"
	"strings"
	"time"

	"sbpanel/internal/pb"
)

func parseUserID(name string) int64 {
	id, _ := strconv.ParseInt(name, 10, 64)
	return id
}

// ingest applies one traffic report exactly once. The (node, seq) row in report_seen
// and every counter update commit in the same transaction, so a retried report is
// acknowledged without being counted again, and a failed one is not half-counted.
func (m *Master) ingest(nodeID string, r *pb.TrafficReport) (dup bool, err error) {
	m.ingestMu.Lock()
	defer m.ingestMu.Unlock()
	tx, err := m.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`INSERT INTO report_seen(node_id, seq, ts) VALUES(?,?,?) ON CONFLICT DO NOTHING`, nodeID, r.Seq, now())
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return true, nil
	}
	ws := r.WindowStart
	if ws == 0 {
		ws = now()
	}
	minute, hour := ws-ws%60, ws-ws%3600
	// a node may only report traffic of real users, and never negative bytes (a compromised
	// node must not be able to reset or inflate other users' quotas through odd numbers)
	known := map[int64]bool{}
	if rows, err := tx.Query(`SELECT id FROM users`); err == nil {
		for rows.Next() {
			var id int64
			rows.Scan(&id)
			known[id] = true
		}
		rows.Close()
	}
	usable := func(name string, up, down, conns *int64) (int64, bool) {
		uid := parseUserID(name)
		if uid > 0 && !known[uid] {
			return 0, false
		}
		*up, *down, *conns = max(*up, 0), max(*down, 0), max(*conns, 0)
		return uid, true
	}

	type ud struct{ up, down int64 }
	perUser := map[int64]*ud{}
	perIn := map[limitKey]*[2]int64{}
	for _, u := range r.Users {
		if u.User == probeUser { // connectivity probe (older nodes still report it)
			continue
		}
		uid, ok := usable(u.User, &u.Up, &u.Down, &u.Conns)
		if !ok {
			continue
		}
		for _, q := range []struct {
			table string
			ts    int64
		}{{"traffic_minute", minute}, {"traffic_hour", hour}} {
			if _, err := tx.Exec(`INSERT INTO `+q.table+`(ts,node_id,user_id,inbound,outbound,up,down,conns) VALUES(?,?,?,?,?,?,?,?)
				ON CONFLICT(ts,node_id,user_id,inbound,outbound) DO UPDATE SET
				up=up+excluded.up, down=down+excluded.down, conns=conns+excluded.conns`,
				q.ts, nodeID, uid, u.Inbound, u.Outbound, u.Up, u.Down, u.Conns); err != nil {
				return false, err
			}
		}
		if uid > 0 {
			a := perUser[uid]
			if a == nil {
				a = &ud{}
				perUser[uid] = a
			}
			a.up += u.Up
			a.down += u.Down
			k := limitKey{uid, u.Inbound}
			if perIn[k] == nil {
				perIn[k] = &[2]int64{}
			}
			perIn[k][0] += u.Up
			perIn[k][1] += u.Down
		}
	}
	crossed, err := m.countLimits(tx, nodeID, ws, perIn)
	if err != nil {
		return false, err
	}
	for uid, a := range perUser {
		if _, err := tx.Exec(`UPDATE users SET used_up=used_up+?, used_down=used_down+?, life_up=life_up+?, life_down=life_down+? WHERE id=?`,
			a.up, a.down, a.up, a.down, uid); err != nil {
			return false, err
		}
	}
	for _, d := range r.Dims {
		if d.User == probeUser {
			continue
		}
		if _, ok := usable(d.User, &d.Up, &d.Down, &d.Conns); !ok {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO dim_5m(ts,node_id,user_id,inbound,outbound,host,port,src_ip,network,rule,up,down,conns)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(ts,node_id,user_id,inbound,outbound,host,port,src_ip,network,rule) DO UPDATE SET
			up=up+excluded.up, down=down+excluded.down, conns=conns+excluded.conns`,
			ws-ws%300, nodeID, parseUserID(d.User), d.Inbound, d.Outbound, strings.ToLower(d.Host), d.Port, d.SrcIp, d.Network, d.Rule,
			d.Up, d.Down, d.Conns); err != nil {
			return false, err
		}
		if _, err := tx.Exec(`INSERT INTO dim_hour(ts,node_id,user_id,inbound,outbound,host,port,src_ip,network,rule,up,down,conns)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(ts,node_id,user_id,inbound,outbound,host,port,src_ip,network,rule) DO UPDATE SET
			up=up+excluded.up, down=down+excluded.down, conns=conns+excluded.conns`,
			hour, nodeID, parseUserID(d.User), d.Inbound, d.Outbound, strings.ToLower(d.Host), d.Port, d.SrcIp, d.Network, d.Rule,
			d.Up, d.Down, d.Conns); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	if len(perUser) > 0 {
		m.checkQuota(perUser2ids(perUser))
	}
	m.limitsCrossed(crossed)
	return false, nil
}

func perUser2ids[T any](m map[int64]T) []int64 {
	out := make([]int64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// checkQuota moves users over their limit to "limited" and pushes new specs.
func (m *Master) checkQuota(ids []int64) {
	var hit []string
	for _, id := range ids {
		res, err := m.db.Exec(`UPDATE users SET status='limited' WHERE id=? AND status='active'
			AND traffic_limit>0 AND used_up+used_down>=traffic_limit`, id)
		if err != nil {
			continue
		}
		if n, _ := res.RowsAffected(); n > 0 {
			addEvent(m.db, "quota_exceeded", id, "", "")
			hit = append(hit, strconv.FormatInt(id, 10))
		}
	}
	if len(hit) > 0 {
		m.reconcile()
		m.hub.kick(hit)
	}
}

// policyLoop handles time-based state: expiry and retention.
func (m *Master) policyLoop(stop <-chan struct{}) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	lastClean := time.Time{}
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		expired, _ := scanRows(m, `SELECT id FROM users WHERE status='active' AND expire_at>0 AND expire_at<=?`, []any{now()},
			func(s func(...any) error) (int64, error) {
				var id int64
				return id, s(&id)
			})
		for _, id := range expired {
			m.recomputeStatus(id)
		}
		if len(expired) > 0 {
			m.reconcile()
		}
		m.resetUsage(time.Now())
		m.refreshLimitPeriods(time.Now())
		m.checkNodeQuota(time.Now())
		if time.Since(lastClean) > time.Hour {
			lastClean = time.Now()
			n := now()
			m.db.Exec(`DELETE FROM traffic_minute WHERE ts<?`, n-int64(m.cfg.KeepMinuteDays)*86400)
			m.db.Exec(`DELETE FROM dim_hour WHERE ts<?`, n-int64(m.cfg.KeepDimDays)*86400)
			m.db.Exec(`DELETE FROM dim_5m WHERE ts<?`, n-int64(m.cfg.KeepMinuteDays)*86400)
			m.db.Exec(`DELETE FROM traffic_hour WHERE ts<?`, n-int64(m.cfg.KeepHourDays)*86400)
			m.db.Exec(`DELETE FROM report_seen WHERE ts<?`, n-14*86400)
			m.db.Exec(`DELETE FROM events WHERE ts<?`, n-90*86400)
			// tables that only ever grew
			m.db.Exec(`DELETE FROM online_ip WHERE last_seen<?`, n-30*86400)
			m.db.Exec(`DELETE FROM sub_access WHERE ts<?`, n-90*86400)
			m.db.Exec(`DELETE FROM audit_log WHERE ts<?`, n-365*86400)
		}
	}
}
