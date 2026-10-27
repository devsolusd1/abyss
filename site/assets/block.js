// The brasa block, shared by every page: the pool's math, number formatting, the heat ramp,
// the still SVG drawing, labels pinned to the object, and the three.js scene and block.
// Pages load three.js, then this file (both deferred), and read what they need from
// window.Block. Colours come from window.BRASA.palette (assets/palettes.js).
(function () {
'use strict';
var PAL = window.BRASA.palette, PC = PAL.css, P3 = PAL.three;
var reduce = false;
try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

/* ================= the pool, as math (simulation the visitor drives) ================= */
var VIRT = 30, SUPPLY = 1e9, K0 = VIRT * SUPPLY, FEE = 0.01;
var GRAD_R = Math.sqrt(420 * VIRT) - VIRT;               // 82.2497 real SOL
var T_G = K0 / (VIRT + GRAD_R);                          // tokens left at graduation
var BURN_G = T_G * VIRT / (VIRT + GRAD_R);               // 71.43M
var T_G2 = T_G - BURN_G, K2 = GRAD_R * T_G2;             // the graduated pool's k
var A = 2.2 / (VIRT + GRAD_R), B = 2.2 / T_G, BH = 0.9; // world units per SOL, per token; block height (it means nothing, so it is set for the look)
var FOV = 30, INTRO_SOL = 40;

function fresh() { return { R: 0, T: SUPPLY, grad: false, burned: 0, held: 0, feeC: 0, feeP: 0 }; }
function xOf(s) { return s.grad ? s.R : VIRT + s.R; }
function priceOf(s) { return xOf(s) / s.T; }
function mcapOf(s) { return priceOf(s) * (SUPPLY - s.burned); }
function buy(s, d) {
  var fee = d * FEE; s.feeC += fee / 2; s.feeP += fee / 2;
  var rest = d - fee, out = 0, info = { out: 0, graduated: false, Tpre: 0, burn: 0 };
  if (!s.grad) {
    var on = Math.min(rest, GRAD_R - s.R);
    if (on > 0) { var x = VIRT + s.R, T2 = x * s.T / (x + on); out += s.T - T2; s.T = T2; s.R += on; rest -= on; }
    if (s.R >= GRAD_R - 1e-9) {
      s.R = GRAD_R; var burn = s.T * VIRT / (VIRT + s.R);
      info.Tpre = s.T; info.burn = burn; s.T -= burn; s.burned += burn; s.grad = true; info.graduated = true;
    }
  }
  if (s.grad && rest > 0) { var x2 = s.R, T3 = x2 * s.T / (x2 + rest); out += s.T - T3; s.T = T3; s.R += rest; }
  s.held += out; info.out = out;
  return info;
}
function sellTokens(s, tok) {
  if (!(tok > 0)) return 0;
  var x = xOf(s), newX = x * s.T / (s.T + tok), gross = x - newX, fee = gross * FEE;
  s.feeC += fee / 2; s.feeP += fee / 2; s.T += tok; s.held -= tok;
  s.R = Math.max(0, s.grad ? newX : newX - VIRT);
  return gross - fee;
}
function sellSol(s, d) {
  var x = xOf(s); d = Math.min(d, x * 0.4);
  var tok = Math.min(s.T * d / (x - d), s.held);
  if (!(tok > 1)) return 0;
  sellTokens(s, tok); return tok;
}
function dimsOf(s) { return { gw: s.grad ? 0 : VIRT * A, rw: s.R * A, d: s.T * B }; }
function heatOf(s) { return s.grad ? 1 : (s.R > 0 ? 0.14 + 0.86 * Math.min(1, s.R / GRAD_R) : 0); }
function stateFromPool(p) {
  return { R: Number(p.realSol) / 1e9, T: Number(p.tokens) / 1e6, grad: !!p.graduated, burned: Number(p.burned) / 1e6, held: 0, feeC: 0, feeP: 0 };
}
function exampleState(sol) { var s = fresh(); while (sol > 0) { var d = Math.min(4, sol); buy(s, d); sol -= d; } return s; }

/* ================= formatting ================= */
function fSol(v) { return v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v >= 0.01 || v <= 0 ? v.toFixed(3) : v.toPrecision(2); }
function fTok(v) { if (v >= 999.95e6) return (v / 1e9).toFixed(v >= 1e9 + 5e6 ? 2 : 0) + 'B'; if (v < 1e4) return '0'; return (v / 1e6).toFixed(v >= 1e8 ? 1 : 2) + 'M'; }
function fPx(p) { var m = p * 1e6; return m.toFixed(m >= 1 ? 3 : 4); }
function ago(sec) {
  if (!sec) return 'unknown';
  var d = Date.now() / 1000 - sec;
  if (d < 90) return 'just now';
  if (d < 5400) return Math.round(d / 60) + ' min ago';
  if (d < 129600) return Math.round(d / 3600) + ' h ago';
  return Math.round(d / 86400) + ' days ago';
}
function shortKey(k) { var s = String(k); return s.slice(0, 4) + '…' + s.slice(-4); }
function explorer(what, id) { try { if (window.NET && NET.explorer) return NET.explorer(what, String(id)); } catch (e) {} return null; }
var RAMP = [[0, BRASA.mix(PC.coal3, PC.heatLow, 0.25)], [0.35, BRASA.rgb(PC.heatLow)], [0.65, BRASA.rgb(PC.heatMid)], [0.88, BRASA.mix(PC.heatMid, PC.heatHigh, 0.5)], [1, BRASA.rgb(PC.heatHigh)]];
function heatRGB(h) {
  h = Math.max(0, Math.min(1, h));
  for (var i = 1; i < RAMP.length; i++) {
    if (h <= RAMP[i][0]) {
      var a = RAMP[i - 1], b = RAMP[i], t = (h - a[0]) / (b[0] - a[0]);
      return [0, 1, 2].map(function (k) { return Math.round(a[1][k] + (b[1][k] - a[1][k]) * t); });
    }
  }
  return RAMP[RAMP.length - 1][1];
}
function heatCss(h) { return 'rgb(' + heatRGB(h).join(',') + ')'; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* ================= a still drawing of the block (no WebGL, offline, thumbnails' fallback) ================= */
var svgN = 0;
function isoSVG(s, W, H, o) {
  o = o || {};
  var th = o.theta != null ? o.theta : 0.68, ph = o.phi != null ? o.phi : 0.5, pad = o.pad != null ? o.pad : 28;
  var dm = dimsOf(s), gw = dm.gw, rw = dm.rw, d = dm.d;
  var ct = Math.cos(th), st = Math.sin(th), cp = Math.cos(ph), sp = Math.sin(ph);
  function P(x, y, z) { return [x * ct - z * st, -(-x * st * sp + y * cp - z * ct * sp)]; }
  var minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  [-gw, rw].forEach(function (x) { [0, BH].forEach(function (y) { [-d, 0].forEach(function (z) {
    var p = P(x, y, z); minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]);
  }); }); });
  var fx = o.fx || 1, fy = o.fy || 1;
  var sc = Math.min((W * fx - 2 * pad) / (maxx - minx || 1), (H * fy - 2 * pad) / (maxy - miny || 1));
  var cx = o.cx != null ? o.cx : W / 2, cy = o.cy != null ? o.cy : H / 2;
  var ox = cx - (minx + maxx) / 2 * sc, oy = cy - (miny + maxy) / 2 * sc;
  function Q(x, y, z) { var p = P(x, y, z); return { x: p[0] * sc + ox, y: p[1] * sc + oy }; }
  function poly(pts, attr) { return '<polygon points="' + pts.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ') + '" ' + attr + '/>'; }
  function faces(x0, x1, z0, z1) {
    return { top: [Q(x0, BH, z1), Q(x1, BH, z1), Q(x1, BH, z0), Q(x0, BH, z0)],
      front: [Q(x0, 0, z1), Q(x1, 0, z1), Q(x1, BH, z1), Q(x0, BH, z1)],
      right: [Q(x1, 0, z1), Q(x1, 0, z0), Q(x1, BH, z0), Q(x1, BH, z1)] };
  }
  var id = 'h' + (++svgN), h = heatOf(s);
  var out = '<svg class="still" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><pattern id="' + id + '" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="' + P3.ghost + '" stroke-width="1" stroke-opacity=".55"/></pattern></defs>';
  var ghostStroke = 'stroke="' + P3.ghost + '" stroke-opacity=".75" stroke-width="1"';
  if (gw > 0) {
    var g = faces(-gw, 0, -d, 0);
    out += poly(g.front, 'fill="' + P3.ghost + '" fill-opacity=".04" ' + ghostStroke) + poly(g.top, 'fill="url(#' + id + ')" ' + ghostStroke);
    if (rw <= 0.0005) out += poly(g.right, 'fill="' + P3.ghost + '" fill-opacity=".04" ' + ghostStroke);
  }
  if (rw > 0.0005) {
    var f = faces(0, rw, -d, 0);
    out += poly(f.right, 'fill="' + heatCss(h * 0.62) + '"') + poly(f.front, 'fill="' + heatCss(h) + '"') + poly(f.top, 'fill="' + PC.navTop + '" stroke="' + heatCss(h) + '" stroke-opacity=".5" stroke-width="1"');
  }
  var a = Q(-gw, BH, 0), b = Q(rw, BH, -d);
  out += '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '" stroke="' + P3.diagonal + '" stroke-opacity=".85" stroke-width="1"/></svg>';
  return { svg: out, anchors: anchorsOf(dm, Q), project: Q };
}
function anchorsOf(dm, Q) {
  var gw = dm.gw, rw = dm.rw, d = dm.d, e = 0.15 * Math.max(0.5, Math.sqrt((gw + rw) * (gw + rw) + d * d));
  function dir(a, b) { return norm({ x: b.x - a.x, y: b.y - a.y }); }
  var dep = Q(rw, 0, -d / 2), fr = Q((rw - gw) / 2, 0, 0), lf = Q(-gw, 0, -d / 2);
  // the block's outline on screen (its eight corners' convex hull) and box, for labels and hit tests
  var cs = [];
  [-gw, rw].forEach(function (x) { [0, BH].forEach(function (y) { [-d, 0].forEach(function (z) { cs.push(Q(x, y, z)); }); }); });
  var hull = hullOf(cs), box = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 }, peak = null;
  hull.forEach(function (p) { box.x0 = Math.min(box.x0, p.x); box.x1 = Math.max(box.x1, p.x); box.y1 = Math.max(box.y1, p.y); if (!peak || p.y < peak.y) peak = p; box.y0 = peak.y; });
  // the top face's front corner: of the four top corners, the one lowest on screen is nearest
  var tf = null;
  [[-gw, 0], [rw, 0], [rw, -d], [-gw, -d]].forEach(function (c) { var p = Q(c[0], BH, c[1]); if (!tf || p.y > tf.y) tf = p; });
  var dS = Q(-gw, BH, 0), dE = Q(rw, BH, -d);
  return { nX: dir(dep, Q(rw + e, 0, -d / 2)), nZ: dir(fr, Q((rw - gw) / 2, 0, e)), nXm: dir(lf, Q(-gw - e, 0, -d / 2)), top: Q((rw - gw) / 2, BH, -d / 2), real: Q(rw / 2, 0, 0), virt: Q(-gw / 2, 0, 0), depth: Q(rw, 0, -d / 2),
    center: Q((rw - gw) / 2, BH / 2, -d / 2), diag: Q(-gw + (rw + gw) * 0.24, BH, -d * 0.24),
    hull: hull, box: box, peak: peak || dE, topFront: tf, diagStart: dS, diagEnd: dE, nD: dir(dS, dE), project: Q };
}
/** Convex hull of screen points (monotone chain), clockwise or not; non-finite points are dropped. */
function hullOf(pts) {
  var p = pts.filter(function (q) { return q && isFinite(q.x) && isFinite(q.y); }).slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
  if (p.length < 3) return p;
  function cr(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
  var lo = [], up = [], i;
  for (i = 0; i < p.length; i++) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p[i]) <= 0) lo.pop(); lo.push(p[i]); }
  for (i = p.length - 1; i >= 0; i--) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop(); up.push(p[i]); }
  lo.pop(); up.pop();
  return lo.concat(up);
}
/** True when screen point (x, y) is on the block: its outline grown by `grow` (0.12 = 12%) about its middle. */
function hitBlock(an, x, y, grow) {
  var h = an && an.hull; if (!h || h.length < 3) return false;
  var cx = 0, cy = 0; h.forEach(function (p) { cx += p.x; cy += p.y; }); cx /= h.length; cy /= h.length;
  var g = 1 + (grow || 0), px = cx + (x - cx) / g, py = cy + (y - cy) / g, sign = 0;
  for (var i = 0; i < h.length; i++) {
    var a = h[i], b = h[(i + 1) % h.length], c = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    if (c !== 0) { if (sign && (c > 0) !== (sign > 0)) return false; sign = c; }
  }
  return true;
}
/** A stepped gauge: n cells, the first `frac` of them lit, each in the heat colour of its own position. */
function gauge(frac, n) {
  n = n || 20; var lit = frac > 0 ? Math.min(n, Math.ceil(frac * n - 1e-9)) : 0, out = '';
  for (var i = 0; i < n; i++) out += i < lit ? '<i class="on" style="background:' + heatCss(0.14 + 0.86 * (i + 1) / n) + '"></i>' : '<i></i>';
  return out;
}
function segHitsRect(x1, y1, x2, y2, r) {
  var t0 = 0, t1 = 1, dx = x2 - x1, dy = y2 - y1, p = [-dx, dx, -dy, dy], q = [x1 - r.x0, r.x1 - x1, y1 - r.y0, r.y1 - y1];
  for (var i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    var t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}
function rectHitsHull(r, h) {
  if (!h || h.length < 3) return false;
  var cs = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]], i, j;
  var axes = [[1, 0], [0, 1]];
  for (i = 0; i < h.length; i++) { var a = h[i], b = h[(i + 1) % h.length]; axes.push([b.y - a.y, a.x - b.x]); }
  for (i = 0; i < axes.length; i++) {
    var ax = axes[i], h0 = 1e18, h1 = -1e18, r0 = 1e18, r1 = -1e18;
    for (j = 0; j < h.length; j++) { var v = h[j].x * ax[0] + h[j].y * ax[1]; h0 = Math.min(h0, v); h1 = Math.max(h1, v); }
    for (j = 0; j < 4; j++) { var w = cs[j][0] * ax[0] + cs[j][1] * ax[1]; r0 = Math.min(r0, w); r1 = Math.max(r1, w); }
    if (r1 < h0 || r0 > h1) return false;
  }
  return true;
}
function rectsMeet(a, b) { return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; }

