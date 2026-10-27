// The forma triangle, shared by every page: the pool drawn as a thick triangular ring on a few
// pixels, in the seven forma colours and nothing else. It comes from the approved prototype
// (prototypes/round6) so the landing, the coin page, the board and the launch page draw it alike.
// Load it deferred; it needs nothing else and puts one object on window.Tri.
//
// Units. A "pixel" is one pixel of the triangle (at scale 1 the house is about 80 wide); the page
// picks how many css pixels one is. A fill is shares of the ring's volume, 0 to 1:
// { v, t, post } = the virtual SOL's top, the real SOL's top, and whether the coin has graduated
// (then there is no virtual SOL and the real SOL fills from the bottom). A pool state is
// { virtualSol, realSol, graduationSol, graduated, full? }: numbers are SOL, and a BigInt is lamports
// (what Chain.readPool and listPools give) and becomes SOL as it comes in. Tri.fromPool does a whole pool.
//
//   Tri.C, Tri.HEX, Tri.ANG34   colour indices (GR INK DEEP BLUE ICE PAPER ORANGE; 0 is the background), their hex, the 3/4 view angle
//   Tri.reduced                 reduced motion: the visitor's setting, or ?motion=reduce in the address
//   Tri.SHAPES                  house, curve, tray, L cut: { id, name, V, M, fee, form, angle, pool, G, Cap, vShare, surf, vol }
//                               (V virtual SOL, M graduation market cap in SOL, fee in basis points, G real SOL to graduate)
//   Tri.shape(id)               one of them, or null
//   Tri.shapeFor({ virtualSol, graduationMcap, feeBps })   the nearest one (SOL or lamports, basis points): every coin gets a
//                               fixed shape; missing or bad numbers give the house
//   Tri.fromPool(p)             a pool as chain.js reads it -> { shape, state } (with no graduationMcap, as in a launch event,
//                               it follows from virtualSol and graduationSol)
//   Tri.pool(V, M, feeBps)      a set-up's pool math (the rules of Block): fresh(), x(s), price(s), buy(s, sol), sellTokens(s, tok), sellSol(s, sol), G
//   Tri.stateOf(shape, s)       the pool state of a simulated pool s (from shape.pool; none: a fresh pool)
//   Tri.fill(state)             the fill for a pool state: virtual SOL at the bottom, real SOL on it; graduated, real SOL alone
//   Tri.progress(state)         the fill for tiles: the way to graduation, from the bottom, a line as soon as any SOL is in
//                               (the line in the main blue, not in the tube's deep underside shade)
//   Tri.heightOf(vol, f), Tri.shareBelow(vol, h)   a shape's volume table both ways (heights in pixels at scale 1)
//   Tri.views(items, scale, { frame }?)   still views (buffers), all one size on one base line: items = shapes or { shape, angle };
//                               frame = more items the size must hold too. A board that wants one tile size whatever coins it
//                               shows takes views(Tri.SHAPES, scale) once (one view per preset, in that order) or frame: Tri.SHAPES
//   Tri.draw(cv, view, fill, { bg, socket })   paints a view: fill = shares or a Tri.Fill; bg 'paper' (default) or 'dark';
//                               socket = x of an empty slot cut into the base bar. A view can paint any number of canvases
//   Tri.size(cv, view, px)      css size at px css pixels a pixel, rounded to whole device pixels; returns the css size of a pixel
//   Tri.devPx(px)               that rounding alone: px css pixels to the nearest whole number of device pixels
//   Tri.still(cv, { shape, state | fill, angle, scale, px, bg, socket, frame })   one still in one call; returns its view
//   Tri.Fill(scale)             levels that move: aim(vol, v, t), put(vol, v, t, post), graduate(v, g, cb), drain(cb), at(ms, fn),
//                               step(dt), levels(), busy()
//   Tri.track(actor), Tri.untrack(actor), Tri.wake()   the one loop, 30 frames a second at most, still off screen and in a
//                               hidden tab; actor = { cv, step(dt), paint(), busy(), onShow?, onHide? }; untrack lets one go
//   Tri.turner(cv, opts)        the turning triangle (see Turner below)
//   Tri.symbol(cv, cell, ink, piece), Tri.wordmark(cv, cell, ink, piece)   the marks on a grid of cell css pixels;
//                               in colour by default, in one colour with ink = piece
(function () {
'use strict';
var reduce = false;
try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
try { if (new URLSearchParams(location.search).get('motion') === 'reduce') reduce = true; } catch (e) {}   // lets a screenshot check the reduced-motion path
window.__frames = 0;

/* ================= palette as indices (0 = the canvas background) ================= */
var HEX = [null, '#1D2228', '#111315', '#102C60', '#398BFF', '#B9E6FF', '#F2EFE7', '#FF7852'];
var GR = 1, INK = 2, DEEP = 3, BLUE = 4, ICE = 5, PAPER = 6, ORANGE = 7;
// the same colours as 32-bit pixels for ImageData; 0 stays transparent, so the section shows through
var RGBA = HEX.map(function (h) { if (!h) return 0; var v = parseInt(h.slice(1), 16); return ((255 << 24) | ((v & 255) << 16) | (v & 0xff00) | (v >> 16)) >>> 0; });

/* ================= the pool's math, for any set-up (same rules as Block for the house settings) ================= */
function Pool(V, M, feeBps) {
  var G = Math.sqrt(M * V) - V, fee = feeBps / 1e4;
  var P = {
    V: V, M: M, fee: fee, G: G,
    fresh: function () { return { R: 0, T: 1e9, grad: false, burned: 0, held: 0 }; },
    x: function (s) { return s.grad ? s.R : V + s.R; },
    price: function (s) { return P.x(s) / s.T; },
    buy: function (s, d) {
      var rest = d - d * fee, out = 0, info = { graduated: false, burn: 0 };
      if (!s.grad) {
        var on = Math.min(rest, G - s.R);
        if (on > 0) { var x = V + s.R, T2 = x * s.T / (x + on); out += s.T - T2; s.T = T2; s.R += on; rest -= on; }
        if (s.R >= G - 1e-9) { s.R = G; var burn = s.T * V / (V + s.R); s.T -= burn; s.burned += burn; s.grad = true; info.graduated = true; info.burn = burn; }
      }
      if (s.grad && rest > 0) { var x2 = s.R, T3 = x2 * s.T / (x2 + rest); out += s.T - T3; s.T = T3; s.R += rest; }
      s.held += out; return info;
    },
    sellTokens: function (s, tok) {
      if (!(tok > 0)) return 0;
      var x = P.x(s), nx = x * s.T / (s.T + tok), gross = x - nx;
      s.T += tok; s.held -= tok; s.R = Math.max(0, s.grad ? nx : nx - V);
      return gross - gross * fee;
    },
    sellSol: function (s, d) {
      var x = P.x(s); d = Math.min(d, x * 0.4);
      var tok = Math.min(s.T * d / (x - d), s.held);
      if (!(tok > 1)) return 0;
      P.sellTokens(s, tok); return tok;
    }
  };
  return P;
}

/* the set-ups: real launch parameters inside the program's bounds (1-1,000 virtual SOL, 2-100x, fee up to 3%).
   Each gives the triangle its own form, in pixels with y up: base left c, base right b, apex a, the corner
   radius rc and how far the right side bows out. The cavity holds the virtual SOL plus the real SOL that
   graduates the coin; the virtual part is the bottom share by volume: house 27%, curve 33%, tray 50%, L cut 38%.
   angle is the still view's: the L cut turns the other way and less, so its right angle does not point like a play sign. */
var TUBE = 7.5, STEP = 0.62;                          // tube radius; surface sample spacing (under 1/√2 pixel, so the near side leaves no gaps)
var ELEV = 15 * Math.PI / 180, CE = Math.cos(ELEV), SE = Math.sin(ELEV);   // we look down at it a little, so the base bar shows its top
var LIGHT = [-0.45, 0.78, 0.45], ANG34 = 0.62;        // one light, up and to the left; the fixed three-quarter view (35 degrees)
LIGHT = LIGHT.map(function (v) { return v / Math.hypot(LIGHT[0], LIGHT[1], LIGHT[2]); });
var SHAPES = [
  { id: 'house', name: 'house', V: 30, M: 420, fee: 100, form: { c: [-31.5, 0], b: [31.5, 0], a: [0, 54.6], rc: 4, bow: 0 }, angle: ANG34 },
  { id: 'curve', name: 'curve', V: 20, M: 180, fee: 200, form: { c: [-25, 0], b: [25, 0], a: [0, 40], rc: 10, bow: 7 }, angle: ANG34 },
  { id: 'tray', name: 'tray', V: 200, M: 800, fee: 150, form: { c: [-32, 0], b: [32, 0], a: [0, 28], rc: 4, bow: 0 }, angle: ANG34 },
  { id: 'ell', name: 'L cut', V: 60, M: 420, fee: 300, form: { c: [-29, 0], b: [29, 0], a: [-29, 52], rc: 4, bow: 0 }, angle: -0.35 }
];
function findShape(id) { for (var i = 0; i < SHAPES.length; i++) if (SHAPES[i].id === id) return SHAPES[i]; return null; }

// any coin's shape: the nearest set-up by log virtual SOL, log graduation multiple and fee, each across the program's
// bounds; nothing to store, and a coin on the house settings (every devnet coin so far) is exactly the house
var SPAN_V = Math.log(1000), SPAN_M = Math.log(50), SPAN_FEE = 300;
function shapeFor(o) {
  o = o || {};
  var V = sol(o.virtualSol), M = sol(o.graduationMcap), fee = Number(o.feeBps), best = SHAPES[0], bd = Infinity;
  if (!(V > 0) || !(M > V)) return best;
  if (!isFinite(fee)) fee = 0;
  SHAPES.forEach(function (su) {
    var a = Math.log(V / su.V) / SPAN_V, b = Math.log((M / V) / (su.M / su.V)) / SPAN_M, c = (fee - su.fee) / SPAN_FEE, d = a * a + b * b + c * c;
    if (d < bd) { bd = d; best = su; }             // a tie keeps the earlier set-up
  });
  return best;
}

/* ================= the triangle: a thick tube along a rounded triangle, drawn on a few pixels ================= */
// The tube's path is the form's triangle grown by rc; the tube is TUBE thick around it. It stands in a vertical
// plane and turns about the vertical axis, so a height on it is a height in the world: the level stays level.
// It is drawn by splatting points of its surface into a small depth buffer, then shading each pixel from the
// nearest point with a few tones and a 4 x 4 Bayer dither between neighbours.
var B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];   // 4 x 4 Bayer order
var R_INK = [INK, GR], R_BLUE = [DEEP, BLUE, ICE], R_LIGHT = [GR, PAPER];   // graphite stays two dark tones: solid, no gloss

function polyOf(f, sc) {                              // the triangle, counter-clockwise; a bowed right side becomes a run of points
  var P = [[f.c[0] * sc, f.c[1] * sc], [f.b[0] * sc, f.b[1] * sc]], i;
  if (f.bow > 0.05) {
    var bx = f.b[0] * sc, by = f.b[1] * sc, dx = (f.a[0] - f.b[0]) * sc, dy = (f.a[1] - f.b[1]) * sc, L = Math.hypot(dx, dy), nx = dy / L, ny = -dx / L;
    for (i = 1; i < 12; i++) { var t = i / 12, k = 4 * t * (1 - t) * f.bow * sc; P.push([bx + dx * t + nx * k, by + dy * t + ny * k]); }
  }
  P.push([f.a[0] * sc, f.a[1] * sc]);
  return P;
}
function lerpForm(A, B, t) {
  function l(p, q) { return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; }
  return { a: l(A.a, B.a), b: l(A.b, B.b), c: l(A.c, B.c), rc: A.rc + (B.rc - A.rc) * t, bow: A.bow + (B.bow - A.bow) * t };
}
// the surface as points with normals, centred on the turning axis, its lowest point at height 0
function surfOf(f, sc, reuse) {
  var Q = polyOf(f, sc), n = Q.length, r = TUBE * sc, rc = Math.max(0, f.rc) * sc, X = [], Y = [], NX = [], NY = [], i, j, k;
  for (i = 0; i < n; i++) {                           // each corner an arc of radius rc around it, each side a straight run
    var p0 = Q[(i + n - 1) % n], p1 = Q[i], p2 = Q[(i + 1) % n], ex = p2[0] - p1[0], ey = p2[1] - p1[1];
    var a0 = Math.atan2(-(p1[0] - p0[0]), p1[1] - p0[1]), a1 = Math.atan2(-ex, ey), da = a1 - a0;
    while (da < 0) da += 2 * Math.PI;
    var m = Math.max(1, Math.ceil(da * (rc + r) / STEP));          // spaced for the outside of the bend
    for (k = 0; k < m; k++) { var an = a0 + da * k / m, ca = Math.cos(an), sa = Math.sin(an); X.push(p1[0] + rc * ca); Y.push(p1[1] + rc * sa); NX.push(ca); NY.push(sa); }
    var len = Math.hypot(ex, ey), c1 = Math.cos(a1), s1 = Math.sin(a1), cnt = Math.max(1, Math.ceil(len / STEP));
    for (k = 0; k < cnt; k++) { var t = k / cnt; X.push(p1[0] + ex * t + rc * c1); Y.push(p1[1] + ey * t + rc * s1); NX.push(c1); NY.push(s1); }
  }
  var x0 = Infinity, x1 = -Infinity, y0 = Infinity;
  for (i = 0; i < X.length; i++) { x0 = Math.min(x0, X[i]); x1 = Math.max(x1, X[i]); y0 = Math.min(y0, Y[i]); }
  var sx = -(x0 + x1) / 2, sy = r - y0;
  var Na = Math.max(8, Math.ceil(2 * Math.PI * r / STEP)), N = X.length * Na, o = 0, top = 0, rho = 0, uLo = Infinity, uHi = -Infinity;
  var p = reuse && reuse.p.length >= N * 3 ? reuse.p : new Float32Array(N * 3), q = reuse && reuse.q.length >= N * 3 ? reuse.q : new Float32Array(N * 3);
  var cs = new Float32Array(Na), sn = new Float32Array(Na);
  for (j = 0; j < Na; j++) { cs[j] = Math.cos(2 * Math.PI * j / Na); sn[j] = Math.sin(2 * Math.PI * j / Na); }
  for (i = 0; i < X.length; i++) {
    var px = X[i] + sx, py = Y[i] + sy, nx = NX[i], ny = NY[i];
    for (j = 0; j < Na; j++, o += 3) {
      var dx = cs[j] * nx, dy = cs[j] * ny, dz = sn[j], x = px + r * dx, y = py + r * dy, z = r * dz, rh = Math.sqrt(x * x + z * z);
      p[o] = x; p[o + 1] = y; p[o + 2] = z; q[o] = dx; q[o + 1] = dy; q[o + 2] = dz;
      if (rh > rho) rho = rh; if (y > top) top = y;
      if (y * CE + rh * SE > uHi) uHi = y * CE + rh * SE; if (y * CE - rh * SE < uLo) uLo = y * CE - rh * SE;   // its reach through a whole turn
    }
  }
  return { n: N, p: p, q: q, top: top, rho: rho, uLo: uLo, uHi: uHi, sx: sx, sy: sy, Q: Q, r: r, rc: rc };
}
function sdPoly(Q, x, y) {                            // signed distance to a convex counter-clockwise polygon, negative inside
  var n = Q.length, inside = true, d2 = Infinity;
  for (var i = 0; i < n; i++) {
    var a = Q[i], b = Q[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1], wx = x - a[0], wy = y - a[1];
    var t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey))), qx = wx - ex * t, qy = wy - ey * t;
    d2 = Math.min(d2, qx * qx + qy * qy);
    if (ex * wy - ey * wx < 0) inside = false;
  }
  return inside ? -Math.sqrt(d2) : Math.sqrt(d2);
}
// the ring's volume below each height, measured on a half-pixel grid of its plane: once per shape
function volOf(S) {
  var h = 0.5, rows = Math.ceil((S.top + 1) / h), cum = new Float64Array(rows + 1), r = S.r, tot = 0;
  for (var j = 0; j < rows; j++) {
    var y = (j + 0.5) * h - S.sy, row = 0;
    for (var x = -S.rho + h / 2; x < S.rho; x += h) {
      var d = Math.abs(sdPoly(S.Q, x - S.sx, y) - S.rc);           // distance to the path (the polygon grown by rc)
      if (d < r) row += 2 * Math.sqrt(r * r - d * d);              // the tube's thickness there
    }
    tot += row * h * h; cum[j + 1] = tot;
  }
  return { h: h, cum: cum, tot: tot, top: S.top };
}
function heightOf(vol, f) {                           // the height under which the ring holds a share f of its volume
  if (f <= 0) return 0;
  if (f >= 1) return vol.top * 1.05 + 2;              // full: above the top, at any scale
  var want = f * vol.tot, C = vol.cum, lo = 0, hi = C.length - 1;
  while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (C[mid] < want) lo = mid; else hi = mid; }
  return (lo + (want - C[lo]) / Math.max(1e-9, C[hi] - C[lo])) * vol.h;
}
function shareBelow(vol, h) {                         // the other way round: the share of its volume under a height
  var C = vol.cum, j = h / vol.h, i = Math.max(0, Math.min(C.length - 2, Math.floor(j)));
  return Math.min(1, (C[i] + (C[i + 1] - C[i]) * Math.max(0, Math.min(1, j - i))) / vol.tot);
}

