package master

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	"sbpanel/internal/pb"
)

// ---------- nodes ----------

type nodeOut struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Address         string          `json:"address"`
	Online          bool            `json:"online"`
	Enrolled        bool            `json:"enrolled"`
	Revision        uint64          `json:"revision"`
	AppliedRevision uint64          `json:"applied_revision"`
	ApplyError      string          `json:"apply_error"`
	LastSeen        int64           `json:"last_seen"`
	CertExpire      int64           `json:"cert_expire"`
	Info            json.RawMessage `json:"info"`
	TrafficLimit    int64           `json:"traffic_limit"`
	ResetDay        int64           `json:"reset_day"`
	Inbounds        int64           `json:"inbounds"`
	Sys             *pb.SysInfo     `json:"sys,omitempty"`
	RateUp          int64           `json:"rate_up"`
	RateDown        int64           `json:"rate_down"`
	ActiveConns     int64           `json:"active_conns"`
	SpoolBacklog    uint64          `json:"spool_backlog"`
	OnlineUsers     int             `json:"online_users"`
	MonthUp         int64           `json:"month_up"`
	MonthDown       int64           `json:"month_down"`
	TodayUp         int64           `json:"today_up"`
	TodayDown       int64           `json:"today_down"`
}

func (m *Master) dayStart(t time.Time) int64 {
	t = t.In(m.loc)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, m.loc).Unix()
}

func (m *Master) monthStart(t time.Time, resetDay int) int64 {
	t = t.In(m.loc)
	if resetDay < 1 || resetDay > 28 {
		resetDay = 1
	}
	s := time.Date(t.Year(), t.Month(), resetDay, 0, 0, 0, 0, m.loc)
	if s.After(t) {
		s = s.AddDate(0, -1, 0)
	}
	return s.Unix()
}

func (m *Master) listNodes() ([]nodeOut, error) {
	out, err := scanRows(m, `SELECT id, name, address, cert_serial<>'', revision, applied_revision, apply_error, last_seen,
		cert_expire, info_json, traffic_limit, reset_day, (SELECT COUNT(*) FROM inbounds i WHERE i.node_id=nodes.id)
		FROM nodes ORDER BY created_at`, nil, func(s func(...any) error) (nodeOut, error) {
		var n nodeOut
		var info string
		err := s(&n.ID, &n.Name, &n.Address, &n.Enrolled, &n.Revision, &n.AppliedRevision, &n.ApplyError, &n.LastSeen,
			&n.CertExpire, &info, &n.TrafficLimit, &n.ResetDay, &n.Inbounds)
		n.Info = json.RawMessage(info)
		return n, err
	})
	if err != nil {
		return nil, err
	}
	nowT := time.Now()
	today := m.dayStart(nowT)
	for i := range out {
		n := &out[i]
		if s := m.hub.session(n.ID); s != nil {
			_, hb, last, online := s.snapshot()
			n.Online = time.Since(last) < 35*time.Second || time.Since(s.connectedAt) < 35*time.Second
			if hb != nil {
				n.Sys, n.RateUp, n.RateDown, n.ActiveConns, n.SpoolBacklog = hb.Sys, hb.RateUp, hb.RateDown, hb.ActiveConns, hb.SpoolBacklog
			}
			n.OnlineUsers = len(online)
		}
		ms := m.monthStart(nowT, int(n.ResetDay))
		m.db.QueryRow(`SELECT COALESCE(SUM(up),0), COALESCE(SUM(down),0) FROM traffic_hour WHERE node_id=? AND ts>=?`, n.ID, ms).Scan(&n.MonthUp, &n.MonthDown)
		m.db.QueryRow(`SELECT COALESCE(SUM(up),0), COALESCE(SUM(down),0) FROM traffic_hour WHERE node_id=? AND ts>=?`, n.ID, today).Scan(&n.TodayUp, &n.TodayDown)
	}
	return out, nil
}

func (m *Master) apiNodes(w http.ResponseWriter, r *http.Request) {
	out, err := m.listNodes()
	if errf(w, err) {
		return
	}
	writeJSON(w, 200, out)
}