/* ================= numbers pinned to the object ================= */
function tagLayer(tagsEl, svgEl) {
  var ns = 'http://www.w3.org/2000/svg', map = {};
  var L = {
    set: function (key, html, cls) {
      var t = map[key];
      if (!t) {
        var el = document.createElement('div'); el.className = 'tag ' + (cls || ''); tagsEl.appendChild(el);
        var g = document.createElementNS(ns, 'g'), ln = document.createElementNS(ns, 'line'), dot = document.createElementNS(ns, 'rect');
        dot.setAttribute('width', 3); dot.setAttribute('height', 3); g.appendChild(ln); g.appendChild(dot); svgEl.appendChild(g);
        t = map[key] = { el: el, g: g, ln: ln, dot: dot, html: null, w: 0, h: 0 };
      }
      if (t.html !== html) { t.el.innerHTML = html; t.html = html; t.w = t.el.offsetWidth; t.h = t.el.offsetHeight; }
      return t;
    },
    remeasure: function () { Object.keys(map).forEach(function (k) { var t = map[k]; t.w = t.el.offsetWidth; t.h = t.el.offsetHeight; }); },
    /**
     * Starts a new frame of placements: labels placed after this keep clear of the block's
     * outline `hull` (screen points) and of each other. Without it, a label keeps clear of every
     * label already showing.
     */
    begin: function (hull) { frame++; curHull = hull || null; },
    /**
     * Pins label `key` to screen point a, its leader going out along dir for len px. No line may
     * cross a label: if the label would touch the block's outline, another label or another
     * leader, the leader is lengthened in steps, then the label flips to the other side.
     */
    place: function (key, a, dir, len, W, H, minTop, maxY) {
      var t = map[key]; if (!t) return;
      if (!a || !isFinite(a.x) || !isFinite(a.y) || a.x < -40 || a.y < -40 || a.x > W + 40 || a.y > H + 40) { L.hide(key); return; }
      var flip = Math.abs(dir.x) >= 0.35 ? { x: -dir.x, y: dir.y } : { x: dir.x, y: -dir.y };
      var cands = [], ks = [1, 1.5, 2.1, 2.9];
      [dir, flip].forEach(function (d) { ks.forEach(function (k) { cands.push(geom(t, a, d, len * k, W, H, minTop, maxY)); }); });
      var order = cands.map(function (c, i) { return i; });
      if (t.ci != null && t.ci < cands.length) order.unshift(t.ci);
      var best = 0, bestS = 1e9;
      for (var i = 0; i < order.length; i++) {
        var s = score(key, cands[order[i]], a);
        if (s < bestS - 1e-6) { bestS = s; best = order[i]; }
        if (s === 0) break;
      }
      t.ci = best; show(t, a, cands[best]);
    },
    /**
     * Pins label `key` in a fixed slot centred above the block's screen box, its leader rising
     * straight from point a (the block's highest corner).
     */
    slot: function (key, a, box, W, H, minTop, gap) {
      var t = map[key]; if (!t) return;
      if (!a || !box || !isFinite(box.y0) || !isFinite(a.x)) { L.hide(key); return; }
      var lx = clamp((box.x0 + box.x1) / 2 - t.w / 2, 8, Math.max(8, W - t.w - 8));
      var ly = Math.max(minTop || 8, box.y0 - (gap || 18) - t.h);
      var ex = clamp(a.x, lx + 8, lx + t.w - 8), ey = ly + t.h;
      show(t, a, { lx: lx, ly: ly, ex: ex, ey: ey });
    },
    hide: function (key) { var t = map[key]; if (t) { t.el.style.opacity = 0; t.g.style.display = 'none'; t.on = false; } },
    remove: function (key) { var t = map[key]; if (t) { t.el.remove(); t.g.remove(); delete map[key]; } },
    has: function (key) { return !!map[key]; }
  };
  var frame = 0, curHull = null;
  function geom(t, a, dir, len, W, H, minTop, maxY) {
    var ex = a.x + dir.x * len, ey = a.y + dir.y * len;
    var lx = dir.x > 0.35 ? ex + 5 : dir.x < -0.35 ? ex - 5 - t.w : ex - t.w / 2;
    var ly = dir.y < -0.35 ? ey - t.h - 3 : dir.y > 0.35 ? ey + 3 : ey - t.h / 2;
    var cx = clamp(lx, 8, Math.max(8, W - t.w - 8)), cy = clamp(ly, minTop || 8, Math.max(minTop || 8, (maxY || H - 8) - t.h));
    return { lx: cx, ly: cy, ex: ex, ey: ey, moved: Math.abs(cx - lx) + Math.abs(cy - ly), w: t.w, h: t.h };
  }
  function score(key, c, a) {
    var r = { x0: c.lx - 2, y0: c.ly - 2, x1: c.lx + c.w + 2, y1: c.ly + c.h + 2 }, s = 0;
    if (curHull && rectHitsHull(r, curHull)) s += 4;
    Object.keys(map).forEach(function (k) {
      var o = map[k]; if (k === key || !o.on || !o.rect || (frame && o.frame !== frame)) return;
      if (rectsMeet(r, o.rect)) s += 3;
      if (segHitsRect(a.x, a.y, c.ex, c.ey, o.rect)) s += 2;
      if (o.seg && segHitsRect(o.seg[0], o.seg[1], o.seg[2], o.seg[3], r)) s += 2;
    });
    if (c.moved > 1) s += 0.5;
    return s;
  }
  function show(t, a, c) {
    t.el.style.transform = 'translate3d(' + Math.round(c.lx) + 'px,' + Math.round(c.ly) + 'px,0)';
    t.el.style.opacity = 1; t.g.style.display = '';
    t.ln.setAttribute('x1', a.x.toFixed(1)); t.ln.setAttribute('y1', a.y.toFixed(1));
    t.ln.setAttribute('x2', c.ex.toFixed(1)); t.ln.setAttribute('y2', c.ey.toFixed(1));
    t.dot.setAttribute('x', (a.x - 1.5).toFixed(1)); t.dot.setAttribute('y', (a.y - 1.5).toFixed(1));
    t.on = true; t.frame = frame; t.seg = [a.x, a.y, c.ex, c.ey];
    t.rect = { x0: c.lx, y0: c.ly, x1: c.lx + t.w, y1: c.ly + t.h };
  }
  return L;
}
function radial(a, c, fb) { var dx = a.x - c.x, dy = a.y - c.y, m = Math.hypot(dx, dy); return m < 2 ? fb : { x: dx / m, y: dy / m }; }
function norm(v) { var m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m }; }
function pinBlock(layer, s, an, W, H, o) {
  // the four standing labels around a block, spread away from its centre
  // o.slot: the market cap goes in a fixed slot above the block (with o.top); o.diagEnd: "this
  // slope is the price" sits past the diagonal's far end. Labels keep clear of the block and of
  // each other (see tagLayer.place).
  o = o || {};
  var dm = dimsOf(s), c = an.center, len = o.len || 30;
  if (layer.begin) layer.begin(an.hull);
  if (o.top && o.slot && layer.slot) layer.slot('mcap', an.peak, an.box, W, H, o.minTop, o.slotGap);
  var sep = norm({ x: an.real.x - an.virt.x, y: an.real.y - an.virt.y });
  if (dm.gw > 0 && dm.rw > 0.0005) {
    layer.place('virt', an.virt, norm({ x: an.nZ.x * 0.6 + an.nXm.x - sep.x * 0.5, y: an.nZ.y * 0.6 + an.nXm.y - sep.y * 0.5 + 0.35 }), len, W, H, o.minTop, o.maxY);
    layer.place('real', an.real, norm({ x: an.nZ.x + sep.x * 0.5, y: an.nZ.y + sep.y * 0.5 + 0.9 }), len * 1.7, W, H, o.minTop, o.maxY);
  } else if (dm.gw > 0) {
    layer.place('virt', an.virt, norm({ x: an.nZ.x, y: an.nZ.y + 0.6 }), len, W, H, o.minTop, o.maxY); layer.hide('real');
  } else {
    layer.hide('virt'); layer.place('real', an.real, norm({ x: an.nZ.x, y: an.nZ.y + 0.6 }), len, W, H, o.minTop, o.maxY);
  }
  layer.place('depth', an.depth, norm({ x: an.nX.x, y: an.nX.y + 0.2 }), len, W, H, o.minTop, o.maxY);
  if (o.diag && o.diagEnd && an.diagEnd) layer.place('diag', an.diagEnd, an.nD, o.diagLen || 18, W, H, o.minTop, o.maxY);
  else if (o.diag) layer.place('diag', an.diag, radial(an.diag, c, { x: -1, y: -0.4 }), 26, W, H, o.minTop, o.maxY); else layer.hide('diag');
  if (o.top && !(o.slot && layer.slot)) layer.place('mcap', an.top, { x: 0, y: -1 }, o.topLen || 54, W, H, o.minTop, o.maxY);
}
/* ================= measurements drawn on the object, as on a technical drawing ================= */
/**
 * Dimension lines for a block: its width along the front edge (the 30 virtual SOL dashed, the
 * real SOL solid), the tokens along its right edge and the price written along the top diagonal.
 * Lines go into svgEl, labels into textEl; both lie over the stage (classes .dims and .dimtext).
 * Each frame: L.begin(W, H, avoid), L.block(pr, o) and/or the primitives, then L.end(). A label
 * not set since begin() fades out at end(). Each label tries a few places (along its line, past
 * either end, either side) and takes the first that keeps clear of the stage's edges, the block,
 * the labels already placed and the `avoid` rectangles (stage px: text, controls). The lines sit
 * off the front (z+) and right (x+) faces, so the camera must see those two faces, as every
 * page frames the block.
 */
