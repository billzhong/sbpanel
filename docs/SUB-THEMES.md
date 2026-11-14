# Subscription-page themes

When a user opens their subscription link (`/s/<token>`) in a browser, sbmaster renders the active
**subscription-page theme**. Admins manage themes in **订阅 → 订阅页**: upload a zip, activate it,
edit its settings and preview it with sample or real users. The built-in theme `default` is embedded
in the binary (`internal/master/subtheme/default/`) and is a good starting point for your own.

## Quick start

1. Copy `internal/master/subtheme/default/` to a new folder.
2. Edit `sbp-theme.json`: give it your own `id`, `name` and `version`.
3. Edit `index.html`, `app.js` and `app.css`.
4. Zip the folder (the manifest may sit at the zip root or inside one top-level folder) and upload it
   in 订阅 → 订阅页 → 上传主题. Uploading the same `id` again upgrades the theme and keeps its settings.

## Package

```
my-theme.zip
├── sbp-theme.json     required, ≤ 64 KB
├── index.html         entry page (or whatever "entry" names)
├── preview.jpg        optional thumbnail shown in the admin (16:10 works best)
└── …                  js / css / images / fonts
```

Limits: ≤ 200 files, ≤ 5 MB per file, ≤ 20 MB unpacked. No symlinks, no absolute or `..` paths,
no dot-files. Installed themes live in `<data dir>/sub-themes/<id>/`.

## Manifest (`sbp-theme.json`)

| field | | |
|---|---|---|
| `api` | required | must be `1` |
| `id` | required | `^[a-z0-9][a-z0-9_-]{1,39}$`; `default` is reserved |
| `name` | required | string or `{"zh-CN": "…", "en": "…"}` |
| `version` | required | e.g. `1.2.0`; it is part of asset URLs, so bump it on every release |
| `author`, `description`, `homepage`, `license` | optional | `description` may be localized like `name` |
| `preview` | optional | path of a thumbnail inside the package |
| `entry` | optional | entry HTML, default `index.html` |
| `settings` | optional | admin-editable settings, see below |

### Settings

Each item is `{ "key", "type", "label", "help", "default", "options", "maxLength", "min", "max" }`.
`label` and `help` may be localized objects. The admin renders a form from this list, validates
values on save and gives your theme the merged result (saved values over defaults) in
`theme.settings`.

| type | value | notes |
|---|---|---|
| `title` | — | section heading in the form; no `key` |
| `text` / `textarea` | string | `maxLength` (default 500 / 4000) |
| `url` | string | empty or `http(s)://…` |
| `color` | string | empty or `#RRGGBB` |
| `number` | number | optional `min` / `max` |
| `switch` | boolean | |
| `select` | string | `options`: `[{"value": "a", "label": "A"}]` |
| `multiselect` | string[] | `options` as above, or `"$clients"` for the built-in client list |

## Placeholders

The server reads your entry page and substitutes:

- `%SBP_DATA%` (exactly once): replaced with
  `<script id="sbp-data" type="application/json">{…}</script>`, the full data object below.
  Read it with `JSON.parse(document.getElementById('sbp-data').textContent)`.
- `%SBP_ASSETS%`: the base URL of your files, `/s/_t/<id>@<version>`. Use it for every asset
  (`<link href="%SBP_ASSETS%/app.css">`). With Vite, set `base: '%SBP_ASSETS%/'`.

Tags written exactly as `<link rel="stylesheet" href="%SBP_ASSETS%/x.css">` and
`<script src="%SBP_ASSETS%/x.js"></script>` (optionally `defer`) are **inlined** into the page when
the file is under 512 KB. That saves round trips on mobile networks. Inlined scripts carry the
per-response CSP nonce. CSS that uses relative `url(…)` is left as a link, because relative URLs
would resolve against `/s/<token>`.

If you don't use `%SBP_DATA%`, fetch the same object from `location.pathname + '?format=json'`.

## Data (API v1)

`GET /s/<token>?format=json` returns the same object that is embedded in the page:

