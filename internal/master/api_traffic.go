package master

import (
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"
)

type seriesOut struct {
	Key    string     `json:"key"`
	Label  string     `json:"label"`
	Up     int64      `json:"up"`
	Down   int64      `json:"down"`
	Points [][3]int64 `json:"points"` // [ts, up, down]
}

func (m *Master) labels() (users map[int64]string, nodes map[string]string) {
	users, nodes = map[int64]string{}, map[string]string{}
	rows, err := m.db.Query(`SELECT id, username FROM users`)
	if err == nil {
		for rows.Next() {
			var id int64
			var n string
			rows.Scan(&id, &n)
			users[id] = n
		}
		rows.Close()
	}
	rows, err = m.db.Query(`SELECT id, name FROM nodes`)
	if err == nil {
		for rows.Next() {
			var id, n string
			rows.Scan(&id, &n)
			nodes[id] = n
		}
		rows.Close()
	}
	return
}

func (m *Master) tzOffset() int64 {
	_, off := time.Now().In(m.loc).Zone()
	return int64(off)
}

type trafficFilter struct {
	from, to int64
	user     int64
	node     string
}

func (m *Master) filter(r *http.Request, defHours int64) trafficFilter {
	n := now()
	f := trafficFilter{from: qInt(r, "from", n-defHours*3600), to: qInt(r, "to", n+1), user: qInt(r, "user", 0), node: r.URL.Query().Get("node")}
	return f
}

func (f trafficFilter) where(tsFrom int64) (string, []any) {
	w := ` WHERE ts>=? AND ts<?`
	a := []any{tsFrom, f.to}
	if f.user > 0 {
		w += ` AND user_id=?`
		a = append(a, f.user)
	}
	if f.node != "" {
		w += ` AND node_id=?`
		a = append(a, f.node)
	}
	return w, a
}

func (m *Master) apiSeries(w http.ResponseWriter, r *http.Request) {
	f := m.filter(r, 24)
	step := qInt(r, "step", 300)
	switch step {
	case 60, 300, 900, 1800, 3600, 10800, 21600, 86400:
	default:
		writeErr(w, 400, "step must be 60/300/900/1800/3600/10800/21600/86400")
		return
	}
	if f.to <= f.from {
		writeErr(w, 400, "The end time must be after the start time")
		return
	}
	// minute data covers the retention window exactly; older ranges fall back to hours
	table := "traffic_minute"
	if f.from < m.minuteFloor() {
		table = "traffic_hour"
		if step < 3600 {
			step = 3600
		}
	}
	if (f.to-f.from)/step > 2000 {
		writeErr(w, 400, "Too many data points (max 2000); pick a coarser step")
		return
	}
	off := int64(0)
	if step == 86400 {
		off = m.tzOffset()
	}
	bucket := func(ts int64) int64 { return ((ts+off)/step)*step - off }

	group := r.URL.Query().Get("group")
	keyExpr := `''`
	switch group {
	case "user":
		keyExpr = `CAST(user_id AS TEXT)`
	case "node":
		keyExpr = `node_id`
	case "inbound":
		keyExpr = `node_id||'/'||inbound`
	case "outbound":
		keyExpr = `outbound`
	case "", "total":
		group = "total"
	default:
		writeErr(w, 400, "bad group")
		return
	}
	// rows are filtered at the table's own precision; buckets only group them
	rowFrom := f.from - f.from%60
	if table == "traffic_hour" {
		rowFrom = f.from - f.from%3600
	}
	where, args := f.where(rowFrom)
	rows, err := m.db.Query(`SELECT ts, `+keyExpr+`, SUM(up), SUM(down) FROM `+table+where+` GROUP BY ts, 2`, args...)
	if errf(w, err) {
		return
	}
	acc := map[string]map[int64][2]int64{}
	tot := map[string][2]int64{}
	for rows.Next() {
		var ts, up, down int64
		var key string
		rows.Scan(&ts, &key, &up, &down)
		b := bucket(ts)
		if acc[key] == nil {
			acc[key] = map[int64][2]int64{}
		}
		v := acc[key][b]
		acc[key][b] = [2]int64{v[0] + up, v[1] + down}
		t := tot[key]
		tot[key] = [2]int64{t[0] + up, t[1] + down}
	}
	rows.Close()

	keys := make([]string, 0, len(acc))
	for k := range acc {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := tot[keys[i]], tot[keys[j]]
		return a[0]+a[1] > b[0]+b[1]
	})
	const maxSeries = 8
	if len(keys) > maxSeries {
		other := map[int64][2]int64{}
		var ot [2]int64
		for _, k := range keys[maxSeries-1:] {
			for b, v := range acc[k] {
				o := other[b]
				other[b] = [2]int64{o[0] + v[0], o[1] + v[1]}
			}
			ot[0] += tot[k][0]
			ot[1] += tot[k][1]
		}
		keys = append(keys[:maxSeries-1], "(other)")
		acc["(other)"], tot["(other)"] = other, ot
	}
	users, nodes := m.labels()
	label := func(k string) string {
		switch group {
		case "user":
			id, _ := strconv.ParseInt(k, 10, 64)
			if n, ok := users[id]; ok {
				return n
			}
			if id == 0 {
				return "(unknown)"
			}
			return "#" + k
		case "node":
			if n, ok := nodes[k]; ok {
				return n
			}
		case "inbound":
			if i := strings.IndexByte(k, '/'); i > 0 {
				if n, ok := nodes[k[:i]]; ok {
					return n + " / " + k[i+1:]
				}
			}
		case "total":
			return "total"
		}
		return k
	}
	start := bucket(f.from)
	out := []seriesOut{}
	for _, k := range keys {
		s := seriesOut{Key: k, Label: label(k), Up: tot[k][0], Down: tot[k][1]}
		for b := start; b < f.to; b += step {
			v := acc[k][b]
			s.Points = append(s.Points, [3]int64{b, v[0], v[1]})
		}
		out = append(out, s)
	}
	writeJSON(w, 200, map[string]any{"step": step, "from": start, "to": f.to, "group": group, "series": out})
}