function dimLayer(svgEl, textEl) {
  var map = {}, out = '', W = 1, H = 1e5, low = 0, used = {}, placed = [], avoid = [], segs = [], hull = null;
  function lab(key, cls) {
    var t = map[key], c = 'dl ' + (cls || '');
    if (!t) { var el = document.createElement('span'); textEl.appendChild(el); t = map[key] = { el: el, html: null, w: 0, h: 0, cls: null, ci: -1 }; }
    if (t.cls !== c) { t.el.className = c; t.cls = c; t.html = null; }
    return t;
  }
  function text(t, html) { if (t.html !== html) { t.el.innerHTML = html; t.html = html; t.w = t.el.offsetWidth; t.h = t.el.offsetHeight; } }
  function upright(a, b) { var ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180; return ang; }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function len(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function ok(p) { return p && isFinite(p.x) && isFinite(p.y); }
  function rectPoly(r) { return [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }]; }
  // the label's corners: centred on `at`, turned by ang degrees, its near edge gap px off the
  // line, below it (side 1) or above it (side -1); the same box the CSS transform draws
  function corners(t, at, ang, side, gap) {
    var r = ang * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
    var y0 = side > 0 ? gap : -gap - t.h, y1 = y0 + t.h, x0 = -t.w / 2, x1 = t.w / 2;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(function (p) { return { x: at.x + p[0] * c - p[1] * sn, y: at.y + p[0] * sn + p[1] * c }; });
  }
  // convex polygons overlap unless some edge's normal separates them
  function meet(p, q) {
    var ps = [p, q];
    for (var k = 0; k < 2; k++) {
      var P = ps[k];
      for (var i = 0; i < P.length; i++) {
        var a = P[i], b = P[(i + 1) % P.length], nx = b.y - a.y, ny = a.x - b.x, p0 = 1e18, p1 = -1e18, q0 = 1e18, q1 = -1e18, j, d;
        for (j = 0; j < p.length; j++) { d = p[j].x * nx + p[j].y * ny; p0 = Math.min(p0, d); p1 = Math.max(p1, d); }
        for (j = 0; j < q.length; j++) { d = q[j].x * nx + q[j].y * ny; q0 = Math.min(q0, d); q1 = Math.max(q1, d); }
        if (p1 < q0 || q1 < p0) return false;
      }
    }
    return true;
  }
  /* places label t at the cheapest of the candidates {at, ang, side, gap, cost} */
  function choose(key, t, cands, o) {
    var best = null, bestS = 1e9;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i]; if (!ok(c.at)) continue;
      var poly = corners(t, c.at, c.ang, c.side, c.gap);
      var bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
      poly.forEach(function (q) { bx0 = Math.min(bx0, q.x); bx1 = Math.max(bx1, q.x); by0 = Math.min(by0, q.y); by1 = Math.max(by1, q.y); });
      // a label that would leave the stage slides back in along its own line (sideways when the
      // line is steep), so it keeps its distance from the line, at a small cost
      var dx = bx1 - bx0 > W - 16 ? 8 - bx0 : bx0 < 8 ? 8 - bx0 : bx1 > W - 8 ? W - 8 - bx1 : 0, dy = 0;
      if (dx) {
        var ra = c.ang * Math.PI / 180;
        if (Math.abs(Math.cos(ra)) > 0.3) dy = dx * Math.tan(ra);
        poly = poly.map(function (q) { return { x: q.x + dx, y: q.y + dy }; }); by0 += dy; by1 += dy;
      }
      var s = c.cost || 0;
      if (Math.abs(dx) > 1) s += 0.5 + Math.abs(dx) / 200;
      if (by0 < 2 || by1 > H - 2) s += 5;
      if (o.hull && hull && meet(poly, hull)) s += 2;
      for (var j = 0; j < placed.length; j++) if (meet(poly, placed[j])) s += 3;
      for (var m = 0; m < avoid.length; m++) if (meet(poly, avoid[m])) s += 3;
      for (var q = 0; q < segs.length; q++) if (meet(poly, segs[q])) s += 1.5;
      if (i === t.ci) s -= 0.05; // on a tie, last frame's place wins, so labels do not flicker
      if (s < bestS) { bestS = s; best = { c: c, poly: poly, dx: dx, dy: dy, i: i }; }
    }
    if (!best) return;
    t.ci = best.i; used[key] = true; placed.push(best.poly);
    if (o.low !== false) best.poly.forEach(function (q) { low = Math.max(low, q.y); });
    var c2 = best.c, off = c2.side > 0 ? c2.gap : -c2.gap - t.h;
    t.el.style.opacity = o.alpha == null ? 1 : o.alpha;
    t.el.style.transform = 'translate(' + (c2.at.x + best.dx).toFixed(1) + 'px,' + (c2.at.y + best.dy).toFixed(1) + 'px) rotate(' + c2.ang.toFixed(2) + 'deg) translate(-50%,' + off.toFixed(1) + 'px)';
  }
  var L = {
    /** Starts a frame on a stage W x H px; keepOut: rectangles {x0, y0, x1, y1} labels keep clear of. */
    begin: function (w, h, keepOut) { W = w || W; H = h || 1e5; out = ''; low = 0; used = {}; placed = []; segs = []; hull = null; avoid = (keepOut || []).filter(Boolean).map(rectPoly); },
    /** One more rectangle for the labels placed after this to keep clear of. */
    avoid: function (r) { if (r) avoid.push(rectPoly(r)); },
    /** Ends the frame: writes the lines, fades labels not set since begin(); returns the lowest y drawn. */
    end: function () {
      svgEl.innerHTML = out;
      Object.keys(map).forEach(function (k) { if (!used[k]) map[k].el.style.opacity = 0; });
      return low;
    },
    show: function (on) { svgEl.classList.toggle('on', !!on); textEl.classList.toggle('on', !!on); },
    clear: function () { svgEl.innerHTML = ''; Object.keys(map).forEach(function (k) { map[k].el.style.opacity = 0; }); },
    /** Measures every label again (their sizes change once the web fonts arrive). */
    remeasure: function () { Object.keys(map).forEach(function (k) { map[k].w = map[k].el.offsetWidth; map[k].h = map[k].el.offsetHeight; }); },
    /** The width label `key` would have with this text. */
    measure: function (key, html, cls) { var t = lab(key, cls); text(t, html); return t.w; },
    line: function (a, b, cls, alpha) {
      if (!ok(a) || !ok(b)) return;
      low = Math.max(low, a.y, b.y);
      // a dimension line, with its ticks and a little air, is kept clear by the labels placed after it
      if (!cls || /^dm\b/.test(cls)) {
        var n = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = -(b.y - a.y) / n * 5, ny = (b.x - a.x) / n * 5;
        segs.push([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]);
      }
      out += '<line class="' + (cls || 'dm') + '"' + (alpha != null && alpha < 1 ? ' style="opacity:' + alpha.toFixed(2) + '"' : '') + ' x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"/>';
    },
    /** A drafting slash at p, 45 degrees across the dimension line a-b. */
    tick: function (p, a, b, cls, alpha) {
      if (!ok(p)) return;
      var ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 4, r = 5;
      L.line({ x: p.x - Math.cos(ang) * r, y: p.y - Math.sin(ang) * r }, { x: p.x + Math.cos(ang) * r, y: p.y + Math.sin(ang) * r }, 'tk ' + (cls || ''), alpha);
    },
    /**
     * Label `key` centred at `at`, turned by `angle` degrees, 9 px below that point (o.above: 7 px
     * above; o.gap sets the distance). o.alts: more places to try, {at, ang, side (1 below, -1
     * above), gap, cost}. o.alpha; o.hull: keep off the block drawn by the last block() call;
     * o.low === false: it does not count for end()'s lowest y. With o.minLen it shows only when
     * o.segLen leaves that much room beside it.
     */
    label: function (key, html, cls, at, angle, o) {
      o = o || {};
      var t = lab(key, cls); text(t, html);
      if (o.minLen && !(o.segLen >= t.w + o.minLen)) return;
      var side = o.above ? -1 : 1, gap = o.gap != null ? o.gap : o.above ? 7 : 9;
      var cands = [{ at: at, ang: angle || 0, side: side, gap: gap, cost: 0 }];
      (o.alts || []).forEach(function (c) { cands.push({ at: c.at, ang: c.ang != null ? c.ang : angle || 0, side: c.side || side, gap: c.gap != null ? c.gap : gap, cost: c.cost != null ? c.cost : 0.2 }); });
      choose(key, t, cands, o);
    },
    /**
     * Label `key` along segment a-b: in the middle when it fits, else past a, else past b; below
     * the line first, above it when below is taken. Options as for label().
     */
    labelOn: function (key, html, cls, a, b, o) {
      o = o || {};
      if (!ok(a) || !ok(b)) return;
      var t = lab(key, cls); text(t, html);
      var n = len(a, b), ang = upright(a, b), ux = (a.x - b.x) / (n || 1), uy = (a.y - b.y) / (n || 1), r = t.w / 2 + 12;
      var short = n < t.w + 12 ? 1.5 : 0, m = mid(a, b), pa = { x: a.x + ux * r, y: a.y + uy * r }, pb = { x: b.x - ux * r, y: b.y - uy * r };
      choose(key, t, [
        { at: m, ang: ang, side: 1, gap: 9, cost: short },
        { at: pa, ang: ang, side: 1, gap: 9, cost: 0.6 },
        { at: pb, ang: ang, side: 1, gap: 9, cost: 0.8 },
        { at: m, ang: ang, side: -1, gap: 7, cost: short + 0.3 },
        { at: pa, ang: ang, side: -1, gap: 7, cost: 0.9 },
        { at: pb, ang: ang, side: -1, gap: 7, cost: 1.1 }
      ], o);
    },
    /**
     * The standard measurements of one block. pr(x, y, z) projects world points to stage px.
     * o.dm: the dimensions drawn (dimsOf, or a display copy easing toward it); o.s: the pool
     * state whose numbers are written. o.text overrides any of virt, real, tok, price, tail
     * (the words after the price). o.price === false leaves the price out; o.slopeAt (0.34)
     * is where along the diagonal it sits first. o.gone {gw, rw, d0, burn, alpha}: at
     * graduation, the dropped virtual part and the burned slice, dashed, fading with alpha.
     * Returns the lowest y drawn so far (lines and the labels under them), to put things below.
     */
    block: function (pr, o) {
      var dm = o.dm, s = o.s, tx = o.text || {};
      var size = Math.max(dm.gw + dm.rw, dm.d, 0.4), e = 0.12 * size, z0 = 0.012;
      var hasV = dm.gw > 5e-4, hasR = dm.rw > 5e-4;
      var cs = [];
      [-dm.gw, dm.rw].forEach(function (x) { [0, BH].forEach(function (y) { [-dm.d, 0].forEach(function (z) { cs.push(pr(x, y, z)); }); }); });
      hull = hullOf(cs);
      // the price, written along the diagonal it is; placed first, so the others keep clear of it
      if (o.price !== false) {
        var s0 = pr(-dm.gw, BH, 0), s1 = pr(dm.rw, BH, -dm.d), k = o.slopeAt != null ? o.slopeAt : 0.34;
        var px = tx.price || (fPx(priceOf(s)) + ' SOL per 1M'), tail = tx.tail != null ? tx.tail : ' <i>· this slope is the price</i>';
        var html = px + tail;
        // measured on a label of its own that never shows, so the shown one is not rewritten every frame
        if (tail && L.measure('slope-full', html, 'dl-p') > len(s0, s1) * 0.95) html = px;
        var along = function (f) { return { x: s0.x + (s1.x - s0.x) * f, y: s0.y + (s1.y - s0.y) * f }; };
        L.label('slope', html, 'dl-p', along(k), upright(s0, s1), { above: true, low: false, alts: [{ at: along(0.5), cost: 0.2 }, { at: along(0.2), cost: 0.3 }, { at: along(0.66), cost: 0.4 }] });
      }
      var virtH = tx.virt || '30 SOL <i>virtual</i>', realH = tx.real || (fSol(s.R) + ' SOL <i>real</i>');
      // width, along the front edge: the virtual part and the real part
      var a0 = pr(-dm.gw, 0, e), a1 = pr(0, 0, e), a2 = pr(dm.rw, 0, e);
      L.line(pr(-dm.gw, 0, z0), pr(-dm.gw, 0, e * 1.35), 'ex'); L.line(pr(dm.rw, 0, z0), pr(dm.rw, 0, e * 1.35), 'ex');
      if (hasV) {
        L.line(a0, a1, 'dm v');
        if (hasR) L.line(pr(0, 0, z0), pr(0, 0, e * 1.2), 'ex');
        L.tick(a0, a0, a2);
      }
      if (hasR) { L.line(a1, a2, 'dm r'); L.tick(a1, a0, a2); }
      L.tick(a2, a0, a2);
      if (hasV && hasR && len(a1, a2) < L.measure('real', realH, 'dl-r') + 12) {
        // the real part is too narrow to carry its own number: one label, on two lines, for the whole width
        L.labelOn('both', virtH + '<br><i>+</i> <span class="dl-r">' + realH + '</span>', 'dl-v', a0, a2, { hull: true });
      } else {
        if (hasV) L.labelOn('virt', virtH, 'dl-v', a0, a1, { hull: true });
        if (hasR) L.labelOn('real', realH, 'dl-r', a2, a1, { hull: true });
      }
      // depth, along the right edge: the tokens in the pool
      var d0 = pr(dm.rw + e, 0, 0), d1 = pr(dm.rw + e, 0, -dm.d);
      L.line(pr(dm.rw + z0, 0, 0), pr(dm.rw + e * 1.35, 0, 0), 'ex'); L.line(pr(dm.rw + z0, 0, -dm.d), pr(dm.rw + e * 1.35, 0, -dm.d), 'ex');
      L.line(d0, d1, 'dm t'); L.tick(d0, d0, d1); L.tick(d1, d0, d1);
      L.labelOn('tok', tx.tok || (fTok(s.T) + ' <i>tokens</i>'), 'dl-t', d1, d0, { hull: true });
      // graduation: the burned slice and the dropped virtual part, dashed while they go
      var g = o.gone;
      if (g && g.alpha > 0) {
        var b0 = pr(g.rw + e, 0, -dm.d), b1 = pr(g.rw + e, 0, -g.d0);
        L.line(b0, b1, 'dm gone', g.alpha); L.tick(b1, b0, b1, 'gone', g.alpha);
        L.labelOn('burn', '−' + fTok(g.burn) + ' <i>burned</i>', 'dl-b', b1, b0, { alpha: g.alpha, hull: true });
        var v0 = pr(-g.gw, 0, e), v1 = pr(0, 0, e);
        L.line(v0, v1, 'dm gone', g.alpha);
        L.labelOn('drop', '30 SOL <i>virtual, dropped</i>', 'dl-b', v0, v1, { alpha: g.alpha, hull: true });
      }
      return low;
    },
    /** The ends of the lines block(pr, {dm}) draws off the block, labels aside. */
    reach: function (pr, dm) {
      var e = 0.12 * Math.max(dm.gw + dm.rw, dm.d, 0.4);
      return [pr(-dm.gw, 0, e * 1.35), pr(dm.rw, 0, e * 1.35), pr(dm.rw + e * 1.35, 0, 0), pr(dm.rw + e * 1.35, 0, -dm.d)].filter(ok);
    },
    /** The lowest y the lines of block(pr, {dm}) reach, labels aside: to put something under them first. */
    bottom: function (pr, dm) {
      var e = 0.12 * Math.max(dm.gw + dm.rw, dm.d, 0.4), y = -1e9;
      [pr(-dm.gw, 0, e * 1.35), pr(dm.rw, 0, e * 1.35), pr(dm.rw + e * 1.35, 0, 0), pr(dm.rw + e * 1.35, 0, -dm.d)].forEach(function (p) { if (ok(p)) y = Math.max(y, p.y); });
      return y + 5;
    },
    upright: upright, mid: mid, len: len
  };
  return L;
}
function standingText(layer, s, sim) {
  layer.set('virt', '<b>30 SOL</b><small>virtual, not really there</small>', 't-virt');
  layer.set('real', '<b>' + fSol(s.R) + ' SOL</b><small>real, came in</small>', 't-real');
  layer.set('depth', '<b>' + fTok(s.T) + '</b><small>tokens in the pool</small>', 't-depth');
  layer.set('diag', 'this slope is the price', 't-diag');
}