SHAPES.forEach(function (s) {
  s.pool = Pool(s.V, s.M, s.fee); s.G = s.pool.G; s.Cap = s.V + s.G; s.vShare = s.V / s.Cap;
  s.surf = surfOf(s.form, 1); s.vol = volOf(s.surf);
});

/* ================= fills: what a pool state shows ================= */
// numbers are SOL; a BigInt is lamports, as chain.js reads the program's u64s, and becomes SOL here
function sol(x) { return typeof x === 'bigint' ? Number(x) / 1e9 : Number(x); }
// every state that comes in from a page: SOL numbers, nothing missing
function norm(st) {
  st = st || {};
  return { virtualSol: sol(st.virtualSol) || 0, realSol: sol(st.realSol) || 0, graduationSol: sol(st.graduationSol) || 0, graduated: !!st.graduated, full: !!st.full };
}
// a pool as Chain.readPool or listPools gives it: its shape and its state. A launch event carries no market cap;
// it follows from G = √(M·V) − V
function fromPool(p) {
  p = p || {};
  var V = sol(p.virtualSol), G = sol(p.graduationSol), M = p.graduationMcap != null ? sol(p.graduationMcap) : (V + G) * (V + G) / V;
  return { shape: shapeFor({ virtualSol: V, graduationMcap: M, feeBps: p.feeBps }), state: norm({ virtualSol: V, realSol: p.realSol, graduationSol: G, graduated: p.graduated }) };
}
function stateOf(su, s) { return { virtualSol: su.V, realSol: s ? s.R : 0, graduationSol: su.G, graduated: !!(s && s.grad) }; }
// virtual SOL at the bottom (its share of the cavity by volume), the real SOL on it up to graduation; graduated,
// the real SOL alone from the bottom, full at virtual plus graduation SOL. pre: draw a graduated state as just before
function fillOf(st, pre) {
  var V = st.virtualSol, G = st.graduationSol, cap = V + G, R = Math.max(0, st.realSol);
  if (!(cap > 0)) return { v: 0, t: 0, post: false };
  if (!st.graduated || pre) return { v: V / cap, t: Math.min(1, V / cap + Math.min(R, G) / cap), post: false };
  return { v: 0, t: st.full ? 1 : Math.min(1, R / cap), post: true };
}
// for tiles: how far the real SOL reaches toward graduation, from the bottom; any SOL in shows as a line along it
function progressOf(st) {
  return { v: 0, t: st.graduated ? 1 : st.graduationSol > 0 ? Math.min(1, st.realSol / st.graduationSol) : 0, post: true, line: st.realSol > 0 };
}

