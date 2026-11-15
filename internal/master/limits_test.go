package master

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"sbpanel/internal/pb"
)

// limitsFixture: node n1 with inbounds "home-a", "home-b" (one home line through two
// relays) and "main"; users 1 and 2 reach all three through one group.
func limitsFixture(t *testing.T) (m *Master, homeA, homeB, main int64) {
	t.Helper()
	m = newTestMaster(t)
	seedNode(t, m, "n1")
	mk := func(tag string, port int) int64 {
		r, err := m.db.Exec(`INSERT INTO inbounds(node_id, tag, type, port, options_json, created_at) VALUES('n1',?,?,?,?,?)`,
			tag, "trojan", port, `{"listen_port":`+itoa(port)+`}`, now())
		if err != nil {
			t.Fatal(err)
		}
		id, _ := r.LastInsertId()
		return id
	}
	homeA, homeB, main = mk("home-a", 2001), mk("home-b", 2002), mk("main", 2003)
	m.db.Exec(`INSERT INTO groups(id, name, created_at) VALUES(10,'all',0)`)
	m.db.Exec(`INSERT INTO group_inbounds VALUES(10,?),(10,?),(10,?)`, homeA, homeB, main)
	m.db.Exec(`INSERT INTO users(id, username, sub_token, uuid, password, traffic_limit, created_at) VALUES
		(1,'alice','tok1','11111111-1111-4111-8111-111111111111','p1',0,0),(2,'bob','tok2','22222222-2222-4222-8222-222222222222','p2',0,0)`)
	m.db.Exec(`INSERT INTO user_groups VALUES(1,10),(2,10)`)
	return
}

var limitSeq uint64

func report(t *testing.T, m *Master, ws int64, stats ...*pb.UserStat) {
	t.Helper()
	limitSeq++
	if _, err := m.ingest("n1", &pb.TrafficReport{Seq: limitSeq, WindowStart: ws, Users: stats}); err != nil {
		t.Fatal(err)
	}
}

func stat(user, inbound string, up, down int64) *pb.UserStat {
	return &pb.UserStat{User: user, Inbound: inbound, Outbound: "direct", Up: up, Down: down, Conns: 1}
}

func hcall(t *testing.T, h http.HandlerFunc, method, path string, body any, pv ...string) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	for i := 0; i+1 < len(pv); i += 2 {
		r.SetPathValue(pv[i], pv[i+1])
	}
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func specUsers(t *testing.T, m *Master, tag string) []string {
	t.Helper()
	spec, err := buildSpec(m.db, "n1")
	if err != nil {
		t.Fatal(err)
	}
	for _, in := range spec.Inbounds {
		if in.Tag == tag {
			return in.UserNames
		}
	}
	t.Fatalf("no inbound %s", tag)
	return nil
}