/* ================= three.js pieces ================= */
var HAS3 = !!window.THREE, TEX = null;
function col(hex) { return new THREE.Color(hex).convertSRGBToLinear(); }
function rnd(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function canvasOf(n, draw) { var c = document.createElement('canvas'); c.width = c.height = n; draw(c.getContext('2d'), n); return c; }
function textures() {
  if (TEX) return TEX;
  // The crack map's luminance is a heat rank: the block's shader lights only the parts brighter
  // than 1 - heat, so a few hot seams glow first and the rest of the cracks, their halos and
  // last the dust join in on the way to graduation.
  var crack = canvasOf(512, function (g, n) {
    var r = rnd(7); g.fillStyle = 'rgb(12,12,12)'; g.fillRect(0, 0, n, n);
    function grey(v) { var c = Math.round(Math.max(0, Math.min(1, v)) * 255); return 'rgb(' + c + ',' + c + ',' + c + ')'; }
    for (var i = 0; i < 1500; i++) { g.fillStyle = grey(0.1 + r() * 0.2); var q = r() * 2 + 0.6; g.fillRect(r() * n, r() * n, q, q); }
    g.lineCap = 'round'; g.lineJoin = 'round';
    function seg(p0, p1, lw, v, blur) {
      g.lineWidth = lw; g.strokeStyle = grey(v); g.shadowColor = grey(v); g.shadowBlur = blur;
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        g.beginPath(); g.moveTo(p0[0] + dx * n, p0[1] + dy * n); g.lineTo(p1[0] + dx * n, p1[1] + dy * n); g.stroke();
      }
    }
    function crackAt(x, y, ang, len, lv, w) {
      var pts = [[x, y]];
      for (var s = 0; s < len; s += 6) { ang += (r() - 0.5) * 0.9; x += Math.cos(ang) * 6; y += Math.sin(ang) * 6; pts.push([x, y]); }
      for (var j = 1; j < pts.length; j++) seg(pts[j - 1], pts[j], w * 3.4, lv * 0.34, 6);
      for (var m = 1; m < pts.length; m++) { var t = m / pts.length; seg(pts[m - 1], pts[m], Math.max(0.5, w * (1 - 0.55 * t)), lv * (1 - 0.4 * t), 2); }
      return pts;
    }
    for (var k = 0; k < 46; k++) {
      var lv = k < 7 ? 0.93 + r() * 0.07 : 0.32 + r() * 0.6, w = 0.7 + lv * 2.1 + r() * 0.5;
      var pts = crackAt(r() * n, r() * n, r() * 6.283, 30 + r() * 120, lv, w);
      if (lv > 0.6 && pts.length > 6) { var b = pts[(pts.length * (0.3 + r() * 0.4)) | 0]; crackAt(b[0], b[1], r() * 6.283, 18 + r() * 50, lv * 0.72, w * 0.6); }
    }
    g.shadowBlur = 0;
  });
  // relief for the coal: soft lumps and grain, read as height by the bump map
  var bump = canvasOf(256, function (g, n) {
    var r = rnd(23); g.fillStyle = 'rgb(128,128,128)'; g.fillRect(0, 0, n, n);
    for (var k = 0; k < 240; k++) {
      var x = r() * n, y = r() * n, rad = 3 + r() * 22, v = r() < 0.5 ? 0 : 255, a = 0.06 + r() * 0.2;
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        var cx = x + dx * n, cy = y + dy * n, gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
        gr.addColorStop(0, 'rgba(' + v + ',' + v + ',' + v + ',' + a.toFixed(2) + ')'); gr.addColorStop(1, 'rgba(' + v + ',' + v + ',' + v + ',0)');
        g.fillStyle = gr; g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      }
    }
    var im = g.getImageData(0, 0, n, n);
    for (var i = 0; i < n * n; i++) { var d = (r() - 0.5) * 22; for (var c = 0; c < 3; c++) im.data[i * 4 + c] = Math.max(0, Math.min(255, im.data[i * 4 + c] + d)); }
    g.putImageData(im, 0, 0);
  });
  var coal = canvasOf(256, function (g, n) {
    var r = rnd(11), im = g.createImageData(n, n);
    for (var i = 0; i < n * n; i++) { var v = 72 + r() * 34; im.data[i * 4] = v; im.data[i * 4 + 1] = v; im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
    g.putImageData(im, 0, 0);
    for (var k = 0; k < 70; k++) { g.fillStyle = 'rgba(0,0,0,' + (r() * 0.3).toFixed(2) + ')'; g.beginPath(); g.arc(r() * n, r() * n, 4 + r() * 24, 0, 7); g.fill(); }
  });
  var hatch = canvasOf(128, function (g, n) {
    g.clearRect(0, 0, n, n); g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = 2.2;
    for (var i = -n; i <= 2 * n; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i - n, n); g.stroke(); }
  });
  var dot = canvasOf(64, function (g, n) {
    var gr = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.22, 'rgba(255,255,255,.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, n, n);
  });
  function T(c, srgb) { var t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (srgb) t.encoding = THREE.sRGBEncoding; return t; }
  TEX = { crack: T(crack, true), coal: T(coal, true), hatch: T(hatch, true), dot: T(dot, false), bump: T(bump, false) };
  return TEX;
}
function pixelRatio(w, h) {
  var dpr = Math.min(1.5, window.devicePixelRatio || 1);
  return w * h * dpr * dpr > 3.5e6 ? 1 : dpr;
}
function setupRenderer(r) {
  r.setPixelRatio(pixelRatio(window.innerWidth, window.innerHeight));
  r.setClearColor(0x000000, 0);
  r.outputEncoding = THREE.sRGBEncoding; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.1;
  r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap; r.shadowMap.autoUpdate = false; r.shadowMap.needsUpdate = true;
}
function makeStage(scene) {
  scene.background = null;
  scene.fog = null;
  var hemi = new THREE.HemisphereLight(col(P3.hemiSky), col(P3.hemiGround), 0.6);
  var key = new THREE.DirectionalLight(col(P3.keyLight), 1.55);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02; key.shadow.radius = 5;
  var rim = new THREE.DirectionalLight(col(P3.rimLight), 0.9);
  var glows = [0, 1, 2].map(function () { return new THREE.PointLight(col(P3.glowLight), 0, 6, 2); });
  var light = PAL.scheme === 'light';
  var floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ opacity: light ? 0.3 : 0.6 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  // the block's own warmth on the ground, as strong as its heat
  var disc = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ map: textures().dot, color: col(P3.glowLight), transparent: true, opacity: 0, depthWrite: false, toneMapped: false, blending: light ? THREE.NormalBlending : THREE.AdditiveBlending }));
  disc.rotation.x = -Math.PI / 2; disc.position.y = 0.002;
  scene.add(hemi, key, key.target, rim, floor, disc); glows.forEach(function (g) { scene.add(g); });
  return {
    aim: function (c, r, dm, dist) {
      key.position.set(c.x - r * 1.5, c.y + r * 3.0 + 1, c.z + r * 1.9); key.target.position.copy(c);
      var sc = key.shadow.camera, e = r * 1.5 + 0.6;
      sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e; sc.near = 0.1; sc.far = r * 9 + 8; sc.updateProjectionMatrix();
      rim.position.set(c.x + r * 1.6, c.y + r * 1.3 + 0.5, c.z - r * 2.6);
      var along = dm.d > dm.rw;
      glows.forEach(function (L, i) {
        var f = (i + 0.5) / 3;
        if (along) L.position.set(dm.rw / 2, BH * 0.8, -dm.d * f); else L.position.set(dm.rw * f, BH * 0.8, -dm.d / 2);
        L.distance = r * 1.6 + 1.8;
      });
      disc.position.x = c.x; disc.position.z = c.z; disc.scale.setScalar(r * 1.9);
    },
    glow: function (h) { glows.forEach(function (L) { L.intensity = h * 2.4; }); disc.material.opacity = Math.min(1, h) * (light ? 0.22 : 0.5); }
  };
}
function makeBlock() {
  var tex = textures();
  function box(tx, ty, tz) { var g = new THREE.BoxGeometry(1, 1, 1); g.translate(tx, ty, tz); return g; }
  var realGeo = box(0.5, 0.5, -0.5), ghostGeo = box(-0.5, 0.5, -0.5);
  var base = realGeo.attributes.uv.array.slice();
  var realMat = new THREE.MeshStandardMaterial({ map: tex.coal, color: col(P3.coalBase), roughness: 0.84, metalness: 0.03, emissive: col(P3.crackHot), emissiveMap: tex.crack, emissiveIntensity: 1, bumpMap: tex.bump, bumpScale: 0.035 });
  // heat as coverage: a crack glows only where its luminance in the map is above 1 - heat
  var heatU = { value: 0 };
  realMat.onBeforeCompile = function (sh) {
    sh.uniforms.uHeat = heatU;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uHeat;').replace('#include <emissivemap_fragment>', [
      '#ifdef USE_EMISSIVEMAP',
      '  vec4 emissiveColor = texture2D( emissiveMap, vUv );',
      '  float crackL = dot( emissiveColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );',
      '  emissiveColor.rgb = emissiveMapTexelToLinear( emissiveColor ).rgb;',
      '  totalEmissiveRadiance *= emissiveColor.rgb * smoothstep( 1.0 - uHeat, 1.0 - uHeat + 0.08, crackL );',
      '#endif'].join('\n'));
  };
  var real = new THREE.Mesh(realGeo, realMat); real.castShadow = true; real.receiveShadow = true;
  var realEdge = new THREE.LineSegments(new THREE.EdgesGeometry(realGeo), new THREE.LineBasicMaterial({ color: col(P3.edge), transparent: true, opacity: 0.2 }));
  var side = new THREE.MeshBasicMaterial({ color: col(P3.ghost), transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  var topH = new THREE.MeshBasicMaterial({ map: tex.hatch, color: col(P3.ghost), transparent: true, opacity: 0.52, depthWrite: false, toneMapped: false });
  var ghost = new THREE.Mesh(ghostGeo, [side, side, topH, side, side, side]);
  var ghostEdge = new THREE.LineSegments(new THREE.EdgesGeometry(ghostGeo), new THREE.LineBasicMaterial({ color: col(P3.ghost), transparent: true, opacity: 0.92, toneMapped: false }));
  var dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  var diag = new THREE.Line(dg, new THREE.LineBasicMaterial({ color: col(P3.diagonal), transparent: true, opacity: 1, toneMapped: false }));
  var group = new THREE.Group(); group.add(real, realEdge, ghost, ghostEdge, diag);
  var cold = col(P3.crackCold), hot = col(P3.crackHot), tmp = new THREE.Color();
  function uv(geo, w, h, d, s) {
    var a = geo.attributes.uv.array, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (var f = 0; f < 6; f++) for (var v = 0; v < 4; v++) { var i = (f * 4 + v) * 2; a[i] = base[i] * dims[f][0] / s; a[i + 1] = base[i + 1] * dims[f][1] / s; }
    geo.attributes.uv.needsUpdate = true;
  }
  return {
    group: group,
    layout: function (dm, hatchSize) {
      var rw = Math.max(dm.rw, 1e-4), gw = Math.max(dm.gw, 1e-4), d = Math.max(dm.d, 1e-4);
      real.visible = realEdge.visible = dm.rw > 5e-4; real.scale.set(rw, BH, d); realEdge.scale.copy(real.scale); uv(realGeo, rw, BH, d, 1.5);
      ghost.visible = ghostEdge.visible = dm.gw > 5e-4; ghost.scale.set(gw, BH, d); ghostEdge.scale.copy(ghost.scale); uv(ghostGeo, gw, BH, d, hatchSize || 0.4);
      var p = dg.attributes.position.array, y = BH + 0.004;
      p[0] = -dm.gw; p[1] = y; p[2] = 0; p[3] = dm.rw; p[4] = y; p[5] = -dm.d; dg.attributes.position.needsUpdate = true; dg.computeBoundingSphere();
    },
    heat: function (h, flick) {
      var hc = Math.max(0, Math.min(1, h));
      heatU.value = hc;
      realMat.emissive.copy(tmp.copy(cold).lerp(hot, Math.sqrt(hc)));
      realMat.emissiveIntensity = (0.9 + 2.5 * h) * (0.9 + 0.1 * flick);
    },
    material: realMat,
    mesh: real
  };
}
function frameFor(dm, aspect, fx, fy) {
  var w = Math.max(0.3, dm.gw + dm.rw), d = Math.max(0.3, dm.d);
  var r = 0.5 * Math.sqrt(w * w + d * d + BH * BH);
  var hv = FOV / 2 * Math.PI / 180, hh = Math.atan(Math.tan(hv) * aspect);
  var half = Math.min(Math.atan(Math.tan(hv) * fy), Math.atan(Math.tan(hh) * fx));
  return { c: new THREE.Vector3((dm.rw - dm.gw) / 2, BH * 0.5, -dm.d / 2), r: r, dist: r / Math.sin(half) };
}
/**
 * The distance at which the block's eight corners, seen from (th, ph), fill fx of the width or
 * fy of the height, whichever comes first. Framing the corners, not a bounding sphere, keeps a
 * long block from sitting small inside an empty circle.
 */
var FIT_V = null;
function fitDistance(cam, dm, c, dist, th, ph, fx, fy) {
  FIT_V = FIT_V || new THREE.Vector3();
  var v = FIT_V, xs = [-dm.gw, dm.rw], ys = [0, BH], zs = [-dm.d, 0];
  for (var it = 0; it < 3; it++) {
    cam.clearViewOffset();
    setCam(cam, c, dist, th, ph);
    var minx = 9, maxx = -9, miny = 9, maxy = -9;
    for (var i = 0; i < 2; i++) for (var j = 0; j < 2; j++) for (var k = 0; k < 2; k++) {
      v.set(xs[i], ys[j], zs[k]).project(cam);
      minx = Math.min(minx, v.x); maxx = Math.max(maxx, v.x); miny = Math.min(miny, v.y); maxy = Math.max(maxy, v.y);
    }
    var need = Math.max((maxx - minx) / 2 / fx, (maxy - miny) / 2 / fy);
    if (!(need > 0) || Math.abs(need - 1) < 0.01) break;
    dist *= need;
  }
  return dist;
}
function setCam(cam, c, dist, th, ph) {
  cam.position.set(c.x + dist * Math.sin(th) * Math.cos(ph), c.y + dist * Math.sin(ph), c.z + dist * Math.cos(th) * Math.cos(ph));
  cam.near = Math.max(0.02, dist * 0.04); cam.far = dist * 8 + 60; cam.lookAt(c); cam.updateProjectionMatrix();
}
function projector(cam, W, H) {
  var v = new THREE.Vector3();
  return function (x, y, z) { v.set(x, y, z).project(cam); return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, z: v.z }; };
}