type topRow struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Up    int64  `json:"up"`
	Down  int64  `json:"down"`
	Conns int64  `json:"conns"`
	Users int64  `json:"users"`
}

func registrable(host string) string {
	if host == "" || net.ParseIP(host) != nil {
		return host
	}
	if d, err := publicsuffix.EffectiveTLDPlusOne(host); err == nil {
		return d
	}
	return host
}

func (m *Master) top(f trafficFilter, dim string, limit int) ([]topRow, error) {
	exact := map[string]string{"user": "CAST(user_id AS TEXT)", "node": "node_id", "inbound": "node_id||'/'||inbound", "outbound": "outbound"}
	dims := map[string]string{"host": "host", "domain": "host", "src_ip": "src_ip", "port": "CAST(port AS TEXT)", "rule": "rule", "network": "network"}
	var q string
	var args []any
	if e, ok := exact[dim]; ok {
		table, from := "traffic_minute", f.from-f.from%60
		if f.from < m.minuteFloor() {
			table, from = "traffic_hour", f.from-f.from%3600
		}
		w, a := f.where(from)
		q = `SELECT ` + e + `, SUM(up), SUM(down), SUM(conns), COUNT(DISTINCT user_id) FROM ` + table + w + ` GROUP BY 1`
		args = a
	} else if e, ok := dims[dim]; ok {
		table, from := "dim_5m", f.from-f.from%300
		if f.from < m.minuteFloor() {
			table, from = "dim_hour", f.from-f.from%3600
		}
		w, a := f.where(from)
		q = `SELECT ` + e + `, SUM(up), SUM(down), SUM(conns), COUNT(DISTINCT user_id) FROM ` + table + w + ` GROUP BY 1`
		args = a
	} else {
		return nil, errBadDim
	}
	rows, err := m.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	merged := map[string]*topRow{}
	for rows.Next() {
		var x topRow
		rows.Scan(&x.Key, &x.Up, &x.Down, &x.Conns, &x.Users)
		k := x.Key
		if dim == "domain" {
			k = registrable(k)
		}
		if t, ok := merged[k]; ok {
			t.Up += x.Up
			t.Down += x.Down
			t.Conns += x.Conns
			if x.Users > t.Users {
				t.Users = x.Users
			}
		} else {
			x.Key = k
			merged[k] = &x
		}
	}
	rows.Close()
	out := make([]topRow, 0, len(merged))
	for _, v := range merged {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Up+out[i].Down > out[j].Up+out[j].Down })
	if len(out) > limit {
		out = out[:limit]
	}
	users, nodes := m.labels()
	for i := range out {
		x := &out[i]
		x.Label = x.Key
		switch dim {
		case "user":
			id, _ := strconv.ParseInt(x.Key, 10, 64)
			if n, ok := users[id]; ok {
				x.Label = n
			} else if id == 0 {
				x.Label = "(unknown)"
			}
		case "node":
			if n, ok := nodes[x.Key]; ok {
				x.Label = n
			}
		case "inbound":
			if i := strings.IndexByte(x.Key, '/'); i > 0 {
				if n, ok := nodes[x.Key[:i]]; ok {
					x.Label = n + " / " + x.Key[i+1:]
				}
			}
		}
		if x.Label == "" {
			x.Label = "(none)"
		}
	}
	return out, nil
}

