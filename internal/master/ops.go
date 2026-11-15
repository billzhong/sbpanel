package master

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"sbpanel/internal/pb"
)

// ---------- usage reset cycles ----------

// periodStart is the beginning of the current billing period for a strategy.
func periodStart(strategy string, created, t time.Time, loc *time.Location) (time.Time, bool) {
	t = t.In(loc)
	day := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
	switch strategy {
	case "day":
		return day, true
	case "week":
		wd := int(day.Weekday()+6) % 7 // Monday = 0
		return day.AddDate(0, 0, -wd), true
	case "month":
		return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, loc), true
	case "month_rolling":
		anchor := created.In(loc).Day()
		start := monthDay(t.Year(), t.Month(), anchor, loc)
		if start.After(t) {
			pm := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, loc).AddDate(0, -1, 0)
			start = monthDay(pm.Year(), pm.Month(), anchor, loc)
		}
		return start, true
	}
	return time.Time{}, false
}

// monthDay clamps the anchor day to the month length (Jan 31 -> Feb 28).
func monthDay(y int, mo time.Month, d int, loc *time.Location) time.Time {
	last := time.Date(y, mo+1, 0, 0, 0, 0, 0, loc).Day()
	if d > last {
		d = last
	}
	return time.Date(y, mo, d, 0, 0, 0, 0, loc)
}

func (m *Master) resetUsage(t time.Time) {
	type u struct {
		id, created, last int64
		strategy, status  string
	}
	us, _ := scanRows(m, `SELECT id, created_at, last_reset_at, reset_strategy, status FROM users WHERE reset_strategy NOT IN ('none','')`, nil,
		func(s func(...any) error) (u, error) {
			var x u
			return x, s(&x.id, &x.created, &x.last, &x.strategy, &x.status)
		})
	changed := false
	for _, x := range us {
		start, ok := periodStart(x.strategy, time.Unix(x.created, 0), t, m.loc)
		if !ok || x.last >= start.Unix() {
			continue
		}
		m.db.Exec(`UPDATE users SET used_up=0, used_down=0, last_reset_at=? WHERE id=?`, t.Unix(), x.id)
		addEvent(m.db, "usage_reset", x.id, "", x.strategy)
		if x.status == "limited" {
			m.recomputeStatus(x.id)
			changed = true
		}
	}
	if changed {
		m.reconcile()
	}
}

// ---------- node quota alerts ----------

func (m *Master) checkNodeQuota(t time.Time) {
	type n struct {
		id, name          string
		limit, day, level int64
	}
	ns, _ := scanRows(m, `SELECT id, name, traffic_limit, reset_day, notified_quota FROM nodes WHERE traffic_limit>0`, nil,
		func(s func(...any) error) (n, error) {
			var x n
			return x, s(&x.id, &x.name, &x.limit, &x.day, &x.level)
		})
	for _, x := range ns {
		var used int64
		m.db.QueryRow(`SELECT COALESCE(SUM(up+down),0) FROM traffic_hour WHERE node_id=? AND ts>=?`, x.id, m.monthStart(t, int(x.day))).Scan(&used)
		pct := used * 100 / x.limit
		level := int64(0)
		switch {
		case pct >= 100:
			level = 100
		case pct >= 80:
			level = 80
		}
		if level > x.level {
			addEvent(m.db, "node_quota", 0, x.id, fmt.Sprintf("%d%% (%s / %s)", pct, fmtBytesGo(used), fmtBytesGo(x.limit)))
		}
		if level != x.level {
			m.db.Exec(`UPDATE nodes SET notified_quota=? WHERE id=?`, level, x.id)
		}
	}
}

// ---------- device limits across nodes ----------