/* ================= drawing a block into any box (board tiles, coin pages) ================= */
var thumb = null;
function getThumb() {
  if (thumb !== null) return thumb;
  try {
    if (!HAS3) throw new Error('no three.js');
    var c = document.createElement('canvas');
    var r = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true, preserveDrawingBuffer: true });
    setupRenderer(r);
    var sc = new THREE.Scene(), li = makeStage(sc), rg = makeBlock(); sc.add(rg.group);
    thumb = { r: r, sc: sc, li: li, rg: rg, cam: new THREE.PerspectiveCamera(FOV, 1, 0.05, 200), lost: false };
    // if the GPU drops the shared context, every later block is drawn as the SVG still
    c.addEventListener('webglcontextlost', function (e) { e.preventDefault(); if (thumb) thumb.lost = true; });
  } catch (e) { thumb = false; }
  return thumb;
}
function paintBlock(s, box, o) {
  // draws coin s into the box (a canvas, or replaced by an SVG still); returns anchors in CSS px
  o = o || {};
  var Wb = Math.max(1, box.clientWidth), Hb = Math.max(1, box.clientHeight), th = getThumb();
  var cnv = box.querySelector('canvas');
  if (th && cnv && !th.lost) {
    var stale = box.querySelector('svg.still'); if (stale) stale.remove();
    if (cnv.style.display === 'none') cnv.style.display = '';
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cnv.width = Math.round(Wb * dpr); cnv.height = Math.round(Hb * dpr);
    th.r.setPixelRatio(dpr); th.r.setSize(Wb, Hb, false);
    var dm = dimsOf(s), fr = frameFor(dm, Wb / Hb, o.fx || 0.8, o.fy || 0.7);
    var tth = o.theta != null ? o.theta : 0.46, tph = o.phi != null ? o.phi : 0.56;
    th.cam.aspect = Wb / Hb; th.cam.clearViewOffset();
    fr.dist = fitDistance(th.cam, dm, fr.c, fr.dist, tth, tph, o.fx || 0.8, o.fy || 0.7);
    setCam(th.cam, fr.c, fr.dist, tth, tph);
    th.li.aim(fr.c, fr.r, dm, fr.dist); th.rg.layout(dm, Math.max(0.22, fr.r * 0.11));
    var h = heatOf(s); th.rg.heat(h, 0.5); th.li.glow(h * 0.9);
    th.r.render(th.sc, th.cam);
    var g = cnv.getContext('2d'); g.clearRect(0, 0, cnv.width, cnv.height); g.drawImage(th.r.domElement, 0, 0, cnv.width, cnv.height);
    // a copy of the shared camera, so the anchors' projector stays right after the next paint
    return anchorsOf(dm, projector(th.cam.clone(), Wb, Hb));
  }
  var res = isoSVG(s, Wb, Hb, { fx: o.fx || 0.8, fy: o.fy || 0.7, pad: 8 });
  var old = box.querySelector('svg.still'); if (old) old.remove();
  if (cnv) cnv.style.display = 'none';
  box.insertAdjacentHTML('afterbegin', res.svg);
  return res.anchors;
}


