package master

// Subscription-page themes: a zip with sbp-theme.json + index.html + assets, stored under
// {DataDir}/sub-themes/<id>/. The built-in "default" theme is embedded. Theme HTML and every
// theme asset are served with a CSP sandbox (opaque origin): a theme can never see the admin
// session cookie or read /api. See docs/SUB-THEMES.md.

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

//go:embed all:subtheme/default
var embeddedThemes embed.FS

const (
	themeAPIVersion    = 1
	themeManifestName  = "sbp-theme.json"
	themeMaxFiles      = 200
	themeMaxFileSize   = 5 << 20
	themeMaxTotalSize  = 20 << 20
	themeMaxManifest   = 64 << 10
	themeMaxSettings   = 64
	themeSettingsLimit = 32 << 10 // stored JSON per theme
	defaultThemeID     = "default"
)

var (
	themeIDRe      = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{1,39}$`)
	themeKeyRe     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,39}$`)
	themeVersionRe = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$`)
	hexColorRe     = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)
)

// themeCSP is sent with theme HTML and every theme asset. `sandbox` without allow-same-origin gives
// the document an opaque origin: no cookies, no localStorage, /api responses are unreadable.
const themeCSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-top-navigation-to-custom-protocols; " +
	"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; " +
	"connect-src 'self'; media-src 'self' https:; base-uri 'none'; form-action 'none'"

type themeOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type themeSetting struct {
	Key       string          `json:"key,omitempty"`
	Type      string          `json:"type"`
	Label     any             `json:"label,omitempty"`
	Help      any             `json:"help,omitempty"`
	Default   any             `json:"default,omitempty"`
	Options   json.RawMessage `json:"options,omitempty"`
	MaxLength int             `json:"maxLength,omitempty"`
	Min       *float64        `json:"min,omitempty"`
	Max       *float64        `json:"max,omitempty"`
}

type themeManifest struct {
	API         int            `json:"api"`
	ID          string         `json:"id"`
	Name        any            `json:"name"`
	Version     string         `json:"version"`
	Author      string         `json:"author,omitempty"`
	Description any            `json:"description,omitempty"`
	Homepage    string         `json:"homepage,omitempty"`
	License     string         `json:"license,omitempty"`
	Preview     string         `json:"preview,omitempty"`
	Entry       string         `json:"entry,omitempty"`
	Settings    []themeSetting `json:"settings,omitempty"`
}

type subTheme struct {
	themeManifest
	fsys    fs.FS
	builtin bool
}

func (t *subTheme) entry() string {
	if t.Entry == "" {
		return "index.html"
	}
	return t.Entry
}

func (t *subTheme) assetBase() string {
	return "/s/_t/" + url.PathEscape(t.ID+"@"+t.Version)
}

// locText resolves a string-or-map manifest field ({"en": "…", "zh-CN": "…"}) for lang (en / zh):
// the language's own keys first, then the other language, then any value.
func locText(lang string, v any) string {
	order := []string{"en", "en-US", "en-GB", "zh-CN", "zh", "zh-Hans"}
	if lang == langZH {
		order = []string{"zh-CN", "zh", "zh-Hans", "zh-TW", "zh-HK", "zh-Hant", "en", "en-US", "en-GB"}
	}
	switch x := v.(type) {
	case string:
		return x
	case map[string]any:
		for _, k := range order {
			if s, ok := x[k].(string); ok && s != "" {
				return s
			}
		}
		ks := make([]string, 0, len(x))
		for k := range x {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		for _, k := range ks {
			if s, ok := x[k].(string); ok && s != "" {
				return s
			}
		}
	}
	return ""
}

// cleanThemePath accepts a relative slash path inside a theme; "" means rejected.
func cleanThemePath(p string) string {
	if p == "" || strings.ContainsAny(p, "\\\x00:") || strings.HasPrefix(p, "/") {
		return ""
	}
	c := path.Clean(p)
	if c == "." || c == ".." || strings.HasPrefix(c, "../") {
		return ""
	}
	for _, seg := range strings.Split(c, "/") {
		if strings.HasPrefix(seg, ".") {
			return ""
		}
	}
	return c
}

func (mf *themeManifest) validate(has func(string) bool) error {
	if mf.API != themeAPIVersion {
		return fmt.Errorf("Unsupported api version %d (current: %d)", mf.API, themeAPIVersion)
	}
	if !themeIDRe.MatchString(mf.ID) {
		return errors.New("id may contain lowercase letters, digits, - and _ (2-40 characters)")
	}
	if locText(langEN, mf.Name) == "" {
		return errors.New("Missing name")
	}
	if !themeVersionRe.MatchString(mf.Version) {
		return errors.New("Invalid version")
	}
	e := mf.Entry
	if e == "" {
		e = "index.html"
	}
	if cleanThemePath(e) == "" || !strings.HasSuffix(e, ".html") || !has(cleanThemePath(e)) {
		return fmt.Errorf("Entry file %s not found", e)
	}
	if mf.Preview != "" && (cleanThemePath(mf.Preview) == "" || !has(cleanThemePath(mf.Preview))) {
		return fmt.Errorf("Preview image %s not found", mf.Preview)
	}
	if len(mf.Settings) > themeMaxSettings {
		return fmt.Errorf("At most %d settings", themeMaxSettings)
	}
	seen := map[string]bool{}
	for i, s := range mf.Settings {
		switch s.Type {
		case "title":
			continue
		case "text", "textarea", "url", "color", "number", "switch", "select", "multiselect":
		default:
			return fmt.Errorf("Setting #%d: unsupported type %q", i+1, s.Type)
		}
		if !themeKeyRe.MatchString(s.Key) || seen[s.Key] {
			return fmt.Errorf("Setting #%d: key %q is invalid or duplicated", i+1, s.Key)
		}
		seen[s.Key] = true
		if s.Type == "select" || s.Type == "multiselect" {
			if _, err := s.options(nil, langEN); err != nil {
				return fmt.Errorf("Setting %s: %v", s.Key, err)
			}
		}
	}
	return nil
}

// options resolves the option list; "$clients" expands to the built-in client list.
func (s themeSetting) options(clients []themeOption, lang string) ([]themeOption, error) {
	if len(s.Options) == 0 {
		return nil, errors.New("Missing options")
	}
	var ref string
	if json.Unmarshal(s.Options, &ref) == nil {
		if ref == "$clients" {
			return clients, nil
		}
		return nil, fmt.Errorf("Unknown options reference %q", ref)
	}
	var raw []struct {
		Value any `json:"value"`
		Label any `json:"label"`
	}
	if err := json.Unmarshal(s.Options, &raw); err != nil || len(raw) == 0 {
		return nil, errors.New("Invalid options")
	}
	out := make([]themeOption, 0, len(raw))
	for _, o := range raw {
		v := fmt.Sprint(o.Value)
		l := locText(lang, o.Label)
		if l == "" {
			l = v
		}
		out = append(out, themeOption{v, l})
	}
	return out, nil
}

func clientOptions() []themeOption {
	out := make([]themeOption, 0, len(subClients))
	for _, c := range subClients {
		out = append(out, themeOption{c.ID, c.Name})
	}
	return out
}

func readManifest(fsys fs.FS) (themeManifest, error) {
	var mf themeManifest
	f, err := fsys.Open(themeManifestName)
	if err != nil {
		return mf, fmt.Errorf("Missing %s", themeManifestName)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, themeMaxManifest+1))
	if err != nil {
		return mf, err
	}
	if len(b) > themeMaxManifest {
		return mf, fmt.Errorf("%s is too large", themeManifestName)
	}
	if err := json.Unmarshal(b, &mf); err != nil {
		return mf, fmt.Errorf("Invalid %s: %v", themeManifestName, err)
	}
	return mf, nil
}

func (m *Master) themesDir() string { return filepath.Join(m.cfg.DataDir, "sub-themes") }

func builtinTheme() *subTheme {
	sub, err := fs.Sub(embeddedThemes, "subtheme/default")
	if err != nil {
		panic(err)
	}
	mf, err := readManifest(sub)
	if err != nil {
		panic("embedded default theme: " + err.Error())
	}
	return &subTheme{themeManifest: mf, fsys: sub, builtin: true}
}

func (m *Master) loadTheme(id string) (*subTheme, error) {
	if id == "" || id == defaultThemeID {
		return builtinTheme(), nil
	}
	if !themeIDRe.MatchString(id) {
		return nil, errors.New("Theme not found")
	}
	dir := filepath.Join(m.themesDir(), id)
	fsys := os.DirFS(dir)
	mf, err := readManifest(fsys)
	if err != nil {
		return nil, err
	}
	if mf.ID != id {
		return nil, errors.New("Theme folder doesn't match its id")
	}
	return &subTheme{themeManifest: mf, fsys: fsys}, nil
}

func (m *Master) activeThemeID() string { return settingOr(m.db, "sub_theme", defaultThemeID) }

// activeTheme falls back to the built-in theme if the configured one is missing or broken.
func (m *Master) activeTheme() *subTheme {
	if t, err := m.loadTheme(m.activeThemeID()); err == nil {
		return t
	}
	return builtinTheme()
}

func (m *Master) listThemes() []*subTheme {
	out := []*subTheme{builtinTheme()}
	ents, _ := os.ReadDir(m.themesDir())
	for _, e := range ents {
		if !e.IsDir() || e.Name() == defaultThemeID || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if t, err := m.loadTheme(e.Name()); err == nil {
			out = append(out, t)
		}
	}
	return out
}

// ---------- settings ----------

func themeSettingsKey(id string) string { return "sub_theme_settings:" + id }

func (m *Master) savedThemeSettings(id string) map[string]any {
	out := map[string]any{}
	if v, ok := getSetting(m.db, themeSettingsKey(id)); ok {
		json.Unmarshal([]byte(v), &out)
	}
	return out
}

// themeSettings returns the stored values merged over manifest defaults, re-validated so a
// manifest upgrade that changed a type cannot hand the theme a wrong-typed value.
func (m *Master) themeSettings(t *subTheme, override map[string]any) map[string]any {
	saved := m.savedThemeSettings(t.ID)
	for k, v := range override {
		saved[k] = v
	}
	out := map[string]any{}
	opts := clientOptions()
	for _, s := range t.Settings {
		if s.Type == "title" {
			continue
		}
		if v, ok := saved[s.Key]; ok {
			if cv, err := s.coerce(v, opts); err == nil {
				out[s.Key] = cv
				continue
			}
		}
		if s.Default != nil {
			if cv, err := s.coerce(s.Default, opts); err == nil {
				out[s.Key] = cv
				continue
			}
		}
		out[s.Key] = s.zero()
	}
	return out
}

func (s themeSetting) zero() any {
	switch s.Type {
	case "switch":
		return false
	case "number":
		return 0.0
	case "multiselect":
		return []string{}
	}
	return ""
}

func (s themeSetting) coerce(v any, clients []themeOption) (any, error) {
	label := s.Key
	switch s.Type {
	case "text", "textarea", "url", "color":
		str, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("%s must be text", label)
		}
		str = strings.TrimSpace(str)
		limit := s.MaxLength
		if limit <= 0 || limit > 8000 {
			limit = map[string]int{"text": 500, "textarea": 4000, "url": 1000, "color": 7}[s.Type]
		}
		if utf8.RuneCountInString(str) > limit {
			return nil, fmt.Errorf("%s can be at most %d characters", label, limit)
		}
		if s.Type == "url" && str != "" && !strings.HasPrefix(str, "https://") && !strings.HasPrefix(str, "http://") {
			return nil, fmt.Errorf("%s must start with http:// or https://", label)
		}
		if s.Type == "color" && str != "" && !hexColorRe.MatchString(str) {
			return nil, fmt.Errorf("%s must be a #RRGGBB color", label)
		}
		return str, nil
	case "number":
		var f float64
		switch x := v.(type) {
		case float64:
			f = x
		case int:
			f = float64(x)
		case string:
			var err error
			if f, err = strconv.ParseFloat(strings.TrimSpace(x), 64); err != nil {
				return nil, fmt.Errorf("%s must be a number", label)
			}
		default:
			return nil, fmt.Errorf("%s must be a number", label)
		}
		if (s.Min != nil && f < *s.Min) || (s.Max != nil && f > *s.Max) {
			return nil, fmt.Errorf("%s is out of range", label)
		}
		return f, nil
	case "switch":
		b, ok := v.(bool)
		if !ok {
			return nil, fmt.Errorf("%s must be true or false", label)
		}
		return b, nil
	case "select":
		str, ok := v.(string)
		opts, _ := s.options(clients, langEN)
		if !ok || !hasOption(opts, str) {
			return nil, fmt.Errorf("%s is not one of the options", label)
		}
		return str, nil
	case "multiselect":
		arr, ok := v.([]any)
		if !ok {
			if ss, ok2 := v.([]string); ok2 {
				for _, x := range ss {
					arr = append(arr, x)
				}
				ok = true
			}
		}
		if !ok {
			return nil, fmt.Errorf("%s must be a list", label)
		}
		opts, _ := s.options(clients, langEN)
		out := []string{}
		for _, x := range arr {
			str, ok := x.(string)
			if !ok || !hasOption(opts, str) {
				return nil, fmt.Errorf("%s contains an invalid option", label)
			}
			out = append(out, str)
		}
		return out, nil
	}
	return nil, fmt.Errorf("%s has an unknown type", label)
}

func hasOption(opts []themeOption, v string) bool {
	for _, o := range opts {
		if o.Value == v {
			return true
		}
	}
	return false
}

// validateThemeSettings checks an admin-submitted settings object against the schema.
func validateThemeSettings(t *subTheme, in map[string]any) (map[string]any, error) {
	out := map[string]any{}
	opts := clientOptions()
	known := map[string]themeSetting{}
	for _, s := range t.Settings {
		if s.Type != "title" {
			known[s.Key] = s
		}
	}
	for k, v := range in {
		s, ok := known[k]
		if !ok {
			continue // unknown keys are dropped
		}
		cv, err := s.coerce(v, opts)
		if err != nil {
			return nil, err
		}
		out[k] = cv
	}
	return out, nil
}

// ---------- install ----------

func randSuffix() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// inspectThemeZip validates an archive and returns its manifest plus the files to extract
// (keyed by clean relative path). A single wrapping top-level folder is tolerated.
func inspectThemeZip(data []byte) (themeManifest, map[string]*zip.File, error) {
	var mf themeManifest
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return mf, nil, errors.New("Not a valid zip file")
	}
	prefix := ""
	rootManifest := false
	var nested []string
	for _, f := range zr.File {
		n := strings.ReplaceAll(f.Name, "\\", "/")
		if n == themeManifestName {
			rootManifest = true
		} else if strings.HasSuffix(n, "/"+themeManifestName) && strings.Count(n, "/") == 1 && !strings.HasPrefix(n, "__MACOSX/") {
			nested = append(nested, strings.TrimSuffix(n, themeManifestName))
		}
	}
	switch {
	case rootManifest:
	case len(nested) == 1:
		prefix = nested[0]
	default:
		return mf, nil, fmt.Errorf("The zip root is missing %s", themeManifestName)
	}
	files := map[string]*zip.File{}
	var total uint64
	for _, f := range zr.File {
		n := f.Name
		if strings.HasPrefix(n, "__MACOSX/") || strings.HasSuffix(n, "/.DS_Store") || n == ".DS_Store" {
			continue
		}
		if f.FileInfo().IsDir() {
			continue
		}
		if f.Mode()&fs.ModeSymlink != 0 || f.Mode()&fs.ModeType != 0 {
			return mf, nil, fmt.Errorf("Links and special files are not allowed: %s", n)
		}
		if !strings.HasPrefix(n, prefix) {
			return mf, nil, fmt.Errorf("File is outside the theme folder: %s", n)
		}
		rel := cleanThemePath(strings.TrimPrefix(n, prefix))
		if rel == "" || rel != strings.TrimPrefix(n, prefix) {
			return mf, nil, fmt.Errorf("Invalid file path: %s", n)
		}
		if f.UncompressedSize64 > themeMaxFileSize {
			return mf, nil, fmt.Errorf("File too large (max %d MB each): %s", themeMaxFileSize>>20, rel)
		}
		total += f.UncompressedSize64
		if total > themeMaxTotalSize {
			return mf, nil, fmt.Errorf("Unpacked size exceeds %d MB", themeMaxTotalSize>>20)
		}
		if _, dup := files[rel]; dup {
			return mf, nil, fmt.Errorf("Duplicate file: %s", rel)
		}
		files[rel] = f
		if len(files) > themeMaxFiles {
			return mf, nil, fmt.Errorf("More than %d files", themeMaxFiles)
		}
	}
	mfFile := files[themeManifestName]
	rc, err := mfFile.Open()
	if err != nil {
		return mf, nil, err
	}
	b, err := io.ReadAll(io.LimitReader(rc, themeMaxManifest+1))
	rc.Close()
	if err != nil || len(b) > themeMaxManifest {
		return mf, nil, fmt.Errorf("%s is unreadable or too large", themeManifestName)
	}
	if err := json.Unmarshal(b, &mf); err != nil {
		return mf, nil, fmt.Errorf("Invalid %s: %v", themeManifestName, err)
	}
	if mf.ID == defaultThemeID {
		return mf, nil, errors.New("id \"default\" is reserved for the built-in theme")
	}
	if err := mf.validate(func(p string) bool { _, ok := files[p]; return ok }); err != nil {
		return mf, nil, err
	}
	return mf, files, nil
}

// installTheme extracts into a temp dir next to the target and swaps it in.
func (m *Master) installTheme(data []byte) (themeManifest, error) {
	mf, files, err := inspectThemeZip(data)
	if err != nil {
		return mf, err
	}
	root := m.themesDir()
	if err := os.MkdirAll(root, 0o755); err != nil {
		return mf, err
	}
	tmp := filepath.Join(root, ".tmp-"+randSuffix())
	defer os.RemoveAll(tmp)
	for rel, f := range files {
		dst := filepath.Join(tmp, filepath.FromSlash(rel))
		if !strings.HasPrefix(dst, tmp+string(os.PathSeparator)) {
			return mf, fmt.Errorf("Invalid file path: %s", rel)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return mf, err
		}
		if err := extractZipFile(f, dst); err != nil {
			return mf, fmt.Errorf("Failed to extract %s: %v", rel, err)
		}
	}
	final := filepath.Join(root, mf.ID)
	old := filepath.Join(root, ".old-"+randSuffix())
	if _, err := os.Stat(final); err == nil {
		if err := os.Rename(final, old); err != nil {
			return mf, err
		}
		defer os.RemoveAll(old)
	}
	if err := os.Rename(tmp, final); err != nil {
		os.Rename(old, final)
		return mf, err
	}
	return mf, nil
}

func extractZipFile(f *zip.File, dst string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(rc, themeMaxFileSize+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > themeMaxFileSize {
		err = errors.New("File too large")
	}
	return err
}

// ---------- serving ----------

func setThemeHeaders(h http.Header, csp string) {
	h.Set("Content-Security-Policy", csp)
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Robots-Tag", "noindex, nofollow")
}

var (
	inlineCSSRe = regexp.MustCompile(`<link\s+rel="stylesheet"\s+href="%SBP_ASSETS%/([^"]+)"\s*/?>`)
	inlineJSRe  = regexp.MustCompile(`<script\s+src="%SBP_ASSETS%/([^"]+)"(?:\s+defer)?\s*></script>`)
	cssURLRe    = regexp.MustCompile(`url\(\s*['"]?([^'")\s]+)`)
)

