package subgen

import (
	"fmt"
	"strings"
)

// CatalogItem maps a well-known category onto public rule sources.
//
//	mihomo : MetaCubeX/meta-rules-dat "meta" branch (.mrs)
//	singbox: MetaCubeX/meta-rules-dat "sing" branch (.srs)
//	surge  : blackmatrix7/ios_rule_script rule/Surge/<Name>/<Name>.list
//
// All GPL-family repos; we reference URLs, never vendor the data.
type CatalogItem struct {
	Key, Label, Kind string   // Kind: streaming | ai | ads | cn | private | service | global | games
	Geosite          string   // geosite name ("" = none)
	Geoip            string   // geoip name ("" = none)
	Surge            []string // blackmatrix7 list names
	SurgeGeoIP       string   // native Surge GEOIP country code, e.g. "CN"
}

var Catalog = map[string]CatalogItem{}

func init() {
	for _, c := range []CatalogItem{
		{"private", "LAN / private addresses", "private", "private", "private", []string{"Lan"}, ""},
		{"ads", "Ad blocking", "ads", "category-ads-all", "", []string{"AdvertisingLite"}, ""},
		{"cn", "Mainland China", "cn", "cn", "cn", []string{"China"}, "CN"},
		{"global", "Outside mainland China", "global", "geolocation-!cn", "", []string{"Global"}, ""},
		{"netflix", "Netflix", "streaming", "netflix", "netflix", []string{"Netflix"}, ""},
		{"disney", "Disney+", "streaming", "disney", "", []string{"Disney"}, ""},
		{"youtube", "YouTube", "streaming", "youtube", "", []string{"YouTube"}, ""},
		{"spotify", "Spotify", "streaming", "spotify", "", []string{"Spotify"}, ""},
		{"tiktok", "TikTok", "streaming", "tiktok", "", []string{"TikTok"}, ""},
		{"hbo", "HBO Max", "streaming", "hbo", "", []string{"HBO"}, ""},
		{"primevideo", "Prime Video", "streaming", "primevideo", "", []string{"PrimeVideo"}, ""},
		{"bahamut", "Bahamut", "streaming", "bahamut", "", []string{"Bahamut"}, ""},
		{"ai", "AI services (OpenAI/Claude/Gemini/Copilot…)", "ai", "category-ai-!cn", "", []string{"OpenAI", "Claude", "Gemini", "Copilot"}, ""},
		{"openai", "OpenAI", "ai", "openai", "", []string{"OpenAI"}, ""},
		{"anthropic", "Claude / Anthropic", "ai", "anthropic", "", []string{"Claude"}, ""},
		{"gemini", "Google Gemini", "ai", "google-gemini", "", []string{"Gemini"}, ""},
		{"telegram", "Telegram", "service", "telegram", "telegram", []string{"Telegram"}, ""},
		{"apple", "Apple", "service", "apple", "", []string{"Apple"}, ""},
		{"microsoft", "Microsoft", "service", "microsoft", "", []string{"Microsoft"}, ""},
		{"google", "Google", "service", "google", "", []string{"Google"}, ""},
		{"github", "GitHub", "service", "github", "", []string{"GitHub"}, ""},
		{"games", "Game platforms", "games", "category-games", "", []string{"Game"}, ""},
	} {
		Catalog[c.Key] = c
	}
}

// remoteRef is one concrete downloadable list for one client.
type remoteRef struct {
	Tag      string // unique id inside the generated config
	URL      string
	Behavior string // domain | ipcidr | classical
	Format   string // mrs | yaml | text | binary | source | list
	IPRule   bool
}

const (
	metaBase = "https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo"
	singBase = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo"
	bm7Base  = "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge"
)

// remotesFor resolves a remote Source into concrete lists for a client.
// Explicit URLs win over the catalogue. Returns nil when the client has no
// source (caller records a warning and skips the rule).
func remotesFor(client string, rs RuleSet, mirror string) []remoteRef {
	out := remotesRaw(client, rs)
	for i := range out {
		out[i].URL = Mirrored(mirror, out[i].URL)
	}
	return out
}

// Mirrored prefixes GitHub-hosted URLs with a mirror (ghproxy style:
// "https://mirror.example/" + "https://raw.githubusercontent.com/...").
func Mirrored(mirror, u string) string {
	if mirror == "" {
		return u
	}
	for _, h := range []string{"https://github.com/", "https://raw.githubusercontent.com/", "https://gist.githubusercontent.com/"} {
		if strings.HasPrefix(u, h) {
			return mirror + u
		}
	}
	return u
}

func remotesRaw(client string, rs RuleSet) []remoteRef {
	src := rs.Remote
	if u := src.URLs[client]; u != "" {
		b := src.Behavior
		if b == "" {
			b = "classical"
		}
		f := map[string]string{"mihomo": "yaml", "singbox": "binary", "surge": "list"}[client]
		switch {
		case hasSuffix(u, ".mrs"):
			f = "mrs"
		case hasSuffix(u, ".txt"), hasSuffix(u, ".list"):
			if client == "mihomo" {
				f = "text"
			}
		case hasSuffix(u, ".json"):
			f = "source"
		}
		return []remoteRef{{Tag: rs.ID, URL: u, Behavior: b, Format: f, IPRule: b == "ipcidr"}}
	}
	c, ok := Catalog[src.Catalog]
	if !ok {
		return nil
	}
	var out []remoteRef
	switch client {
	case "mihomo", "singbox":
		base, ext, f := metaBase, "mrs", "mrs"
		if client == "singbox" {
			base, ext, f = singBase, "srs", "binary"
		}
		if c.Geosite != "" {
			out = append(out, remoteRef{Tag: rs.ID + "-site", URL: fmt.Sprintf("%s/geosite/%s.%s", base, c.Geosite, ext), Behavior: "domain", Format: f})
		}
		if c.Geoip != "" {
			out = append(out, remoteRef{Tag: rs.ID + "-ip", URL: fmt.Sprintf("%s/geoip/%s.%s", base, c.Geoip, ext), Behavior: "ipcidr", Format: f, IPRule: true})
		}
	case "surge":
		for _, n := range c.Surge {
			out = append(out, remoteRef{Tag: rs.ID + "-" + n, URL: fmt.Sprintf("%s/%s/%s.list", bm7Base, n, n), Behavior: "classical", Format: "list"})
		}
	}
	return out
}

func hasSuffix(s, suf string) bool { return strings.HasSuffix(strings.SplitN(s, "?", 2)[0], suf) }
