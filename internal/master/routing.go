package master

// Subscription routing profiles: one generic routing model per profile, rendered
// per client by internal/subgen. Edits go to draft_json; subscriptions always use
// the published json. Publish dry-runs every enabled client first.

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"sbpanel/internal/subgen"
)

type profileRow struct {
	ID          int64  `json:"id"`
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Description string `json:"description"`
	JSON        string `json:"-"`
	Draft       string `json:"-"`
	IsDefault   bool   `json:"is_default"`
	Selectable  bool   `json:"selectable"`
	PublishedAt int64  `json:"published_at"`
	UpdatedAt   int64  `json:"updated_at"`
}

const profileCols = `id, slug, name, description, json, draft_json, is_default, selectable, published_at, updated_at`

func scanProfile(s func(...any) error) (profileRow, error) {
	var p profileRow
	return p, s(&p.ID, &p.Slug, &p.Name, &p.Description, &p.JSON, &p.Draft, &p.IsDefault, &p.Selectable, &p.PublishedAt, &p.UpdatedAt)
}

func (m *Master) profiles() ([]profileRow, error) {
	return scanRows(m, `SELECT `+profileCols+` FROM sub_profiles ORDER BY sort, id`, nil, scanProfile)
}

func (m *Master) profileByID(id int64) (profileRow, bool) {
	ps, err := scanRows(m, `SELECT `+profileCols+` FROM sub_profiles WHERE id=?`, []any{id}, scanProfile)
	if err != nil || len(ps) == 0 {
		return profileRow{}, false
	}
	return ps[0], true
}

func parseProfile(js string) (*subgen.Profile, error) {
	var p subgen.Profile
	d := json.NewDecoder(strings.NewReader(js))
	d.DisallowUnknownFields()
	if err := d.Decode(&p); err != nil {
		return nil, fmt.Errorf("Invalid JSON: %v", err)
	}
	return &p, nil
}

// assignedProfile is the user's own choice: user override, then the first of the
// user's groups that has one, then the default.
func (m *Master) assignedProfile(userID int64) (profileRow, bool) {
	var id int64
	m.db.QueryRow(`SELECT sub_profile_id FROM users WHERE id=?`, userID).Scan(&id)
	if id == 0 {
		m.db.QueryRow(`SELECT g.sub_profile_id FROM user_groups ug JOIN groups g ON g.id=ug.group_id
			WHERE ug.user_id=? AND g.sub_profile_id>0 ORDER BY g.id LIMIT 1`, userID).Scan(&id)
	}
	if id > 0 {
		if p, ok := m.profileByID(id); ok {
			return p, true
		}
	}
	ps, _ := scanRows(m, `SELECT `+profileCols+` FROM sub_profiles WHERE is_default=1 LIMIT 1`, nil, scanProfile)
	if len(ps) == 1 {
		return ps[0], true
	}
	return profileRow{}, false
}

// subProfile resolves which profile renders this request. ?profile=<slug> wins
// when that profile is user-selectable or is the one assigned to the user.
func (m *Master) subProfile(u subUser, slug string) (profileRow, bool) {
	assigned, ok := m.assignedProfile(u.ID)
	if slug != "" && (!ok || slug != assigned.Slug) {
		ps, _ := scanRows(m, `SELECT `+profileCols+` FROM sub_profiles WHERE slug=? AND selectable=1`, []any{slug}, scanProfile)
		if len(ps) == 1 {
			return ps[0], true
		}
	}
	return assigned, ok
}

// renderProfile renders entries with a profile. ok=false means "use the legacy
// generators" (no profile, a client the profile disables, or a render error).
func (m *Master) renderProfile(r *http.Request, format string, u subUser, es []subEntry) (*subgen.Result, bool) {
	p, ok := m.subProfile(u, r.URL.Query().Get("profile"))
	if !ok {
		return nil, false
	}
	prof, err := parseProfile(p.JSON)
	if err != nil {
		m.log.Printf("subgen %s: profile %s: %v", format, p.Slug, err)
		return nil, false
	}
	if ct, ok := prof.Clients[format]; !ok || !ct.Enabled {
		return nil, false
	}
	res, err := subgen.Render(format, prof, toEndpoints(es), m.subMeta(r, u))
	if err != nil {
		m.log.Printf("subgen %s: profile %s: %v (falling back)", format, p.Slug, err)
		return nil, false
	}
	return res, true
}