const themeInlineMax = 512 << 10

// inlineAssets replaces the theme's own <link rel=stylesheet> / <script src> tags with their content:
// one round trip on slow mobile networks, and the page still works where sub-resource loads from
// an opaque-origin document are filtered. Files that cannot be inlined safely keep their tag.
func inlineAssets(t *subTheme, page, nonce string) string {
	read := func(rel string) (string, bool) {
		rel = cleanThemePath(rel)
		if rel == "" {
			return "", false
		}
		b, err := fs.ReadFile(t.fsys, rel)
		if err != nil || len(b) > themeInlineMax {
			return "", false
		}
		return string(b), true
	}
	page = inlineCSSRe.ReplaceAllStringFunc(page, func(tag string) string {
		css, ok := read(inlineCSSRe.FindStringSubmatch(tag)[1])
		if !ok || strings.Contains(strings.ToLower(css), "</style") {
			return tag
		}
		for _, m := range cssURLRe.FindAllStringSubmatch(css, -1) {
			if !strings.HasPrefix(m[1], "data:") && !strings.HasPrefix(m[1], "#") {
				return tag // relative url() would resolve against /s/<token>
			}
		}
		return "<style>" + css + "</style>"
	})
	return inlineJSRe.ReplaceAllStringFunc(page, func(tag string) string {
		js, ok := read(inlineJSRe.FindStringSubmatch(tag)[1])
		if !ok || strings.Contains(strings.ToLower(js), "</script") {
			return tag
		}
		return `<script nonce="` + nonce + `">` + js + "</script>"
	})
}

