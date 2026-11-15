package master

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

type batchReq struct {
	IDs    []int64         `json:"ids"`
	Action string          `json:"action"`
	Value  json.RawMessage `json:"value"`
}

// userSnap is the reversible state of a user; "restore" writes it back (undo).
type userSnap struct {
	ID           int64 `json:"id"`
	Enabled      bool  `json:"enabled"`
	ExpireAt     int64 `json:"expire_at"`
	TrafficLimit int64 `json:"traffic_limit"`
	UsedUp       int64 `json:"used_up"`
	UsedDown     int64 `json:"used_down"`
}

func (m *Master) snapshot(ids []int64) []userSnap {
	out := []userSnap{}
	for _, id := range ids {
		var s userSnap
		if m.db.QueryRow(`SELECT id, enabled, expire_at, traffic_limit, used_up, used_down FROM users WHERE id=?`, id).
			Scan(&s.ID, &s.Enabled, &s.ExpireAt, &s.TrafficLimit, &s.UsedUp, &s.UsedDown) == nil {
			out = append(out, s)
		}
	}
	return out
}

// applyBatch runs one action over many users in a single transaction and returns
// the number of users affected. Status is recomputed and nodes reconciled once.
func (m *Master) applyBatch(req batchReq) (int64, error) {
	if len(req.IDs) == 0 {
		return 0, fmt.Errorf("No users selected")
	}
	if len(req.IDs) > 5000 {
		return 0, fmt.Errorf("At most 5000 users per batch")
	}
	var num float64
	var groups []int64
	var snaps []userSnap
	var lim struct {
		RuleID       int64  `json:"rule_id"`
		Attach       bool   `json:"attach"`
		TrafficLimit *int64 `json:"traffic_limit"`
	}
	switch req.Action {
	case "restore":
		if err := json.Unmarshal(req.Value, &snaps); err != nil {
			return 0, fmt.Errorf("value must be an array of snapshots")
		}
	case "extend_days", "add_traffic":
		if err := json.Unmarshal(req.Value, &num); err != nil {
			return 0, fmt.Errorf("value must be a number")
		}
	case "set_groups":
		if err := json.Unmarshal(req.Value, &groups); err != nil {
			return 0, fmt.Errorf("value must be an array of group ids")
		}
	case "set_limit":
		if err := json.Unmarshal(req.Value, &lim); err != nil || lim.RuleID <= 0 {
			return 0, fmt.Errorf("value must be {\"rule_id\": id, \"traffic_limit\": bytes|null}")
		}
		if lim.TrafficLimit != nil && *lim.TrafficLimit < 0 {
			return 0, fmt.Errorf("Traffic limit must not be negative")
		}
		var n int
		m.db.QueryRow(`SELECT COUNT(*) FROM traffic_rules WHERE id=?`, lim.RuleID).Scan(&n)
		if n == 0 {
			return 0, fmt.Errorf("Traffic limit not found")
		}
	case "enable", "disable", "reset_usage", "delete":
	default:
		return 0, fmt.Errorf("Unknown action: %s", req.Action)
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(req.IDs)), ",")
	args := make([]any, len(req.IDs))
	for i, id := range req.IDs {
		args[i] = id
	}
	in := ` WHERE id IN (` + ph + `)`
	tx, err := m.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var res interface{ RowsAffected() (int64, error) }
	exec := func(q string, a ...any) error {
		r, err := tx.Exec(q, a...)
		if err == nil {
			res = r
		}
		return err
	}
	switch req.Action {
	case "restore":
		want := map[int64]bool{}
		for _, id := range req.IDs {
			want[id] = true
		}
		var n int64
		for _, sn := range snaps {
			if !want[sn.ID] {
				continue
			}
			if _, err = tx.Exec(`UPDATE users SET enabled=?, expire_at=?, traffic_limit=?, used_up=?, used_down=? WHERE id=?`,
				sn.Enabled, sn.ExpireAt, sn.TrafficLimit, sn.UsedUp, sn.UsedDown, sn.ID); err != nil {
				break
			}
			n++
		}
		res = rowsN(n)
	case "enable":
		err = exec(`UPDATE users SET enabled=1`+in, args...)
	case "disable":
		err = exec(`UPDATE users SET enabled=0`+in, args...)
	case "reset_usage":
		err = exec(`UPDATE users SET used_up=0, used_down=0, last_reset_at=?`+in, append([]any{now()}, args...)...)
		if err == nil {
			err = resetUserLimits(tx, req.IDs...)
		}
	case "extend_days":
		secs := int64(num * 86400)
		// extend from the later of now and the current expiry; no expiry -> now+days
		err = exec(`UPDATE users SET expire_at = MAX(CASE WHEN expire_at>0 THEN MAX(expire_at, ?) ELSE ? END + ?, 0)`+in,
			append([]any{now(), now(), secs}, args...)...)
	case "add_traffic":
		err = exec(`UPDATE users SET traffic_limit = MAX(traffic_limit + ?, 1) WHERE traffic_limit>0 AND id IN (`+ph+`)`,
			append([]any{int64(num)}, args...)...)
	case "set_groups":
		if err = exec(`DELETE FROM user_groups WHERE user_id IN (`+ph+`)`, args...); err == nil {
			for _, id := range req.IDs {
				for _, g := range groups {
					if _, err = tx.Exec(`INSERT OR IGNORE INTO user_groups(user_id, group_id) VALUES(?,?)`, id, g); err != nil {
						break
					}
				}
			}
			res = rowsN(len(req.IDs))
		}
	case "set_limit":
		// attach (traffic_limit 0 / absent = the preset's size) or take off
		size := int64(0)
		if lim.TrafficLimit != nil {
			size = *lim.TrafficLimit
		}
		for _, id := range req.IDs {
			if err = attachLimit(tx, id, lim.RuleID, lim.Attach, size); err != nil {
				break
			}
		}
		res = rowsN(len(req.IDs))
	case "delete":
		tx.Exec(`DELETE FROM user_groups WHERE user_id IN (`+ph+`)`, args...)
		tx.Exec(`DELETE FROM online_ip WHERE user_id IN (`+ph+`)`, args...)
		err = exec(`DELETE FROM users`+in, args...)
	}
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	if req.Action == "delete" {
		for _, id := range req.IDs {
			m.purgeUserTraffic(id)
		}
	}
	if req.Action != "delete" {
		for _, id := range req.IDs {
			m.recomputeStatus(id)
		}
	}
	m.reconcile()
	if req.Action == "delete" || req.Action == "disable" {
		names := make([]string, len(req.IDs))
		for i, id := range req.IDs {
			names[i] = strconv.FormatInt(id, 10)
		}
		m.hub.kick(names)
	}
	return n, nil
}

type rowsN int64

func (r rowsN) RowsAffected() (int64, error) { return int64(r), nil }

func (m *Master) apiBatchUsers(w http.ResponseWriter, r *http.Request) {
	var req batchReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var undo []userSnap
	if req.Action != "delete" && req.Action != "set_groups" && req.Action != "restore" && req.Action != "set_limit" {
		undo = m.snapshot(req.IDs)
	}
	n, err := m.applyBatch(req)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	m.audit(r, "user.batch."+req.Action, fmt.Sprintf("%d users", len(req.IDs)), truncate(string(req.Value), 200))
	out := map[string]any{"affected": n}
	if undo != nil {
		out["undo"] = undo // POST {"ids":..., "action":"restore", "value": undo} reverts exactly
	}
	writeJSON(w, 200, out)
}