func (m *Master) subMeta(r *http.Request, u subUser) subgen.Meta {
	hours, _ := strconv.Atoi(settingOr(m.db, "sub_update_hours", "12"))
	sub := m.subURL(r, u.Token)
	if p := r.URL.Query().Get("profile"); p != "" {
		sub += "?profile=" + p
	}
	return subgen.Meta{User: u.Username, SubURL: sub, Title: settingOr(m.db, "sub_title", "sbpanel"), UpdateHrs: hours,
		Mirror: settingOr(m.db, "sub_rule_mirror", "")}
}

func toEndpoints(es []subEntry) []subgen.Endpoint {
	out := make([]subgen.Endpoint, len(es))
	for i, e := range es {
		out[i] = subgen.Endpoint(e)
	}
	return out
}

// writeSub writes a subscription body with an ETag over body + usage header, so
// clients that revalidate get 304 when nothing changed.
func writeSub(w http.ResponseWriter, r *http.Request, body []byte) {
	h := w.Header()
	sum := sha256.New()
	sum.Write(body)
	sum.Write([]byte(h.Get("Subscription-Userinfo")))
	tag := `"` + hex.EncodeToString(sum.Sum(nil))[:32] + `"`
	h.Set("ETag", tag)
	h.Set("Cache-Control", "private, no-cache")
	if inm := r.Header.Get("If-None-Match"); inm != "" {
		for _, t := range strings.Split(inm, ",") {
			if t = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(t), "W/")); t == tag || t == "*" {
				h.Del("Content-Disposition")
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
	}
	w.Write(body)
}

// ---------- public data ----------

type subProfileJSON struct {
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// presetEN holds English names for the built-in presets' (Chinese) names and descriptions.
// Profiles created from a preset store those strings; as long as the admin hasn't renamed them,
// they are shown in the reader's language.
var presetEN = map[string]string{
	"标准分流": "Standard", "流媒体、AI、广告拦截、国内直连，其余走代理": "Streaming, AI and ad blocking rules; mainland China direct, everything else proxied",
	"全局代理": "Global proxy", "除局域网外全部走代理": "Everything except the LAN goes through the proxy",
	"绕过大陆": "Bypass mainland China", "中国大陆域名与 IP 直连，其余走代理": "Mainland China domains and IPs go direct, everything else is proxied",
	"极简": "Minimal", "只有节点选择和自动选择，不下载任何规则": "Only node selection and auto-select; no rule downloads",
}

func presetText(lang, s string) string {
	if en, ok := presetEN[s]; ok && lang != langZH {
		return en
	}
	return s
}

// selectableProfiles lists what the subscription page may offer, plus the slug in effect.
func (m *Master) selectableProfiles(u subUser, req string) ([]subProfileJSON, string) {
	out := []subProfileJSON{}
	cur, ok := m.subProfile(u, req)
	selected := ""
	if ok {
		selected = cur.Slug
	}
	ps, _ := m.profiles()
	for _, p := range ps {
		if p.Selectable || p.Slug == selected {
			out = append(out, subProfileJSON{Slug: p.Slug, Name: p.Name, Description: p.Description})
		}
	}
	return out, selected
}

// ---------- admin API ----------

type profileOut struct {
	profileRow
	HasDraft bool    `json:"has_draft"`
	Users    int64   `json:"users"`
	GroupIDs []int64 `json:"group_ids"`
}

func (m *Master) apiProfiles(w http.ResponseWriter, r *http.Request) {
	ps, err := m.profiles()
	if errf(w, err) {
		return
	}
	out := []profileOut{}
	for _, p := range ps {
		p.Name, p.Description = presetText(langOf(w), p.Name), presetText(langOf(w), p.Description)
		o := profileOut{profileRow: p, HasDraft: p.Draft != "" && p.Draft != p.JSON, GroupIDs: []int64{}}
		m.db.QueryRow(`SELECT COUNT(*) FROM users WHERE sub_profile_id=?`, p.ID).Scan(&o.Users)
		o.GroupIDs, _ = scanRows(m, `SELECT id FROM groups WHERE sub_profile_id=? ORDER BY id`, []any{p.ID}, func(s func(...any) error) (int64, error) {
			var id int64
			return id, s(&id)
		})
		out = append(out, o)
	}
	writeJSON(w, 200, out)
}

type catalogItemJSON struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Kind    string   `json:"kind"`
	Geosite string   `json:"geosite,omitempty"`
	Geoip   string   `json:"geoip,omitempty"`
	Surge   []string `json:"surge,omitempty"`
}

