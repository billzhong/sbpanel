package master

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/libdns/libdns"
)

const cloudflareAPI = "https://api.cloudflare.com/client/v4"

// cfClient is a minimal Cloudflare v4 API client: token verification, zones and
// DNS records. The base URL is configurable so tests run against httptest.
type cfClient struct {
	base, token string
	hc          *http.Client
}

func (m *Master) cfClient(token string) *cfClient {
	base := m.cfg.CloudflareAPI
	if base == "" {
		base = cloudflareAPI
	}
	return &cfClient{base: strings.TrimRight(base, "/"), token: token, hc: &http.Client{Timeout: 20 * time.Second}}
}

type cfZone struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type cfRecord struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Proxied bool   `json:"proxied"`
	TTL     int    `json:"ttl,omitempty"`
	Comment string `json:"comment,omitempty"`
}

type cfError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type cfEnvelope struct {
	Success    bool            `json:"success"`
	Errors     []cfError       `json:"errors"`
	Result     json.RawMessage `json:"result"`
	ResultInfo struct {
		Page       int `json:"page"`
		TotalPages int `json:"total_pages"`
	} `json:"result_info"`
}

// cfAPIError explains the common failure modes in Chinese.
type cfAPIError struct {
	Status int
	Errs   []cfError
}

func (e *cfAPIError) Error() string {
	var parts []string
	for _, x := range e.Errs {
		parts = append(parts, fmt.Sprintf("%d %s", x.Code, x.Message))
	}
	msg := strings.Join(parts, "; ")
	switch {
	case e.Status == 401 || e.Status == 403 && len(e.Errs) > 0 && e.Errs[0].Code == 1000:
		return "Cloudflare 拒绝了令牌（无效或已撤销）：" + msg
	case e.Status == 403:
		return "令牌权限不足（需要 Zone:Read 与 DNS:Edit）：" + msg
	case e.Status == 429:
		return "Cloudflare 限流，请稍后重试"
	}
	if msg == "" {
		msg = fmt.Sprintf("HTTP %d", e.Status)
	}
	return "Cloudflare: " + msg
}

func (c *cfClient) do(ctx context.Context, method, path string, body any) (*cfEnvelope, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接 Cloudflare API: %s", strings.ReplaceAll(err.Error(), c.token, "***"))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	var env cfEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("Cloudflare: HTTP %d, unexpected response", resp.StatusCode)
	}
	if !env.Success || resp.StatusCode >= 300 {
		return nil, &cfAPIError{Status: resp.StatusCode, Errs: env.Errors}
	}
	return &env, nil
}

// Verify checks that the token is active. Account-owned tokens can't use the user
// verify endpoint, so a token that can list zones counts as verified too.
func (c *cfClient) Verify(ctx context.Context) error {
	env, err := c.do(ctx, "GET", "/user/tokens/verify", nil)
	if err == nil {
		var r struct{ Status string }
		json.Unmarshal(env.Result, &r)
		if r.Status != "" && r.Status != "active" {
			return fmt.Errorf("令牌状态为 %s（不是 active）", r.Status)
		}
		return nil
	}
	if _, zerr := c.Zones(ctx); zerr == nil {
		return nil
	}
	return err
}

func (c *cfClient) Zones(ctx context.Context) ([]cfZone, error) {
	var out []cfZone
	for page := 1; page <= 20; page++ {
		env, err := c.do(ctx, "GET", fmt.Sprintf("/zones?per_page=50&page=%d", page), nil)
		if err != nil {
			return nil, err
		}
		var zs []cfZone
		if err := json.Unmarshal(env.Result, &zs); err != nil {
			return nil, err
		}
		out = append(out, zs...)
		if env.ResultInfo.TotalPages <= page {
			break
		}
	}
	return out, nil
}

