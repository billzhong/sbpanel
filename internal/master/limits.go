package master

// Traffic limits: presets of an extra quota on a set of inbounds (e.g. "home lines, 50 GB a
// month" over every relay reaching them) that admins attach to individual users. Users
// without one have no such limit. A user over an attached limit is taken off its inbounds
// only (the spec drops them, the node closes their connections there, subscriptions hide
// the entries); everything else keeps working. Limits reset with the user's own cycle or on
// a fixed day of the month. user_rule_limits holds the attachments: traffic_limit 0 means
// the preset's size (so editing the preset applies to everyone on it), > 0 a custom size.
//
// Counters are exact like the total: ingest updates inbound_usage and rule_usage in the
// report's transaction. A limit created or edited later is backfilled (inbound_usage for
// the user cycle, traffic_hour for calendar months).

import (
	"database/sql"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	periodUser  = "user"  // with the user's reset cycle (and manual resets)
	periodMonth = "month" // monthly on reset_day, whatever the user's cycle
)

type limitRule struct {
	ID           int64   `json:"id"`
	Name         string  `json:"name"`
	Note         string  `json:"note"`
	TrafficLimit int64   `json:"traffic_limit"` // per attached user and period
	Period       string  `json:"period"`
	ResetDay     int     `json:"reset_day"`
	Enabled      bool    `json:"enabled"`
	InboundIDs   []int64 `json:"inbound_ids"`
	CreatedAt    int64   `json:"created_at"`
	// computed
	PeriodStart int64 `json:"period_start"` // month limits; 0 = each user's own cycle
	NextReset   int64 `json:"next_reset"`   // month limits
	Users       int   `json:"users"`        // users it is attached to
	Limited     int   `json:"limited"`      // of those, how many are over it now
	Used        int64 `json:"used"`         // attached users, this period
	Overrides   int   `json:"overrides"`    // attached with a custom size
	curPeriod   int64
}

// effLimit is the size in effect for an attachment (ul) of a preset (r).
const effLimit = `(CASE WHEN ul.traffic_limit>0 THEN ul.traffic_limit ELSE r.traffic_limit END)`

// limitedUsersSQL selects the users a limit has closed an inbound (?) for.
const limitedUsersSQL = `SELECT ru.user_id FROM rule_usage ru
	JOIN traffic_rules r ON r.id=ru.rule_id AND ru.period=r.cur_period
	JOIN traffic_rule_inbounds ri ON ri.rule_id=r.id
	JOIN user_rule_limits ul ON ul.rule_id=r.id AND ul.user_id=ru.user_id
	WHERE ri.inbound_id=? AND r.enabled=1 AND ru.up+ru.down>=` + effLimit

// blockedInbounds lists the inbounds a limit has closed for one user.
func (m *Master) blockedInbounds(uid int64) map[int64]bool {
	out := map[int64]bool{}
	rows, err := m.db.Query(`SELECT DISTINCT ri.inbound_id FROM rule_usage ru
		JOIN traffic_rules r ON r.id=ru.rule_id AND ru.period=r.cur_period
		JOIN traffic_rule_inbounds ri ON ri.rule_id=r.id
		JOIN user_rule_limits ul ON ul.rule_id=r.id AND ul.user_id=ru.user_id
		WHERE ru.user_id=? AND r.enabled=1 AND ru.up+ru.down>=`+effLimit, uid)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		out[id] = true
	}
	return out
}

func (m *Master) rulePeriod(period string, resetDay int, t time.Time) int64 {
	if period == periodMonth {
		return m.monthStart(t, resetDay)
	}
	return 0
}

func (m *Master) nextMonthReset(start int64) int64 {
	return time.Unix(start, 0).In(m.loc).AddDate(0, 1, 0).Unix()
}

// ---------- counting (called from ingest, inside the report's transaction) ----------

type limitKey struct {
	uid int64
	tag string
}

type limitCross struct {
	uid         int64
	rule        string
	used, limit int64
}