func (m *Master) apiRoutingCatalog(w http.ResponseWriter, r *http.Request) {
	items := []catalogItemJSON{}
	for _, c := range subgen.Catalog {
		items = append(items, catalogItemJSON{c.Key, T(langOf(w), c.Label), c.Kind, c.Geosite, c.Geoip, c.Surge})
	}
	order := map[string]int{"private": 0, "cn": 1, "global": 2, "ads": 3, "ai": 4, "streaming": 5, "service": 6, "games": 7}
	sort.Slice(items, func(i, j int) bool {
		if order[items[i].Kind] != order[items[j].Kind] {
			return order[items[i].Kind] < order[items[j].Kind]
		}
		return items[i].Key < items[j].Key
	})
	presets := []map[string]string{}
	for _, p := range subgen.Presets {
		presets = append(presets, map[string]string{"slug": p.Slug, "name": presetText(langOf(w), p.Name), "description": presetText(langOf(w), p.Description)})
	}
	bases := map[string]string{"mihomo": subgen.MihomoBase, "singbox": subgen.SingboxBase, "surge": subgen.SurgeBase}
	writeJSON(w, 200, map[string]any{
		"catalog": items, "presets": presets, "placeholders": subgen.Placeholders, "required": subgen.Required,
		"default_options": subgen.DefaultOptions, "clients": subgen.ClientNames, "bases": bases,
		"mirror": settingOr(m.db, "sub_rule_mirror", ""),
	})
}

var slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

func (m *Master) apiCreateProfile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string `json:"name"`
		Slug        string `json:"slug"`
		Description string `json:"description"`
		Preset      string `json:"preset"`
		From        int64  `json:"from"`
	}
	if err := readJSON(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		writeErr(w, 400, "Name is required")
		return
	}
	if !slugRe.MatchString(req.Slug) {
		writeErr(w, 400, "The slug may contain lowercase letters, digits and - (up to 32 characters)")
		return
	}
	var js string
	switch {
	case req.From > 0:
		p, ok := m.profileByID(req.From)
		if !ok {
			writeErr(w, 404, "Source profile not found")
			return
		}
		js = nz(p.Draft, p.JSON)
	default:
		p := subgen.PresetBySlug(nz(req.Preset, "standard"))
		if p == nil {
			writeErr(w, 400, "Unknown preset")
			return
		}
		b, _ := json.Marshal(p)
		js = string(b)
	}
	res, err := m.db.Exec(`INSERT INTO sub_profiles(slug, name, description, json, sort, published_at, updated_at)
		VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM sub_profiles),?,?)`, req.Slug, strings.TrimSpace(req.Name), req.Description, js, now(), now())
	if err != nil {
		writeErr(w, 400, "This slug already exists")
		return
	}
	id, _ := res.LastInsertId()
	m.db.Exec(`INSERT INTO sub_profile_history(profile_id, ts, admin, json) VALUES(?,?,?,?)`, id, now(), actor(r), js)
	m.audit(r, "profile.create", fmtID(id), req.Slug)
	writeJSON(w, 200, map[string]int64{"id": id})
}

func rawOrNull(s string) json.RawMessage {
	if s == "" {
		return json.RawMessage("null")
	}
	return json.RawMessage(s)
}

func (m *Master) apiProfile(w http.ResponseWriter, r *http.Request) {
	id, _ := pathID(r)
	p, ok := m.profileByID(id)
	if !ok {
		writeErr(w, 404, "Profile not found")
		return
	}
	draft := p.Draft
	if draft == p.JSON {
		draft = ""
	}
	p.Name, p.Description = presetText(langOf(w), p.Name), presetText(langOf(w), p.Description)
	writeJSON(w, 200, map[string]any{"profile": p, "published": rawOrNull(p.JSON), "draft": rawOrNull(draft)})
}

