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

  // ---------- formatting ----------
  function bytes(n) { var u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'], i = 0; n = +n || 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) : n) + ' ' + u[i]; }
  function date(ts) { var d = new Date(ts * 1000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function daysTo(ts) { return Math.ceil((ts * 1000 - Date.now()) / 86400000); }
  var STATUS = { active: ['正常', 'good'], limited: ['流量已用完', 'bad'], expired: ['已过期', 'bad'], disabled: ['已停用', 'bad'] };
  var RESET = { none: '不重置', day: '每日', week: '每周', month: '每月', month_rolling: '每月' };
  var PROTO = { vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'SS', hysteria2: 'Hy2', tuic: 'TUIC', anytls: 'AnyTLS', naive: 'Naive' };
  var SEC = { reality: 'Reality', tls: 'TLS', none: '无加密' };

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
    var done = function () { toast(label || '已复制'); };
    var fail = function () { toast('复制失败，请长按选择'); };
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
    var closeBtn = h('button', { cls: 'btn sec', on: { click: close } }, '关闭');
    var scrim = h('div', { cls: 'scrim', on: { click: function (e) { if (e.target === scrim) close(); } } },
      h('div', { cls: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { cls: 'grab' }), h('h3', { text: title }), sub ? h('div', { cls: 'meta', text: sub }) : null,
        h('img', { cls: 'qr', src: img, alt: title + ' 二维码' }),
        h('div', { cls: 'row' }, h('button', { cls: 'btn pri', on: { click: function () { copy(text); } } }, ic('copy'), '复制链接'), closeBtn), extra));
    document.addEventListener('keydown', esc);
    document.body.appendChild(scrim); closeBtn.focus();
  }

  // ---------- sections ----------
  function header(d) {
    var site = d.site || {}, modes = ['system', 'light', 'dark'], mi = { system: 'auto', light: 'sun', dark: 'moon' }, ml = { system: '跟随系统', light: '浅色', dark: '深色' };
    var cur = document.documentElement.dataset.theme || 'system';
    var btn = h('button', { cls: 'icon-btn', 'aria-label': '外观：' + ml[cur], title: '外观：' + ml[cur] }, ic(mi[cur], 20));
    btn.addEventListener('click', function () {
      cur = modes[(modes.indexOf(cur) + 1) % 3];
      if (cur === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = cur;
      try { localStorage.setItem('sbp-sub-mode', cur); } catch (e) {}
      if (window.__sbpAccent) window.__sbpAccent();
      btn.replaceChildren(ic(mi[cur], 20)); btn.setAttribute('aria-label', '外观：' + ml[cur]); btn.title = '外观：' + ml[cur]; toast('外观：' + ml[cur]);
    });
    var title = site.title || '订阅';
    return h('header', { cls: 'top' },
      h('div', { cls: 'logo', 'aria-hidden': 'true' }, site.logo ? h('img', { src: site.logo, alt: '' }) : title.slice(0, 1)),
      h('div', null, h('h1', { text: title }), h('div', { cls: 'who', text: d.user.name })),
      h('div', { cls: 'sp' }), btn);
  }

  function notice(d) {
    var a = (d.site || {}).announcement; if (!a) return null;
    var key = 'sbp-sub-notice-' + a.length + '-' + a.slice(0, 16);
    try { if (localStorage.getItem(key)) return null; } catch (e) {}
    var el = h('div', { cls: 'notice', role: 'note' }, ic('info'), h('p', { text: a }),
      h('button', { cls: 'x', 'aria-label': '关闭公告', on: { click: function () { el.remove(); try { localStorage.setItem(key, '1'); } catch (e) {} } } }, ic('x', 16)));
    return el;
  }

  function status(d) {
    var u = d.user, st = STATUS[u.status] || STATUS.active, unlimited = !u.total, pct = unlimited ? 0 : Math.min(100, u.used / u.total * 100);
    var lvl = u.status !== 'active' ? 'bad' : pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
    var C = 2 * Math.PI * 44;
    var ring = h('div', { cls: 'ring ' + lvl, role: 'img', 'aria-label': unlimited ? '流量不限' : '已使用 ' + pct.toFixed(1) + '%' },
      h('svg:svg', { viewBox: '0 0 100 100' },
        h('svg:circle', { cls: 'trk', cx: 50, cy: 50, r: 44, fill: 'none', 'stroke-width': 9 }),
        h('svg:circle', { cls: 'val', cx: 50, cy: 50, r: 44, fill: 'none', 'stroke-width': 9, 'stroke-linecap': 'round', 'stroke-dasharray': C, 'stroke-dashoffset': C * (1 - (unlimited ? 0 : Math.max(pct, 1.5) / 100)) })),
      h('div', { cls: 'c' }, h('b', { cls: 'num', text: unlimited ? '∞' : (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%' }), h('span', { text: unlimited ? '不限量' : '已使用' })));

    var exp = u.expire_at ? daysTo(u.expire_at) : null;
    var expV = u.expire_at ? (exp < 0 ? '已过期' : exp + ' 天') : '永久';
    var expCls = exp != null && exp <= 3 ? 'bad' : exp != null && exp <= 7 ? 'warn' : '';
    var r = u.reset || {}, resetV = RESET[r.strategy] || '不重置', resetS = r.next_at ? date(r.next_at).slice(5) + ' 重置' : '—';
    return h('section', { cls: 'card', 'aria-labelledby': 'h-status' },
      h('div', { cls: 'card-h' }, h('h2', { id: 'h-status', text: '我的订阅' }), h('div', { cls: 'sp' }), h('span', { cls: 'badge ' + st[1], text: st[0] })),
      h('div', { cls: 'usage' }, ring,
        h('div', { style: 'min-width:0' },
          h('div', { cls: 'meta', text: unlimited ? '已用流量' : '剩余流量' }),
          h('div', { cls: 'big num' }, unlimited ? bytes(u.used) : bytes(Math.max(0, u.total - u.used)), unlimited ? null : h('small', { text: ' / ' + bytes(u.total) })),
          h('div', { cls: 'split num' }, h('span', null, ic('down', 14), ' ' + bytes(u.down)), h('span', null, ic('up', 14), ' ' + bytes(u.up))))),
      h('div', { cls: 'tiles' },
        h('div', { cls: 'tile' }, h('div', { cls: 'k' }, ic('cal', 14), '到期'), h('div', { cls: 'v num ' + expCls, text: expV }), h('div', { cls: 's num', text: u.expire_at ? date(u.expire_at) : '无期限' })),
        h('div', { cls: 'tile' }, h('div', { cls: 'k' }, ic('reset', 14), '流量重置'), h('div', { cls: 'v', text: resetV }), h('div', { cls: 's num', text: r.strategy && r.strategy !== 'none' ? resetS : '—' })),
        h('div', { cls: 'tile' }, h('div', { cls: 'k' }, ic('dev', 14), '设备'), h('div', { cls: 'v num', text: u.device_limit ? u.device_limit + ' 台' : '不限' }), h('div', { cls: 's', text: '同时在线' }))));
  }

  // 配置模板: the server pre-renders url/qr/formats/client links per selectable routing profile.
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
      toast('已切换到「' + e.target.options[e.target.selectedIndex].text + '」，链接与二维码已更新');
    } } }, ps.map(function (p) { return h('option', { value: p.slug, selected: p.slug === d.selected_profile, text: p.name }); }));
    return h('div', { cls: 'prof' },
      h('label', { 'for': 'sbp-profile', text: '配置模板' }), sel,
      h('p', { cls: 'meta', id: 'sbp-profile-d', text: (cur && cur.description) || '决定 Clash、sing-box、Surge 里的分流规则' }));
  }

  function subscription(d) {
    var s = d.subscription, F = [['auto', '通用'], ['singbox', 'sing-box'], ['mihomo', 'Clash'], ['surge', 'Surge'], ['base64', 'Base64']], cur = 'auto';
    var code = h('code', { cls: 'mono', text: s.url });
    var chips = F.filter(function (f) { return s.formats && s.formats[f[0]]; }).map(function (f) {
      return h('button', { cls: 'chip', 'aria-pressed': f[0] === cur ? 'true' : 'false', on: { click: function (e) { cur = f[0]; code.textContent = s.formats[cur]; chips.forEach(function (c) { c.setAttribute('aria-pressed', c === e.currentTarget ? 'true' : 'false'); }); } } }, f[1]);
    });
    return h('section', { cls: 'card', 'aria-labelledby': 'h-sub' },
      h('div', { cls: 'card-h' }, h('h2', { id: 'h-sub', text: '订阅链接' }), h('div', { cls: 'sp' }), h('span', { cls: 'meta', text: '每 ' + (s.update_hours || 12) + ' 小时自动更新' })),
      profilePicker(d),
      h('div', { cls: 'link' }, code, h('button', { cls: 'btn sm sec', 'aria-label': '复制订阅链接', on: { click: function () { copy(code.textContent, '订阅链接已复制'); } } }, ic('copy', 16), '复制')),
      h('div', { cls: 'fmt', role: 'group', 'aria-label': '订阅格式' }, chips),
      h('div', { cls: 'row', style: 'margin-top:12px' },
        h('button', { cls: 'btn pri', on: { click: function () { copy(code.textContent, '订阅链接已复制'); } } }, ic('copy'), '复制订阅'),
        h('button', { cls: 'btn sec', on: { click: function () { sheet('订阅二维码', '用客户端扫码导入', s.qr, code.textContent); } } }, ic('qr'), '二维码')));
  }

  function abbr(n) { var w = n.split(/[^A-Za-z0-9]+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).replace(/^./, function (x) { return x.toUpperCase(); }); }
  function clients(d, settings) {
    var allow = settings.clients, list = (d.clients || []).filter(function (c) { return !allow || allow.indexOf(c.id) >= 0; });
    list.sort(function (a, b) { return (b.platforms.indexOf(plat) >= 0) - (a.platforms.indexOf(plat) >= 0); });
    var rec = list.filter(function (c) { return c.platforms.indexOf(plat) >= 0; });
    var shown = rec.length >= 2 ? rec : list, rest = list.filter(function (c) { return shown.indexOf(c) < 0; });
    var grid = h('div', { cls: 'clients' });
    function card(c, isRec) {
      return h('a', { cls: 'client' + (isRec ? ' rec' : ''), href: c.url, 'aria-label': '一键导入到 ' + c.name },
        h('span', { cls: 'ci', 'aria-hidden': 'true', text: abbr(c.name) }),
        h('div', null, h('b', { text: c.name }), h('span', { text: c.platforms.map(function (p) { return PLAT[p]; }).join(' · ') })));
    }
    shown.forEach(function (c, i) { grid.appendChild(card(c, i === 0 && rec.length > 0)); });
    var more = rest.length ? h('button', { cls: 'more', on: { click: function () { rest.forEach(function (c) { grid.appendChild(card(c)); }); more.remove(); } } }, '其他客户端（' + rest.length + '）') : null;
    return h('section', { cls: 'card', 'aria-labelledby': 'h-cli' },
      h('div', { cls: 'card-h' }, h('h2', { id: 'h-cli', text: '一键导入' }), h('div', { cls: 'sp' }), plat ? h('span', { cls: 'meta', text: '已为 ' + PLAT[plat] + ' 推荐' }) : null),
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
        var showQR = function () { sheet(n.name, (PROTO[n.protocol] || n.protocol) + ' · ' + n.address + ':' + n.port, n.qr, n.uri); };
        return h('article', { cls: 'node' },
          settings.show_node_qr !== false && n.qr ? h('button', { cls: 'open', 'aria-label': n.name + '：查看二维码', on: { click: showQR } }) : null,
          h('div', { cls: 'flag' + (r.flag ? '' : ' txt'), 'aria-hidden': 'true', text: r.flag || (r.code || (PROTO[n.protocol] || '?').slice(0, 2)) }),
          h('div', { cls: 'nm', text: n.name.replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, '') }),
          h('div', { cls: 'tags' }, tags),
          settings.show_node_address !== false ? h('div', { cls: 'addr mono', text: n.address + ':' + n.port }) : null,
          h('div', { cls: 'acts' },
            h('button', { cls: 'ib', 'aria-label': '复制 ' + n.name + ' 链接', title: '复制链接', on: { click: function () { copy(n.uri, '「' + n.name + '」已复制'); } } }, ic('copy', 18))));
      }) : [h('div', { cls: 'empty', text: d.user.status === 'active' ? '暂无可用节点' : '订阅当前不可用，续费或重置流量后节点会自动恢复。' })]);
    }
    var chips = protos.length > 1 ? [''].concat(protos).map(function (p) {
      return h('button', { cls: 'chip', 'aria-pressed': p === filter ? 'true' : 'false', on: { click: function (e) { filter = p; chips.forEach(function (c) { c.setAttribute('aria-pressed', c === e.currentTarget ? 'true' : 'false'); }); render(); } } }, p ? (PROTO[p] || p) : '全部 ' + all.length);
    }) : [];
    render();
    return h('section', { cls: 'card', 'aria-labelledby': 'h-nodes' },
      h('div', { cls: 'card-h' }, h('h2', { id: 'h-nodes', text: '节点' }), h('span', { cls: 'meta num', text: all.length + ' 个' }), h('div', { cls: 'sp' }),
        all.length ? h('button', { cls: 'btn sm sec', on: { click: function () { copy(all.map(function (n) { return n.uri; }).join('\n'), '已复制全部 ' + all.length + ' 个节点'); } } }, ic('copy', 16), '全部') : null),
      chips.length ? h('div', { cls: 'tools', role: 'group', 'aria-label': '按协议筛选' }, chips) : null, list);
  }

  function support(d) {
    var s = (d.site || {}).support || []; if (!s.length) return null;
    var icon = { telegram: 'tg', book: 'book', mail: 'mail', chat: 'tg' };
    return h('section', { cls: 'card', 'aria-labelledby': 'h-sup' },
      h('div', { cls: 'card-h' }, h('h2', { id: 'h-sup', text: '帮助与支持' })),
      h('div', { cls: 'links' }, s.map(function (l) {
        var safe = /^(https?:|mailto:|tg:)/i.test(l.url) ? l.url : '#';
        return h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, ic(icon[l.icon] || 'link'), l.label, ic('ext', 16));
      })));
  }

  function o(el, n) { if (el) el.style.order = n; return el; }
  var base = null;
  function render(d, again) {
    if (!again) base = d;
    var settings = (d.theme || {}).settings || {};
    document.title = (d.site && d.site.title ? d.site.title + ' · ' : '') + d.user.name;
    var app = document.getElementById('app');
    app.removeAttribute('aria-busy');
    app.replaceChildren(h('div', { cls: 'wrap' }, header(d),
      h('div', { cls: 'layout' },
        h('div', { cls: 'main' }, o(notice(d), 1), o(status(d), 2), o(nodes(d, settings), 5)),
        h('div', { cls: 'side' }, o(subscription(d), 3), o(clients(d, settings), 4), o(support(d), 6))),
      h('div', { cls: 'foot meta', text: settings.footer || ('由 sbpanel 提供 · 更新于 ' + new Date(d.generated_at * 1000).toLocaleString('zh-CN', { hour12: false })) })));
    if (again) { var ps = document.getElementById('sbp-profile'); if (ps) ps.focus(); }
  }

  // ---------- data: inline (preferred) -> ?format=json -> prototype mock ----------
  var inline = document.getElementById('sbp-data');
  if (inline) { try { render(JSON.parse(inline.textContent)); return; } catch (e) {} }
  var src = location.pathname + '?format=json';
  fetch(src, { credentials: 'omit' }).then(function (r) { if (!r.ok) throw r; return r.json(); }).then(render, function () {
    document.getElementById('app').replaceChildren(h('div', { cls: 'wrap' }, h('div', { cls: 'card empty', text: '订阅加载失败，请稍后重试。' })));
  });
})();