type apiError string

func (e apiError) Error() string { return string(e) }

const errBadDim = apiError("bad dim")

// minuteFloor is the oldest timestamp still covered by minute / 5-minute tables.
func (m *Master) minuteFloor() int64 {
	return now() - int64(m.cfg.KeepMinuteDays)*86400 + 3600
}

// topPrecision tells the client how exact the breakdown for a dimension is.
func (m *Master) topPrecision(f trafficFilter, dim string) string {
	switch dim {
	case "user", "node", "inbound", "outbound":
		if f.from < m.minuteFloor() {
			return "1h"
		}
		return "1m"
	}
	if f.from < m.minuteFloor() {
		return "1h"
	}
	return "5m"
}

func (m *Master) apiTop(w http.ResponseWriter, r *http.Request) {
	f := m.filter(r, 24)
	w.Header().Set("X-Precision", m.topPrecision(f, r.URL.Query().Get("dim")))
	w.Header().Set("Access-Control-Expose-Headers", "X-Precision")
	limit := int(qInt(r, "limit", 50))
	if limit < 1 || limit > 1000 {
		limit = 50
	}
	out, err := m.top(f, r.URL.Query().Get("dim"), limit)
	if err == errBadDim {
		writeErr(w, 400, "dim must be one of user,node,inbound,outbound,host,domain,src_ip,port,rule,network")
		return
	}
	if errf(w, err) {
		return
	}
	writeJSON(w, 200, out)
}

func (m *Master) apiOnline(w http.ResponseWriter, r *http.Request) {
	users, nodes := m.labels()
	type row struct {
		UserID int64  `json:"user_id"`
		User   string `json:"user"`
		IP     string `json:"ip"`
		NodeID string `json:"node_id"`
		Node   string `json:"node"`
	}
	out := []row{}
	for uid, ips := range m.onlineIPs() {
		for ip, node := range ips {
			out = append(out, row{uid, users[uid], ip, node, nodes[node]})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].User != out[j].User {
			return out[i].User < out[j].User
		}
		return out[i].IP < out[j].IP
	})
	writeJSON(w, 200, out)
}

func (m *Master) apiOverview(w http.ResponseWriter, r *http.Request) {
	t := time.Now()
	today, month := m.dayStart(t), m.monthStart(t, 1)
	var o struct {
		TodayUp     int64         `json:"today_up"`
		TodayDown   int64         `json:"today_down"`
		MonthUp     int64         `json:"month_up"`
		MonthDown   int64         `json:"month_down"`
		RateUp      int64         `json:"rate_up"`
		RateDown    int64         `json:"rate_down"`
		Conns       int64         `json:"active_conns"`
		Users       int64         `json:"users"`
		ActiveUsers int64         `json:"active_users"`
		OnlineUsers int           `json:"online_users"`
		OnlineIPs   int           `json:"online_ips"`
		NodesTotal  int           `json:"nodes_total"`
		NodesOnline int           `json:"nodes_online"`
		Nodes       []nodeOut     `json:"nodes"`
		TopUsers    []topRow      `json:"top_users"`
		TopDomains  []topRow      `json:"top_domains"`
		TopOutbound []topRow      `json:"top_outbounds"`
		Events      []interface{} `json:"-"`
	}
	m.db.QueryRow(`SELECT COALESCE(SUM(up),0), COALESCE(SUM(down),0) FROM traffic_hour WHERE ts>=?`, today).Scan(&o.TodayUp, &o.TodayDown)
	m.db.QueryRow(`SELECT COALESCE(SUM(up),0), COALESCE(SUM(down),0) FROM traffic_hour WHERE ts>=?`, month).Scan(&o.MonthUp, &o.MonthDown)
	m.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(status='active' AND enabled=1),0) FROM users`).Scan(&o.Users, &o.ActiveUsers)
	nodes, err := m.listNodes()
	if errf(w, err) {
		return
	}
	o.Nodes, o.NodesTotal = nodes, len(nodes)
	for _, n := range nodes {
		if n.Online {
			o.NodesOnline++
			o.RateUp += n.RateUp
			o.RateDown += n.RateDown
			o.Conns += n.ActiveConns
		}
	}
	on := m.onlineIPs()
	o.OnlineUsers = len(on)
	for _, ips := range on {
		o.OnlineIPs += len(ips)
	}
	f := trafficFilter{from: t.Unix() - 86400, to: t.Unix() + 1}
	o.TopUsers, _ = m.top(f, "user", 8)
	o.TopDomains, _ = m.top(f, "domain", 10)
	o.TopOutbound, _ = m.top(f, "outbound", 6)
	writeJSON(w, 200, o)
}