func TestTrafficLimitLifecycle(t *testing.T) {
	m, homeA, homeB, _ := limitsFixture(t)
	ws := time.Now().Unix()

	// traffic before the limit exists is backfilled into it
	report(t, m, ws, stat("1", "home-a", 10, 290), stat("1", "main", 0, 5000))
	w := hcall(t, m.apiCreateLimit, "POST", "/api/limits", map[string]any{"name": "Home", "traffic_limit": 1000, "inbound_ids": []int64{homeA, homeB}})
	if w.Code != 200 {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	var created struct{ ID int64 }
	json.Unmarshal(w.Body.Bytes(), &created)
	// a preset limits nobody until it is attached; usage is counted anyway
	if len(m.userLimits(1)) != 0 {
		t.Fatal("unattached preset listed for user")
	}
	hcall(t, m.apiSetUserLimit, "PUT", "/", map[string]any{"attach": true}, "id", "1", "rule", itoa(int(created.ID)))
	lim := func(uid int64) userLimit {
		for _, l := range m.userLimits(uid) {
			if l.ID == created.ID {
				return l
			}
		}
		t.Fatalf("user %d has no limit %d", uid, created.ID)
		return userLimit{}
	}
	if l := lim(1); l.Used != 300 || l.TrafficLimit != 1000 || l.Exhausted {
		t.Fatalf("backfilled: %+v", l)
	}

	// both relays of the line count towards it; "main" does not
	report(t, m, ws, stat("1", "home-b", 0, 600), stat("1", "main", 0, 10_000))
	if l := lim(1); l.Used != 900 || l.Exhausted {
		t.Fatalf("after relay b: %+v", l)
	}
	if got := specUsers(t, m, "home-a"); !slices.Equal(got, []string{"1", "2"}) {
		t.Fatalf("still allowed: %v", got)
	}
	// bob has no preset: unlimited however much he uses
	report(t, m, ws, stat("2", "home-a", 0, 5000))
	if got := specUsers(t, m, "home-a"); !slices.Equal(got, []string{"1", "2"}) {
		t.Fatalf("unattached user limited: %v", got)
	}
	// crossing the limit drops the user from the line's inbounds only, and records an event
	report(t, m, ws, stat("1", "home-a", 0, 200))
	if l := lim(1); !l.Exhausted || l.Used != 1100 {
		t.Fatalf("exhausted: %+v", l)
	}
	for _, tag := range []string{"home-a", "home-b"} {
		if got := specUsers(t, m, tag); !slices.Equal(got, []string{"2"}) {
			t.Fatalf("%s users: %v", tag, got)
		}
	}
	if got := specUsers(t, m, "main"); !slices.Equal(got, []string{"1", "2"}) {
		t.Fatalf("main must stay open: %v", got)
	}
	var st string
	m.db.QueryRow(`SELECT status FROM users WHERE id=1`).Scan(&st)
	if st != "active" {
		t.Fatalf("a line limit must not limit the whole user: %s", st)
	}
	var events int
	m.db.QueryRow(`SELECT COUNT(*) FROM events WHERE kind='limit_exceeded' AND user_id=1`).Scan(&events)
	if events != 1 {
		t.Fatalf("events: %d", events)
	}
	// more traffic over the limit (in flight) does not repeat the event
	report(t, m, ws, stat("1", "home-a", 0, 50))
	m.db.QueryRow(`SELECT COUNT(*) FROM events WHERE kind='limit_exceeded' AND user_id=1`).Scan(&events)
	if events != 1 {
		t.Fatalf("event repeated: %d", events)
	}

	// per-inbound usage for the user drawer
	use := map[string]int64{}
	for _, x := range m.userInboundUsage(1) {
		use[x.Tag] = x.Up + x.Down
		if (x.Tag == "main") == x.Blocked {
			t.Fatalf("blocked flag on %s: %v", x.Tag, x.Blocked)
		}
	}
	if use["home-a"] != 550 || use["home-b"] != 600 || use["main"] != 15_000 {
		t.Fatalf("inbound usage: %v", use)
	}

	// a custom size for this user: raise it -> back on the line
	w = hcall(t, m.apiSetUserLimit, "PUT", "/", map[string]any{"attach": true, "traffic_limit": 5000}, "id", "1", "rule", itoa(int(created.ID)))
	if w.Code != 200 {
		t.Fatalf("override: %d %s", w.Code, w.Body)
	}
	if l := lim(1); l.Exhausted || !l.Override || l.TrafficLimit != 5000 || l.Default != 1000 {
		t.Fatalf("override: %+v", l)
	}
	if got := specUsers(t, m, "home-a"); !slices.Equal(got, []string{"1", "2"}) {
		t.Fatalf("override reopens: %v", got)
	}
	// taken off: no limit, line open whatever the usage
	hcall(t, m.apiSetUserLimit, "PUT", "/", map[string]any{"attach": false}, "id", "1", "rule", itoa(int(created.ID)))
	report(t, m, ws, stat("1", "home-a", 0, 1<<30))
	if len(m.userLimits(1)) != 0 || len(m.blockedInbounds(1)) != 0 {
		t.Fatal("detached preset still applies")
	}
	// re-attached at the preset's size -> closed again (the usage was counted meanwhile)
	hcall(t, m.apiUpdateUser, "PATCH", "/", map[string]any{"limits": []map[string]any{{"id": created.ID}}}, "id", "1")
	if l := lim(1); !l.Exhausted || l.Override {
		t.Fatalf("back to preset size: %+v", l)
	}

	// subscription: the closed line is hidden from configs, listed on the page as used up
	u, err := m.loadSubUser("tok1")
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/s/tok1?format=json", nil)
	r.SetPathValue("token", "tok1")
	w = httptest.NewRecorder()
	m.handleSub(w, r)
	var page subPageData
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err, w.Body.String())
	}
	if len(page.Nodes) != 1 || !strings.Contains(page.Nodes[0].Name, "main") {
		t.Fatalf("page nodes: %+v", page.Nodes)
	}
	if len(page.Usage) != 3 || !page.Usage[0].Exhausted || page.Usage[0].Used < 1<<30 {
		t.Fatalf("page usage: %+v", page.Usage)
	}
	if len(page.Limits) != 1 || !page.Limits[0].Exhausted || len(page.Limits[0].Lines) != 2 {
		t.Fatalf("page limits: %+v", page.Limits)
	}
	r = httptest.NewRequest("GET", "/s/tok1", nil)
	r.Header.Set("User-Agent", "v2rayN/6")
	r.SetPathValue("token", "tok1")
	w = httptest.NewRecorder()
	m.handleSub(w, r)
	if links := w.Body.String(); links == "" {
		t.Fatal("empty subscription")
	}
	_ = u

	// resetting the user's usage (user-cycle limit) reopens the line
	hcall(t, m.apiUpdateUser, "PATCH", "/", map[string]any{"reset_usage": true}, "id", "1")
	if l := lim(1); l.Used != 0 || l.Exhausted {
		t.Fatalf("after reset: %+v", l)
	}
	if len(m.userInboundUsage(1)) != 3 || m.userInboundUsage(1)[0].Up+m.userInboundUsage(1)[0].Down != 0 {
		t.Fatalf("inbound usage after reset: %+v", m.userInboundUsage(1))
	}
	if got := specUsers(t, m, "home-a"); !slices.Equal(got, []string{"1", "2"}) {
		t.Fatalf("reset reopens: %v", got)
	}

	// listing
	var list []limitRule
	json.Unmarshal(hcall(t, m.apiLimits, "GET", "/api/limits", nil).Body.Bytes(), &list)
	if len(list) != 1 || list[0].Users != 1 || !slices.Equal(list[0].InboundIDs, []int64{homeA, homeB}) {
		t.Fatalf("list: %+v", list)
	}
	// batch attach; disabling a limit lifts it
	if _, err := m.applyBatch(batchReq{IDs: []int64{2}, Action: "set_limit", Value: json.RawMessage(`{"rule_id":` + itoa(int(created.ID)) + `,"attach":true}`)}); err != nil {
		t.Fatal(err)
	}
	report(t, m, ws, stat("2", "home-b", 0, 2000))
	if got := specUsers(t, m, "home-b"); !slices.Equal(got, []string{"1"}) {
		t.Fatalf("bob over: %v", got)
	}
	hcall(t, m.apiUpdateLimit, "PATCH", "/", map[string]any{"enabled": false}, "id", itoa(int(created.ID)))
	if got := specUsers(t, m, "home-b"); !slices.Equal(got, []string{"1", "2"}) {
		t.Fatalf("disabled limit still applies: %v", got)
	}
	// deleting cleans up
	hcall(t, m.apiDeleteLimit, "DELETE", "/", nil, "id", itoa(int(created.ID)))
	var n int
	m.db.QueryRow(`SELECT (SELECT COUNT(*) FROM rule_usage)+(SELECT COUNT(*) FROM traffic_rule_inbounds)+(SELECT COUNT(*) FROM user_rule_limits)`).Scan(&n)
	if n != 0 {
		t.Fatalf("leftovers: %d", n)
	}
}