func newNonce() string {
	b := make([]byte, 16)
	rand.Read(b)
	return base64.StdEncoding.EncodeToString(b)
}

// renderTheme writes the theme's entry page with the data object embedded. csp is themeCSP plus
// frame-ancestors; the per-response nonce is added for inlined scripts.
func renderTheme(w http.ResponseWriter, t *subTheme, data subPageData, frameAncestors string) error {
	b, err := fs.ReadFile(t.fsys, t.entry())
	if err != nil {
		return err
	}
	js, err := json.Marshal(data) // escapes <, >, & and U+2028/9, so it cannot close the script tag
	if err != nil {
		return err
	}
	nonce := newNonce()
	page := inlineAssets(t, string(b), nonce)
	page = strings.Replace(page, "%SBP_DATA%", `<script id="sbp-data" type="application/json">`+string(js)+`</script>`, 1)
	page = strings.ReplaceAll(page, "%SBP_ASSETS%", t.assetBase())
	page = strings.ReplaceAll(page, "%SBP_LANG%", data.Locale)
	csp := strings.Replace(themeCSP, "script-src 'self'", "script-src 'self' 'nonce-"+nonce+"'", 1) + "; frame-ancestors " + frameAncestors
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Language", data.Locale)
	h.Set("Vary", "Accept-Language")
	setThemeHeaders(h, csp)
	_, err = io.WriteString(w, page)
	return err
}

