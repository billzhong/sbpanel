/* Runs synchronously before first paint (after the stylesheets): palette, optional custom accent
   from the theme settings, and the visitor's light/dark choice. Storage can throw inside the
   sandboxed (opaque-origin) page, so every access is guarded. */
(function () {
  var d = document.documentElement, s = {};
  try { s = (JSON.parse(document.getElementById('sbp-data').textContent).theme || {}).settings || {}; } catch (e) {}
  d.dataset.palette = s.palette || 'neutral';
  var mode = s.default_mode || 'system';
  try { mode = localStorage.getItem('sbp-sub-mode') || mode; } catch (e) {}
  if (mode === 'light' || mode === 'dark') d.dataset.theme = mode;

  // Custom accent: nudge until it reads as text on every surface (>= 4.5:1) and its ink passes too.
  var hex = /^#[0-9a-f]{6}$/i.test(s.accent || '') ? s.accent : '';
  if (!hex) return;
  function rgb(h) { return [1, 3, 5].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }); }
  function lum(h) { var c = rgb(h).map(function (v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function cr(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function mix(a, b, t) { var A = rgb(a), B = rgb(b); return '#' + A.map(function (v, i) { return ('0' + Math.round(v + (B[i] - v) * t).toString(16)).slice(-2); }).join(''); }
  function tok(n) { return getComputedStyle(d).getPropertyValue('--' + n).trim(); }
  function apply() {
    d.style.removeProperty('--accent');
    var bgs = [tok('base'), tok('surface'), tok('overlay')], text = tok('text');
    if (!/^#[0-9a-f]{6}$/i.test(bgs[0]) || !/^#[0-9a-f]{6}$/i.test(text)) return;
    var dark = lum(bgs[0]) < 0.2, a = hex;
    for (var i = 0; i < 24 && Math.min(cr(a, bgs[0]), cr(a, bgs[1]), cr(a, bgs[2])) < 4.5; i++) a = mix(a, text, 0.08);
    var ink = dark ? '#0b0d10' : '#ffffff';
    for (var j = 0; j < 24 && cr(a, ink) < 4.5; j++) a = mix(a, dark ? '#ffffff' : '#000000', 0.06);
    d.style.setProperty('--accent', a); d.style.setProperty('--accent-text', a);
    d.style.setProperty('--on-accent', ink); d.style.setProperty('--focus', a);
  }
  apply();
  window.__sbpAccent = apply;
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply); } catch (e) {}
})();
