package master

import (
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// Backend i18n. Messages are written in English in the source (the English text is the key,
// gettext style) and zhCatalog maps them to Simplified Chinese. English is the fallback for
// every language and for any message missing from the catalog.
//
// The language of an /api request comes from reqLang: the X-Lang header the web UI sends on
// every call, else Accept-Language. withLang records it in the response's Content-Language
// header, which is how writeErr (and anything else holding only the ResponseWriter) finds it.
//
// Formatted messages use their format string as the key ("Node %s not found"), so stored
// English text (event details, probe results) can be translated when it is read back: L
// matches a message against the catalog's formats and re-renders the captured arguments
// into the Chinese format. Indexed verbs (%[2]s) let a translation reorder them.

const (
	langEN = "en"
	langZH = "zh"
)

// langFromTag maps a BCP 47 tag (zh, zh-CN, zh-TW, zh-Hant-HK, en-US, …) to en / zh.
func langFromTag(tag string) string {
	tag = strings.ToLower(strings.TrimSpace(tag))
	if tag == "zh" || strings.HasPrefix(tag, "zh-") || strings.HasPrefix(tag, "zh_") {
		return langZH
	}
	return langEN
}

// acceptLang picks en / zh from the first (highest-priority) Accept-Language tag.
func acceptLang(h string) string {
	first, _, _ := strings.Cut(h, ",")
	first, _, _ = strings.Cut(first, ";")
	return langFromTag(first)
}

// reqLang is the language of an API request: X-Lang, else Accept-Language, else English.
func reqLang(r *http.Request) string {
	if v := r.Header.Get("X-Lang"); v != "" {
		return langFromTag(v)
	}
	return acceptLang(r.Header.Get("Accept-Language"))
}

// withLang tags /api responses with the caller's language (Content-Language) so handlers and
// writeErr can localize messages without threading the request through.
func withLang(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Content-Language", contentLanguage(reqLang(r)))
		}
		h.ServeHTTP(w, r)
	})
}

func contentLanguage(lang string) string {
	if lang == langZH {
		return "zh-CN"
	}
	return "en"
}

// langOf reads back the language withLang recorded on the response.
func langOf(w http.ResponseWriter) string {
	return langFromTag(w.Header().Get("Content-Language"))
}

// T formats a message in lang; format is the English text and the catalog key.
func T(lang, format string, args ...any) string {
	if lang == langZH {
		if zh, ok := zhCatalog[format]; ok {
			format = zh
		}
	}
	if len(args) == 0 {
		return format
	}
	return fmt.Sprintf(format, args...)
}

// L translates an already-rendered English message (e.g. err.Error(), a stored event detail).
// It tries an exact match, then the catalog's formats, then " · " / "; "-separated parts on their own.
// For English it only touches text containing Chinese: rows stored before the backend was
// localized (event details, probe results, cert issuers) are mapped back through the same
// catalog. Unknown text is returned unchanged.
func L(lang, s string) string {
	if s == "" {
		return s
	}
	if lang != langZH {
		if !hasHan(s) {
			return s
		}
		return untranslate(s, 0)
	}
	return translate(s, 0)
}

func hasHan(s string) bool {
	for _, r := range s {
		if r >= 0x3400 && r <= 0x9fff {
			return true
		}
	}
	return false
}

func translate(s string, depth int) string {
	if zh, ok := zhCatalog[s]; ok {
		return zh
	}
	if depth > 3 {
		return s
	}
	// A " · "-joined message is several messages, unless a format spells the separator out.
	joined := strings.Contains(s, " · ")
	for _, p := range catalogPatterns() {
		if joined && !p.dot {
			continue
		}
		m := p.re.FindStringSubmatch(s)
		if m == nil {
			continue
		}
		args := make([]any, len(m)-1)
		for i, a := range m[1:] {
			args[i] = translate(a, depth+1)
		}
		return fmt.Sprintf(p.zh, args...)
	}
	for _, sep := range []string{" · ", "; "} {
		if strings.Contains(s, sep) {
			parts := strings.Split(s, sep)
			for i, p := range parts {
				parts[i] = translate(p, depth+1)
			}
			return strings.Join(parts, sep)
		}
	}
	return s
}

// untranslate is translate in reverse (zh → en), for legacy stored Chinese text.
func untranslate(s string, depth int) string {
	revOnce.Do(buildReverse)
	if en, ok := enCatalog[s]; ok {
		return en
	}
	if depth > 3 {
		return s
	}
	joined := strings.Contains(s, " · ")
	for _, p := range revPats {
		if joined && !p.dot {
			continue
		}
		m := p.re.FindStringSubmatch(s)
		if m == nil {
			continue
		}
		args := make([]any, p.n)
		for i := range args {
			args[i] = ""
		}
		for i, a := range m[1:] {
			if k := p.idx[i]; k < len(args) {
				args[k] = untranslate(a, depth+1)
			}
		}
		return fmt.Sprintf(p.en, args...)
	}
	for _, sep := range []string{" · ", "；", "; "} {
		if strings.Contains(s, sep) {
			parts := strings.Split(s, sep)
			for i, p := range parts {
				parts[i] = untranslate(p, depth+1)
			}
			return strings.Join(parts, sep)
		}
	}
	return s
}