/* a depth buffer of the nearest surface point per pixel: its height, its x and how much light it takes */
function GBuf(w, h) { var n = w * h; this.w = w; this.h = h; this.dep = new Float32Array(n); this.idx = new Int32Array(n); this.y = new Float32Array(n); this.x = new Float32Array(n); this.lit = new Float32Array(n); this.out = new Uint8Array(n); }
function splat(G, S, th, cx, oy) {
  var c = Math.cos(th), s = Math.sin(th), W = G.w, Hh = G.h, dep = G.dep, idx = G.idx, P = S.p, N = S.q, n = S.n * 3, j, k;
  dep.fill(-1e9); idx.fill(-1);
  for (j = 0; j < n; j += 3) {
    var nx = N[j], nz = N[j + 2];
    if (N[j + 1] * SE + (nz * c - nx * s) * CE <= 0) continue;      // faces away from us
    var x = P[j], y = P[j + 1], z = P[j + 2], zr = z * c - x * s;
    var col = Math.floor(cx + x * c + z * s), row = Math.floor(oy - y * CE + zr * SE);
    if (col < 0 || col >= W || row < 0 || row >= Hh) continue;
    k = row * W + col;
    var d = y * SE + zr * CE;
    if (d > dep[k]) { dep[k] = d; idx[k] = j; }
  }
  var L0 = LIGHT[0], L1 = LIGHT[1], L2 = LIGHT[2];
  for (k = 0; k < W * Hh; k++) {
    j = idx[k]; if (j < 0) continue;
    var mx = N[j] * c + N[j + 2] * s, mz = N[j + 2] * c - N[j] * s;
    G.y[k] = P[j + 1]; G.x[k] = P[j]; G.lit[k] = Math.max(0, mx * L0 + N[j + 1] * L1 + mz * L2);
  }
}
function ramp(R, v, b) { var i = Math.floor(v), last = R.length - 1; if (v <= 0) return R[0]; if (i >= last) return R[last]; return R[i + ((v - i) * 16 > b + 0.5 ? 1 : 0)]; }
// flat tones, dithered only in a narrow band where one meets the next: E holds each step's start and width in light
var E_BLUE = [0.22, 0.03, 0.8, 0.03], E_LIGHT = [0.06, 0.04], E_INK = [0.32, 0.05];   // blue: deep in the shade, ice only where it faces the light
var E_BLUE_D = [0.1, 0.03, 0.8, 0.03];               // on the dark sections less of it is deep, or it sinks into the background
function tone(R, E, l, b) { var v = 0.001; for (var i = 0; i < E.length; i += 2) v += 0.998 * Math.max(0, Math.min(1, (l - E[i]) / E[i + 1])); return ramp(R, v, b); }
// colour by height: below L.v the virtual SOL (a 50% half-tone of deep blue and ice, a checkerboard, gone where its
// Bayer rank is under L.dis), from L.lo to L.t the real SOL (solid blue), the rest empty: graphite on warm white,
// or warm white on graphite (light) for the dark sections
function tint(G, L, light, sock) {
  var W = G.w, out = G.out, idx = G.idx, dz = L.dis * 16, k = 0, c;
  for (var yy = 0; yy < G.h; yy++) for (var xx = 0; xx < W; xx++, k++) {
    if (idx[k] < 0) { out[k] = 0; continue; }
    var b = B4[(yy & 3) * 4 + (xx & 3)], y = G.y[k], l = G.lit[k];
    if (y < L.v && b >= dz) out[k] = b < 8 ? DEEP : ICE;
    else if (y >= L.lo && y < L.t) { c = tone(R_BLUE, light ? E_BLUE_D : E_BLUE, l, b); out[k] = c === DEEP && y < L.bright ? BLUE : c; }   // bright: a tile's line, never deep
    else out[k] = light ? tone(R_LIGHT, E_LIGHT, l, b) : tone(R_INK, E_INK, l, b);
  }
  if (sock) socket(G, sock);
}
// an empty socket cut into the tube from outside: a notch open to the dark around it, lined in orange where it meets the tube
function socket(G, s) {
  var W = G.w, n = W * G.h, m = new Uint8Array(n), idx = G.idx, k;
  for (k = 0; k < n; k++) if (idx[k] >= 0) {
    var dx = G.x[k] - s.cx, dy = G.y[k] - s.cy, u = dx * s.tx + dy * s.ty, v = dy * s.tx - dx * s.ty;   // along the side, and outward from its path
    if (Math.abs(u) < s.a && v > s.v0 && v < s.v1) m[k] = 1;
  }
  function tube(x, y) { var j = y * W + x; return x >= 0 && y >= 0 && x < W && y < G.h && idx[j] >= 0 && !m[j]; }
  for (k = 0; k < n; k++) if (m[k]) {                 // lined where any of the eight neighbours is tube, so the line closes
    var x = k % W, y = (k - x) / W, on = false;
    for (var dy = -1; dy <= 1 && !on; dy++) for (var dx = -1; dx <= 1; dx++) if ((dx || dy) && tube(x + dx, y + dy)) { on = true; break; }
    G.out[k] = on ? ORANGE : 0;
  }
}
// the socket's place: a slot cut down into the base bar from its top, x pixels right of the middle
function socketOn(f, S, sc, x) {
  var r = TUBE * sc;
  return { cx: x * sc + S.sx, cy: f.c[1] * sc - S.rc + S.sy, tx: 1, ty: 0, a: r * 1.3, v0: -r * 0.55, v1: r * 2 };
}
function qh(h, sc) { return Math.round(h * sc * CE) / CE; }   // a height on a whole pixel row
function levelsAt(vol, sc, vf, tf, post) {           // still levels: virtual SOL up to vf, real SOL up to tf (from the bottom if post)
  var v = post ? 0 : qh(heightOf(vol, vf), sc);
  return { v: v, lo: v, t: qh(heightOf(vol, tf), sc), dis: post ? 1 : 0 };
}