func (m *Master) enrollInfo(r *http.Request, nodeID string) (map[string]any, error) {
	token := randHex(16)
	exp := time.Now().Add(30 * time.Minute)
	if _, err := m.db.Exec(`INSERT INTO enroll_tokens(token_hash,node_id,expires_at) VALUES(?,?,?)`, hashToken(token), nodeID, exp.Unix()); err != nil {
		return nil, err
	}
	addr := m.cfg.PublicGRPCAddr
	if addr == "" {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		_, port, _ := net.SplitHostPort(m.cfg.GRPCListen)
		addr = net.JoinHostPort(host, port)
	}
	cmd := fmt.Sprintf("sbnode enroll --master %s --token %s --ca-sha256 %s", addr, token, m.CAFingerprint())
	return map[string]any{"node_id": nodeID, "token": token, "expires_at": exp.Unix(), "master": addr,
		"ca_sha256": m.CAFingerprint(), "command": cmd}, nil
}

func (m *Master) apiCreateNode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := readJSON(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		writeErr(w, 400, "name required")
		return
	}
	id := randHex(6)
	if _, err := m.db.Exec(`INSERT INTO nodes(id,name,skeleton_json,created_at) VALUES(?,?,?,?)`, id, strings.TrimSpace(req.Name), DefaultSkeleton, now()); errf(w, err) {
		return
	}
	info, err := m.enrollInfo(r, id)
	if errf(w, err) {
		return
	}
	m.reconcile(id)
	writeJSON(w, 200, info)
}

func (m *Master) apiNodeToken(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var x string
	if err := m.db.QueryRow(`SELECT id FROM nodes WHERE id=?`, id).Scan(&x); err != nil {
		writeErr(w, 404, "node not found")
		return
	}
	info, err := m.enrollInfo(r, id)
	if errf(w, err) {
		return
	}
	writeJSON(w, 200, info)
}

func (m *Master) apiUpdateNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		Name         *string          `json:"name"`
		Skeleton     *json.RawMessage `json:"skeleton"`
		TrafficLimit *int64           `json:"traffic_limit"`
		ResetDay     *int64           `json:"reset_day"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if req.Name != nil {
		m.db.Exec(`UPDATE nodes SET name=? WHERE id=?`, *req.Name, id)
	}
	if req.TrafficLimit != nil {
		m.db.Exec(`UPDATE nodes SET traffic_limit=? WHERE id=?`, *req.TrafficLimit, id)
	}
	if req.ResetDay != nil {
		m.db.Exec(`UPDATE nodes SET reset_day=? WHERE id=?`, *req.ResetDay, id)
	}
	if req.Skeleton != nil {
		var probe map[string]any
		if err := json.Unmarshal(*req.Skeleton, &probe); err != nil {
			writeErr(w, 400, "skeleton: "+err.Error())
			return
		}
		if _, ok := probe["inbounds"]; ok {
			writeErr(w, 400, "skeleton must not contain inbounds; manage them on the Inbounds page")
			return
		}
		m.db.Exec(`UPDATE nodes SET skeleton_json=? WHERE id=?`, string(*req.Skeleton), id)
		m.reconcile(id)
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiDeleteNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m.db.Exec(`DELETE FROM inbounds WHERE node_id=?`, id)
	m.db.Exec(`DELETE FROM enroll_tokens WHERE node_id=?`, id)
	m.db.Exec(`DELETE FROM nodes WHERE id=?`, id) // cert_serial gone => node certificate rejected
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiNodeSpec(w http.ResponseWriter, r *http.Request) {
	spec, err := m.loadSpec(r.PathValue("id"))
	if errf(w, err) {
		return
	}
	b, _ := protojson.Marshal(spec)
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

// ---------- inbounds ----------

type inboundOut struct {
	ID      int64           `json:"id"`
	NodeID  string          `json:"node_id"`
	Node    string          `json:"node"`
	Tag     string          `json:"tag"`
	Type    string          `json:"type"`
	Port    int64           `json:"port"`
	Options json.RawMessage `json:"options"`
	Client  json.RawMessage `json:"client"`
	Enabled bool            `json:"enabled"`
	Remark  string          `json:"remark"`
}

func (m *Master) apiInbounds(w http.ResponseWriter, r *http.Request) {
	q := `SELECT i.id, i.node_id, COALESCE(n.name,''), i.tag, i.type, i.port, i.options_json, i.client_json, i.enabled, i.remark
		FROM inbounds i LEFT JOIN nodes n ON n.id=i.node_id`
	var args []any
	if node := r.URL.Query().Get("node"); node != "" {
		q += ` WHERE i.node_id=?`
		args = append(args, node)
	}
	out, err := scanRows(m, q+` ORDER BY n.created_at, i.port`, args, func(s func(...any) error) (inboundOut, error) {
		var x inboundOut
		var o, c string
		err := s(&x.ID, &x.NodeID, &x.Node, &x.Tag, &x.Type, &x.Port, &o, &c, &x.Enabled, &x.Remark)
		x.Options, x.Client = json.RawMessage(o), json.RawMessage(c)
		return x, err
	})
	if errf(w, err) {
		return
	}
	writeJSON(w, 200, out)
}

var tagRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,48}$`)

