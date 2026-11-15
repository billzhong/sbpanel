package master

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// XUIInbound is one inbound as exported by 3x-ui (API /panel/api/inbounds/list or x-ui.db).
type XUIInbound struct {
	ID             int64           `json:"id"`
	Remark         string          `json:"remark"`
	Enable         bool            `json:"enable"`
	Listen         string          `json:"listen"`
	Port           int             `json:"port"`
	Protocol       string          `json:"protocol"`
	Settings       json.RawMessage `json:"settings"`
	StreamSettings json.RawMessage `json:"streamSettings"`
	Tag            string          `json:"tag"`
	ClientStats    []struct {
		Email string `json:"email"`
		Up    int64  `json:"up"`
		Down  int64  `json:"down"`
	} `json:"clientStats"`
}

type xuiClient struct {
	ID         string `json:"id"`
	Email      string `json:"email"`
	Flow       string `json:"flow"`
	Password   string `json:"password"`
	TotalGB    int64  `json:"totalGB"`
	ExpiryTime int64  `json:"expiryTime"`
	Enable     *bool  `json:"enable"`
	SubID      string `json:"subId"`
	LimitIP    int64  `json:"limitIp"`
	Comment    string `json:"comment"`
}

// ImportReport describes what an import did (or would do in a dry run).
type ImportReport struct {
	DryRun    bool             `json:"dry_run"`
	UsersOnly bool             `json:"users_only"`
	Users     int              `json:"users"`
	Updated   int              `json:"updated"`
	Inbounds  []ImportedInb    `json:"inbounds"`
	Skipped   []string         `json:"skipped"`
	Groups    []string         `json:"groups"`
	Warnings  []string         `json:"warnings"`
	Details   map[string][]int `json:"-"`
}

type ImportedInb struct {
	Tag    string `json:"tag"`
	Type   string `json:"type"`
	Port   int    `json:"port"`
	Users  int    `json:"users"`
	Remark string `json:"remark"`
}

// rawString accepts settings as an embedded JSON string (3x-ui API) or an object.
func rawString(r json.RawMessage) []byte {
	var s string
	if json.Unmarshal(r, &s) == nil {
		return []byte(s)
	}
	return r
}

// ParseXUIExport accepts the API response {"success":..,"obj":[...]} or a bare array.
func ParseXUIExport(b []byte) ([]XUIInbound, error) {
	var wrap struct {
		Obj []XUIInbound `json:"obj"`
	}
	if err := json.Unmarshal(b, &wrap); err == nil && wrap.Obj != nil {
		return wrap.Obj, nil
	}
	var arr []XUIInbound
	if err := json.Unmarshal(b, &arr); err != nil {
		return nil, fmt.Errorf("不是 3x-ui 入站列表 JSON：%w", err)
	}
	return arr, nil
}

// LoadXUIDB reads inbounds and client traffic from an x-ui.db SQLite file.
func LoadXUIDB(path string) ([]XUIInbound, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.Query(`SELECT id, remark, enable, listen, port, protocol, settings, stream_settings, tag FROM inbounds`)
	if err != nil {
		return nil, err
	}
	var out []XUIInbound
	for rows.Next() {
		var x XUIInbound
		var settings, stream string
		if err := rows.Scan(&x.ID, &x.Remark, &x.Enable, &x.Listen, &x.Port, &x.Protocol, &settings, &stream, &x.Tag); err != nil {
			rows.Close()
			return nil, err
		}
		x.Settings, x.StreamSettings = json.RawMessage(settings), json.RawMessage(stream)
		out = append(out, x)
	}
	rows.Close()
	stats := map[string][2]int64{}
	if r, err := db.Query(`SELECT email, up, down FROM client_traffics`); err == nil {
		for r.Next() {
			var e string
			var u, d int64
			r.Scan(&e, &u, &d)
			stats[e] = [2]int64{u, d}
		}
		r.Close()
	}
	for i := range out {
		var s struct{ Clients []xuiClient }
		json.Unmarshal(out[i].Settings, &s)
		for _, c := range s.Clients {
			if st, ok := stats[c.Email]; ok {
				out[i].ClientStats = append(out[i].ClientStats, struct {
					Email string `json:"email"`
					Up    int64  `json:"up"`
					Down  int64  `json:"down"`
				}{c.Email, st[0], st[1]})
			}
		}
	}
	return out, nil
}