/* ================= stills: cards and tiles ================= */
// still views at each shape's own angle (or the one given): one buffer per item, all one size, on one base line.
// o.frame: more items (shapes or { shape, angle }) that the size must hold too, so tiles keep one size whatever is shown
function views(items, sc, o) {
  function item(it) { return it && it.form ? { shape: it } : it; }
  function angOf(it) { return it.angle == null ? it.shape.angle : it.angle; }
  items = items.map(item);
  var S = items.map(function (it) { return surfOf(it.shape.form, sc); }), x0 = 0, x1 = 0, u0 = 0, u1 = 0;
  items.concat(o && o.frame ? o.frame.map(item) : []).forEach(function (it, i) {
    var q = i < S.length ? S[i] : surfOf(it.shape.form, sc), a = angOf(it), c = Math.cos(a), s = Math.sin(a);
    for (var j = 0; j < q.n * 3; j += 3) {
      var x = q.p[j], y = q.p[j + 1], z = q.p[j + 2], xr = x * c + z * s, u = y * CE - (z * c - x * s) * SE;
      if (xr < x0) x0 = xr; if (xr > x1) x1 = xr; if (u < u0) u0 = u; if (u > u1) u1 = u;
    }
  });
  var w = Math.ceil(x1 - x0) + 2, h = Math.ceil(u1 - u0) + 2;
  return S.map(function (q, i) { var G = new GBuf(w, h), a = angOf(items[i]); splat(G, q, a, 1 - x0, 1 + u1); G.S = q; G.shape = items[i].shape; G.scale = sc; G.angle = a; return G; });
}
function present(cv, G) {
  if (cv.width !== G.w || cv.height !== G.h) { cv.width = G.w; cv.height = G.h; cv.__img = null; }
  var ctx = cv.getContext('2d'); if (!ctx) return;
  if (!cv.__img) { cv.__img = ctx.createImageData(G.w, G.h); cv.__u = new Uint32Array(cv.__img.data.buffer); }
  var u = cv.__u, o = G.out; for (var k = 0; k < o.length; k++) u[k] = RGBA[o[k]];
  ctx.putImageData(cv.__img, 0, 0);
}
function draw(cv, view, fill, o) {
  o = o || {};
  var su = view.shape, L;
  if (fill && typeof fill.levels === 'function') L = fill.levels();
  else {
    fill = fill || {};
    var t = fill.t || 0, line = 1.5 / (view.scale * CE);
    if (fill.line) t = Math.max(t, shareBelow(su.vol, line));
    L = levelsAt(su.vol, view.scale, fill.v || 0, t, !!fill.post);
    // a tile's line (Tri.progress) is the bottom of the tube, which faces down: in its deep shade it would sink into the
    // dark around it, so up to the line's top the real SOL is drawn in the main blue at least
    L.bright = fill.line ? qh(line, view.scale) : 0;
  }
  tint(view, L, o.bg === 'dark', o.socket != null ? socketOn(su.form, view.S, view.scale, o.socket) : null);
  present(cv, view);
}
// whole device pixels per pixel, so the pixels stay even at 1.25 or 1.5 too: px css pixels, rounded to the screen
function devPx(px) { var r = window.devicePixelRatio || 1; return Math.max(1, Math.round(px * r)) / r; }
function size(cv, G, px) { var d = devPx(px); cv.style.width = (G.w * d) + 'px'; cv.style.height = (G.h * d) + 'px'; return d; }
function still(cv, o) {
  var v = views([{ shape: o.shape || SHAPES[0], angle: o.angle }], o.scale || 0.3, { frame: o.frame })[0];
  draw(cv, v, o.fill || fillOf(o.state ? norm(o.state) : stateOf(v.shape)), { bg: o.bg, socket: o.socket });
  if (o.px) size(cv, v, o.px);
  return v;
}