window.Block = {
  VIRT: VIRT,
  SUPPLY: SUPPLY,
  K0: K0,
  FEE: FEE,
  GRAD_R: GRAD_R,
  T_G: T_G,
  BURN_G: BURN_G,
  T_G2: T_G2,
  K2: K2,
  A: A,
  B: B,
  BH: BH,
  FOV: FOV,
  INTRO_SOL: INTRO_SOL,
  fresh: fresh,
  xOf: xOf,
  priceOf: priceOf,
  mcapOf: mcapOf,
  buy: buy,
  sellTokens: sellTokens,
  sellSol: sellSol,
  dimsOf: dimsOf,
  heatOf: heatOf,
  stateFromPool: stateFromPool,
  exampleState: exampleState,
  fSol: fSol,
  fTok: fTok,
  fPx: fPx,
  ago: ago,
  shortKey: shortKey,
  explorer: explorer,
  RAMP: RAMP,
  heatRGB: heatRGB,
  heatCss: heatCss,
  clamp: clamp,
  isoSVG: isoSVG,
  anchorsOf: anchorsOf,
  tagLayer: tagLayer,
  radial: radial,
  norm: norm,
  pinBlock: pinBlock,
  dimLayer: dimLayer,
  standingText: standingText,
  HAS3: HAS3,
  col: col,
  rnd: rnd,
  canvasOf: canvasOf,
  textures: textures,
  pixelRatio: pixelRatio,
  setupRenderer: setupRenderer,
  makeStage: makeStage,
  makeBlock: makeBlock,
  frameFor: frameFor,
  fitDistance: fitDistance,
  setCam: setCam,
  projector: projector,
  getThumb: getThumb,
  paintBlock: paintBlock,
  // added in the second pass (all optional for callers)
  hullOf: hullOf,
  hitBlock: hitBlock,
  gauge: gauge
};
})();