var tagSan = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// convertXUIInbound maps an Xray inbound to sing-box inbound options.
func convertXUIInbound(x XUIInbound) (typ string, opts map[string]any, err error) {
	var settings map[string]any
	var stream map[string]any
	json.Unmarshal(rawString(x.Settings), &settings)
	json.Unmarshal(rawString(x.StreamSettings), &stream)
	listen := x.Listen
	if listen == "" || listen == "0.0.0.0" {
		listen = "::"
	}
	if net.ParseIP(listen) == nil {
		return "", nil, fmt.Errorf("监听地址 %q 不是 IP（可能是 unix socket / fallback），跳过", x.Listen)
	}
	opts = map[string]any{"listen": listen, "listen_port": x.Port}
	switch x.Protocol {
	case "vless", "vmess", "trojan":
		typ = x.Protocol
	case "shadowsocks":
		typ = "shadowsocks"
		opts["method"] = str(settings, "method")
		if p := str(settings, "password"); p != "" {
			opts["password"] = p
		}
		if n := str(settings, "network"); n == "tcp" || n == "udp" {
			opts["network"] = n
		}
		return typ, opts, nil
	case "hysteria", "hysteria2":
		return "", nil, fmt.Errorf("Xray 的 %s 入站需要手动迁移", x.Protocol)
	default:
		return "", nil, fmt.Errorf("协议 %s 不支持迁移", x.Protocol)
	}
	network := str(stream, "network")
	switch network {
	case "", "tcp", "raw":
		if hdr := obj(obj(stream, "tcpSettings"), "header"); hdr != nil && str(hdr, "type") == "http" {
			return "", nil, fmt.Errorf("TCP HTTP 伪装不支持")
		}
	case "ws":
		ws := obj(stream, "wsSettings")
		t := map[string]any{"type": "ws", "path": nz(str(ws, "path"), "/")}
		if h := str(ws, "host"); h != "" {
			t["headers"] = map[string]any{"Host": h}
		} else if hs := obj(ws, "headers"); hs != nil && str(hs, "Host") != "" {
			t["headers"] = map[string]any{"Host": str(hs, "Host")}
		}
		opts["transport"] = t
	case "grpc":
		opts["transport"] = map[string]any{"type": "grpc", "service_name": str(obj(stream, "grpcSettings"), "serviceName")}
	case "httpupgrade":
		hu := obj(stream, "httpupgradeSettings")
		opts["transport"] = map[string]any{"type": "httpupgrade", "path": nz(str(hu, "path"), "/"), "host": str(hu, "host")}
	case "xhttp", "splithttp":
		return "", nil, fmt.Errorf("XHTTP 传输 sing-box 不支持，跳过")
	default:
		return "", nil, fmt.Errorf("传输 %s 不支持", network)
	}
	switch str(stream, "security") {
	case "reality":
		rs := obj(stream, "realitySettings")
		names := strs(rs, "serverNames")
		dest := str(rs, "dest")
		if dest == "" {
			dest = str(rs, "target")
		}
		host, port, perr := net.SplitHostPort(dest)
		if perr != nil {
			host, port = dest, "443"
		}
		pn, _ := strconv.Atoi(port)
		sn := ""
		if len(names) > 0 {
			sn = names[0]
		}
		opts["tls"] = map[string]any{"enabled": true, "server_name": sn, "reality": map[string]any{
			"enabled": true, "handshake": map[string]any{"server": host, "server_port": pn},
			"private_key": str(rs, "privateKey"), "short_id": strs(rs, "shortIds"),
		}}
	case "tls":
		ts := obj(stream, "tlsSettings")
		t := map[string]any{"enabled": true, "server_name": str(ts, "serverName")}
		if alpn := strs(ts, "alpn"); len(alpn) > 0 {
			t["alpn"] = alpn
		}
		if certs, ok := ts["certificates"].([]any); ok && len(certs) > 0 {
			c, _ := certs[0].(map[string]any)
			if f := str(c, "certificateFile"); f != "" {
				t["certificate_path"] = f
				t["key_path"] = str(c, "keyFile")
			} else {
				t["certificate"] = strs(c, "certificate")
				t["key"] = strs(c, "key")
			}
		}
		opts["tls"] = t
	case "", "none":
	default:
		return "", nil, fmt.Errorf("安全层 %s 不支持", str(stream, "security"))
	}
	return typ, opts, nil
}