/* ================= motion: the level rises with weight and settles on whole pixel rows ================= */
var GRAV = 0.0012;                                    // pixel rows per ms^2, for drops and drains
function fallDur(rows) { return reduce ? 0 : Math.sqrt(2 * Math.max(0, rows) / GRAV); }
function Spring(w, z) { this.x = 0; this.v = 0; this.g = 0; this.w = w; this.z = z; }
Spring.prototype.step = function (dt) {
  for (var left = dt; left > 0; left -= 8) {
    var h = Math.min(8, left) / 1000;
    this.v += (-2 * this.z * this.w * this.v - this.w * this.w * (this.x - this.g)) * h;
    this.x += this.v * h;
  }
};
Spring.prototype.rest = function (e) { e = e || 0.04; return Math.abs(this.x - this.g) < e && Math.abs(this.v) < e * 10; };
Spring.prototype.snap = function () { this.x = this.g; this.v = 0; };
// what one triangle shows: the virtual SOL's top (v), the real SOL's top (t), both heights in pixels at scale 1, plus
// the moments between: the half-tone dissolving, the real SOL dropping to the bottom, everything draining away
function Fill(sc) { this.sc = sc; this.v = new Spring(20, 0.8); this.t = new Spring(20, 0.8); this.post = false; this.dis = 0; this.an = null; this.clock = 0; this.timers = []; this.vol = null; }
var FP = Fill.prototype;
FP.at = function (ms, fn) { this.timers.push({ t: this.clock + ms, fn: fn }); };
FP.aim = function (vol, vf, tf) { this.vol = vol; this.v.g = heightOf(vol, vf); this.t.g = heightOf(vol, tf); if (reduce) { this.v.snap(); this.t.snap(); } };
FP.put = function (vol, vf, tf, post) { this.post = !!post; this.dis = post ? 1 : 0; this.an = null; this.aim(vol, post ? 0 : vf, tf); this.v.snap(); this.t.snap(); };
// graduation: the half-tone dissolves in Bayer order (400 ms), then the real SOL drops to the bottom and settles
FP.graduate = function (vs, g, cb) {
  if (reduce) { this.put(this.vol, 0, g, true); if (cb) cb(); return; }
  this.an = { kind: 'dis', t0: this.clock, dur: 400, vs: vs, g: g, cb: cb };
};
FP.drain = function (cb) {
  if (reduce || this.t.x <= 0.01) { this.put(this.vol, 0, 0, false); if (cb) cb(); return; }
  this.an = { kind: 'drain', t0: this.clock, v0: this.v.x, top0: this.t.x, cb: cb };
};
FP.sunk = function () { var e = this.clock - this.an.t0; return 0.5 * GRAV * e * e / (this.sc * CE); };
FP.step = function (dt) {
  this.clock += dt;
  var t = this.clock, due = this.timers.filter(function (x) { return x.t <= t; }), a;
  this.timers = this.timers.filter(function (x) { return x.t > t; });
  due.forEach(function (x) { x.fn(); });
  a = this.an;
  if (a && a.kind === 'dis' && t >= a.t0 + a.dur) {
    this.dis = 1;
    var fall = heightOf(this.vol, Math.min(0.999, a.vs + a.g)) - heightOf(this.vol, a.g);   // timed by how far its top falls
    this.an = { kind: 'drop', t0: t, dur: fallDur(fall * this.sc * CE), vs: a.vs, g: a.g, cb: a.cb };
  } else if (a && a.kind === 'drop' && t >= a.t0 + a.dur) {
    this.an = null; this.post = true; this.v.x = this.v.g = this.v.v = 0;
    this.t.x = heightOf(this.vol, a.g); this.t.v = -GRAV * a.dur * 1000 * 0.35 / (this.sc * CE);   // it lands with a little give
    if (a.cb) a.cb();
  } else if (a && a.kind === 'drain' && a.top0 - this.sunk() <= 0) {
    this.put(this.vol, 0, 0, false);
    if (a.cb) a.cb();
  }
  if (!this.an) {
    this.v.step(dt); this.t.step(dt);
    if (this.v.rest()) this.v.snap(); if (this.t.rest()) this.t.snap();
  }
};
FP.levels = function () {
  var a = this.an, t = this.clock, v = this.v.x, top = this.t.x, lo = this.post ? 0 : v, dis = this.dis, f, d;
  if (a && a.kind === 'dis') dis = Math.min(1, (t - a.t0) / a.dur);
  if (a && a.kind === 'drop') { f = Math.min(1, (t - a.t0) / Math.max(1, a.dur)); f = a.vs * (1 - f * f); lo = heightOf(this.vol, f); top = heightOf(this.vol, f + a.g); }
  if (a && a.kind === 'drain') { d = this.sunk(); v = Math.max(0, a.v0 - d); top = Math.max(0, a.top0 - d); lo = this.post ? 0 : v; }
  return { v: qh(v, this.sc), lo: qh(lo, this.sc), t: qh(top, this.sc), dis: dis };
};
FP.busy = function () { return !!this.an || this.timers.length > 0 || !this.v.rest() || !this.t.rest(); };