// Calendar-month limits count from their reset day, independently of the user's cycle,
// and give closed lines back when the month turns.
func TestTrafficLimitMonthPeriod(t *testing.T) {
	m, homeA, _, _ := limitsFixture(t)
	nowT := time.Now()
	start := m.monthStart(nowT, 1)
	// last month's traffic must not count; this month's (already recorded) must
	m.db.Exec(`INSERT INTO traffic_hour(ts, node_id, user_id, inbound, outbound, up, down, conns) VALUES(?,?,?,?,?,?,?,1),(?,?,?,?,?,?,?,1)`,
		start-7200, "n1", 1, "home-a", "direct", 0, 700, start, "n1", 1, "home-a", "direct", 0, 400)
	w := hcall(t, m.apiCreateLimit, "POST", "/", map[string]any{"name": "Home", "traffic_limit": 1000, "period": "month", "reset_day": 1, "inbound_ids": []int64{homeA}})
	if w.Code != 200 {
		t.Fatalf("create: %s", w.Body)
	}
	var id int64
	m.db.QueryRow(`SELECT id FROM traffic_rules`).Scan(&id)
	if err := attachLimit(m.db, 1, id, true, 0); err != nil {
		t.Fatal(err)
	}
	if l := m.userLimits(1)[0]; l.Used != 400 || l.NextReset != m.nextMonthReset(start) {
		t.Fatalf("month backfill: %+v", l)
	}
	report(t, m, nowT.Unix(), stat("1", "home-a", 0, 700))
	if got := specUsers(t, m, "home-a"); !slices.Equal(got, []string{"2"}) {
		t.Fatalf("closed: %v", got)
	}
	// users: attached only
	var lu []struct {
		UserID    int64 `json:"user_id"`
		Exhausted bool  `json:"exhausted"`
	}
	json.Unmarshal(hcall(t, m.apiLimitUsers, "GET", "/", nil, "id", itoa(int(id))).Body.Bytes(), &lu)
	if len(lu) != 1 || lu[0].UserID != 1 || !lu[0].Exhausted {
		t.Fatalf("limit users: %+v", lu)
	}
	// the user's own reset does not touch a calendar-month limit
	resetUserLimits(m.db, 1)
	if l := m.userLimits(1)[0]; l.Used != 1100 {
		t.Fatalf("user reset touched month limit: %+v", l)
	}
	// next month
	m.refreshLimitPeriods(time.Unix(m.nextMonthReset(start)+3600, 0))
	if l := m.userLimits(1)[0]; l.Used != 0 || l.Exhausted {
		t.Fatalf("new month: %+v", l)
	}
	if got := specUsers(t, m, "home-a"); !slices.Equal(got, []string{"1", "2"}) {
		t.Fatalf("new month reopens: %v", got)
	}
	// invalid input
	for _, body := range []map[string]any{
		{"name": "", "traffic_limit": 1},
		{"name": "x", "traffic_limit": 0},
		{"name": "x", "traffic_limit": 1, "period": "week"},
		{"name": "x", "traffic_limit": 1, "period": "month", "reset_day": 31},
	} {
		if w := hcall(t, m.apiCreateLimit, "POST", "/", body); w.Code != 400 {
			t.Fatalf("%v accepted: %d", body, w.Code)
		}
	}
}