var inboundTypes = map[string]bool{"vless": true, "vmess": true, "trojan": true, "shadowsocks": true,
	"hysteria2": true, "tuic": true, "anytls": true, "naive": true}

type inboundReq struct {
	NodeID  string          `json:"node_id"`
	Tag     string          `json:"tag"`
	Type    string          `json:"type"`
	Options json.RawMessage `json:"options"`
	Client  json.RawMessage `json:"client"`
	Enabled *bool           `json:"enabled"`
	Remark  string          `json:"remark"`
}

func (req *inboundReq) validate() (port int64, opts []byte, err error) {
	if !tagRe.MatchString(req.Tag) {
		return 0, nil, fmt.Errorf("tag must match %s", tagRe)
	}
	if !inboundTypes[req.Type] {
		return 0, nil, fmt.Errorf("unsupported inbound type %q", req.Type)
	}
	var o map[string]any
	if err := json.Unmarshal(req.Options, &o); err != nil {
		return 0, nil, fmt.Errorf("options: %w", err)
	}
	p, _ := o["listen_port"].(float64)
	if p < 1 || p > 65535 {
		return 0, nil, fmt.Errorf("options.listen_port required (1-65535)")
	}
	if _, ok := o["listen"]; !ok {
		o["listen"] = "::"
	}
	delete(o, "users")
	b, _ := json.Marshal(o)
	return int64(p), b, nil
}