// countLimits adds one report's per-user, per-inbound bytes to inbound_usage and to the
// limits covering those inbounds. It returns the limits that this report pushed over.
func (m *Master) countLimits(tx *sql.Tx, nodeID string, ws int64, deltas map[limitKey]*[2]int64) ([]limitCross, error) {
	if len(deltas) == 0 {
		return nil, nil
	}
	ids := map[string]int64{}
	rows, err := tx.Query(`SELECT tag, id FROM inbounds WHERE node_id=?`, nodeID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var tag string
		var id int64
		rows.Scan(&tag, &id)
		ids[tag] = id
	}
	rows.Close()
	type rule struct {
		id, limit int64
		name      string
		period    string
		day       int
	}
	covering := map[int64][]*rule{}
	byID := map[int64]*rule{}
	rows, err = tx.Query(`SELECT ri.inbound_id, r.id, r.name, r.traffic_limit, r.period, r.reset_day FROM traffic_rule_inbounds ri
		JOIN traffic_rules r ON r.id=ri.rule_id JOIN inbounds i ON i.id=ri.inbound_id WHERE i.node_id=? AND r.enabled=1`, nodeID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var in int64
		x := &rule{}
		rows.Scan(&in, &x.id, &x.name, &x.limit, &x.period, &x.day)
		if byID[x.id] == nil {
			byID[x.id] = x
		}
		covering[in] = append(covering[in], byID[x.id])
	}
	rows.Close()

	type ru struct{ rule, uid int64 }
	perRule := map[ru]*[2]int64{}
	keys := make([]limitKey, 0, len(deltas))
	for k := range deltas {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { // fixed order: deterministic writes
		if keys[i].uid != keys[j].uid {
			return keys[i].uid < keys[j].uid
		}
		return keys[i].tag < keys[j].tag
	})
	for _, k := range keys {
		d := deltas[k]
		in, ok := ids[k.tag]
		if !ok || k.uid <= 0 {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO inbound_usage(user_id, inbound_id, up, down) VALUES(?,?,?,?)
			ON CONFLICT(user_id, inbound_id) DO UPDATE SET up=up+excluded.up, down=down+excluded.down`, k.uid, in, d[0], d[1]); err != nil {
			return nil, err
		}
		for _, r := range covering[in] {
			a := perRule[ru{r.id, k.uid}]
			if a == nil {
				a = &[2]int64{}
				perRule[ru{r.id, k.uid}] = a
			}
			a[0] += d[0]
			a[1] += d[1]
		}
	}
	var crossed []limitCross
	t := time.Unix(ws, 0)
	for k, d := range perRule {
		r := byID[k.rule]
		var total int64
		if err := tx.QueryRow(`INSERT INTO rule_usage(rule_id, user_id, period, up, down) VALUES(?,?,?,?,?)
			ON CONFLICT(rule_id, user_id, period) DO UPDATE SET up=up+excluded.up, down=down+excluded.down
			RETURNING up+down`, r.id, k.uid, m.rulePeriod(r.period, r.day, t), d[0], d[1]).Scan(&total); err != nil {
			return nil, err
		}
		var own int64
		if tx.QueryRow(`SELECT traffic_limit FROM user_rule_limits WHERE user_id=? AND rule_id=?`, k.uid, r.id).Scan(&own) != nil {
			continue // counted (so attaching it later starts from the real number) but not limited
		}
		limit := r.limit
		if own > 0 {
			limit = own
		}
		if limit > 0 && total >= limit && total-d[0]-d[1] < limit {
			crossed = append(crossed, limitCross{k.uid, r.name, total, limit})
		}
	}
	return crossed, nil
}

// limitsCrossed records and enforces limits a report pushed over.
func (m *Master) limitsCrossed(cs []limitCross) {
	if len(cs) == 0 {
		return
	}
	for _, c := range cs {
		addEvent(m.db, "limit_exceeded", c.uid, "", fmt.Sprintf("%s (%s / %s)", c.rule, fmtBytesGo(c.used), fmtBytesGo(c.limit)))
	}
	m.reconcile() // the node closes their connections on the inbounds they lose
}

// resetUserLimits clears the per-inbound counters and the user-cycle limits of users whose
// usage was just reset. ex runs inside the caller's transaction when it has one.
func resetUserLimits(ex execer, ids ...int64) error {
	for _, id := range ids {
		if _, err := ex.Exec(`DELETE FROM inbound_usage WHERE user_id=?`, id); err != nil {
			return err
		}
		if _, err := ex.Exec(`DELETE FROM rule_usage WHERE user_id=? AND rule_id IN (SELECT id FROM traffic_rules WHERE period=?)`, id, periodUser); err != nil {
			return err
		}
	}
	return nil
}

// refreshLimitPeriods moves calendar-month limits into their current period. Users the
// old period had closed get their inbounds back. Called from the policy loop.
func (m *Master) refreshLimitPeriods(t time.Time) {
	type r struct {
		id, cur int64
		day     int
	}
	rs, _ := scanRows(m, `SELECT id, cur_period, reset_day FROM traffic_rules WHERE period=?`, []any{periodMonth},
		func(s func(...any) error) (r, error) {
			var x r
			return x, s(&x.id, &x.cur, &x.day)
		})
	changed := false
	for _, x := range rs {
		p := m.monthStart(t, x.day)
		if p == x.cur {
			continue
		}
		m.db.Exec(`UPDATE traffic_rules SET cur_period=? WHERE id=?`, p, x.id)
		m.db.Exec(`DELETE FROM rule_usage WHERE rule_id=? AND period<?`, x.id, p)
		changed = true
	}
	if changed {
		m.reconcile()
	}
}

// backfillLimit recomputes a limit's usage for its current period from what is already
// counted, so a limit added mid-period starts from the right number.
func (m *Master) backfillLimit(tx *sql.Tx, id int64) error {
	var period string
	var cur int64
	if err := tx.QueryRow(`SELECT period, cur_period FROM traffic_rules WHERE id=?`, id).Scan(&period, &cur); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM rule_usage WHERE rule_id=?`, id); err != nil {
		return err
	}
	if period == periodMonth {
		// traffic_hour rows are keyed by node + tag; hour buckets start on the hour, as
		// month periods (local midnight) do in whole-hour time zones
		_, err := tx.Exec(`INSERT INTO rule_usage(rule_id, user_id, period, up, down)
			SELECT ?, t.user_id, ?, SUM(t.up), SUM(t.down) FROM traffic_hour t
			JOIN inbounds i ON i.node_id=t.node_id AND i.tag=t.inbound
			JOIN traffic_rule_inbounds ri ON ri.inbound_id=i.id AND ri.rule_id=?
			WHERE t.ts>=? AND t.user_id>0 GROUP BY t.user_id`, id, cur, id, cur)
		return err
	}
	_, err := tx.Exec(`INSERT INTO rule_usage(rule_id, user_id, period, up, down)
		SELECT ?, iu.user_id, 0, SUM(iu.up), SUM(iu.down) FROM inbound_usage iu
		JOIN traffic_rule_inbounds ri ON ri.inbound_id=iu.inbound_id AND ri.rule_id=?
		GROUP BY iu.user_id`, id, id)
	return err
}

// ---------- API ----------

func (m *Master) loadLimits(where string, args ...any) ([]limitRule, error) {
	rs, err := scanRows(m, `SELECT id, name, note, traffic_limit, period, reset_day, enabled, created_at, cur_period FROM traffic_rules`+where+` ORDER BY id`, args,
		func(s func(...any) error) (limitRule, error) {
			var x limitRule
			err := s(&x.ID, &x.Name, &x.Note, &x.TrafficLimit, &x.Period, &x.ResetDay, &x.Enabled, &x.CreatedAt, &x.curPeriod)
			return x, err
		})
	if err != nil {
		return nil, err
	}
	for i := range rs {
		x := &rs[i]
		x.InboundIDs = []int64{}
		ids, _ := scanRows(m, `SELECT inbound_id FROM traffic_rule_inbounds WHERE rule_id=? ORDER BY inbound_id`, []any{x.ID}, scanID)
		x.InboundIDs = append(x.InboundIDs, ids...)
		if x.Period == periodMonth {
			x.PeriodStart = x.curPeriod
			x.NextReset = m.nextMonthReset(x.curPeriod)
		}
		m.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(traffic_limit>0),0) FROM user_rule_limits WHERE rule_id=?`, x.ID).Scan(&x.Users, &x.Overrides)
		m.db.QueryRow(`SELECT COALESCE(SUM(ru.up+ru.down),0) FROM rule_usage ru JOIN user_rule_limits ul ON ul.rule_id=ru.rule_id AND ul.user_id=ru.user_id
			WHERE ru.rule_id=? AND ru.period=?`, x.ID, x.curPeriod).Scan(&x.Used)
		m.db.QueryRow(`SELECT COUNT(*) FROM rule_usage ru JOIN user_rule_limits ul ON ul.rule_id=ru.rule_id AND ul.user_id=ru.user_id
			JOIN traffic_rules r ON r.id=ru.rule_id WHERE ru.rule_id=? AND ru.period=? AND ru.up+ru.down>=`+effLimit,
			x.ID, x.curPeriod).Scan(&x.Limited)
		if !x.Enabled {
			x.Limited = 0
		}
	}
	return rs, nil
}

func scanID(s func(...any) error) (int64, error) {
	var id int64
	return id, s(&id)
}

func (m *Master) apiLimits(w http.ResponseWriter, r *http.Request) {
	rs, err := m.loadLimits("")
	if errf(w, err) {
		return
	}
	if rs == nil {
		rs = []limitRule{}
	}
	writeJSON(w, 200, rs)
}

type limitReq struct {
	Name         *string  `json:"name"`
	Note         *string  `json:"note"`
	TrafficLimit *int64   `json:"traffic_limit"`
	Period       *string  `json:"period"`
	ResetDay     *int     `json:"reset_day"`
	Enabled      *bool    `json:"enabled"`
	InboundIDs   *[]int64 `json:"inbound_ids"`
}

func (q *limitReq) check(creating bool) error {
	if creating && (q.Name == nil || q.TrafficLimit == nil) {
		return fmt.Errorf("name and traffic_limit are required")
	}
	if q.Name != nil && strings.TrimSpace(*q.Name) == "" {
		return fmt.Errorf("Name is required")
	}
	if q.TrafficLimit != nil && *q.TrafficLimit <= 0 {
		return fmt.Errorf("Traffic limit must be greater than 0")
	}
	if q.Period != nil && *q.Period != periodUser && *q.Period != periodMonth {
		return fmt.Errorf("Period must be user or month")
	}
	if q.ResetDay != nil && (*q.ResetDay < 1 || *q.ResetDay > 28) {
		return fmt.Errorf("Reset day must be between 1 and 28")
	}
	return nil
}

func (m *Master) apiCreateLimit(w http.ResponseWriter, r *http.Request) {
	var q limitReq
	if err := readJSON(r, &q); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if err := q.check(true); err != nil {
		writeErr(w, 400, L(reqLang(r), err.Error()))
		return
	}
	period, day := periodUser, 1
	if q.Period != nil {
		period = *q.Period
	}
	if q.ResetDay != nil {
		day = *q.ResetDay
	}
	enabled := q.Enabled == nil || *q.Enabled
	note := ""
	if q.Note != nil {
		note = *q.Note
	}
	tx, err := m.db.Begin()
	if errf(w, err) {
		return
	}
	defer tx.Rollback()
	res, err := tx.Exec(`INSERT INTO traffic_rules(name, note, traffic_limit, period, reset_day, cur_period, enabled, created_at) VALUES(?,?,?,?,?,?,?,?)`,
		strings.TrimSpace(*q.Name), note, *q.TrafficLimit, period, day, m.rulePeriod(period, day, time.Now()), enabled, now())
	if errf(w, err) {
		return
	}
	id, _ := res.LastInsertId()
	if q.InboundIDs != nil {
		if errf(w, setLimitInbounds(tx, id, *q.InboundIDs)) {
			return
		}
	}
	if errf(w, m.backfillLimit(tx, id)) || errf(w, tx.Commit()) {
		return
	}
	m.audit(r, "limit.create", fmtID(id), *q.Name)
	m.reconcile()
	writeJSON(w, 200, map[string]int64{"id": id})
}

func setLimitInbounds(tx *sql.Tx, id int64, ids []int64) error {
	if _, err := tx.Exec(`DELETE FROM traffic_rule_inbounds WHERE rule_id=?`, id); err != nil {
		return err
	}
	for _, in := range ids {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO traffic_rule_inbounds(rule_id, inbound_id) SELECT ?, id FROM inbounds WHERE id=?`, id, in); err != nil {
			return err
		}
	}
	return nil
}