// handleThemeAsset serves /s/_t/{ref}/{path...}; ref is "<id>@<version>" (the version only busts caches).
func (m *Master) handleThemeAsset(w http.ResponseWriter, r *http.Request) {
	ref := r.PathValue("ref")
	id, ver, _ := strings.Cut(ref, "@")
	rel := cleanThemePath(r.PathValue("path"))
	t, err := m.loadTheme(id)
	if err != nil || rel == "" {
		http.NotFound(w, r)
		return
	}
	b, err := fs.ReadFile(t.fsys, rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ct := mime.TypeByExtension(path.Ext(rel))
	if ct == "" {
		ct = "application/octet-stream"
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("Access-Control-Allow-Origin", "*") // the page origin is opaque ("null"); module scripts need CORS
	if ver == t.Version {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "no-cache")
	}
	setThemeHeaders(h, themeCSP)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(b))
}

// ---------- admin API ----------

type themeInfo struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Version     string         `json:"version"`
	Author      string         `json:"author"`
	Description string         `json:"description"`
	Homepage    string         `json:"homepage"`
	License     string         `json:"license"`
	Builtin     bool           `json:"builtin"`
	Active      bool           `json:"active"`
	PreviewURL  *string        `json:"preview_url"` // built from the manifest's "preview"; null when absent
	Schema      []any          `json:"schema"`
	Settings    map[string]any `json:"settings"`
}

