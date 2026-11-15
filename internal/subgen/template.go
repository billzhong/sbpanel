package subgen

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Template language: literal substitution only, no logic, no function calls.
//
//	{{name}}       a generated section (block) or scalar
//	{{opt.key}}    a client option (ClientTemplate.Options, then defaults)
//
// A block placeholder that is alone on its line is re-indented to that line's
// indentation, so it can sit inside YAML mappings. Unknown placeholders are an
// error, as are missing required ones. Values never get re-scanned, so user
// data (node names, remarks) cannot inject placeholders.
var phRe = regexp.MustCompile(`\{\{\s*([a-z_][a-z0-9_.]*)\s*\}\}`)

var optRe = regexp.MustCompile(`^[A-Za-z0-9._:/\-\[\]]*$`)

// Placeholders documents what each client offers (for the UI palette).
var Placeholders = map[string][]string{
	"mihomo":  {"proxies", "proxy_groups", "rule_providers", "rules", "dns"},
	"singbox": {"outbounds", "route_rules", "rule_set", "final", "dns"},
	"surge":   {"proxies", "proxy_groups", "rules", "dns", "sub_url"},
}

// Required placeholders per client.
var Required = map[string][]string{
	"mihomo":  {"proxies", "proxy_groups", "rules"},
	"singbox": {"outbounds", "route_rules", "final"},
	"surge":   {"proxies", "proxy_groups", "rules"},
}

func render(client, base string, vals map[string]string, opts map[string]string) (string, error) {
	used := map[string]bool{}
	var errs []string
	lines := strings.Split(base, "\n")
	for i, ln := range lines {
		// whole-line block placeholder: re-indent
		if m := phRe.FindStringSubmatch(strings.TrimSpace(ln)); m != nil && m[0] == strings.TrimSpace(ln) {
			if v, ok := vals[m[1]]; ok {
				used[m[1]] = true
				ind := ln[:len(ln)-len(strings.TrimLeft(ln, " \t"))]
				vl := strings.Split(strings.TrimRight(v, "\n"), "\n")
				for j := range vl {
					if vl[j] != "" {
						vl[j] = ind + vl[j]
					}
				}
				lines[i] = strings.Join(vl, "\n")
				continue
			}
		}
		lineInd := ln[:len(ln)-len(strings.TrimLeft(ln, " \t"))]
		lines[i] = phRe.ReplaceAllStringFunc(ln, func(s string) string {
			k := phRe.FindStringSubmatch(s)[1]
			if strings.HasPrefix(k, "opt.") {
				v, ok := opts[k[4:]]
				if !ok {
					errs = append(errs, "Undefined option "+k)
					return s
				}
				if !optRe.MatchString(v) {
					errs = append(errs, "Option value contains invalid characters: "+k)
					return s
				}
				return v
			}
			v, ok := vals[k]
			if !ok {
				errs = append(errs, "Unknown placeholder {{"+k+"}}")
				return s
			}
			used[k] = true
			return strings.ReplaceAll(v, "\n", "\n"+lineInd) // keep multi-line values aligned
		})
	}
	for _, r := range Required[client] {
		if !used[r] {
			errs = append(errs, "Missing required placeholder {{"+r+"}}")
		}
	}
	if len(errs) > 0 {
		sort.Strings(errs)
		return "", fmt.Errorf("Template error: %s", strings.Join(errs, "; "))
	}
	return strings.Join(lines, "\n"), nil
}

func mergeOpts(def, over map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range def {
		out[k] = v
	}
	for k, v := range over {
		out[k] = v
	}
	return out
}