// Import3XUI creates users, inbounds (on nodeID) and groups from a 3x-ui export.
// Users are matched by email (= username); existing users are updated, not duplicated.
func (m *Master) Import3XUI(nodeID string, ins []XUIInbound, dryRun bool) (*ImportReport, error) {
	return m.import3XUI(nodeID, ins, dryRun, false)
}

// Import3XUIUsers migrates only the users (credentials, quotas, expiry, subIds) into
// the default groups; inbounds are designed fresh in the new panel.
func (m *Master) Import3XUIUsers(ins []XUIInbound, dryRun bool) (*ImportReport, error) {
	return m.import3XUI("", ins, dryRun, true)
}

func (m *Master) import3XUI(nodeID string, ins []XUIInbound, dryRun, usersOnly bool) (*ImportReport, error) {
	rep := &ImportReport{DryRun: dryRun, UsersOnly: usersOnly}
	if !usersOnly {
		var exists int
		m.db.QueryRow(`SELECT COUNT(*) FROM nodes WHERE id=?`, nodeID).Scan(&exists)
		if exists == 0 {
			return nil, fmt.Errorf("节点 %s 不存在", nodeID)
		}
	}
	type userAcc struct {
		c        xuiClient
		up, down int64
		inbounds []string // converted inbound tags
		uuid     string
		password string
		enabled  bool
	}
	users := map[string]*userAcc{}
	var order []string
	type convIn struct {
		tag, typ, remark string
		port             int
		opts             map[string]any
		enabled          bool
	}
	var conv []convIn
	usedTags := map[string]bool{}
	for _, x := range ins {
		typ, opts, err := convertXUIInbound(x)
		name := fmt.Sprintf("%s (:%d %s)", x.Remark, x.Port, x.Protocol)
		if err != nil {
			rep.Skipped = append(rep.Skipped, name+"："+err.Error())
			continue
		}
		var s struct{ Clients []xuiClient }
		json.Unmarshal(rawString(x.Settings), &s)
		tag := strings.Trim(tagSan.ReplaceAllString(strings.ToLower(x.Tag), "-"), "-")
		if tag == "" || len(tag) > 48 {
			tag = fmt.Sprintf("%s-%d", typ, x.Port)
		}
		for usedTags[tag] {
			tag += "-2"
		}
		usedTags[tag] = true
		flow := ""
		stats := map[string][2]int64{}
		for _, cs := range x.ClientStats {
			stats[cs.Email] = [2]int64{cs.Up, cs.Down}
		}
		for _, c := range s.Clients {
			if c.Email == "" {
				continue
			}
			key := strings.ToLower(c.Email)
			u := users[key]
			if u == nil {
				u = &userAcc{c: c, enabled: c.Enable == nil || *c.Enable}
				users[key] = u
				order = append(order, key)
			}
			if c.Enable != nil && !*c.Enable {
				u.enabled = false
			}
			// 3x-ui keeps one traffic row per email (client_traffics) and lists that same
			// row under every inbound the email is in: take it once, never sum it.
			if st, ok := stats[c.Email]; ok && st[0]+st[1] > u.up+u.down {
				u.up, u.down = st[0], st[1]
			}
			switch typ {
			case "vless", "vmess":
				if u.uuid == "" {
					u.uuid = c.ID
				} else if u.uuid != c.ID {
					rep.Warnings = append(rep.Warnings, fmt.Sprintf("%s 在不同入站使用了不同 UUID，保留第一个", c.Email))
				}
			case "trojan":
				if u.password == "" {
					u.password = c.Password
				}
			case "shadowsocks":
				rep.Warnings = append(rep.Warnings, fmt.Sprintf("%s：Shadowsocks 用户密钥会重新生成，需要重新导入订阅", c.Email))
			}
			if typ == "vless" && c.Flow != "" {
				flow = c.Flow
			}
			if c.SubID != "" && u.c.SubID == "" {
				u.c.SubID = c.SubID
			}
			u.inbounds = append(u.inbounds, tag)
		}
		if flow != "" {
			opts["_flow"] = flow
		}
		conv = append(conv, convIn{tag, typ, x.Remark, x.Port, opts, x.Enable})
		rep.Inbounds = append(rep.Inbounds, ImportedInb{Tag: tag, Type: typ, Port: x.Port, Users: len(s.Clients), Remark: x.Remark})
	}
	// users with the same inbound set share a group
	sets := map[string][]string{}
	for _, k := range order {
		u := users[k]
		sort.Strings(u.inbounds)
		u.inbounds = dedup(u.inbounds)
		sk := strings.Join(u.inbounds, ",")
		sets[sk] = append(sets[sk], k)
	}
	setKeys := make([]string, 0, len(sets))
	for k := range sets {
		setKeys = append(setKeys, k)
	}
	sort.Strings(setKeys)
	for i, sk := range setKeys {
		rep.Groups = append(rep.Groups, fmt.Sprintf("3x-ui 导入 %d：%s（%d 用户）", i+1, sk, len(sets[sk])))
	}
	rep.Users = len(order)
	if usersOnly {
		rep.Inbounds, rep.Groups = nil, nil
	}
	if dryRun {
		return rep, nil
	}

	tx, err := m.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	inbID := map[string]int64{}
	if usersOnly {
		conv = nil
	}
	for _, c := range conv {
		ob, _ := json.Marshal(c.opts)
		var existing int64
		if tx.QueryRow(`SELECT id FROM inbounds WHERE node_id=? AND port=?`, nodeID, c.port).Scan(&existing) == nil {
			return nil, fmt.Errorf("节点上端口 %d 已有入站，先删除或换一个节点", c.port)
		}
		res, err := tx.Exec(`INSERT INTO inbounds(node_id, tag, type, port, options_json, client_json, enabled, remark, created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
			nodeID, c.tag, c.typ, c.port, string(ob), "{}", c.enabled, c.remark, now())
		if err != nil {
			return nil, fmt.Errorf("inbound %s: %w", c.tag, err)
		}
		inbID[c.tag], _ = res.LastInsertId()
	}
	groupID := map[string]int64{}
	if usersOnly {
		setKeys = nil
	}
	for i, sk := range setKeys {
		name := fmt.Sprintf("3x-ui 导入 %d", i+1)
		for n := 2; ; n++ {
			var x int
			tx.QueryRow(`SELECT COUNT(*) FROM groups WHERE name=?`, name).Scan(&x)
			if x == 0 {
				break
			}
			name = fmt.Sprintf("3x-ui 导入 %d-%d", i+1, n)
		}
		res, err := tx.Exec(`INSERT INTO groups(name, remark, created_at) VALUES(?,?,?)`, name, "入站："+sk, now())
		if err != nil {
			return nil, err
		}
		gid, _ := res.LastInsertId()
		groupID[sk] = gid
		for _, t := range strings.Split(sk, ",") {
			if id, ok := inbID[t]; ok {
				tx.Exec(`INSERT OR IGNORE INTO group_inbounds(group_id, inbound_id) VALUES(?,?)`, gid, id)
			}
		}
	}
	ids := map[string]int64{}
	for _, k := range order {
		u := users[k]
		c := u.c
		exp := int64(0)
		if c.ExpiryTime > 0 {
			exp = c.ExpiryTime / 1000
		} else if c.ExpiryTime < 0 {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("%s：「首次使用后开始计时」的到期设置未迁移", c.Email))
		}
		token := c.SubID
		if token == "" {
			token = randHex(12)
		}
		uid := nz(u.uuid, uuid.NewString())
		pw := nz(u.password, randHex(12))
		name := c.Email
		if !userRe.MatchString(name) {
			name = tagSan.ReplaceAllString(name, "_")
		}
		var id int64
		if tx.QueryRow(`SELECT id FROM users WHERE username=?`, name).Scan(&id) == nil {
			tx.Exec(`UPDATE users SET uuid=?, password=?, traffic_limit=?, expire_at=?, device_limit=?, enabled=? WHERE id=?`,
				uid, pw, c.TotalGB, exp, c.LimitIP, u.enabled, id)
			if err := syncXUIUsage(tx, id, u.up, u.down); err != nil {
				return nil, fmt.Errorf("user %s: %w", name, err)
			}
			rep.Updated++
		} else {
			var clash int
			tx.QueryRow(`SELECT COUNT(*) FROM users WHERE sub_token=?`, token).Scan(&clash)
			if clash > 0 {
				token = randHex(12)
				rep.Warnings = append(rep.Warnings, fmt.Sprintf("%s 的 subId 与已有用户冲突，已生成新订阅链接", c.Email))
			}
			res, err := tx.Exec(`INSERT INTO users(username, sub_token, uuid, password, traffic_limit, expire_at, device_limit, enabled, note,
				used_up, used_down, life_up, life_down, xui_up, xui_down, last_reset_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				name, token, uid, pw, c.TotalGB, exp, c.LimitIP, u.enabled, nz(c.Comment, "从 3x-ui 导入"), u.up, u.down, u.up, u.down, u.up, u.down, now(), now())
			if err != nil {
				return nil, fmt.Errorf("user %s: %w", name, err)
			}
			id, _ = res.LastInsertId()
		}
		if usersOnly {
			for _, g := range defaultGroupIDs(tx) {
				tx.Exec(`INSERT OR IGNORE INTO user_groups(user_id, group_id) VALUES(?,?)`, id, g)
			}
		} else {
			tx.Exec(`INSERT OR IGNORE INTO user_groups(user_id, group_id) VALUES(?,?)`, id, groupID[strings.Join(u.inbounds, ",")])
		}
		ids[k] = id
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	for _, id := range ids {
		m.recomputeStatus(id)
	}
	if usersOnly {
		m.reconcile()
	} else {
		m.reconcile(nodeID)
	}
	return rep, nil
}

// syncXUIUsage folds 3x-ui's current usage of an existing user into its sbpanel
// usage. While both panels run, a user's usage is what 3x-ui counted plus what
// sbpanel counted, so a re-import adds only 3x-ui's growth since the last sync
// (all of it when 3x-ui reset the counter in between).
//
// Users imported before the baseline existed (xui_* = -1) were imported with
// usage multiplied by their inbound count; they are rebuilt from 3x-ui's value
// plus sbpanel's own recorded traffic.
func syncXUIUsage(tx *sql.Tx, id, up, down int64) error {
	var baseUp, baseDown, resetAt, created int64
	if err := tx.QueryRow(`SELECT xui_up, xui_down, last_reset_at, created_at FROM users WHERE id=?`, id).
		Scan(&baseUp, &baseDown, &resetAt, &created); err != nil {
		return err
	}
	if baseUp < 0 || baseDown < 0 {
		own := func(from int64) (u, d int64) {
			tx.QueryRow(`SELECT COALESCE(SUM(up),0), COALESCE(SUM(down),0) FROM traffic_hour WHERE user_id=? AND ts>=?`,
				id, from-from%3600).Scan(&u, &d)
			return
		}
		ou, od := own(resetAt)
		lu, ld := own(created)
		_, err := tx.Exec(`UPDATE users SET used_up=?, used_down=?, life_up=?, life_down=?, xui_up=?, xui_down=? WHERE id=?`,
			ou+up, od+down, lu+up, ld+down, up, down, id)
		return err
	}
	grow := func(now, base int64) int64 {
		if now >= base {
			return now - base
		}
		return now // 3x-ui reset its counter
	}
	du, dd := grow(up, baseUp), grow(down, baseDown)
	_, err := tx.Exec(`UPDATE users SET used_up=used_up+?, used_down=used_down+?, life_up=life_up+?, life_down=life_down+?,
		xui_up=?, xui_down=? WHERE id=?`, du, dd, du, dd, up, down, id)
	return err
}

func dedup(xs []string) []string {
	out := xs[:0]
	for i, x := range xs {
		if i == 0 || x != xs[i-1] {
			out = append(out, x)
		}
	}
	return out
}

func (m *Master) apiImport3XUI(w http.ResponseWriter, r *http.Request) {
	var req struct {
		NodeID    string          `json:"node_id"`
		Data      json.RawMessage `json:"data"`
		DryRun    bool            `json:"dry_run"`
		UsersOnly bool            `json:"users_only"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	data := []byte(req.Data)
	var s string
	if json.Unmarshal(req.Data, &s) == nil {
		data = []byte(s) // pasted text
	}
	ins, err := ParseXUIExport(data)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var rep *ImportReport
	if req.UsersOnly {
		rep, err = m.Import3XUIUsers(ins, req.DryRun)
	} else {
		rep, err = m.Import3XUI(req.NodeID, ins, req.DryRun)
	}
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if !req.DryRun {
		m.audit(r, "import.3xui", req.NodeID, fmt.Sprintf("%d users, %d inbounds", rep.Users, len(rep.Inbounds)))
	}
	writeJSON(w, 200, rep)
}
