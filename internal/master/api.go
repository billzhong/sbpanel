package master

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const sessionCookie = "sbm_session"

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 4<<20))
	return dec.Decode(v)
}

func (m *Master) sign(payload string) string {
	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (m *Master) newSession(user string) string {
	exp := time.Now().Add(7 * 24 * time.Hour).Unix()
	p := user + "|" + strconv.FormatInt(exp, 10)
	return base64.RawURLEncoding.EncodeToString([]byte(p)) + "." + m.sign(p)
}

func (m *Master) checkSession(r *http.Request) (string, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return "", false
	}
	parts := strings.SplitN(c.Value, ".", 2)
	if len(parts) != 2 {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || !hmac.Equal([]byte(m.sign(string(raw))), []byte(parts[1])) {
		return "", false
	}
	f := strings.SplitN(string(raw), "|", 2)
	if len(f) != 2 {
		return "", false
	}
	exp, _ := strconv.ParseInt(f[1], 10, 64)
	if exp < time.Now().Unix() {
		return "", false
	}
	return f[0], true
}

func (m *Master) auth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := m.checkSession(r); !ok {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r)
	}
}

func (m *Master) routes() http.Handler {
	mux := http.NewServeMux()
	a := m.auth
	mux.HandleFunc("POST /api/auth/login", m.apiLogin)
	mux.HandleFunc("POST /api/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1})
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		u, ok := m.checkSession(r)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		writeJSON(w, 200, map[string]string{"username": u})
	})

	mux.HandleFunc("GET /api/overview", a(m.apiOverview))
	mux.HandleFunc("GET /api/traffic/series", a(m.apiSeries))
	mux.HandleFunc("GET /api/traffic/top", a(m.apiTop))
	mux.HandleFunc("GET /api/events", a(m.apiEvents))
	mux.HandleFunc("GET /api/online", a(m.apiOnline))

	mux.HandleFunc("GET /api/nodes", a(m.apiNodes))
	mux.HandleFunc("POST /api/nodes", a(m.apiCreateNode))
	mux.HandleFunc("PATCH /api/nodes/{id}", a(m.apiUpdateNode))
	mux.HandleFunc("DELETE /api/nodes/{id}", a(m.apiDeleteNode))
	mux.HandleFunc("POST /api/nodes/{id}/token", a(m.apiNodeToken))
	mux.HandleFunc("GET /api/nodes/{id}/spec", a(m.apiNodeSpec))

	mux.HandleFunc("GET /api/inbounds", a(m.apiInbounds))
	mux.HandleFunc("POST /api/inbounds", a(m.apiCreateInbound))
	mux.HandleFunc("PATCH /api/inbounds/{id}", a(m.apiUpdateInbound))
	mux.HandleFunc("DELETE /api/inbounds/{id}", a(m.apiDeleteInbound))
	mux.HandleFunc("POST /api/tools/reality-keypair", a(m.apiRealityKeypair))

	mux.HandleFunc("GET /api/users", a(m.apiUsers))
	mux.HandleFunc("POST /api/users", a(m.apiCreateUser))
	mux.HandleFunc("GET /api/users/{id}", a(m.apiUser))
	mux.HandleFunc("PATCH /api/users/{id}", a(m.apiUpdateUser))
	mux.HandleFunc("DELETE /api/users/{id}", a(m.apiDeleteUser))
	mux.HandleFunc("POST /api/users/{id}/kick", a(m.apiKickUser))

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { writeErr(w, 404, "not found") })
	if m.cfg.Web != nil {
		mux.Handle("/", spaHandler(m.cfg.Web))
	}
	return securityHeaders(mux)
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		h.ServeHTTP(w, r)
	})
}

// spaHandler serves built assets and falls back to index.html for client routes.
func spaHandler(fsys fs.FS) http.Handler {
	files := http.FileServer(http.FS(fsys))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if f, err := fsys.Open(p); err == nil {
				f.Close()
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		b, err := fs.ReadFile(fsys, "index.html")
		if err != nil {
			http.Error(w, "web ui not built", 404)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(b)
	})
}

func (m *Master) apiLogin(w http.ResponseWriter, r *http.Request) {
	var req struct{ Username, Password string }
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	var hash string
	err := m.db.QueryRow(`SELECT pass_hash FROM admins WHERE username=?`, req.Username).Scan(&hash)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		time.Sleep(500 * time.Millisecond)
		writeErr(w, 401, "用户名或密码错误")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: m.newSession(req.Username), Path: "/", HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		MaxAge: 7 * 86400,
	})
	writeJSON(w, 200, map[string]string{"username": req.Username})
}

func qInt(r *http.Request, k string, d int64) int64 {
	if v, err := strconv.ParseInt(r.URL.Query().Get(k), 10, 64); err == nil {
		return v
	}
	return d
}

func pathID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		return 0, errors.New("bad id")
	}
	return id, nil
}

func scanRows[T any](m *Master, q string, args []any, fn func(scan func(...any) error) (T, error)) ([]T, error) {
	rows, err := m.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		v, err := fn(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (m *Master) apiEvents(w http.ResponseWriter, r *http.Request) {
	limit := qInt(r, "limit", 100)
	type ev struct {
		TS     int64  `json:"ts"`
		Kind   string `json:"kind"`
		UserID int64  `json:"user_id"`
		User   string `json:"user"`
		NodeID string `json:"node_id"`
		Node   string `json:"node"`
		Detail string `json:"detail"`
	}
	out, err := scanRows(m, `SELECT e.ts, e.kind, e.user_id, COALESCE(u.username,''), e.node_id, COALESCE(n.name,''), e.detail
		FROM events e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN nodes n ON n.id=e.node_id
		ORDER BY e.id DESC LIMIT ?`, []any{limit}, func(s func(...any) error) (ev, error) {
		var e ev
		return e, s(&e.TS, &e.Kind, &e.UserID, &e.User, &e.NodeID, &e.Node, &e.Detail)
	})
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, out)
}

func errf(w http.ResponseWriter, err error) bool {
	if err != nil {
		writeErr(w, 500, err.Error())
		return true
	}
	return false
}

func fmtID(n int64) string { return fmt.Sprint(n) }
