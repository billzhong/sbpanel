package master

import (
	"testing"
	"time"

	"sbpanel/internal/pb"
)

func TestServerUsage(t *testing.T) {
	m := newTestMaster(t)
	m.db.Exec(`INSERT INTO nodes(id, name, reset_day, traffic_limit, created_at) VALUES('n1','hk',1,1000,0)`)
	hb := func(rx, tx, uptime uint64) { m.recordWan("n1", &pb.SysInfo{WanRx: rx, WanTx: tx, Uptime: uptime}) }
	get := func() serverUsage { return m.serverUsage("n1", mode(m), 1, time.Now()) }

	hb(5000, 9000, 100) // baseline only: bytes before the first report are not this panel's to count
	if u := get(); !u.Tracked || u.Used != 0 {
		t.Fatalf("first report: %+v", u)
	}
	hb(5100, 9050, 110)
	if u := get(); u.Rx != 100 || u.Tx != 50 || u.Used != 150 {
		t.Fatalf("both: %+v", u)
	}
	m.db.Exec(`UPDATE nodes SET traffic_mode='out'`)
	if u := get(); u.Used != 50 {
		t.Fatalf("out: %+v", u)
	}
	m.db.Exec(`UPDATE nodes SET traffic_mode='max'`)
	if u := get(); u.Used != 100 {
		t.Fatalf("max: %+v", u)
	}
	m.db.Exec(`UPDATE nodes SET traffic_mode='both'`)

	// correction to the provider's figure, then counting continues from there
	if err := m.setServerUsed("n1", 400); err != nil {
		t.Fatal(err)
	}
	if u := get(); u.Used != 400 {
		t.Fatalf("corrected: %+v", u)
	}
	hb(5200, 9050, 120)
	if u := get(); u.Used != 500 {
		t.Fatalf("after correction: %+v", u)
	}

	// reboot: counters restart; the bytes since boot count
	time.Sleep(10 * time.Millisecond)
	hb(30, 20, 5) // boot time moved by ~115 s? use a counter drop as well
	if u := get(); u.Used != 550 {
		t.Fatalf("after reboot: %+v", u)
	}
	// limit crossing raises the node quota event
	m.setServerUsed("n1", 1200)
	m.checkNodeQuota(time.Now())
	var n int
	m.db.QueryRow(`SELECT COUNT(*) FROM events WHERE kind='node_quota'`).Scan(&n)
	if n != 1 {
		t.Fatalf("quota events = %d", n)
	}
}

func mode(m *Master) string {
	var s string
	m.db.QueryRow(`SELECT traffic_mode FROM nodes WHERE id='n1'`).Scan(&s)
	return s
}