func (m *Master) apiUpdateProfile(w http.ResponseWriter, r *http.Request) {
	id, _ := pathID(r)
	if _, ok := m.profileByID(id); !ok {
		writeErr(w, 404, "Profile not found")
		return
	}
	var req struct {
		Name        *string `json:"name"`
		Slug        *string `json:"slug"`
		Description *string `json:"description"`
		Selectable  *bool   `json:"selectable"`
		IsDefault   *bool   `json:"is_default"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if req.Name != nil {
		if strings.TrimSpace(*req.Name) == "" {
			writeErr(w, 400, "Name is required")
			return
		}
		m.db.Exec(`UPDATE sub_profiles SET name=? WHERE id=?`, strings.TrimSpace(*req.Name), id)
	}
	if req.Slug != nil {
		if !slugRe.MatchString(*req.Slug) {
			writeErr(w, 400, "The slug may contain lowercase letters, digits and - (up to 32 characters)")
			return
		}
		if _, err := m.db.Exec(`UPDATE sub_profiles SET slug=? WHERE id=?`, *req.Slug, id); err != nil {
			writeErr(w, 400, "This slug already exists")
			return
		}
	}
	if req.Description != nil {
		m.db.Exec(`UPDATE sub_profiles SET description=? WHERE id=?`, *req.Description, id)
	}
	if req.Selectable != nil {
		m.db.Exec(`UPDATE sub_profiles SET selectable=? WHERE id=?`, *req.Selectable, id)
	}
	if req.IsDefault != nil && *req.IsDefault {
		m.db.Exec(`UPDATE sub_profiles SET is_default=(id=?)`, id)
	}
	m.audit(r, "profile.update", fmtID(id), "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiDeleteProfile(w http.ResponseWriter, r *http.Request) {
	id, _ := pathID(r)
	p, ok := m.profileByID(id)
	if !ok {
		writeErr(w, 404, "Profile not found")
		return
	}
	if p.IsDefault {
		writeErr(w, 400, "The default profile can't be deleted; make another profile the default first")
		return
	}
	m.db.Exec(`UPDATE users SET sub_profile_id=0 WHERE sub_profile_id=?`, id)
	m.db.Exec(`UPDATE groups SET sub_profile_id=0 WHERE sub_profile_id=?`, id)
	m.db.Exec(`DELETE FROM sub_profile_history WHERE profile_id=?`, id)
	m.db.Exec(`DELETE FROM sub_profiles WHERE id=?`, id)
	m.audit(r, "profile.delete", fmtID(id), p.Slug)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// apiSaveProfileDraft validates the model (cheap) and stores it as the draft.
func (m *Master) apiSaveProfileDraft(w http.ResponseWriter, r *http.Request) {
	id, _ := pathID(r)
	p, ok := m.profileByID(id)
	if !ok {
		writeErr(w, 404, "Profile not found")
		return
	}
	var req struct {
		Draft json.RawMessage `json:"draft"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	prof, err := parseProfile(string(req.Draft))
	if err == nil {
		err = subgen.Validate(prof)
	}
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	b, _ := json.Marshal(prof)
	d := string(b)
	if d == p.JSON {
		d = ""
	}
	m.db.Exec(`UPDATE sub_profiles SET draft_json=?, updated_at=? WHERE id=?`, d, now(), id)
	writeJSON(w, 200, map[string]any{"ok": true, "has_draft": d != ""})
}

func (m *Master) apiDiscardProfileDraft(w http.ResponseWriter, r *http.Request) {
	id, _ := pathID(r)
	m.db.Exec(`UPDATE sub_profiles SET draft_json='' WHERE id=?`, id)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// apiPreviewProfile renders draft (or published) and published for one client
// and a sample user, so the UI can show the output and a diff.
func (m *Master) apiPreviewProfile(w http.ResponseWriter, r *http.Request) {
	id, _ := pathID(r)
	p, ok := m.profileByID(id)
	if !ok {
		writeErr(w, 404, "Profile not found")
		return
	}
	var req struct {
		Client string          `json:"client"`
		UserID int64           `json:"user_id"`
		Draft  json.RawMessage `json:"draft"` // unsaved editor state; empty = stored draft or published
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if _, ok := subgen.ClientCaps[req.Client]; !ok {
		writeErr(w, 400, "Unknown client")
		return
	}
	es, u, err := m.previewEntries(r, req.UserID)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	meta := m.subMeta(r, u)
	run := func(js string) (string, []string, string) {
		prof, err := parseProfile(js)
		if err != nil {
			return "", nil, err.Error()
		}
		res, err := subgen.Render(req.Client, prof, toEndpoints(es), meta)
		if err != nil {
			return "", nil, err.Error()
		}
		if err := subgen.ValidateOutput(req.Client, res.Body); err != nil {
			return string(res.Body), res.Warnings, fmt.Sprintf("Output validation failed: %v", err)
		}
		return string(res.Body), res.Warnings, ""
	}
	cur := nz(p.Draft, p.JSON)
	if len(bytes.TrimSpace(req.Draft)) > 0 && string(req.Draft) != "null" {
		cur = string(req.Draft)
	}
	body, warns, perr := run(cur)
	pub, _, _ := run(p.JSON)
	lang := langOf(w)
	writeJSON(w, 200, map[string]any{"body": body, "warnings": localizeAll(lang, warns), "error": L(lang, perr), "published_body": pub, "nodes": len(es)})
}

// previewEntries: userID>0 uses that user's real endpoints; 0 lists every inbound.
func (m *Master) previewEntries(r *http.Request, userID int64) ([]subEntry, subUser, error) {
	if userID > 0 {
		var tok string
		if err := m.db.QueryRow(`SELECT sub_token FROM users WHERE id=?`, userID).Scan(&tok); err != nil {
			return nil, subUser{}, fmt.Errorf("User not found")
		}
		u, err := m.loadSubUser(tok)
		if err != nil {
			return nil, u, err
		}
		es, err := m.subEntries(u)
		return es, u, err
	}
	u := subUser{ID: -1, Username: "preview", Token: "preview", UUID: "00000000-0000-4000-8000-000000000000", Password: "preview-password"}
	es, err := m.subEntries(u)
	return es, u, err
}

func (m *Master) apiPublishProfile(w http.ResponseWriter, r *http.Request) {
	id, _ := pathID(r)
	p, ok := m.profileByID(id)
	if !ok {
		writeErr(w, 404, "Profile not found")
		return
	}
	if p.Draft == "" {
		writeJSON(w, 200, map[string]any{"ok": true, "changed": false})
		return
	}
	prof, err := parseProfile(p.Draft)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	warns, err := subgen.Check(prof)
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	t := now()
	m.db.Exec(`UPDATE sub_profiles SET json=draft_json, draft_json='', published_at=?, updated_at=? WHERE id=?`, t, t, id)
	m.db.Exec(`INSERT INTO sub_profile_history(profile_id, ts, admin, json) VALUES(?,?,?,?)`, id, t, actor(r), p.Draft)
	// keep the last 20 versions
	m.db.Exec(`DELETE FROM sub_profile_history WHERE profile_id=? AND id NOT IN (SELECT id FROM sub_profile_history WHERE profile_id=? ORDER BY id DESC LIMIT 20)`, id, id)
	m.audit(r, "profile.publish", fmtID(id), p.Slug)
	for c, ws := range warns {
		warns[c] = localizeAll(langOf(w), ws)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "changed": true, "warnings": warns})
}

func (m *Master) apiProfileHistory(w http.ResponseWriter, r *http.Request) {
	id, _ := pathID(r)
	type h struct {
		ID    int64           `json:"id"`
		TS    int64           `json:"ts"`
		Admin string          `json:"admin"`
		JSON  json.RawMessage `json:"json"`
	}
	hs, err := scanRows(m, `SELECT id, ts, admin, json FROM sub_profile_history WHERE profile_id=? ORDER BY id DESC`, []any{id},
		func(s func(...any) error) (h, error) {
			var x h
			var js string
			err := s(&x.ID, &x.TS, &x.Admin, &js)
			x.JSON = json.RawMessage(js)
			return x, err
		})
	if errf(w, err) {
		return
	}
	writeJSON(w, 200, hs)
}

func (m *Master) apiRestoreProfile(w http.ResponseWriter, r *http.Request) {
	id, _ := pathID(r)
	hid, err := strconv.ParseInt(r.PathValue("hid"), 10, 64)
	if err != nil {
		writeErr(w, 400, "bad id")
		return
	}
	var js, pub string
	if err := m.db.QueryRow(`SELECT h.json, p.json FROM sub_profile_history h JOIN sub_profiles p ON p.id=h.profile_id
		WHERE h.id=? AND h.profile_id=?`, hid, id).Scan(&js, &pub); err == sql.ErrNoRows {
		writeErr(w, 404, "Version not found")
		return
	}
	if js == pub {
		js = ""
	}
	m.db.Exec(`UPDATE sub_profiles SET draft_json=?, updated_at=? WHERE id=?`, js, now(), id)
	m.audit(r, "profile.restore", fmtID(id), fmtID(hid))
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// apiRoutingNodes lists every endpoint name, for live filter-match counts in the editor.
func (m *Master) apiRoutingNodes(w http.ResponseWriter, r *http.Request) {
	es, _, err := m.previewEntries(r, 0)
	if errf(w, err) {
		return
	}
	type n struct {
		Remark string `json:"remark"`
		Node   string `json:"node"`
		Type   string `json:"type"`
		Surge  bool   `json:"surge"`
	}
	out := []n{}
	for _, e := range es {
		ok, _ := subgen.Supported("surge", subgen.Endpoint(e))
		out = append(out, n{e.Remark, e.Node, e.Type, ok})
	}
	writeJSON(w, 200, out)
}

// checkProfileID accepts 0 (inherit) or an existing profile.
func checkProfileID(q interface {
	QueryRow(string, ...any) *sql.Row
}, id int64) error {
	if id == 0 {
		return nil
	}
	var n int
	q.QueryRow(`SELECT COUNT(*) FROM sub_profiles WHERE id=?`, id).Scan(&n)
	if n == 0 {
		return fmt.Errorf("Routing profile not found")
	}
	return nil
}