func (m *Master) apiUpdateLimit(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var q limitReq
	if err := readJSON(r, &q); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if err := q.check(false); err != nil {
		writeErr(w, 400, L(reqLang(r), err.Error()))
		return
	}
	tx, err := m.db.Begin()
	if errf(w, err) {
		return
	}
	defer tx.Rollback()
	var period string
	var day int
	if err := tx.QueryRow(`SELECT period, reset_day FROM traffic_rules WHERE id=?`, id).Scan(&period, &day); err != nil {
		writeErr(w, 404, T(reqLang(r), "Traffic limit not found"))
		return
	}
	set := func(col string, v any) {
		if err == nil {
			_, err = tx.Exec(`UPDATE traffic_rules SET `+col+`=? WHERE id=?`, v, id)
		}
	}
	recount := false
	if q.Name != nil {
		set("name", strings.TrimSpace(*q.Name))
	}
	if q.Note != nil {
		set("note", *q.Note)
	}
	if q.TrafficLimit != nil {
		set("traffic_limit", *q.TrafficLimit)
	}
	if q.Enabled != nil {
		set("enabled", *q.Enabled)
	}
	if q.Period != nil && *q.Period != period {
		period, recount = *q.Period, true
		set("period", period)
	}
	if q.ResetDay != nil && *q.ResetDay != day {
		day, recount = *q.ResetDay, recount || period == periodMonth
		set("reset_day", day)
	}
	if recount {
		set("cur_period", m.rulePeriod(period, day, time.Now()))
	}
	if q.InboundIDs != nil && err == nil {
		err, recount = setLimitInbounds(tx, id, *q.InboundIDs), true
	}
	if err == nil && recount {
		err = m.backfillLimit(tx, id)
	}
	if errf(w, err) || errf(w, tx.Commit()) {
		return
	}
	m.audit(r, "limit.update", fmtID(id), "")
	m.reconcile()
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiDeleteLimit(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	for _, t := range []string{"traffic_rule_inbounds", "user_rule_limits", "rule_usage"} {
		m.db.Exec(`DELETE FROM `+t+` WHERE rule_id=?`, id)
	}
	m.db.Exec(`DELETE FROM traffic_rules WHERE id=?`, id)
	m.audit(r, "limit.delete", fmtID(id), "")
	m.reconcile()
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// PUT /api/users/{id}/limits/{rule}: {"attach": true, "traffic_limit": bytes} attaches the
// preset to the user (traffic_limit 0 or absent = the preset's size), {"attach": false}
// takes it off; "reset_usage": true clears the user's usage of it for the current period.
func (m *Master) apiSetUserLimit(w http.ResponseWriter, r *http.Request) {
	uid, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	rid, err := strconv.ParseInt(r.PathValue("rule"), 10, 64)
	if err != nil {
		writeErr(w, 400, "bad limit id")
		return
	}
	var q struct {
		Attach       *bool  `json:"attach"`
		TrafficLimit *int64 `json:"traffic_limit"`
		ResetUsage   bool   `json:"reset_usage"`
	}
	if err := readJSON(r, &q); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var n int
	m.db.QueryRow(`SELECT (SELECT COUNT(*) FROM users WHERE id=?) + (SELECT COUNT(*) FROM traffic_rules WHERE id=?)`, uid, rid).Scan(&n)
	if n != 2 {
		writeErr(w, 404, T(reqLang(r), "Traffic limit not found"))
		return
	}
	if q.TrafficLimit != nil && *q.TrafficLimit < 0 {
		writeErr(w, 400, T(reqLang(r), "Traffic limit must not be negative"))
		return
	}
	if q.Attach != nil || q.TrafficLimit != nil {
		attach := q.Attach == nil || *q.Attach
		size := int64(0)
		if q.TrafficLimit != nil {
			size = *q.TrafficLimit
		}
		if err := attachLimit(m.db, uid, rid, attach, size); errf(w, err) {
			return
		}
	}
	if q.ResetUsage {
		m.db.Exec(`DELETE FROM rule_usage WHERE user_id=? AND rule_id=?`, uid, rid)
	}
	m.audit(r, "user.limit", fmtID(uid), fmt.Sprintf("limit %d", rid))
	m.reconcile()
	writeJSON(w, 200, map[string]bool{"ok": true})
}

type execer interface {
	Exec(string, ...any) (sql.Result, error)
}

// attachLimit attaches a preset to a user (size 0 = the preset's size) or takes it off.
func attachLimit(ex execer, uid, rid int64, attach bool, size int64) error {
	if !attach {
		_, err := ex.Exec(`DELETE FROM user_rule_limits WHERE user_id=? AND rule_id=?`, uid, rid)
		return err
	}
	_, err := ex.Exec(`INSERT INTO user_rule_limits(user_id, rule_id, traffic_limit) SELECT ?, id, ? FROM traffic_rules WHERE id=?
		ON CONFLICT(user_id, rule_id) DO UPDATE SET traffic_limit=excluded.traffic_limit`, uid, size, rid)
	return err
}

// userLimitSet is one preset in a user's create / update request.
type userLimitSet struct {
	ID           int64 `json:"id"`
	TrafficLimit int64 `json:"traffic_limit"` // 0 = the preset's size
}

// setUserLimits replaces the presets attached to a user.
func setUserLimits(ex execer, uid int64, ls []userLimitSet) error {
	if _, err := ex.Exec(`DELETE FROM user_rule_limits WHERE user_id=?`, uid); err != nil {
		return err
	}
	for _, l := range ls {
		if l.TrafficLimit < 0 {
			return fmt.Errorf("Traffic limit must not be negative")
		}
		if err := attachLimit(ex, uid, l.ID, true, l.TrafficLimit); err != nil {
			return err
		}
	}
	return nil
}

// GET /api/limits/{id}/users: the users a preset is attached to, with usage this period.
func (m *Master) apiLimitUsers(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	rs, err := m.loadLimits(` WHERE id=?`, id)
	if errf(w, err) {
		return
	}
	if len(rs) == 0 {
		writeErr(w, 404, T(reqLang(r), "Traffic limit not found"))
		return
	}
	x := rs[0]
	type row struct {
		UserID       int64  `json:"user_id"`
		Username     string `json:"username"`
		Enabled      bool   `json:"enabled"`
		TrafficLimit int64  `json:"traffic_limit"` // in effect
		Override     bool   `json:"override"`      // custom size
		Up           int64  `json:"up"`
		Down         int64  `json:"down"`
		Used         int64  `json:"used"`
		Exhausted    bool   `json:"exhausted"`
		Reaches      bool   `json:"reaches"` // can use at least one of its inbounds
	}
	out, err := scanRows(m, `SELECT u.id, u.username, u.enabled, ul.traffic_limit>0, CASE WHEN ul.traffic_limit>0 THEN ul.traffic_limit ELSE ? END,
		COALESCE(ru.up,0), COALESCE(ru.down,0),
		EXISTS(SELECT 1 FROM user_groups ug JOIN group_inbounds gi ON gi.group_id=ug.group_id JOIN traffic_rule_inbounds ri ON ri.inbound_id=gi.inbound_id
			WHERE ug.user_id=u.id AND ri.rule_id=?)
		FROM users u JOIN user_rule_limits ul ON ul.user_id=u.id AND ul.rule_id=?
		LEFT JOIN rule_usage ru ON ru.user_id=u.id AND ru.rule_id=? AND ru.period=?
		ORDER BY COALESCE(ru.up,0)+COALESCE(ru.down,0) DESC, u.id`, []any{x.TrafficLimit, id, id, id, x.curPeriod},
		func(s func(...any) error) (row, error) {
			var r row
			err := s(&r.UserID, &r.Username, &r.Enabled, &r.Override, &r.TrafficLimit, &r.Up, &r.Down, &r.Reaches)
			r.Used = r.Up + r.Down
			r.Exhausted = x.Enabled && r.TrafficLimit > 0 && r.Used >= r.TrafficLimit
			return r, err
		})
	if errf(w, err) {
		return
	}
	if out == nil {
		out = []row{}
	}
	writeJSON(w, 200, out)
}

// ---------- per-user view (user drawer, subscription page) ----------

type userLimit struct {
	ID           int64   `json:"id"`
	Name         string  `json:"name"`
	TrafficLimit int64   `json:"traffic_limit"` // in effect for this user
	Default      int64   `json:"default_limit"` // the preset's size
	Override     bool    `json:"override"`      // custom size
	Up           int64   `json:"up"`
	Down         int64   `json:"down"`
	Used         int64   `json:"used"`
	Exhausted    bool    `json:"exhausted"`
	Period       string  `json:"period"`
	NextReset    int64   `json:"next_reset"` // 0 = with the user's cycle (see the user's reset)
	InboundIDs   []int64 `json:"inbound_ids"`
}

type inboundUse struct {
	InboundID int64  `json:"inbound_id"`
	Node      string `json:"node"`
	Tag       string `json:"tag"`
	Remark    string `json:"remark"`
	Type      string `json:"type"`
	Up        int64  `json:"up"`
	Down      int64  `json:"down"`
	Blocked   bool   `json:"blocked"`
}

// userLimits lists the enabled presets attached to the user.
func (m *Master) userLimits(uid int64) []userLimit {
	rs, _ := m.loadLimits(` WHERE enabled=1 AND id IN (SELECT rule_id FROM user_rule_limits WHERE user_id=?)`, uid)
	out := []userLimit{}
	for _, x := range rs {
		ul := userLimit{ID: x.ID, Name: x.Name, TrafficLimit: x.TrafficLimit, Default: x.TrafficLimit, Period: x.Period,
			NextReset: x.NextReset, InboundIDs: x.InboundIDs}
		var own int64
		m.db.QueryRow(`SELECT traffic_limit FROM user_rule_limits WHERE user_id=? AND rule_id=?`, uid, x.ID).Scan(&own)
		if own > 0 {
			ul.TrafficLimit, ul.Override = own, true
		}
		m.db.QueryRow(`SELECT up, down FROM rule_usage WHERE rule_id=? AND user_id=? AND period=?`, x.ID, uid, x.curPeriod).Scan(&ul.Up, &ul.Down)
		ul.Used = ul.Up + ul.Down
		ul.Exhausted = ul.TrafficLimit > 0 && ul.Used >= ul.TrafficLimit
		out = append(out, ul)
	}
	return out
}

// userInboundUsage is this cycle's usage per inbound the user can reach or has used.
func (m *Master) userInboundUsage(uid int64) []inboundUse {
	blocked := m.blockedInbounds(uid)
	rows, _ := scanRows(m, `SELECT i.id, COALESCE(n.name, i.node_id), i.tag, i.remark, i.type, COALESCE(iu.up,0), COALESCE(iu.down,0)
		FROM inbounds i LEFT JOIN nodes n ON n.id=i.node_id
		LEFT JOIN inbound_usage iu ON iu.inbound_id=i.id AND iu.user_id=?
		WHERE i.options_json NOT LIKE '%"_static":true%' AND (iu.user_id IS NOT NULL OR i.id IN (SELECT gi.inbound_id FROM group_inbounds gi JOIN user_groups ug ON ug.group_id=gi.group_id WHERE ug.user_id=?))
		ORDER BY COALESCE(iu.up,0)+COALESCE(iu.down,0) DESC, n.created_at, i.sort, i.port`, []any{uid, uid},
		func(s func(...any) error) (inboundUse, error) {
			var x inboundUse
			err := s(&x.InboundID, &x.Node, &x.Tag, &x.Remark, &x.Type, &x.Up, &x.Down)
			x.Blocked = blocked[x.InboundID]
			return x, err
		})
	if rows == nil {
		rows = []inboundUse{}
	}
	return rows
}

type userLimitIndex struct {
	sets map[int64][]userLimitSet
	out  map[int64]int
}

// allUserLimits is every user's attached presets and how many are used up (user list).
func (m *Master) allUserLimits() userLimitIndex {
	x := userLimitIndex{sets: map[int64][]userLimitSet{}, out: map[int64]int{}}
	if rows, err := m.db.Query(`SELECT user_id, rule_id, traffic_limit FROM user_rule_limits ORDER BY rule_id`); err == nil {
		for rows.Next() {
			var uid int64
			var l userLimitSet
			rows.Scan(&uid, &l.ID, &l.TrafficLimit)
			x.sets[uid] = append(x.sets[uid], l)
		}
		rows.Close()
	}
	if rows, err := m.db.Query(`SELECT ru.user_id, COUNT(*) FROM rule_usage ru
		JOIN traffic_rules r ON r.id=ru.rule_id AND ru.period=r.cur_period AND r.enabled=1
		JOIN user_rule_limits ul ON ul.rule_id=r.id AND ul.user_id=ru.user_id
		WHERE ru.up+ru.down>=` + effLimit + ` GROUP BY ru.user_id`); err == nil {
		for rows.Next() {
			var uid int64
			var n int
			rows.Scan(&uid, &n)
			x.out[uid] = n
		}
		rows.Close()
	}
	return x
}