// Records lists DNS records of a zone; name (FQDN) and typ narrow the list.
func (c *cfClient) Records(ctx context.Context, zoneID, name, typ string) ([]cfRecord, error) {
	q := url.Values{"per_page": {"100"}}
	if name != "" {
		q.Set("name", name)
	}
	if typ != "" {
		q.Set("type", typ)
	}
	var out []cfRecord
	for page := 1; page <= 50; page++ {
		q.Set("page", fmt.Sprint(page))
		env, err := c.do(ctx, "GET", "/zones/"+url.PathEscape(zoneID)+"/dns_records?"+q.Encode(), nil)
		if err != nil {
			return nil, err
		}
		var rs []cfRecord
		if err := json.Unmarshal(env.Result, &rs); err != nil {
			return nil, err
		}
		out = append(out, rs...)
		if env.ResultInfo.TotalPages <= page {
			break
		}
	}
	return out, nil
}

func (c *cfClient) CreateRecord(ctx context.Context, zoneID string, r cfRecord) (cfRecord, error) {
	if r.TTL == 0 {
		r.TTL = 1 // automatic
	}
	env, err := c.do(ctx, "POST", "/zones/"+url.PathEscape(zoneID)+"/dns_records", r)
	if err != nil {
		return cfRecord{}, err
	}
	var out cfRecord
	return out, json.Unmarshal(env.Result, &out)
}

// UpdateRecord patches content and proxied of one existing record, nothing else.
func (c *cfClient) UpdateRecord(ctx context.Context, zoneID, id string, content string, proxied bool) (cfRecord, error) {
	env, err := c.do(ctx, "PATCH", "/zones/"+url.PathEscape(zoneID)+"/dns_records/"+url.PathEscape(id),
		map[string]any{"content": content, "proxied": proxied})
	if err != nil {
		return cfRecord{}, err
	}
	var out cfRecord
	return out, json.Unmarshal(env.Result, &out)
}

func (c *cfClient) DeleteRecord(ctx context.Context, zoneID, id string) error {
	_, err := c.do(ctx, "DELETE", "/zones/"+url.PathEscape(zoneID)+"/dns_records/"+url.PathEscape(id), nil)
	return err
}

// ---------- libdns adapter (ACME DNS-01 challenges) ----------

// cfDNS implements libdns.RecordAppender/RecordDeleter on top of cfClient, so the
// ACME solver only ever creates and removes its own _acme-challenge TXT records.
type cfDNS struct {
	c     *cfClient
	zones []cfZone
}

func (p *cfDNS) zoneID(ctx context.Context, zone string) (string, error) {
	zone = strings.TrimSuffix(zone, ".")
	if p.zones == nil {
		zs, err := p.c.Zones(ctx)
		if err != nil {
			return "", err
		}
		p.zones = zs
	}
	for _, z := range p.zones {
		if strings.EqualFold(z.Name, zone) {
			return z.ID, nil
		}
	}
	return "", fmt.Errorf("令牌无权访问区域 %s", zone)
}

func txtQuoted(s string) string { return `"` + strings.Trim(s, `"`) + `"` }

func (p *cfDNS) AppendRecords(ctx context.Context, zone string, recs []libdns.Record) ([]libdns.Record, error) {
	zid, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	var out []libdns.Record
	for _, r := range recs {
		rr := r.RR()
		name := strings.TrimSuffix(libdns.AbsoluteName(rr.Name, zone), ".")
		content := rr.Data
		if rr.Type == "TXT" {
			content = txtQuoted(content)
		}
		ttl := int(rr.TTL.Seconds())
		if ttl < 60 {
			ttl = 60
		}
		if _, err := p.c.CreateRecord(ctx, zid, cfRecord{Type: rr.Type, Name: name, Content: content, TTL: ttl, Comment: "sbpanel acme challenge"}); err != nil {
			return out, err
		}
		out = append(out, r)
	}
	return out, nil
}

func (p *cfDNS) DeleteRecords(ctx context.Context, zone string, recs []libdns.Record) ([]libdns.Record, error) {
	zid, err := p.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	var out []libdns.Record
	for _, r := range recs {
		rr := r.RR()
		name := strings.TrimSuffix(libdns.AbsoluteName(rr.Name, zone), ".")
		existing, err := p.c.Records(ctx, zid, name, rr.Type)
		if err != nil {
			return out, err
		}
		for _, e := range existing {
			if strings.Trim(e.Content, `"`) == strings.Trim(rr.Data, `"`) {
				if err := p.c.DeleteRecord(ctx, zid, e.ID); err != nil {
					return out, err
				}
				out = append(out, r)
			}
		}
	}
	return out, nil
}