/* ================= one loop for everything that moves, at 30 frames a second at most ================= */
var actors = [], raf = 0, lastT = 0, lastWork = -1e9, inFrame = false, rewake = false;
// woken from inside a frame (an actor's step), the frame itself asks for the next one, so there is only ever one chain
function wake() { if (inFrame) { rewake = true; return; } if (raf || document.hidden) return; lastT = performance.now(); raf = requestAnimationFrame(frame); }
function frame(now) {
  raf = 0;
  if (window.__frozen) return;                         // screenshots can hold a frame still
  if (now - lastWork < 1000 / 30 - 4) { raf = requestAnimationFrame(frame); return; }
  var dt = Math.min(50, Math.max(0, now - lastT)), again = false; lastT = now; lastWork = now; inFrame = true; rewake = false;
  try {
    for (var i = 0, list = actors.slice(); i < list.length; i++) {   // a copy: an actor may untrack itself (or another) as it steps
      var a = list[i];
      if (!a.visible || !a.busy()) continue;
      a.step(dt); a.paint();
      if (a.busy()) again = true;
    }
  } finally { inFrame = false; }
  window.__frames++;
  if ((again || rewake) && !document.hidden) raf = requestAnimationFrame(frame);
}
document.addEventListener('visibilitychange', function () { if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; } else wake(); });
var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) {
  es.forEach(function (e) { var a = e.target.__actor; if (!a) return; var was = a.visible; a.visible = e.isIntersecting; if (a.visible && !was) { a.paint(); if (a.onShow) a.onShow(); wake(); } if (!a.visible && was && a.onHide) a.onHide(); });
}, { threshold: [0, 0.3] }) : null;
function track(a) { if (actors.indexOf(a) >= 0) return; actors.push(a); a.cv.__actor = a; if (io) io.observe(a.cv); else a.visible = true; }
// a page that throws a canvas away (or makes a new turner for it) lets the old actor go, observer and all
function untrack(a) {
  var i = actors.indexOf(a); if (i < 0) return;
  actors.splice(i, 1); a.visible = false;
  if (io) io.unobserve(a.cv);
  if (a.cv.__actor === a) a.cv.__actor = null;
}

