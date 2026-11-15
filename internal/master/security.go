package master

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type actorKey struct{}

// actor is who performed a request: an admin session or an API token.
func actor(r *http.Request) string {
	if v, ok := r.Context().Value(actorKey{}).(string); ok {
		return v
	}
	return "system"
}

func (m *Master) audit(r *http.Request, action, target, detail string) {
	ip := ""
	if r != nil {
		ip = clientIP(r)
	}
	who := "system"
	if r != nil {
		who = actor(r)
	}
	m.db.Exec(`INSERT INTO audit_log(ts, admin, action, target, detail, ip) VALUES(?,?,?,?,?,?)`, now(), who, action, target, truncate(detail, 500), ip)
}

func withActor(r *http.Request, who string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), actorKey{}, who))
}

// ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----------

func totpCode(secret string, t time.Time) string {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(secret))
	if err != nil {
		return ""
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(t.Unix()/30))
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	s := mac.Sum(nil)
	off := s[len(s)-1] & 0x0f
	v := binary.BigEndian.Uint32(s[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", v%1000000)
}

func totpValid(secret, code string, t time.Time) bool {
	code = strings.TrimSpace(code)
	if len(code) != 6 {
		return false
	}
	for _, d := range []time.Duration{-30 * time.Second, 0, 30 * time.Second} {
		if subtle.ConstantTimeCompare([]byte(totpCode(secret, t.Add(d))), []byte(code)) == 1 {
			return true
		}
	}
	return false
}

func newTOTPSecret() string {
	b := make([]byte, 20)
	rand.Read(b)
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b)
}

// ---------- account endpoints ----------

func (m *Master) apiMe(w http.ResponseWriter, r *http.Request) {
	who := actor(r)
	var totp string
	m.db.QueryRow(`SELECT totp_secret FROM admins WHERE username=?`, who).Scan(&totp)
	out := map[string]any{"username": who, "totp": totp != "", "token": strings.HasPrefix(who, "token:")}
	if p := principalFrom(r); p != nil && !p.session {
		out["scopes"] = p.scopes
	} else {
		out["scopes"] = []string{ScopeAdmin}
	}
	writeJSON(w, 200, out)
}

func (m *Master) apiChangePassword(w http.ResponseWriter, r *http.Request) {
	var req struct{ Old, New string }
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if len(req.New) < 8 {
		writeErr(w, 400, "新密码至少 8 位")
		return
	}
	var hash string
	if err := m.db.QueryRow(`SELECT pass_hash FROM admins WHERE username=?`, actor(r)).Scan(&hash); err != nil ||
		bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Old)) != nil {
		writeErr(w, 400, "原密码不正确")
		return
	}
	h, _ := bcrypt.GenerateFromPassword([]byte(req.New), bcrypt.DefaultCost)
	m.db.Exec(`UPDATE admins SET pass_hash=? WHERE username=?`, string(h), actor(r))
	m.audit(r, "admin.password", actor(r), "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiTOTPSetup(w http.ResponseWriter, r *http.Request) {
	sec := newTOTPSecret()
	setSetting(m.db, "totp_pending:"+actor(r), sec)
	issuer := settingOr(m.db, "sub_title", "sbpanel")
	uri := "otpauth://totp/" + url.PathEscape(issuer+":"+actor(r)) + "?secret=" + sec + "&issuer=" + url.QueryEscape(issuer)
	writeJSON(w, 200, map[string]any{"secret": sec, "uri": uri, "qr": string(qrDataURI(uri))})
}

func (m *Master) apiTOTPEnable(w http.ResponseWriter, r *http.Request) {
	var req struct{ Code string }
	readJSON(r, &req)
	sec, ok := getSetting(m.db, "totp_pending:"+actor(r))
	if !ok || !totpValid(sec, req.Code, time.Now()) {
		writeErr(w, 400, "验证码不正确")
		return
	}
	m.db.Exec(`UPDATE admins SET totp_secret=? WHERE username=?`, sec, actor(r))
	m.db.Exec(`DELETE FROM settings WHERE k=?`, "totp_pending:"+actor(r))
	m.audit(r, "admin.totp_enable", actor(r), "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiTOTPDisable(w http.ResponseWriter, r *http.Request) {
	var req struct{ Password string }
	readJSON(r, &req)
	var hash string
	if err := m.db.QueryRow(`SELECT pass_hash FROM admins WHERE username=?`, actor(r)).Scan(&hash); err != nil ||
		bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		writeErr(w, 400, "密码不正确")
		return
	}
	m.db.Exec(`UPDATE admins SET totp_secret='' WHERE username=?`, actor(r))
	m.audit(r, "admin.totp_disable", actor(r), "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiAudit(w http.ResponseWriter, r *http.Request) {
	type row struct {
		TS     int64  `json:"ts"`
		Admin  string `json:"admin"`
		Action string `json:"action"`
		Target string `json:"target"`
		Detail string `json:"detail"`
		IP     string `json:"ip"`
	}
	out, err := scanRows(m, `SELECT ts, admin, action, target, detail, ip FROM audit_log ORDER BY id DESC LIMIT ?`, []any{qInt(r, "limit", 200)},
		func(s func(...any) error) (row, error) {
			var x row
			return x, s(&x.TS, &x.Admin, &x.Action, &x.Target, &x.Detail, &x.IP)
		})
	if errf(w, err) {
		return
	}
	writeJSON(w, 200, out)
}

// ResetAdmin sets a new password (creating the admin if needed) and clears 2FA.
// RenameAdmin changes an admin's username (keeps password and 2FA).
func (m *Master) RenameAdmin(from, to string) error {
	res, err := m.db.Exec(`UPDATE admins SET username=? WHERE username=?`, to, from)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("no admin named %q", from)
	}
	return nil
}

func (m *Master) ResetAdmin(user, password string) error {
	h, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = m.db.Exec(`INSERT INTO admins(username, pass_hash, created_at) VALUES(?,?,?)
		ON CONFLICT(username) DO UPDATE SET pass_hash=excluded.pass_hash, totp_secret=''`, user, string(h), now())
	return err
}
