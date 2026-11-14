package master

import (
	"encoding/json"
	"testing"
	"time"
)

func TestBatchUsers(t *testing.T) {
	m := newTestMaster(t)
	seedNode(t, m, "n1")
	future := time.Now().Add(10 * 24 * time.Hour).Unix()
	m.db.Exec(`INSERT INTO users(id, username, sub_token, uuid, password, traffic_limit, expire_at, used_up, used_down, created_at) VALUES
		(1,'a','t1','x','y',100,?,40,40,0),
		(2,'b','t2','x','y',0,0,5,5,0),
		(3,'c','t3','x','y',100,1,0,0,0)`, future) // c expired long ago
	m.db.Exec(`UPDATE users SET status='expired' WHERE id=3`)
	get := func(id int64) userSnap { return m.snapshot([]int64{id})[0] }
	var st string
	status := func(id int64) string { m.db.QueryRow(`SELECT status FROM users WHERE id=?`, id).Scan(&st); return st }
	val := func(v any) json.RawMessage { b, _ := json.Marshal(v); return b }

	before := m.snapshot([]int64{1, 2, 3})
	n, err := m.applyBatch(batchReq{IDs: []int64{1, 2, 3}, Action: "extend_days", Value: val(30)})
	if err != nil || n != 3 {
		t.Fatalf("extend: %d %v", n, err)
	}
	if got := get(1).ExpireAt; got != future+30*86400 {
		t.Fatalf("a extends from its expiry: %d", got)
	}
	if got := get(2).ExpireAt; got < time.Now().Unix()+29*86400 {
		t.Fatalf("b (no expiry) gets now+30d: %d", got)
	}
	if got := get(3).ExpireAt; got < time.Now().Unix()+29*86400 || status(3) != "active" {
		t.Fatalf("c (expired) extends from now and is reactivated: %d %s", got, status(3))
	}
	// exact undo
	if n, err := m.applyBatch(batchReq{IDs: []int64{1, 2, 3}, Action: "restore", Value: val(before)}); err != nil || n != 3 {
		t.Fatalf("restore: %d %v", n, err)
	}
	for i, id := range []int64{1, 2, 3} {
		if get(id) != before[i] {
			t.Fatalf("user %d not restored: %+v vs %+v", id, get(id), before[i])
		}
	}
	if status(3) != "expired" {
		t.Fatalf("c status after undo: %s", status(3))
	}

	// add traffic: unlimited users stay unlimited; over-quota user becomes active
	m.db.Exec(`UPDATE users SET status='limited', used_up=60, used_down=60 WHERE id=1`)
	m.applyBatch(batchReq{IDs: []int64{1, 2}, Action: "add_traffic", Value: val(100)})
	if get(1).TrafficLimit != 200 || get(2).TrafficLimit != 0 || status(1) != "active" {
		t.Fatalf("add traffic: %+v %+v %s", get(1), get(2), status(1))
	}
	m.applyBatch(batchReq{IDs: []int64{1}, Action: "add_traffic", Value: val(-1000)})
	if get(1).TrafficLimit != 1 || status(1) != "limited" {
		t.Fatalf("negative add clamps at 1 byte: %+v %s", get(1), status(1))
	}

	m.applyBatch(batchReq{IDs: []int64{1, 2}, Action: "disable"})
	if get(1).Enabled || get(2).Enabled {
		t.Fatal("disable")
	}
	m.applyBatch(batchReq{IDs: []int64{1}, Action: "enable"})
	if !get(1).Enabled || get(2).Enabled {
		t.Fatal("enable only the selected user")
	}
	m.applyBatch(batchReq{IDs: []int64{1}, Action: "reset_usage"})
	if g := get(1); g.UsedUp != 0 || g.UsedDown != 0 {
		t.Fatal("reset usage")
	}

	m.db.Exec(`INSERT INTO groups(id, name, created_at) VALUES(7,'g7',0),(8,'g8',0)`)
	m.applyBatch(batchReq{IDs: []int64{1, 2}, Action: "set_groups", Value: val([]int64{7, 8})})
	var c int
	m.db.QueryRow(`SELECT COUNT(*) FROM user_groups WHERE user_id IN (1,2)`).Scan(&c)
	if c != 4 {
		t.Fatalf("set groups rows %d", c)
	}
	if n, _ := m.applyBatch(batchReq{IDs: []int64{2, 3, 999}, Action: "delete"}); n != 2 {
		t.Fatalf("delete affected %d", n)
	}
	m.db.QueryRow(`SELECT COUNT(*) FROM user_groups WHERE user_id=2`).Scan(&c)
	if c != 0 {
		t.Fatal("orphaned group rows")
	}
	for _, bad := range []batchReq{{IDs: nil, Action: "enable"}, {IDs: []int64{1}, Action: "explode"},
		{IDs: []int64{1}, Action: "extend_days", Value: val("x")}, {IDs: []int64{1}, Action: "set_groups", Value: val(5)}} {
		if _, err := m.applyBatch(bad); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}