func (m *Master) themeInfo(t *subTheme, active, lang string) themeInfo {
	ti := themeInfo{ID: t.ID, Name: locText(lang, t.Name), Version: t.Version, Author: t.Author, Description: locText(lang, t.Description),
		Homepage: t.Homepage, License: t.License, Builtin: t.builtin, Active: t.ID == active, Schema: []any{}, Settings: m.themeSettings(t, nil)}
	if p := cleanThemePath(t.Preview); p != "" {
		if _, err := fs.Stat(t.fsys, p); err == nil {
			u := t.assetBase() + "/" + p
			ti.PreviewURL = &u
		}
	}
	opts := clientOptions()
	for _, s := range t.Settings {
		item := map[string]any{"type": s.Type, "label": locText(lang, s.Label), "help": locText(lang, s.Help)}
		if s.Key != "" {
			item["key"] = s.Key
			item["default"] = s.Default
		}
		if s.MaxLength > 0 {
			item["maxLength"] = s.MaxLength
		}
		if s.Min != nil {
			item["min"] = *s.Min
		}
		if s.Max != nil {
			item["max"] = *s.Max
		}
		if s.Type == "select" || s.Type == "multiselect" {
			o, _ := s.options(opts, lang)
			item["options"] = o
		}
		ti.Schema = append(ti.Schema, item)
	}
	return ti
}