// Deleting an inbound or a user drops their limit rows; the v10 migration backfills
// per-inbound usage from hourly traffic since the user's last reset.
func TestTrafficLimitCleanupAndMigration(t *testing.T) {
	m, homeA, _, _ := limitsFixture(t)
	hcall(t, m.apiCreateLimit, "POST", "/", map[string]any{"name": "Home", "traffic_limit": 10, "inbound_ids": []int64{homeA}})
	attachLimit(m.db, 2, 1, true, 0)
	report(t, m, time.Now().Unix(), stat("2", "home-a", 0, 50))
	hcall(t, m.apiDeleteUser, "DELETE", "/", nil, "id", "2")
	var n int
	m.db.QueryRow(`SELECT (SELECT COUNT(*) FROM rule_usage WHERE user_id=2)+(SELECT COUNT(*) FROM inbound_usage WHERE user_id=2)`).Scan(&n)
	if n != 0 {
		t.Fatalf("user rows left: %d", n)
	}
	hcall(t, m.apiDeleteInbound, "DELETE", "/", nil, "id", itoa(int(homeA)))
	m.db.QueryRow(`SELECT COUNT(*) FROM traffic_rule_inbounds`).Scan(&n)
	if n != 0 {
		t.Fatalf("rule inbounds left: %d", n)
	}

	// migration backfill (re-run the v10 statement's INSERT on fresh data)
	m2, a2, _, main2 := limitsFixture(t)
	h := now() - now()%3600
	m2.db.Exec(`UPDATE users SET last_reset_at=? WHERE id=1`, h)
	m2.db.Exec(`INSERT INTO traffic_hour(ts, node_id, user_id, inbound, outbound, up, down, conns) VALUES
		(?, 'n1', 1, 'home-a', 'direct', 1, 2, 1), (?, 'n1', 1, 'main', 'direct', 3, 4, 1), (?, 'n1', 1, 'main', 'direct', 100, 100, 1)`, h, h, h-7200)
	v10 := migrations[len(migrations)-1]
	ins := v10[strings.Index(v10, "INSERT INTO inbound_usage"):]
	if _, err := m2.db.Exec(ins); err != nil {
		t.Fatal(err)
	}
	got := map[int64]int64{}
	for _, x := range m2.userInboundUsage(1) {
		got[x.InboundID] = x.Up + x.Down
	}
	if got[a2] != 3 || got[main2] != 7 {
		t.Fatalf("migration backfill: %v", got)
	}
}