type revPattern struct {
	re  *regexp.Regexp
	en  string // English format with every verb rewritten to %[n]s
	idx []int  // capture group i → argument index
	n   int    // number of arguments
	lit int
	dot bool
}

var (
	revOnce   sync.Once
	enCatalog map[string]string
	revPats   []revPattern
)

func buildReverse() {
	enCatalog = make(map[string]string, len(zhCatalog))
	for en, zh := range zhCatalog {
		if !verbRe.MatchString(en) {
			if _, dup := enCatalog[zh]; !dup {
				enCatalog[zh] = en
			}
			continue
		}
		var b strings.Builder
		b.WriteString("^")
		var idx []int
		lit, last, seq := 0, 0, 0
		for _, loc := range verbRe.FindAllStringIndex(zh, -1) {
			b.WriteString(regexp.QuoteMeta(zh[last:loc[0]]))
			lit += loc[0] - last
			v := zh[loc[0]:loc[1]]
			if v == "%%" {
				b.WriteString("%")
			} else {
				k := seq
				if strings.HasPrefix(v, "%[") {
					fmt.Sscanf(v, "%%[%d]", &k)
					k--
				}
				seq = k + 1
				idx = append(idx, k)
				b.WriteString("(.+?)")
			}
			last = loc[1]
		}
		b.WriteString(regexp.QuoteMeta(zh[last:]))
		lit += len(zh) - last
		b.WriteString("$")
		re, err := regexp.Compile(b.String())
		if err != nil {
			continue
		}
		n, seqEN := 0, 0
		e := verbRe.ReplaceAllStringFunc(en, func(v string) string {
			if v == "%%" {
				return v
			}
			k := seqEN
			if strings.HasPrefix(v, "%[") {
				fmt.Sscanf(v, "%%[%d]", &k)
				k--
			}
			seqEN = k + 1
			if k+1 > n {
				n = k + 1
			}
			return fmt.Sprintf("%%[%d]s", k+1)
		})
		for _, k := range idx {
			if k+1 > n {
				n = k + 1
			}
		}
		revPats = append(revPats, revPattern{re: re, en: e, idx: idx, n: n, lit: lit, dot: strings.Contains(zh, " · ")})
	}
	sort.Slice(revPats, func(i, j int) bool { return revPats[i].lit > revPats[j].lit })
}

type catPattern struct {
	re  *regexp.Regexp
	zh  string // Chinese format with every verb rewritten to %s / %[n]s
	lit int    // literal length, to try more specific patterns first
	dot bool   // the format itself contains " · "
}

var (
	patOnce sync.Once
	pats    []catPattern
	verbRe  = regexp.MustCompile(`%%|%(\[\d+\])?[-+# 0]*\d*(\.\d+)?[a-zA-Z]`)
)

func catalogPatterns() []catPattern {
	patOnce.Do(func() {
		for en, zh := range zhCatalog {
			if !verbRe.MatchString(en) {
				continue
			}
			var b strings.Builder
			b.WriteString("^")
			lit, last := 0, 0
			for _, loc := range verbRe.FindAllStringIndex(en, -1) {
				b.WriteString(regexp.QuoteMeta(en[last:loc[0]]))
				lit += loc[0] - last
				if en[loc[0]:loc[1]] == "%%" {
					b.WriteString("%")
				} else {
					b.WriteString("(.+?)")
				}
				last = loc[1]
			}
			b.WriteString(regexp.QuoteMeta(en[last:]))
			lit += len(en) - last
			b.WriteString("$")
			re, err := regexp.Compile(b.String())
			if err != nil {
				continue
			}
			z := verbRe.ReplaceAllStringFunc(zh, func(v string) string {
				if v == "%%" {
					return v
				}
				if i := strings.Index(v, "]"); strings.HasPrefix(v, "%[") && i > 0 {
					return v[:i+1] + "s"
				}
				return "%s"
			})
			pats = append(pats, catPattern{re: re, zh: z, lit: lit, dot: strings.Contains(en, " · ")})
		}
		sort.Slice(pats, func(i, j int) bool { return pats[i].lit > pats[j].lit })
	})
	return pats
}

// writeErrf writes a localized, formatted error: the format string is the catalog key.
// String and error arguments are translated too (L), so a wrapped English error reads in zh.
func writeErrf(w http.ResponseWriter, code int, format string, args ...any) {
	lang := langOf(w)
	for i, a := range args {
		switch v := a.(type) {
		case string:
			args[i] = L(lang, v)
		case error:
			args[i] = L(lang, v.Error())
		}
	}
	writeJSON(w, code, map[string]string{"error": T(lang, format, args...)})
}

// localizeAll translates a list of messages (never nil, so it encodes as []).
func localizeAll(lang string, ms []string) []string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = L(lang, m)
	}
	return out
}