// enforceDevices keeps each user's distinct online IPs (all nodes) within the limit.
func (m *Master) enforceDevices() {
	limits := map[int64]int{}
	rows, err := m.db.Query(`SELECT id, device_limit FROM users WHERE device_limit>0`)
	if err != nil {
		return
	}
	for rows.Next() {
		var id int64
		var l int
		rows.Scan(&id, &l)
		limits[id] = l
	}
	rows.Close()
	if len(limits) == 0 {
		return
	}
	policy := settingOr(m.db, "device_policy", "reject")
	for uid, ips := range m.onlineIPs() {
		limit, ok := limits[uid]
		if !ok || len(ips) <= limit {
			continue
		}
		type seen struct {
			ip, node string
			first    int64
		}
		var ss []seen
		for ip, node := range ips {
			var f int64
			m.db.QueryRow(`SELECT MIN(first_seen) FROM online_ip WHERE user_id=? AND ip=?`, uid, ip).Scan(&f)
			ss = append(ss, seen{ip, node, f})
		}
		// reject: the earliest devices keep access; kick_oldest: the newest do
		sort.Slice(ss, func(i, j int) bool {
			if policy == "kick_oldest" {
				return ss[i].first > ss[j].first
			}
			return ss[i].first < ss[j].first
		})
		byNode := map[string][]string{}
		for _, s := range ss[limit:] {
			byNode[s.node] = append(byNode[s.node], s.ip)
		}
		for node, ips := range byNode {
			if s := m.hub.session(node); s != nil {
				m.hub.trySend(s, &pb.MasterMsg{M: &pb.MasterMsg_KickIps{KickIps: &pb.KickIPs{User: strconv.FormatInt(uid, 10), Ips: ips}}})
			}
			m.eventOnce("device_limit", uid, node, strings.Join(ips, ","), 10*time.Minute)
		}
	}
}

var (
	onceMu   sync.Mutex
	onceSeen = map[string]time.Time{}
)

// eventOnce records an event at most once per window for the same key.
func (m *Master) eventOnce(kind string, uid int64, node, detail string, window time.Duration) {
	k := fmt.Sprintf("%s|%d|%s|%s", kind, uid, node, detail)
	onceMu.Lock()
	if t, ok := onceSeen[k]; ok && time.Since(t) < window {
		onceMu.Unlock()
		return
	}
	onceSeen[k] = time.Now()
	onceMu.Unlock()
	addEvent(m.db, kind, uid, node, detail)
}

// ---------- notifications ----------

var eventHook func(kind string, userID int64, nodeID, detail string)

var eventText = map[string]string{
	"node_offline": "🔴 节点离线", "node_online": "🟢 节点恢复", "quota_exceeded": "⚠️ 用户流量用尽", "user_expired": "⌛ 用户到期",
	"users_expired": "⌛ 用户到期", "node_quota": "📈 节点月流量告警", "apply_failed": "❗ 节点配置下发失败", "device_limit": "📱 设备数超限",
	"node_enrolled": "🆕 节点接入", "usage_reset": "🔄 用量已重置", "user_reactivated": "✅ 用户恢复",
	"cert_renewed": "🔐 证书已续期", "cert_renew_failed": "❗ 证书续期失败", "cert_expiring": "⏳ 证书即将过期",
	"inbound_unreachable": "🔴 入站不可达", "inbound_recovered": "🟢 入站恢复",
}

func (m *Master) onEvent(kind string, userID int64, nodeID, detail string) {
	enabled := settingOr(m.db, "notify_events", publicSettings["notify_events"])
	if !strings.Contains(","+enabled+",", ","+kind+",") {
		return
	}
	go func() {
		if kind == "node_offline" {
			// ignore restarts and short blips
			time.Sleep(60 * time.Second)
			if m.hub.session(nodeID) != nil {
				return
			}
		}
		m.sendNotify(m.formatEvent(kind, userID, nodeID, detail))
	}()
}

func (m *Master) formatEvent(kind string, userID int64, nodeID, detail string) string {
	title := eventText[kind]
	if title == "" {
		title = kind
	}
	var parts []string
	if nodeID != "" {
		var n string
		m.db.QueryRow(`SELECT name FROM nodes WHERE id=?`, nodeID).Scan(&n)
		parts = append(parts, "节点："+nz(n, nodeID))
	}
	if userID > 0 {
		var u string
		m.db.QueryRow(`SELECT username FROM users WHERE id=?`, userID).Scan(&u)
		parts = append(parts, "用户："+nz(u, fmtID(userID)))
	}
	if detail != "" {
		parts = append(parts, detail)
	}
	return settingOr(m.db, "sub_title", "sbpanel") + " · " + title + "\n" + strings.Join(parts, "\n")
}