/* ================= the turning triangle ================= */
// One turn in 16 s, quicker edge-on and slower face-on. Graduation and a re-form play broadside: they wait until
// the face is towards us, the turn brakes almost to a stop for them, then eases back. Reduced motion: a still
// three-quarter view, levels that jump. The buffer holds every shape given through a whole turn, so nothing
// moves when the shape changes.
//   opts: { shape, state, shapes (default all four), bg ('paper' or 'dark'), pace() (turn speed, 1 = 16 s a turn),
//           busy() (the page needs frames, say while a hold is on), step(clock) (the page's own logic, each frame),
//           change() (a graduation has started), graduated() (it has played),
//           line (true: one pixel row of real SOL shows as soon as any is in, for real pools and first buys) }
//   turn.show(state)            the state it should show. Settled: the level moves there, and a graduated state plays the
//                               graduation by itself once the level is still and the face is towards us. During a re-form
//                               it only becomes what pours in; during a graduation, what the level goes to after it. A state
//                               from before graduation after a graduated one drains and pours afresh
//   turn.reform(shape, state, cb)   what is in it drains away, the corners ease to the new shape at a broadside face, the
//                               state pours in, then cb(). Called again before that is over, it takes the new shape and
//                               state from where things are (still draining: drains on; morphing: eases on from the
//                               in-between corners; pouring: drains from that level) and every cb given runs, in order, once
//                               it has settled. The same shape drains and pours again (that is "start over"). During a
//                               graduation it waits: the graduation plays out, the re-form starts, then graduated() fires
//                               (turn.locked is true again by then); a graduation still waiting to face us is dropped
//   turn.follow(shape, state)   for a page that follows settings: reform when the shape differs from where it is heading,
//                               otherwise show(state)
//   turn.put(shape, state)      jump there at once; a re-form under way is dropped and its callbacks with it
//   turn.size(px)  turn.face(angle | null) (held at an angle it rests while nothing moves)  turn.angle()  turn.paint()
//   turn.perf()  turn.wake()
//   turn.stop()                 let it go: off the loop and the observer (the canvas keeps its last frame)
//   turn.pending (a graduation waits), turn.grading (it plays), turn.locked (graduating or re-forming),
//   turn.reforming (null, 'drain', 'wait', 'morph' or 'pour'), turn.su (its shape, or the one it is re-forming to),
//   turn.fill (a Tri.Fill at scale 1), turn.w, turn.h (in pixels), turn.oy (the base row)
var TURN = 16000, EASE = 0.3;                         // one turn in 16 s, quicker edge-on and slower face-on (speed 0.4 to 1.6)
var HUSH = 0.15, HURRY = 2.4;                         // the turn during graduation or a re-form, and while it waits to face us for one
function eased(phi) { return phi - EASE * Math.sin(2 * phi); }
function Turner(cv, o) {
  o = o || {};
  var T = this, rho = 0, uLo = 0, uHi = 0;
  (o.shapes || SHAPES).forEach(function (su) { rho = Math.max(rho, su.surf.rho); uLo = Math.min(uLo, su.surf.uLo); uHi = Math.max(uHi, su.surf.uHi); });
  var w = 2 * Math.ceil(rho) + 2, G = new GBuf(w, Math.ceil(uHi) + Math.ceil(-uLo) + 4);   // 90 wide: 4 px a pixel still fits a 360 px phone
  G.cx = w / 2; G.oy = Math.ceil(uHi) + 2;            // the turning axis; the row of height 0 seen straight on
  T.G = G; T.w = G.w; T.h = G.h; T.oy = G.oy;
  T.cv = cv; T.o = o; T.dark = o.bg === 'dark'; T.visible = false;
  T.spin = new Spring(3, 1); T.spin.x = T.spin.g = 1; T.phi = 0.9; T.fixed = null;
  T.fill = new Fill(1); T.ms = []; T.at = []; T.mbuf = null;
  T.put(o.shape || SHAPES[0], o.state);
  T.wake = wake;
  track(T);
}
var TP = Turner.prototype;
TP.put = function (su, st) {
  this.su = su; this.S = su.surf; this.form = su.form; this.state = norm(st || stateOf(su));
  this.reforming = this.morph = this.next = null; this.cbs = []; this.pending = this.grading = this.locked = this.hush = false;
  var f = this.fillOf(this.state); this.fill.put(su.vol, f.v, f.t, f.post);
};
// a graduated state is drawn as just before graduation until the graduation has played
TP.aim = function () { var f = this.fillOf(this.state, !this.fill.post); this.fill.aim(this.su.vol, f.v, f.t); };
// the fill for a state; with opts.line, one pixel row of real SOL shows on the virtual SOL as soon as any is in
// (a coin's first SOL or two, a small first buy, is under a row on its own); the page's numbers stay exact
TP.fillOf = function (st, pre) {
  var f = fillOf(st, pre);
  if (!this.o.line || f.post || !(f.t > f.v)) return f;
  var vol = this.su.vol, least = shareBelow(vol, (Math.round(heightOf(vol, f.v) * CE) + 0.55) / CE);   // its top a row above the half-tone's
  return f.t >= least ? f : { v: f.v, t: Math.min(1, least), post: false };
};
TP.show = function (st) {
  var T = this;
  st = norm(st);
  if (T.next) { T.next.st = st; return; }             // a re-form waits for the graduation: it is that re-form's state
  T.state = st;
  if (T.reforming && T.reforming !== 'pour') return;  // drained and re-forming: the pour reads T.state
  if (T.grading) return;                              // the graduation aims at T.state when it has played
  if (!st.graduated && T.fill.post) { T.reform(T.su, st); return; }   // back from graduated (a simulation started over)
  if (st.graduated && !T.fill.post) T.pending = true;
  T.aim(); wake();
};
// a re-form runs in phases (T.reforming): 'drain' the level sinks away, 'wait' it hurries to a broadside face,
// 'morph' the corners ease to T.su, 'pour' T.state pours in; then every callback runs
TP.reform = function (su, st, cb) {
  var T = this, m = T.morph, was = T.reforming;
  st = norm(st || stateOf(su));
  if (cb) T.cbs.push(cb);
  T.pending = false;                                  // a graduation still waiting to face us is dropped
  if (T.grading) { T.next = { su: su, st: st }; return; }   // one that plays finishes first
  T.su = su; T.state = st; T.locked = true;
  if (was === 'wait') { if (su.form === T.form) pourIn(T); }   // back to where it is: nothing to ease
  else if (was === 'morph') {
    if (m.su !== su) { var k = new Spring(11, 0.7); k.g = 1; T.morph = { from: lerpForm(m.from, m.su.form, m.k.x), su: su, k: k }; }
  } else if (was !== 'drain') drainOut(T);            // settled, or pouring: it drains from where the level is
  wake();
};
TP.follow = function (su, st) { if (su !== (this.next ? this.next.su : this.su)) this.reform(su, st); else this.show(st); };
function drainOut(T) {
  T.reforming = 'drain'; T.hush = false;
  T.fill.drain(function () {
    if (T.form === T.su.form) { pourIn(T); return; }
    if (reduce) { T.S = T.su.surf; T.form = T.su.form; pourIn(T); return; }
    T.reforming = 'wait';                             // the morph starts once the face is towards us
  });
}
function pourIn(T) {
  T.reforming = 'pour';
  if (T.state.graduated) T.fill.put(T.su.vol, 0, 0, true);
  T.aim();
}
TP.angle = function () { if (this.fixed !== null) return this.fixed; return reduce ? ANG34 : eased(this.phi); };
// it faces us now and still will once the turn has braked to HUSH (a critically damped brake at w = 8 runs on for
// about (speed - HUSH) x 250 ms)
TP.broadside = function () {
  if (reduce || this.fixed !== null) return true;
  var ahead = (this.spin.x - HUSH) * 250 / TURN * 2 * Math.PI + 0.05;
  return Math.abs(Math.cos(eased(this.phi))) > 0.6 && Math.abs(Math.cos(eased(this.phi + ahead))) > 0.6;
};
TP.step = function (dt) {
  var T = this, o = T.o;
  T.fill.step(dt);
  // the page's pace (quicker while buying), then it eases back; waiting to graduate or re-form, it hurries past the
  // thin edge-on view; graduating or re-forming, it brakes almost to a stop with the face towards us
  var waiting = (T.pending && !T.locked && !T.fill.busy()) || T.reforming === 'wait';
  T.spin.g = T.hush ? HUSH : waiting ? HURRY : o.pace ? o.pace() : 1; T.spin.w = T.hush ? 8 : 3; T.spin.step(dt);
  if (!reduce) T.phi = (T.phi + dt / TURN * 2 * Math.PI * T.spin.x) % (2 * Math.PI);
  if (T.reforming === 'wait' && T.broadside()) {
    var k = new Spring(11, 0.7); k.g = 1;
    T.morph = { from: T.form, su: T.su, k: k }; T.reforming = 'morph'; T.hush = true;
  }
  var m = T.morph;
  if (m) {                                            // re-forming: the corners ease to the new shape, with a little give
    m.k.step(dt);
    if (m.k.rest(0.002)) { T.morph = null; T.S = m.su.surf; T.form = m.su.form; pourIn(T); }
    else T.S = T.mbuf = surfOf(lerpForm(m.from, m.su.form, m.k.x), 1, T.mbuf);   // the in-between forms share one scratch buffer
  }
  if (T.reforming === 'pour' && !T.fill.busy()) {
    var cbs = T.cbs; T.cbs = []; T.reforming = null; T.hush = false; T.locked = false;
    cbs.forEach(function (f) { f(); });
    return;
  }
  if (T.pending && !T.locked && !T.fill.busy() && T.broadside()) {   // the level has reached the apex and it faces us: graduate
    var st = T.state, cap = st.virtualSol + st.graduationSol;
    T.pending = false; T.locked = true; T.grading = true; T.hush = true;
    T.fill.graduate(st.virtualSol / cap, st.graduationSol / cap, function () {
      var n = T.next; T.next = null;
      T.locked = false; T.grading = false; T.hush = false;
      if (n) T.reform(n.su, n.st);                    // asked for while it played: now
      else if (!T.state.graduated) T.reform(T.su, T.state);   // shown a state from before graduation meanwhile: pour it afresh
      else T.aim();
      if (o.graduated) o.graduated();
    });
    if (o.change) o.change();
    return;
  }
  if (o.step) o.step(T.fill.clock);
};
TP.paint = function () {
  var t0 = performance.now(), G = this.G;
  splat(G, this.S, this.angle(), G.cx, G.oy);
  tint(G, this.fill.levels(), this.dark);
  present(this.cv, G);
  var t1 = performance.now();
  this.ms.push(t1 - t0); this.at.push(t1);
  if (this.ms.length > 600) { this.ms.shift(); this.at.shift(); }
};
// it needs frames while it turns or something moves; held at one angle (face) with nothing moving, it rests
TP.busy = function () { return (!reduce && this.fixed === null) || this.fill.busy() || !!this.reforming || this.pending || !!(this.o.busy && this.o.busy()); };
TP.size = function (px) { return size(this.cv, this.G, px); };
TP.stop = function () { untrack(this); };
TP.face = function (th) { this.fixed = th == null ? null : th; this.paint(); wake(); };   // hold it at one angle (radians), or let it turn again
TP.perf = function () {                               // what painting has cost over the last 600 frames
  var m = this.ms, n = m.length, s = 0, w = 0; for (var i = 0; i < n; i++) { s += m[i]; w = Math.max(w, m[i]); }
  var span = n > 1 ? this.at[n - 1] - this.at[0] : 0;
  return { frames: n, avgMs: n ? s / n : 0, worstMs: w, fps: span ? (n - 1) / span * 1000 : 0, points: this.S.n, size: this.G.w + 'x' + this.G.h };
};