func (m *Master) apiCreateInbound(w http.ResponseWriter, r *http.Request) {
	var req inboundReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	port, opts, err := req.validate()
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if len(req.Client) == 0 {
		req.Client = json.RawMessage("{}")
	}
	_, err = m.db.Exec(`INSERT INTO inbounds(node_id,tag,type,port,options_json,client_json,enabled,remark,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
		req.NodeID, req.Tag, req.Type, port, string(opts), string(req.Client), req.Enabled == nil || *req.Enabled, req.Remark, now())
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	m.reconcile(req.NodeID)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiUpdateInbound(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var cur inboundReq
	var curOpts, curClient string
	var enabled bool
	if err := m.db.QueryRow(`SELECT node_id, tag, type, options_json, client_json, enabled, remark FROM inbounds WHERE id=?`, id).
		Scan(&cur.NodeID, &cur.Tag, &cur.Type, &curOpts, &curClient, &enabled, &cur.Remark); err != nil {
		writeErr(w, 404, "inbound not found")
		return
	}
	cur.Options, cur.Client, cur.Enabled = json.RawMessage(curOpts), json.RawMessage(curClient), &enabled
	var req inboundReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if req.Tag != "" {
		cur.Tag = req.Tag
	}
	if req.Type != "" {
		cur.Type = req.Type
	}
	if len(req.Options) > 0 {
		cur.Options = req.Options
	}
	if len(req.Client) > 0 {
		cur.Client = req.Client
	}
	if req.Enabled != nil {
		cur.Enabled = req.Enabled
	}
	if req.Remark != "" {
		cur.Remark = req.Remark
	}
	port, opts, err := cur.validate()
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if _, err := m.db.Exec(`UPDATE inbounds SET tag=?, type=?, port=?, options_json=?, client_json=?, enabled=?, remark=? WHERE id=?`,
		cur.Tag, cur.Type, port, string(opts), string(cur.Client), *cur.Enabled, cur.Remark, id); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	m.reconcile(cur.NodeID)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiDeleteInbound(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var node string
	m.db.QueryRow(`SELECT node_id FROM inbounds WHERE id=?`, id).Scan(&node)
	m.db.Exec(`DELETE FROM inbounds WHERE id=?`, id)
	m.reconcile(node)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiRealityKeypair(w http.ResponseWriter, r *http.Request) {
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if errf(w, err) {
		return
	}
	sid := make([]byte, 8)
	rand.Read(sid)
	writeJSON(w, 200, map[string]string{
		"private_key": base64.RawURLEncoding.EncodeToString(k.Bytes()),
		"public_key":  base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes()),
		"short_id":    fmt.Sprintf("%x", sid),
	})
}

// ---------- users ----------

type userOut struct {
	ID            int64  `json:"id"`
	Username      string `json:"username"`
	SubToken      string `json:"sub_token"`
	UUID          string `json:"uuid"`
	Password      string `json:"password,omitempty"`
	Status        string `json:"status"`
	Enabled       bool   `json:"enabled"`
	TrafficLimit  int64  `json:"traffic_limit"`
	ExpireAt      int64  `json:"expire_at"`
	ResetStrategy string `json:"reset_strategy"`
	Note          string `json:"note"`
	UsedUp        int64  `json:"used_up"`
	UsedDown      int64  `json:"used_down"`
	LifeUp        int64  `json:"life_up"`
	LifeDown      int64  `json:"life_down"`
	CreatedAt     int64  `json:"created_at"`
	OnlineIPs     int    `json:"online_ips"`
}

const userCols = `id, username, sub_token, uuid, password, status, enabled, traffic_limit, expire_at, reset_strategy, note,
	used_up, used_down, life_up, life_down, created_at`

func scanUser(s func(...any) error) (userOut, error) {
	var u userOut
	err := s(&u.ID, &u.Username, &u.SubToken, &u.UUID, &u.Password, &u.Status, &u.Enabled, &u.TrafficLimit, &u.ExpireAt,
		&u.ResetStrategy, &u.Note, &u.UsedUp, &u.UsedDown, &u.LifeUp, &u.LifeDown, &u.CreatedAt)
	return u, err
}

// onlineIPs merges live per-node snapshots into user id -> distinct ips.
func (m *Master) onlineIPs() map[int64]map[string]string {
	out := map[int64]map[string]string{}
	m.hub.mu.Lock()
	sessions := make([]*session, 0, len(m.hub.sessions))
	for _, s := range m.hub.sessions {
		sessions = append(sessions, s)
	}
	m.hub.mu.Unlock()
	for _, s := range sessions {
		_, _, _, online := s.snapshot()
		for _, u := range online {
			id := parseUserID(u.User)
			if out[id] == nil {
				out[id] = map[string]string{}
			}
			for _, ip := range u.Ips {
				out[id][ip] = s.nodeID
			}
		}
	}
	return out
}

func (m *Master) apiUsers(w http.ResponseWriter, r *http.Request) {
	out, err := scanRows(m, `SELECT `+userCols+` FROM users ORDER BY id`, nil, scanUser)
	if errf(w, err) {
		return
	}
	on := m.onlineIPs()
	for i := range out {
		out[i].OnlineIPs = len(on[out[i].ID])
		out[i].Password = ""
	}
	writeJSON(w, 200, out)
}

func (m *Master) apiUser(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	us, err := scanRows(m, `SELECT `+userCols+` FROM users WHERE id=?`, []any{id}, scanUser)
	if errf(w, err) {
		return
	}
	if len(us) == 0 {
		writeErr(w, 404, "user not found")
		return
	}
	type ipRow struct {
		IP        string `json:"ip"`
		NodeID    string `json:"node_id"`
		Node      string `json:"node"`
		FirstSeen int64  `json:"first_seen"`
		LastSeen  int64  `json:"last_seen"`
		Online    bool   `json:"online"`
	}
	ips, _ := scanRows(m, `SELECT o.ip, o.node_id, COALESCE(n.name,''), o.first_seen, o.last_seen FROM online_ip o
		LEFT JOIN nodes n ON n.id=o.node_id WHERE o.user_id=? ORDER BY o.last_seen DESC LIMIT 100`, []any{id},
		func(s func(...any) error) (ipRow, error) {
			var x ipRow
			return x, s(&x.IP, &x.NodeID, &x.Node, &x.FirstSeen, &x.LastSeen)
		})
	live := m.onlineIPs()[id]
	for i := range ips {
		_, ips[i].Online = live[ips[i].IP]
	}
	us[0].OnlineIPs = len(live)
	writeJSON(w, 200, map[string]any{"user": us[0], "ips": ips})
}

type userReq struct {
	Username      *string `json:"username"`
	TrafficLimit  *int64  `json:"traffic_limit"`
	ExpireAt      *int64  `json:"expire_at"`
	ResetStrategy *string `json:"reset_strategy"`
	Note          *string `json:"note"`
	Enabled       *bool   `json:"enabled"`
	ResetUsage    bool    `json:"reset_usage"`
	RotateSecrets bool    `json:"rotate_secrets"`
}

var userRe = regexp.MustCompile(`^[\p{L}\p{N}._@-]{1,64}$`)

func (m *Master) apiCreateUser(w http.ResponseWriter, r *http.Request) {
	var req userReq
	if err := readJSON(r, &req); err != nil || req.Username == nil || !userRe.MatchString(*req.Username) {
		writeErr(w, 400, "username required (letters, digits, . _ @ -)")
		return
	}
	var limit, exp int64
	if req.TrafficLimit != nil {
		limit = *req.TrafficLimit
	}
	if req.ExpireAt != nil {
		exp = *req.ExpireAt
	}
	strategy, note := "none", ""
	if req.ResetStrategy != nil {
		strategy = *req.ResetStrategy
	}
	if req.Note != nil {
		note = *req.Note
	}
	res, err := m.db.Exec(`INSERT INTO users(username, sub_token, uuid, password, traffic_limit, expire_at, reset_strategy, note, last_reset_at, created_at)
		VALUES(?,?,?,?,?,?,?,?,?,?)`, *req.Username, randHex(12), uuid.NewString(), randHex(12), limit, exp, strategy, note, now(), now())
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	id, _ := res.LastInsertId()
	m.reconcile()
	writeJSON(w, 200, map[string]int64{"id": id})
}

func (m *Master) apiUpdateUser(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var req userReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	set := func(col string, v any) { m.db.Exec(`UPDATE users SET `+col+`=? WHERE id=?`, v, id) }
	if req.Username != nil {
		if !userRe.MatchString(*req.Username) {
			writeErr(w, 400, "bad username")
			return
		}
		set("username", *req.Username)
	}
	if req.TrafficLimit != nil {
		set("traffic_limit", *req.TrafficLimit)
	}
	if req.ExpireAt != nil {
		set("expire_at", *req.ExpireAt)
	}
	if req.ResetStrategy != nil {
		set("reset_strategy", *req.ResetStrategy)
	}
	if req.Note != nil {
		set("note", *req.Note)
	}
	if req.Enabled != nil {
		set("enabled", *req.Enabled)
	}
	if req.ResetUsage {
		m.db.Exec(`UPDATE users SET used_up=0, used_down=0, last_reset_at=? WHERE id=?`, now(), id)
	}
	if req.RotateSecrets {
		m.db.Exec(`UPDATE users SET uuid=?, password=?, sub_token=? WHERE id=?`, uuid.NewString(), randHex(12), randHex(12), id)
	}
	m.recomputeStatus(id)
	m.reconcile()
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// recomputeStatus derives status from limits after an admin edit.
func (m *Master) recomputeStatus(id int64) {
	var before, after string
	m.db.QueryRow(`SELECT status FROM users WHERE id=?`, id).Scan(&before)
	defer func() {
		m.db.QueryRow(`SELECT status FROM users WHERE id=?`, id).Scan(&after)
		if after != before {
			kind := map[string]string{"limited": "quota_exceeded", "expired": "user_expired", "active": "user_reactivated"}[after]
			addEvent(m.db, kind, id, "", before+" → "+after)
			if after != "active" {
				m.hub.kick([]string{strconv.FormatInt(id, 10)})
			}
		}
	}()
	m.db.Exec(`UPDATE users SET status = CASE
		WHEN expire_at>0 AND expire_at<=? THEN 'expired'
		WHEN traffic_limit>0 AND used_up+used_down>=traffic_limit THEN 'limited'
		ELSE 'active' END WHERE id=?`, now(), id)
}

func (m *Master) apiDeleteUser(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	m.db.Exec(`DELETE FROM users WHERE id=?`, id)
	m.db.Exec(`DELETE FROM online_ip WHERE user_id=?`, id)
	m.reconcile()
	m.hub.kick([]string{strconv.FormatInt(id, 10)})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiKickUser(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	m.hub.kick([]string{strconv.FormatInt(id, 10)})
	writeJSON(w, 200, map[string]bool{"ok": true})
}