var notifyClient = &http.Client{Timeout: 15 * time.Second}

func (m *Master) sendNotify(text string) error {
	var errs []string
	tok := settingOr(m.db, "tg_token", "")
	chat := settingOr(m.db, "tg_chat", "")
	if tok != "" && chat != "" {
		resp, err := notifyClient.PostForm("https://api.telegram.org/bot"+tok+"/sendMessage", url.Values{"chat_id": {chat}, "text": {text}})
		if err != nil {
			errs = append(errs, "telegram: "+strings.ReplaceAll(err.Error(), tok, "***"))
		} else {
			if resp.StatusCode != 200 {
				b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
				errs = append(errs, fmt.Sprintf("telegram: HTTP %d %s", resp.StatusCode, b))
			}
			resp.Body.Close()
		}
	}
	if hook := settingOr(m.db, "webhook_url", ""); hook != "" {
		b, _ := json.Marshal(map[string]any{"text": text, "ts": now()})
		resp, err := notifyClient.Post(hook, "application/json", bytes.NewReader(b))
		if err != nil {
			errs = append(errs, "webhook: "+err.Error())
		} else {
			if resp.StatusCode >= 300 {
				errs = append(errs, fmt.Sprintf("webhook: HTTP %d", resp.StatusCode))
			}
			resp.Body.Close()
		}
	}
	if len(errs) > 0 {
		m.log.Printf("notify: %s", strings.Join(errs, "; "))
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

func (m *Master) apiNotifyTest(w http.ResponseWriter, r *http.Request) {
	if settingOr(m.db, "tg_token", "") == "" && settingOr(m.db, "webhook_url", "") == "" {
		writeErr(w, 400, "还没有配置 Telegram 或 Webhook")
		return
	}
	if err := m.sendNotify(settingOr(m.db, "sub_title", "sbpanel") + " · 测试通知\n通知渠道工作正常。"); err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---------- backup ----------

func (m *Master) apiBackup(w http.ResponseWriter, r *http.Request) {
	tmp := filepath.Join(m.cfg.DataDir, fmt.Sprintf("backup-%d.db", time.Now().UnixNano()))
	defer os.Remove(tmp)
	if _, err := m.db.Exec(`VACUUM INTO ?`, tmp); errf(w, err) {
		return
	}
	f, err := os.Open(tmp)
	if errf(w, err) {
		return
	}
	defer f.Close()
	m.audit(r, "backup.download", "", "")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=sbmaster-%s.db", time.Now().In(m.loc).Format("20060102-1504")))
	io.Copy(w, f)
}

// ---------- live connections ----------

func (m *Master) apiNodeConns(w http.ResponseWriter, r *http.Request) {
	s := m.hub.session(r.PathValue("id"))
	if s == nil {
		writeErr(w, 409, "节点离线")
		return
	}
	s.mu.Lock()
	wasWatching := time.Now().Before(s.watchUntil)
	s.watchUntil = time.Now().Add(15 * time.Second)
	snap := s.conns
	s.mu.Unlock()
	if !wasWatching {
		m.hub.trySend(s, &pb.MasterMsg{M: &pb.MasterMsg_Watch{Watch: &pb.Watch{On: true}}})
	}
	users, _ := m.labels()
	type conn struct {
		*pb.ConnInfo
		Username string `json:"username"`
	}
	out := []conn{}
	var total int64
	if snap != nil {
		total = snap.Total
		for _, c := range snap.Conns {
			if c.User == probeUser { // probe sightings are not part of total
				continue
			}
			out = append(out, conn{c, users[parseUserID(c.User)]})
		}
	}
	writeJSON(w, 200, map[string]any{"conns": out, "total": total, "ready": snap != nil})
}

func (m *Master) apiCloseConns(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []uint64 `json:"ids"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s := m.hub.session(r.PathValue("id"))
	if s == nil {
		writeErr(w, 409, "节点离线")
		return
	}
	m.hub.trySend(s, &pb.MasterMsg{M: &pb.MasterMsg_CloseConns{CloseConns: &pb.CloseConns{Ids: req.IDs}}})
	m.audit(r, "conn.close", r.PathValue("id"), fmt.Sprint(req.IDs))
	writeJSON(w, 200, map[string]bool{"ok": true})
}