func (m *Master) apiSubThemes(w http.ResponseWriter, r *http.Request) {
	active := m.activeTheme().ID
	out := []themeInfo{}
	for _, t := range m.listThemes() {
		out = append(out, m.themeInfo(t, active, reqLang(r)))
	}
	writeJSON(w, 200, out)
}

func (m *Master) apiUploadSubTheme(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, themeMaxTotalSize+(1<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeErr(w, 400, "Upload failed: the file must be a zip of at most 20 MB")
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, 400, "Missing file")
		return
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if r.URL.Query().Get("dry_run") == "1" {
		mf, _, err := inspectThemeZip(data)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"id": mf.ID, "name": locText(reqLang(r), mf.Name), "version": mf.Version, "dry_run": true})
		return
	}
	mf, err := m.installTheme(data)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	m.audit(r, "sub_theme.install", mf.ID, mf.Version)
	t, err := m.loadTheme(mf.ID)
	if errf(w, err) {
		return
	}
	writeJSON(w, 200, m.themeInfo(t, m.activeTheme().ID, reqLang(r)))
}

func (m *Master) apiActivateSubTheme(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if _, err := m.loadTheme(req.ID); err != nil {
		writeErr(w, 404, "Theme not found")
		return
	}
	if req.ID == "" {
		req.ID = defaultThemeID
	}
	setSetting(m.db, "sub_theme", req.ID)
	m.audit(r, "sub_theme.activate", req.ID, "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (m *Master) apiSaveSubThemeSettings(w http.ResponseWriter, r *http.Request) {
	t, err := m.loadTheme(r.PathValue("id"))
	if err != nil {
		writeErr(w, 404, "Theme not found")
		return
	}
	var in map[string]any
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	out, err := validateThemeSettings(t, in)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	b, _ := json.Marshal(out)
	if len(b) > themeSettingsLimit {
		writeErr(w, 400, "Settings are too large")
		return
	}
	setSetting(m.db, themeSettingsKey(t.ID), string(b))
	m.audit(r, "sub_theme.settings", t.ID, "")
	writeJSON(w, 200, m.themeSettings(t, nil))
}

func (m *Master) apiDeleteSubTheme(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == defaultThemeID {
		writeErr(w, 400, "The built-in theme can't be deleted")
		return
	}
	if !themeIDRe.MatchString(id) {
		writeErr(w, 404, "Theme not found")
		return
	}
	dir := filepath.Join(m.themesDir(), id)
	if _, err := os.Stat(dir); err != nil {
		writeErr(w, 404, "Theme not found")
		return
	}
	if err := os.RemoveAll(dir); errf(w, err) {
		return
	}
	m.db.Exec(`DELETE FROM settings WHERE k=?`, themeSettingsKey(id))
	if m.activeThemeID() == id {
		setSetting(m.db, "sub_theme", defaultThemeID)
	}
	m.audit(r, "sub_theme.delete", id, "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// apiPreviewSubTheme renders a theme with a synthetic user for the admin's preview iframe.
// ?settings=<json> previews unsaved settings; ?state=limited|expired shows other sample states;
// ?user=<id> renders that user's real page instead of the sample.
func (m *Master) apiPreviewSubTheme(w http.ResponseWriter, r *http.Request) {
	t, err := m.loadTheme(r.PathValue("id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	var override map[string]any
	if s := r.URL.Query().Get("settings"); s != "" {
		var in map[string]any
		if json.Unmarshal([]byte(s), &in) == nil {
			override, _ = validateThemeSettings(t, in)
		}
	}
	var data subPageData
	if uid := r.URL.Query().Get("user"); uid != "" {
		// A real user's page, as they would see it, but with this theme and the unsaved settings.
		var token string
		if err := m.db.QueryRow(`SELECT sub_token FROM users WHERE id=?`, uid).Scan(&token); err != nil {
			http.NotFound(w, r)
			return
		}
		u, err := m.loadSubUser(token)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		var es []subEntry
		if u.active() {
			if es, err = m.subEntries(u); errf(w, err) {
				return
			}
		}
		data = m.subData(r, u, es, t)
		data.Theme.Settings = m.themeSettings(t, override)
	} else {
		data = m.previewData(r, t, override, r.URL.Query().Get("state"))
	}
	// Allow framing by the panel itself; still sandboxed.
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	renderTheme(w, t, data, "'self'")
}