```jsonc
{
  "api": 1, "generated_at": 1794672000,
  "site": { "title": "…", "logo": "https://… or empty", "announcement": "plain text, may contain \n",
            "support": [{ "label": "Telegram 群组", "url": "https://…|mailto:…|tg://…", "icon": "telegram|chat|book|mail|link" }] },
  "user": { "name": "alice", "status": "active|limited|expired|disabled", "enabled": true,
            "up": 0, "down": 0, "used": 0, "total": 0,          // bytes; total 0 = unlimited
            "expire_at": 0, "days_left": null,                   // unix seconds; 0 / null = never
            "device_limit": 0,                                   // 0 = unlimited
            "reset": { "strategy": "none|day|week|month|month_rolling", "last_at": 0, "next_at": 0 } },
  "subscription": { "url": "https://…/s/<token>", "qr": "data:image/png;base64,…", "update_hours": 12,
            "formats": { "auto": "…", "base64": "…", "singbox": "…", "mihomo": "…", "surge": "…", "links": "…", "json": "…" } },
  "clients": [{ "id": "singbox", "name": "sing-box", "platforms": ["ios","android","macos","windows","linux"],
                "url": "sing-box://import-remote-profile?url=…", "download": "https://…" }],
  "nodes": [{ "id": 0, "name": "🇺🇸 洛杉矶 CN2", "protocol": "vless|vmess|trojan|shadowsocks|hysteria2|tuic|…",
              "transport": "tcp|ws|grpc|http|httpupgrade|quic", "security": "reality|tls|none", "flow": "",
              "address": "la.example.com", "port": 443, "sni": "…",
              "region": { "code": "US", "flag": "🇺🇸" },          // best-effort guess from the name, or null
              "uri": "vless://…", "qr": "data:image/png;base64,…" }],
  "theme": { "id": "my-theme", "version": "1.2.0", "settings": { /* merged with defaults */ } },
  // 配置模板: routing profiles the user may switch between (订阅 → 分流规则). Every link is
  // pre-rendered, so a theme only swaps values; "qr" is empty when there is a single profile.
  "profiles": [{ "slug": "standard", "name": "标准分流", "description": "…",
                 "url": "https://…/s/<token>?profile=standard", "qr": "data:image/png;base64,…",
                 "formats": { /* as subscription.formats */ }, "clients": { "singbox": "sing-box://…", "mihomo": "clash://…" } }],
  "selected_profile": "standard"   // in effect for this request (?profile= honoured when selectable)
}
```

- `nodes` is empty unless `user.status` is `active`.
- Credentials only appear inside `uri` (and its QR code).
- `clients` follows the admin's client list in 订阅 → 订阅页.
- `subscription` and `clients` already reflect `selected_profile`. To switch, take the values from the
  matching `profiles` entry; keep the choice in the page URL (`?profile=<slug>`), not storage.
- New fields may be added within `api: 1`. Ignore fields you don't know.

## Sandbox: what a theme can and cannot do

Theme pages, and every file under `/s/_t/`, are served with:

```
Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads
  allow-modals allow-top-navigation-to-custom-protocols; default-src 'none'; script-src 'self' 'nonce-…';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self';
  media-src 'self' https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
```

The page runs in an **opaque origin** (`self.origin === "null"`). In practice that means:

- **No cookies.** The admin's session cookie is never sent with the page's requests (verified in
  Chrome: `SameSiteStrict`-blocked), and `/api` responses cannot be read. sbmaster also rejects any
  state-changing `/api` request carrying `Origin: null`.
- **`localStorage`, `sessionStorage` and `document.cookie` throw.** Wrap every access in `try/catch`
  and treat persistence as best-effort.
- **Clipboard.** `navigator.clipboard` needs a secure context. Fall back to a temporary
  `<textarea>` plus `document.execCommand('copy')`, as the default theme's `legacyCopy` does.
- **No inline `<script>` without the nonce, and no `eval`.** Ship JS as files referenced through
  `%SBP_ASSETS%`; the server inlines and nonces them for you.
- **External resources:** images and media over `https:` are allowed. Scripts, styles and fonts must
  come from your package. Requests go out with no referrer, so the token in the URL does not leak.
- **Deep links:** `sing-box://`, `clash://` and other custom schemes work through
  `allow-top-navigation-to-custom-protocols`. Use plain `<a href>` links.
- **Framing:** pages cannot be framed, except the admin preview (`frame-ancestors 'self'`).
- `prefers-color-scheme` works. Inside the admin preview it follows the preview's light/dark toggle.

## Panel colour tokens

The default theme ships `tokens.css`: the panel's palettes (`neutral`, `rosepine`, `catppuccin`,
`nord`) as CSS variables (`--base --surface --overlay --raised --text --subtle --muted --border
--border-strong --accent --accent-text --on-accent --good --warn --bad …`), selected by
`<html data-palette="…" data-theme="light|dark">`. Every text/background pair meets WCAG AA. To
regenerate it, run `node web/scripts/tokens/gen-panel.mjs` and check with
`node web/scripts/tokens/check.mjs`.

## Developing locally

- 订阅 → 订阅页 → 实时预览 renders any theme with sample data (normal / over quota / expired) or a
  real user. Unsaved theme settings can be previewed with
  `/api/sub-themes/<id>/preview?settings=<json>`.
- `curl '<sub url>?format=json'` gives you real data to develop against. To work without uploading,
  serve your folder statically with a copy of that JSON inlined in place of `%SBP_DATA%`.