/* ================= marks: a flat pixel triangle with a blue piece in it (it reads in one colour), and the wordmark ================= */
var SYMBOL = ['....#....', '...###...', '..##.##..', '.##...##.', '##.PPP.##', '#########'];
// the wordmark: wide, compact pixel letters on the same grid; the o holds the piece in one corner of its counter
var GLYPH = {
  f: ['.###', '.#..', '###.', '.#..', '.#..', '.#..'],
  o: ['.....', '.....', '.###.', '#...#', '#P..#', '.###.'],
  r: ['....', '....', '.###', '#...', '#...', '#...'],
  m: ['.......', '.......', '.#####.', '#..#..#', '#..#..#', '#..#..#'],
  a: ['......', '......', '.####.', '#...#.', '#...#.', '.#####']
};
var WORD = (function () {
  var rows = ['', '', '', '', '', ''];
  'forma'.split('').forEach(function (ch, i) { GLYPH[ch].forEach(function (g, y) { rows[y] += (i ? '.' : '') + g; }); });
  return rows;
})();
// whole device pixels per cell, so every cell edge lands on a device pixel; the cells blitted as merged runs
function mark(cv, rows, cell, ink, piece) {
  var dpr = Math.min(2, window.devicePixelRatio || 1), gd = Math.max(1, Math.round(cell * dpr)), w = rows[0].length, h = rows.length;
  if (cv.width !== w * gd || cv.height !== h * gd) { cv.width = w * gd; cv.height = h * gd; }
  cv.style.width = (w * gd / dpr) + 'px'; cv.style.height = (h * gd / dpr) + 'px';
  var ctx = cv.getContext('2d'); if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  var cur = '';
  function at(row, x) { return row[x] === '#' ? ink : row[x] === 'P' ? piece : 0; }
  rows.forEach(function (row, y) {
    var x = 0;
    while (x < w) {
      var c = at(row, x), e = x + 1;
      while (e < w && at(row, e) === c) e++;
      if (c) { if (HEX[c] !== cur) { ctx.fillStyle = HEX[c]; cur = HEX[c]; } ctx.fillRect(x * gd, y * gd, (e - x) * gd, gd); }
      x = e;
    }
  });
}
function symbol(cv, cell, ink, piece) { mark(cv, SYMBOL, cell, ink || GR, piece || BLUE); }
function wordmark(cv, cell, ink, piece) { mark(cv, WORD, cell, ink || INK, piece || BLUE); }

window.Tri = {
  C: { GR: GR, INK: INK, DEEP: DEEP, BLUE: BLUE, ICE: ICE, PAPER: PAPER, ORANGE: ORANGE },
  HEX: HEX,
  ANG34: ANG34,
  reduced: reduce,
  SHAPES: SHAPES,
  shape: findShape,
  shapeFor: shapeFor,
  fromPool: fromPool,
  pool: Pool,
  stateOf: stateOf,
  fill: function (st) { return fillOf(norm(st)); },
  progress: function (st) { return progressOf(norm(st)); },
  heightOf: heightOf,
  shareBelow: shareBelow,
  views: views,
  draw: draw,
  size: size,
  devPx: devPx,
  still: still,
  Fill: Fill,
  track: track,
  untrack: untrack,
  wake: wake,
  turner: function (cv, o) { return new Turner(cv, o); },
  symbol: symbol,
  wordmark: wordmark
};
})();
