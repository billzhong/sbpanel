/* sbpanel default subscription theme — dependency-free, builds DOM with textContent only (no innerHTML from data). */
(function () {
  'use strict';
  // ---------- tiny DOM helper ----------
  function h(tag, attrs) {
    var el = document.createElementNS(tag.indexOf('svg:') === 0 ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag.replace('svg:', ''));
    for (var k in attrs || {}) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'on') for (var e in v) el.addEventListener(e, v[e]);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k === 'cls' ? 'class' : k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(function (x) { add(el, x); }); else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
  var ICONS = { // 24x24 stroke paths
    copy: 'M9 9h10v10H9zM5 15V5h10', qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2v2h-2zM18 14h2v2h-2z',
    sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z', auto: 'M12 3a9 9 0 1 0 0 18V3z M12 3a9 9 0 0 1 0 18',
    info: 'M12 8h.01M11 12h1v5h1 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', x: 'M6 6l12 12M18 6 6 18',
    down: 'M12 5v14M6 13l6 6 6-6', up: 'M12 19V5M6 11l6-6 6 6', cal: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
    reset: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4', dev: 'M7 3h10v18H7zM11 18h2', ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    tg: 'M21 4 3 11l6 2 2 6 3-4 5 4 2-15zM9 13l9-6', book: 'M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2V5zM20 19v2H6', mail: 'M3 6h18v12H3zM3 6l9 7 9-7',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1', check: 'M5 12l5 5 9-10',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4'
  };
  function ic(n, s) { s = s || 18; return h('svg:svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, h('svg:path', { d: ICONS[n] })); }

  // ---------- i18n ----------
  // The server picks the language (?lang=en|zh, else the browser's Accept-Language; English by
  // default) and passes it as data.lang. Every visible string lives in this dictionary.
  var LANG = 'en';
  var M = {
    en: {
      active: 'Active', limited: 'Out of data', expired: 'Expired', disabled: 'Disabled',
      r_none: 'No reset', r_day: 'Daily', r_week: 'Weekly', r_month: 'Monthly',
      noEnc: 'No encryption', copied: 'Copied', copyFail: 'Copy failed — press and hold to select', close: 'Close',
      qrAlt: function (t) { return 'QR code for ' + t; }, copyLink: 'Copy link',
      m_system: 'System', m_light: 'Light', m_dark: 'Dark', appearance: function (m) { return 'Appearance: ' + m; },
      subTitle: 'Subscription', dismiss: 'Dismiss announcement',
      unlimitedData: 'Unlimited data', usedPct: function (p) { return p + '% used'; }, unlimited: 'Unlimited', used: 'used',
      days: function (n) { return n + (n === 1 ? ' day' : ' days'); }, never: 'Never', resetsOn: function (d) { return 'Resets ' + d; },
      mySub: 'My subscription', dataUsed: 'Data used', dataLeft: 'Data left', expires: 'Expires', noExpiry: 'No expiry',
      dataReset: 'Data reset', devices: 'Devices', devN: function (n) { return n + (n === 1 ? ' device' : ' devices'); }, noLimit: 'No limit', atOnce: 'at the same time',
      switched: function (n) { return 'Switched to “' + n + '”; links and QR codes updated'; },
      profile: 'Routing profile', profileHint: 'Sets the routing rules in Clash, sing-box and Surge',
      universal: 'Universal', subLink: 'Subscription link', every: function (h) { return 'Updates every ' + h + ' h'; },
      copySubLink: 'Copy subscription link', subCopied: 'Subscription link copied', copy: 'Copy', subFormat: 'Subscription format',
      copySub: 'Copy link', subQR: 'Subscription QR code', scanHint: 'Scan with your client to import', qr: 'QR code',
      importInto: function (n) { return 'Import into ' + n; }, otherClients: function (n) { return 'Other clients (' + n + ')'; },
      oneTap: 'One-tap import', recFor: function (p) { return 'Recommended for ' + p; },
      showQR: function (n) { return n + ': show QR code'; }, copyNode: function (n) { return 'Copy ' + n + ' link'; }, nodeCopied: function (n) { return '“' + n + '” copied'; },
      noNodes: 'No nodes available', unavailable: 'Your subscription is unavailable right now. Nodes come back once it is renewed or the data is reset.',
      allN: function (n) { return 'All ' + n; }, nodes: 'Nodes', nodeCount: function (n) { return String(n); },
      allCopied: function (n) { return 'Copied all ' + n + ' nodes'; }, copyAll: 'Copy all', byProto: 'Filter by protocol',
      lines: 'Usage by line', lineLimits: 'Line limits', noUse: 'No traffic yet this period', exhausted: 'Used up',
      leftOf: function (a, b) { return a + ' left of ' + b; }, noLineLimit: 'No limit for you', showAllN: function (n) { return 'Show all ' + n; },
      pausedUntil: function (d) { return 'Paused until ' + d + ', when it resets'; }, pausedLine: 'Paused: its line limit is used up',
      help: 'Help & support', footer: function (t) { return 'Powered by sbpanel · Updated ' + t; },
      loadFail: 'Couldn’t load the subscription. Try again later.', language: 'Language', other: '中文', otherLang: 'zh'
    },
    zh: {
      active: '正常', limited: '流量已用完', expired: '已过期', disabled: '已停用',
      r_none: '不重置', r_day: '每日', r_week: '每周', r_month: '每月',
      noEnc: '无加密', copied: '已复制', copyFail: '复制失败，请长按选择', close: '关闭',
      qrAlt: function (t) { return t + ' 二维码'; }, copyLink: '复制链接',
      m_system: '跟随系统', m_light: '浅色', m_dark: '深色', appearance: function (m) { return '外观：' + m; },
      subTitle: '订阅', dismiss: '关闭公告',
      unlimitedData: '流量不限', usedPct: function (p) { return '已使用 ' + p + '%'; }, unlimited: '不限量', used: '已使用',
      days: function (n) { return n + ' 天'; }, never: '永久', resetsOn: function (d) { return d + ' 重置'; },
      mySub: '我的订阅', dataUsed: '已用流量', dataLeft: '剩余流量', expires: '到期', noExpiry: '无期限',
      dataReset: '流量重置', devices: '设备', devN: function (n) { return n + ' 台'; }, noLimit: '不限', atOnce: '同时在线',
      switched: function (n) { return '已切换到「' + n + '」，链接与二维码已更新'; },
      profile: '配置模板', profileHint: '决定 Clash、sing-box、Surge 里的分流规则',
      universal: '通用', subLink: '订阅链接', every: function (h) { return '每 ' + h + ' 小时自动更新'; },
      copySubLink: '复制订阅链接', subCopied: '订阅链接已复制', copy: '复制', subFormat: '订阅格式',
      copySub: '复制订阅', subQR: '订阅二维码', scanHint: '用客户端扫码导入', qr: '二维码',
      importInto: function (n) { return '一键导入到 ' + n; }, otherClients: function (n) { return '其他客户端（' + n + '）'; },
      oneTap: '一键导入', recFor: function (p) { return '已为 ' + p + ' 推荐'; },
      showQR: function (n) { return n + '：查看二维码'; }, copyNode: function (n) { return '复制 ' + n + ' 链接'; }, nodeCopied: function (n) { return '「' + n + '」已复制'; },
      noNodes: '暂无可用节点', unavailable: '订阅当前不可用，续费或重置流量后节点会自动恢复。',
      allN: function (n) { return '全部 ' + n; }, nodes: '节点', nodeCount: function (n) { return n + ' 个'; },
      allCopied: function (n) { return '已复制全部 ' + n + ' 个节点'; }, copyAll: '全部', byProto: '按协议筛选',
      lines: '各线路用量', lineLimits: '线路限额', noUse: '本周期还没有使用', exhausted: '已用尽',
      leftOf: function (a, b) { return '剩余 ' + a + ' / ' + b; }, noLineLimit: '对你不限量', showAllN: function (n) { return '显示全部 ' + n + ' 条'; },
      pausedUntil: function (d) { return '已暂停，' + d + ' 重置后恢复'; }, pausedLine: '已暂停：所属线路限额已用尽',
      help: '帮助与支持', footer: function (t) { return '由 sbpanel 提供 · 更新于 ' + t; },
      loadFail: '订阅加载失败，请稍后重试。', language: '语言', other: 'English', otherLang: 'en'
    }
  };
  function t(k) {
    var v = M[LANG][k]; if (v == null) v = M.en[k];
    return typeof v === 'function' ? v.apply(null, Array.prototype.slice.call(arguments, 1)) : v;
  }
  function setLang(l) { LANG = l === 'zh' ? 'zh' : 'en'; document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en'; }
  // The same page with ?lang=<l>, keeping ?profile= and the rest (storage is unavailable in the sandbox).
  function langHref(l) { try { var u = new URL(location.href); u.searchParams.set('lang', l); return u.pathname + u.search + u.hash; } catch (e) { return '?lang=' + l; } }
  setLang((function () { try { return new URL(location.href).searchParams.get('lang') || document.documentElement.lang; } catch (e) { return document.documentElement.lang; } })().slice(0, 2));

  // ---------- formatting ----------
  function bytes(n) { var u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'], i = 0; n = +n || 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) : n) + ' ' + u[i]; }
  function date(ts) { var d = new Date(ts * 1000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function daysTo(ts) { return Math.ceil((ts * 1000 - Date.now()) / 86400000); }
  var STATUS = { active: 'good', limited: 'bad', expired: 'bad', disabled: 'bad' };
  var RESET = { none: 'r_none', day: 'r_day', week: 'r_week', month: 'r_month', month_rolling: 'r_month' };
  var PROTO = { vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'SS', hysteria2: 'Hy2', tuic: 'TUIC', anytls: 'AnyTLS', naive: 'Naive' };
  var SEC = { reality: 'Reality', tls: 'TLS' };

  // ---------- platform detection for client ordering ----------
  var ua = navigator.userAgent.toLowerCase();
  var plat = /iphone|ipad|ipod/.test(ua) || (/macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'ios' : /android/.test(ua) ? 'android' : /mac os/.test(ua) ? 'macos' : /windows/.test(ua) ? 'windows' : /linux/.test(ua) ? 'linux' : '';
  var PLAT = { ios: 'iOS', android: 'Android', macos: 'macOS', windows: 'Windows', linux: 'Linux' };

  // ---------- clipboard (works in the opaque-origin sandbox via execCommand fallback) ----------
  // Clipboard API needs a secure context (and is unavailable in the sandboxed page on some browsers):
  // fall back to a temporary textarea holding exactly the text to copy.
  function legacyCopy(t) {
    var a = document.createElement('textarea');
    a.value = t; a.setAttribute('readonly', ''); a.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(a); a.select(); a.setSelectionRange(0, t.length);
    var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(a); return ok;
  }
  function copy(text, label) {
    var done = function () { toast(label || t('copied')); };
    var fail = function () { toast(t('copyFail')); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text) ? done() : fail(); });
    } else { legacyCopy(text) ? done() : fail(); }
  }
  var toastEl, toastT;
  function toast(msg) { if (!toastEl) { toastEl = h('div', { cls: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastEl); } toastEl.replaceChildren(ic('check', 16), msg); toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('on'); }, 1600); }

  function sheet(title, sub, img, text, extra) {
    var prev = document.activeElement;
    var close = function () { scrim.remove(); document.removeEventListener('keydown', esc); prev && prev.focus && prev.focus(); };
    var esc = function (e) { if (e.key === 'Escape') close(); };
    var closeBtn = h('button', { cls: 'btn sec', on: { click: close } }, t('close'));
    var scrim = h('div', { cls: 'scrim', on: { click: function (e) { if (e.target === scrim) close(); } } },
      h('div', { cls: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { cls: 'grab' }), h('h3', { text: title }), sub ? h('div', { cls: 'meta', text: sub }) : null,
        h('img', { cls: 'qr', src: img, alt: t('qrAlt', title) }),
        h('div', { cls: 'row' }, h('button', { cls: 'btn pri', on: { click: function () { copy(text); } } }, ic('copy'), t('copyLink')), closeBtn), extra));
    document.addEventListener('keydown', esc);
    document.body.appendChild(scrim); closeBtn.focus();
  }

  // ---------- sections ----------
  function header(d) {
    var site = d.site || {}, modes = ['system', 'light', 'dark'], mi = { system: 'auto', light: 'sun', dark: 'moon' }, ml = { system: t('m_system'), light: t('m_light'), dark: t('m_dark') };
    var cur = document.documentElement.dataset.theme || 'system';
    var btn = h('button', { cls: 'icon-btn', 'aria-label': t('appearance', ml[cur]), title: t('appearance', ml[cur]) }, ic(mi[cur], 20));
    btn.addEventListener('click', function () {
      cur = modes[(modes.indexOf(cur) + 1) % 3];
      if (cur === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = cur;
      try { localStorage.setItem('sbp-sub-mode', cur); } catch (e) {}
      if (window.__sbpAccent) window.__sbpAccent();
      btn.replaceChildren(ic(mi[cur], 20)); btn.setAttribute('aria-label', t('appearance', ml[cur])); btn.title = t('appearance', ml[cur]); toast(t('appearance', ml[cur]));
    });
    var title = site.title || t('subTitle');
    var lang = h('a', { cls: 'lang-btn', href: langHref(t('otherLang')), hreflang: t('otherLang'), lang: t('otherLang') === 'zh' ? 'zh-CN' : 'en', title: t('language'), text: t('other') });
    return h('header', { cls: 'top' },
      h('div', { cls: 'logo', 'aria-hidden': 'true' }, site.logo ? h('img', { src: site.logo, alt: '' }) : title.slice(0, 1)),
      h('div', null, h('h1', { text: title }), h('div', { cls: 'who', text: d.user.name })),
      h('div', { cls: 'sp' }), h('div', { cls: 'top-acts' }, lang, btn));
  }

  function notice(d) {
    var a = (d.site || {}).announcement; if (!a) return null;
    var key = 'sbp-sub-notice-' + a.length + '-' + a.slice(0, 16);
    try { if (localStorage.getItem(key)) return null; } catch (e) {}
    var el = h('div', { cls: 'notice', role: 'note' }, ic('info'), h('p', { text: a }),
      h('button', { cls: 'x', 'aria-label': t('dismiss'), on: { click: function () { el.remove(); try { localStorage.setItem(key, '1'); } catch (e) {} } } }, ic('x', 16)));
    return el;
  }

  function status(d) {
    var u = d.user, sk = STATUS[u.status] ? u.status : 'active', st = [t(sk), STATUS[sk]], unlimited = !u.total, pct = unlimited ? 0 : Math.min(100, u.used / u.total * 100);
    var lvl = u.status !== 'active' ? 'bad' : pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
    var C = 2 * Math.PI * 44;
    var ring = h('div', { cls: 'ring ' + lvl, role: 'img', 'aria-label': unlimited ? t('unlimitedData') : t('usedPct', pct.toFixed(1)) },
      h('svg:svg', { viewBox: '0 0 100 100' },
        h('svg:circle', { cls: 'trk', cx: 50, cy: 50, r: 44, fill: 'none', 'stroke-width': 9 }),
        h('svg:circle', { cls: 'val', cx: 50, cy: 50, r: 44, fill: 'none', 'stroke-width': 9, 'stroke-linecap': 'round', 'stroke-dasharray': C, 'stroke-dashoffset': C * (1 - (unlimited ? 0 : Math.max(pct, 1.5) / 100)) })),
      h('div', { cls: 'c' }, h('b', { cls: 'num', text: unlimited ? '∞' : (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%' }), h('span', { text: unlimited ? t('unlimited') : t('used') })));

    var exp = u.expire_at ? daysTo(u.expire_at) : null;
    var expV = u.expire_at ? (exp < 0 ? t('expired') : t('days', exp)) : t('never');
    var expCls = exp != null && exp <= 3 ? 'bad' : exp != null && exp <= 7 ? 'warn' : '';
    var r = u.reset || {}, resetV = t(RESET[r.strategy] || 'r_none'), resetS = r.next_at ? t('resetsOn', date(r.next_at).slice(5)) : '—';
    return h('section', { cls: 'card', 'aria-labelledby': 'h-status' },
      h('div', { cls: 'card-h' }, h('h2', { id: 'h-status', text: t('mySub') }), h('div', { cls: 'sp' }), h('span', { cls: 'badge ' + st[1], text: st[0] })),
      h('div', { cls: 'usage' }, ring,
        h('div', { style: 'min-width:0' },
          h('div', { cls: 'meta', text: unlimited ? t('dataUsed') : t('dataLeft') }),
          h('div', { cls: 'big num' }, unlimited ? bytes(u.used) : bytes(Math.max(0, u.total - u.used)), unlimited ? null : h('small', { text: ' / ' + bytes(u.total) })),
          h('div', { cls: 'split num' }, h('span', null, ic('down', 14), ' ' + bytes(u.down)), h('span', null, ic('up', 14), ' ' + bytes(u.up))))),
      h('div', { cls: 'tiles' },
        h('div', { cls: 'tile' }, h('div', { cls: 'k' }, ic('cal', 14), t('expires')), h('div', { cls: 'v num ' + expCls, text: expV }), h('div', { cls: 's num', text: u.expire_at ? date(u.expire_at) : t('noExpiry') })),
        h('div', { cls: 'tile' }, h('div', { cls: 'k' }, ic('reset', 14), t('dataReset')), h('div', { cls: 'v', text: resetV }), h('div', { cls: 's num', text: r.strategy && r.strategy !== 'none' ? resetS : '—' })),
        h('div', { cls: 'tile' }, h('div', { cls: 'k' }, ic('dev', 14), t('devices')), h('div', { cls: 'v num', text: u.device_limit ? t('devN', u.device_limit) : t('noLimit') }), h('div', { cls: 's', text: t('atOnce') }))));
  }

  // Routing profiles: the server pre-renders url/qr/formats/client links per selectable routing profile.
  function profileOf(d) {
    var ps = d.profiles || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].slug === d.selected_profile) return ps[i];
    return null;
  }
  function withProfile(d, slug) {
    var p = null;
    (d.profiles || []).forEach(function (x) { if (x.slug === slug) p = x; });
    if (!p) return d;
    var out = Object.assign({}, d, { selected_profile: slug });
    out.subscription = Object.assign({}, d.subscription, { url: p.url, formats: p.formats || d.subscription.formats, qr: p.qr || d.subscription.qr });
    out.clients = (d.clients || []).map(function (c) { return Object.assign({}, c, { url: (p.clients && p.clients[c.id]) || c.url }); });
    return out;
  }
  function profilePicker(d) {
    var ps = d.profiles || [];
    if (ps.length < 2) return null;
    var cur = profileOf(d);
    var sel = h('select', { cls: 'psel', id: 'sbp-profile', 'aria-describedby': 'sbp-profile-d', on: { change: function (e) {
      var slug = e.target.value;
      try { var u = new URL(location.href); u.searchParams.set('profile', slug); history.replaceState(null, '', u.pathname + u.search + u.hash); } catch (x) {}
      render(withProfile(base, slug), true);
      toast(t('switched', e.target.options[e.target.selectedIndex].text));
    } } }, ps.map(function (p) { return h('option', { value: p.slug, selected: p.slug === d.selected_profile, text: p.name }); }));
    return h('div', { cls: 'prof' },
      h('label', { 'for': 'sbp-profile', text: t('profile') }), sel,
      h('p', { cls: 'meta', id: 'sbp-profile-d', text: (cur && cur.description) || t('profileHint') }));
  }

  function subscription(d) {
    var s = d.subscription, F = [['auto', t('universal')], ['singbox', 'sing-box'], ['mihomo', 'Clash'], ['surge', 'Surge'], ['base64', 'Base64']], cur = 'auto';
    var code = h('code', { cls: 'mono', text: s.url });
    var chips = F.filter(function (f) { return s.formats && s.formats[f[0]]; }).map(function (f) {
      return h('button', { cls: 'chip', 'aria-pressed': f[0] === cur ? 'true' : 'false', on: { click: function (e) { cur = f[0]; code.textContent = s.formats[cur]; chips.forEach(function (c) { c.setAttribute('aria-pressed', c === e.currentTarget ? 'true' : 'false'); }); } } }, f[1]);
    });
    return h('section', { cls: 'card', 'aria-labelledby': 'h-sub' },
      h('div', { cls: 'card-h' }, h('h2', { id: 'h-sub', text: t('subLink') }), h('div', { cls: 'sp' }), h('span', { cls: 'meta', text: t('every', s.update_hours || 12) })),
      profilePicker(d),
      h('div', { cls: 'link' }, code, h('button', { cls: 'btn sm sec', 'aria-label': t('copySubLink'), on: { click: function () { copy(code.textContent, t('subCopied')); } } }, ic('copy', 16), t('copy'))),
      h('div', { cls: 'fmt', role: 'group', 'aria-label': t('subFormat') }, chips),
      h('div', { cls: 'row', style: 'margin-top:12px' },
        h('button', { cls: 'btn pri', on: { click: function () { copy(code.textContent, t('subCopied')); } } }, ic('copy'), t('copySub')),
        h('button', { cls: 'btn sec', on: { click: function () { sheet(t('subQR'), t('scanHint'), s.qr, code.textContent); } } }, ic('qr'), t('qr'))));
  }

  function abbr(n) { var w = n.split(/[^A-Za-z0-9]+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).replace(/^./, function (x) { return x.toUpperCase(); }); }
  function clients(d, settings) {
    var allow = settings.clients, list = (d.clients || []).filter(function (c) { return !allow || allow.indexOf(c.id) >= 0; });
    list.sort(function (a, b) { return (b.platforms.indexOf(plat) >= 0) - (a.platforms.indexOf(plat) >= 0); });
    var rec = list.filter(function (c) { return c.platforms.indexOf(plat) >= 0; });
    var shown = rec.length >= 2 ? rec : list, rest = list.filter(function (c) { return shown.indexOf(c) < 0; });
    var grid = h('div', { cls: 'clients' });
    function card(c, isRec) {
      return h('a', { cls: 'client' + (isRec ? ' rec' : ''), href: c.url, 'aria-label': t('importInto', c.name) },
        h('span', { cls: 'ci', 'aria-hidden': 'true', text: abbr(c.name) }),
        h('div', null, h('b', { text: c.name }), h('span', { text: c.platforms.map(function (p) { return PLAT[p]; }).join(' · ') })));
    }
    shown.forEach(function (c, i) { grid.appendChild(card(c, i === 0 && rec.length > 0)); });
    var more = rest.length ? h('button', { cls: 'more', on: { click: function () { rest.forEach(function (c) { grid.appendChild(card(c)); }); more.remove(); } } }, t('otherClients', rest.length)) : null;
    return h('section', { cls: 'card', 'aria-labelledby': 'h-cli' },
      h('div', { cls: 'card-h' }, h('h2', { id: 'h-cli', text: t('oneTap') }), h('div', { cls: 'sp' }), plat ? h('span', { cls: 'meta', text: t('recFor', PLAT[plat]) }) : null),
      grid, more);
  }

  function nodes(d, settings) {
    var all = d.nodes || [];
    var protos = []; all.forEach(function (n) { if (protos.indexOf(n.protocol) < 0) protos.push(n.protocol); });
    var filter = '', list = h('div', { cls: 'nodes' });
    function render() {
      var items = all.filter(function (n) { return !filter || n.protocol === filter; });
      list.replaceChildren.apply(list, items.length ? items.map(function (n) {
        var r = n.region || {}, tags = [h('span', { cls: 'tag p', text: PROTO[n.protocol] || n.protocol })];
        if (n.transport && n.transport !== 'tcp') tags.push(h('span', { cls: 'tag', text: n.transport.toUpperCase() }));
        if (n.security && n.security !== 'none') tags.push(h('span', { cls: 'tag', text: SEC[n.security] || n.security }));
        if (n.flow) tags.push(h('span', { cls: 'tag', text: 'Vision' }));
        if (n.paused) tags.unshift(h('span', { cls: 'tag off', title: t('pausedLine'), text: t('exhausted') }));
        var showQR = function () { sheet(n.name, (PROTO[n.protocol] || n.protocol) + ' · ' + n.address + ':' + n.port, n.qr, n.uri); };
        return h('article', { cls: 'node' + (n.paused ? ' paused' : '') },
          settings.show_node_qr !== false && n.qr ? h('button', { cls: 'open', 'aria-label': t('showQR', n.name), on: { click: showQR } }) : null,
          h('div', { cls: 'flag' + (r.flag ? '' : ' txt'), 'aria-hidden': 'true', text: r.flag || (r.code || (PROTO[n.protocol] || '?').slice(0, 2)) }),
          h('div', { cls: 'nm', text: n.name.replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, '') }),
          h('div', { cls: 'tags' }, tags),
          settings.show_node_address !== false ? h('div', { cls: 'addr mono', text: n.address + ':' + n.port }) : null,
          h('div', { cls: 'acts' },
            h('button', { cls: 'ib', 'aria-label': t('copyNode', n.name), title: t('copyLink'), on: { click: function () { copy(n.uri, t('nodeCopied', n.name)); } } }, ic('copy', 18))));
      }) : [h('div', { cls: 'empty', text: d.user.status === 'active' ? t('noNodes') : t('unavailable') })]);
    }
    var chips = protos.length > 1 ? [''].concat(protos).map(function (p) {
      return h('button', { cls: 'chip', 'aria-pressed': p === filter ? 'true' : 'false', on: { click: function (e) { filter = p; chips.forEach(function (c) { c.setAttribute('aria-pressed', c === e.currentTarget ? 'true' : 'false'); }); render(); } } }, p ? (PROTO[p] || p) : t('allN', all.length));
    }) : [];
    render();
    return h('section', { cls: 'card', 'aria-labelledby': 'h-nodes' },
      h('div', { cls: 'card-h' }, h('h2', { id: 'h-nodes', text: t('nodes') }), h('span', { cls: 'meta num', text: t('nodeCount', all.length) }), h('div', { cls: 'sp' }),
        all.length ? h('button', { cls: 'btn sm sec', on: { click: function () { copy(all.map(function (n) { return n.uri; }).join('\n'), t('allCopied', all.length)); } } }, ic('copy', 16), t('copyAll')) : null),
      chips.length ? h('div', { cls: 'tools', role: 'group', 'aria-label': t('byProto') }, chips) : null, list);
  }

  // Per-line usage this period, with the traffic limits (e.g. a home line) on top.
  function lines(d) {
    var us = d.usage || [], ls = d.limits || [];
    if (!us.length && !ls.length) return null;
    function bar(pct, lvl) { return h('div', { cls: 'bar ' + (lvl || ''), role: 'presentation' }, h('i', { style: 'width:' + Math.max(pct, pct > 0 ? 2 : 0).toFixed(1) + '%' })); }
    var lim = ls.map(function (l) {
      var pct = l.total ? Math.min(100, l.used / l.total * 100) : 0, lvl = l.exhausted || pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
      var sub = l.exhausted ? (l.next_at ? t('pausedUntil', date(l.next_at).slice(5)) : t('exhausted'))
        : l.total ? t('leftOf', bytes(Math.max(0, l.total - l.used)), bytes(l.total)) + (l.next_at ? ' · ' + t('resetsOn', date(l.next_at).slice(5)) : '') : t('noLineLimit');
      return h('li', { cls: 'lim' + (l.exhausted ? ' off' : '') },
        h('div', { cls: 'row1' }, h('b', { text: l.name }), l.exhausted ? h('span', { cls: 'badge bad', text: t('exhausted') }) : null, h('span', { cls: 'sp' }),
          h('span', { cls: 'num', text: bytes(l.used) + (l.total ? ' / ' + bytes(l.total) : '') })),
        l.total ? bar(pct, lvl) : null,
        h('div', { cls: 'meta', text: sub }),
        l.lines && l.lines.length ? h('div', { cls: 'meta lns', text: l.lines.join(' · ') }) : null);
    });
    var max = us.reduce(function (a, x) { return Math.max(a, x.used); }, 0), used = us.filter(function (x) { return x.used > 0 || x.exhausted; });
    var shown = used.slice(0, 6), more = used.length - shown.length;
    var list = h('ul', { cls: 'uses' });
    function row(x) {
      return h('li', { cls: x.exhausted ? 'off' : '', title: x.exhausted ? t('pausedLine') : '' },
        h('div', { cls: 'row1' }, h('span', { cls: 'tag p', text: PROTO[x.protocol] || x.protocol }), h('span', { cls: 'nm', text: x.name }), h('span', { cls: 'sp' }),
          x.exhausted ? h('span', { cls: 'badge bad', text: t('exhausted') }) : null, h('span', { cls: 'num', text: bytes(x.used) })),
        bar(max ? x.used / max * 100 : 0, x.exhausted ? 'bad' : 'soft'));
    }
    shown.forEach(function (x) { list.appendChild(row(x)); });
    var moreBtn = more > 0 ? h('button', { cls: 'btn sm sec', on: { click: function () { used.slice(6).forEach(function (x) { list.appendChild(row(x)); }); moreBtn.remove(); } } }, t('showAllN', used.length)) : null;
    return h('section', { cls: 'card', 'aria-labelledby': 'h-lines' },
      h('div', { cls: 'card-h' }, h('h2', { id: 'h-lines', text: t('lines') })),
      lim.length ? h('ul', { cls: 'lims', 'aria-label': t('lineLimits') }, lim) : null,
      used.length ? list : h('div', { cls: 'meta', text: t('noUse') }), moreBtn);
  }

  function support(d) {
    var s = (d.site || {}).support || []; if (!s.length) return null;
    var icon = { telegram: 'tg', book: 'book', mail: 'mail', chat: 'tg' };
    return h('section', { cls: 'card', 'aria-labelledby': 'h-sup' },
      h('div', { cls: 'card-h' }, h('h2', { id: 'h-sup', text: t('help') })),
      h('div', { cls: 'links' }, s.map(function (l) {
        var safe = /^(https?:|mailto:|tg:)/i.test(l.url) ? l.url : '#';
        return h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, ic(icon[l.icon] || 'link'), l.label, ic('ext', 16));
      })));
  }

  function o(el, n) { if (el) el.style.order = n; return el; }
  var base = null;
  function render(d, again) {
    if (!again) { base = d; setLang(d.lang); }
    var settings = (d.theme || {}).settings || {};
    document.title = (d.site && d.site.title ? d.site.title + ' · ' : '') + d.user.name;
    var app = document.getElementById('app');
    app.removeAttribute('aria-busy');
    app.replaceChildren(h('div', { cls: 'wrap' }, header(d),
      h('div', { cls: 'layout' },
        h('div', { cls: 'main' }, o(notice(d), 1), o(status(d), 2), o(lines(d), 2), o(nodes(d, settings), 5)),
        h('div', { cls: 'side' }, o(subscription(d), 3), o(clients(d, settings), 4), o(support(d), 6))),
      h('div', { cls: 'foot meta', text: settings.footer || t('footer', new Date(d.generated_at * 1000).toLocaleString(LANG === 'zh' ? 'zh-CN' : 'en', { hour12: false })) })));
    if (again) { var ps = document.getElementById('sbp-profile'); if (ps) ps.focus(); }
  }

  // ---------- data: inline (preferred) -> ?format=json -> prototype mock ----------
  var inline = document.getElementById('sbp-data');
  if (inline) { try { render(JSON.parse(inline.textContent)); return; } catch (e) {} }
  var src = location.pathname + '?format=json&lang=' + LANG;
  fetch(src, { credentials: 'omit' }).then(function (r) { if (!r.ok) throw r; return r.json(); }).then(render, function () {
    document.getElementById('app').replaceChildren(h('div', { cls: 'wrap' }, h('div', { cls: 'card empty', text: t('loadFail') })));
  });
})();
