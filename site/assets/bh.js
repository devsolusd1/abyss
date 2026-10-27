/* Nox: the black hole every page draws, in dark purple and light yellow (window.BH).
 *
 * The light is bent the way a Schwarzschild black hole bends it (mass M = 1: horizon at r = 2, the
 * shadow's edge at impact parameter b = 3√3, the disk's inner edge at r = 6). A ray's path depends only
 * on its impact parameter, so one table of 1/r along the path, per b, serves every pixel at every tilt:
 * the disk in front, its far side lifted over and under the shadow, the thin second image that hugs
 * the shadow, and the stars behind, pulled into rings near the edge. The side of the disk that comes
 * towards us is blue-shifted and bright, the side going away is dim: that is the yellow and the purple.
 *
 * A coin is a black hole. Its disk is the SOL in its pool: the disk's edge goes from 10 M (nothing in)
 * to its reach at graduation; every buy is a clump that spirals in, and the SOL counts when it lands;
 * at graduation the jets light and stay lit. The reach grows with how far the coin has to go
 * (graduation market cap over virtual SOL), and the fee makes it glow hotter.
 *
 * Units: a Number is SOL, a BigInt is lamports (as chain.js reads the program's u64s).
 *
 * The drawing
 *   BH.HEX                 the eight colours: 0 the shadow, 1 the sky (the page), 2..7 the disk, cold to hot
 *   new BH.Hole(cv, { w, h, span, rOut, theta, t, glow, jet, stars, clear, grain })
 *     .theta (π/2 is edge-on) .rOut (the disk's edge, M) .t (disk time, s) .glow .jet (0..1) .flash (0..1)
 *     .drop(sol) a clump in from the edge; .step(dt); .onEat(clump) when one lands; .paint(); .size(w, h)
 *   BH.run(hole, frame)    frame(dt) at up to 30 fps while the canvas is on screen and the tab visible; { stop, wake }
 * A coin
 *   BH.look(settings)      { V, M, fee, G, reach, span, heat, burn } from { virtualSol, graduationMcap, feeBps }
 *                          (or graduationSol in place of graduationMcap); bad input gives 30 / 420 / 1%
 *   BH.stateOf(p)          { virtualSol, realSol, graduationSol, graduated } in SOL
 *   BH.fromPool(p)         { look, state } for a pool from Chain.readPool or listPools, or a launch event
 *   BH.progress(state)     0..1 toward graduation (1 once graduated); BH.rAt(look, progress) the disk's edge
 *   BH.still(cv, { look | settings, state | progress, w = 64, h = 40, theta, t, px, zoom, clear, stars }) a still
 *   BH.live(cv, { look, state, w = 168, h = 92, theta, rock, onLand(shownSol), onGraduate() }) a moving one:
 *     .show(state) new SOL comes in as clumps, SOL that goes out leaves the disk at once (the clumps still falling
 *     keep falling), a graduation plays once they land; .follow(look, state) new settings;
 *     .put(look, state) at once; .lean(-1..1) a little tilt (a hand over it); .size(px); .paint(); .stop() for good;
 *     .perf() { frames, fps, avgMs, worstMs }; readable .hole .look .state .shown (SOL drawn so far) .busy .graduated
 * The page
 *   BH.mark(cv, px, ink)   the hand-drawn mark, 21x12 (ink: one colour for all but the shadow); BH.favicon()
 *   BH.starTile(n)         a data URL of n x n sky pixels: the same colours and density as the hole's sky
 *   BH.devPx(px), BH.fit(cv, px) whole device pixels; BH.fitPx(avail, n) the largest whole-device pixel that fits
 *                          n of them in avail css px (the narrowest phones); BH.reduced (reduced motion, or ?motion=reduce)
 */
(function () {
'use strict';

var PI = Math.PI, TAU = 2 * PI, BC = 3 * Math.sqrt(3), R_IN = 6;
var reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) || /[?&]motion=reduce/.test(location.search);

/* ---------- palette: 0 the shadow, 1 the sky (the page), 2..7 the disk from cold to hot ---------- */
var HEX = ['#07040d', '#120a1f', '#22123b', '#3b1e60', '#67378d', '#b296cf', '#f4e4a1', '#fffbe6'];
function pack(hex, a) { var n = parseInt(hex.slice(1), 16); return ((a << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | (n >> 16)) >>> 0; }
var COL = HEX.map(function (h) { return pack(h, 255); }), CLEAR = 0;
var NR = 7;                                                    // ramp length: the background, then indices 2..7
var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
var BAND = .42;                                                // how wide the dithered step between two tones is

/* ---------- the ray table: u = 1/r along each ray, traced back from the eye ----------
 * u'' = 3u² − u (the photon orbit equation, M = 1), from u = 0 with u' = 1/b at φ = 0.
 * After the ray falls in, U holds 0.5; after it leaves for the sky, U holds 0. ESC holds the angle at
 * which it leaves (−1 if it falls in), which bends the stars. */
var NB = 720, BMAX = 36, DB = BMAX / (NB - 1);
var NP = 420, PMAX = TAU + .3, DP = PMAX / (NP - 1);
var U = new Float32Array(NB * NP), ESC = new Float32Array(NB);

(function trace() {
  var S = 4, h = DP / S, LIM = 14 * PI;
  for (var i = 0; i < NB; i++) {
    var b = Math.max(i * DB, DB * .25), u = 0, w = 1 / b, phi = 0, row = i * NP, state = 0, j = 1, s = 0;
    U[row] = 0; ESC[i] = -1;
    while (j < NP || (state === 0 && phi < LIM)) {
      if (state === 0) {                                   // one RK4 step
        var k1w = 3 * u * u - u;
        var u2 = u + .5 * h * w, w2 = w + .5 * h * k1w, k2w = 3 * u2 * u2 - u2;
        var u3 = u + .5 * h * w2, w3 = w + .5 * h * k2w, k3w = 3 * u3 * u3 - u3;
        var u4 = u + h * w3, w4 = w + h * k3w, k4w = 3 * u4 * u4 - u4;
        var un = u + h / 6 * (w + 2 * w2 + 2 * w3 + w4), wn = w + h / 6 * (k1w + 2 * k2w + 2 * k3w + k4w);
        if (un >= .5) state = 1;
        else if (un <= 0) { state = 2; ESC[i] = phi + h * u / (u - un); }
        u = un; w = wn; phi += h;
      }
      if (++s === S) { s = 0; if (j < NP) U[row + j] = state === 1 ? .5 : state === 2 ? 0 : u; j++; }
    }
  }
})();

function ray(b, phi) {
  var x = b / DB, y = phi / DP;
  if (x > NB - 1.001) x = NB - 1.001;
  var i = x | 0, j = y | 0, fx = x - i, fy = y - j, o = i * NP + j;
  var a = U[o] + (U[o + 1] - U[o]) * fy, c = U[o + NP] + (U[o + NP + 1] - U[o + NP]) * fy;
  return a + (c - a) * fx;
}

/* ---------- noise for the disk's grain (periodic around the disk) ---------- */
function hash2(i, j) {
  var h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, per) {
  var i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  var i0 = ((i % per) + per) % per, i1 = (i0 + 1) % per;
  var a = hash2(i0, j), b = hash2(i1, j), c = hash2(i0, j + 1), d = hash2(i1, j + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/* how bright a thin disk glows at radius r: nothing at the inner edge, a peak near r = 8, then a
   long fall, softened over the last 3 M before the outer edge */
function emit(r, rOut) {
  var x = R_IN / r, e = Math.pow(x, 2.2) * Math.sqrt(Math.max(0, 1 - Math.sqrt(x))) / .195;
  var f = (rOut - r) / Math.min(5, (rOut - R_IN) * .55);
  if (f < 1) e *= f <= 0 ? 0 : f * f * (3 - 2 * f);
  return e;
}

var SPIN = 26;     // M of disk time per second: the inner edge turns about every 6 s, the outer edge about every 20 s
var FLOW = 7;      // seconds between the two grain layers' resets, which keeps the shear from winding forever
var LENS = 10;     // how far behind the hole the stars sit, in M: their ring falls just outside the shadow

function Hole(cv, o) {
  o = o || {};
  this.cv = cv; this.ctx = cv.getContext('2d');
  this.span = o.span || 52;
  this.rOut = o.rOut || 20;
  this.theta = o.theta != null ? o.theta : 1.36;
  this.t = o.t || 0;
  this.glow = o.glow || 1;
  this.jet = o.jet || 0; this.flash = 0;
  this.stars = o.stars !== false;
  this.clear = !!o.clear;
  this.grain = o.grain !== false;
  this.blobs = [];
  this.onEat = null;
  this.size(o.w || 168, o.h || 104);
}

Hole.prototype.size = function (w, h) {
  this.w = w; this.h = h; this.cv.width = w; this.cv.height = h;
  this.img = this.ctx.createImageData(w, h); this.px = new Uint32Array(this.img.data.buffer);
  var n = w * h, s = this.s = this.span / w, cx = (w - 1) / 2, cy = (h - 1) / 2;
  this.B = new Float32Array(n); this.CA = new Float32Array(n); this.SA = new Float32Array(n);
  this.D = new Float32Array(n); this.SKY = new Int8Array(n);
  this.tw = [];
  var dens = .011;
  for (var y = 0, k = 0; y < h; y++) for (var x = 0; x < w; x++, k++) {
    var X = (x - cx) * s, Y = (cy - y) * s, b = Math.hypot(X, Y), ca = b ? X / b : 1, sa = b ? Y / b : 0;
    this.B[k] = b; this.CA[k] = ca; this.SA[k] = sa;
    this.D[k] = (BAYER[(y & 3) * 4 + (x & 3)] + .5) / 16;
    // the sky behind, bent: -1 the shadow, 0 empty, 1..4 a star's brightness
    var e = ESC[Math.min(NB - 1, Math.round(b / DB))];
    if (b < BC || e < 0) { this.SKY[k] = -1; continue; }
    if (!this.stars) continue;
    var q = (b - LENS * (e - PI)) / s;
    var hx = Math.floor(q * ca), hy = Math.floor(q * sa), hv = hash2(hx * 7 + 3, hy * 13 + 5);
    if (hv < dens) {
      var lv = hash2(hx + 101, hy - 77);
      this.SKY[k] = lv < .62 ? 1 : lv < .9 ? 2 : lv < .975 ? 3 : 4;
      if (hash2(hx - 9, hy + 31) < .18) this.tw.push(k, hash2(hx, hy) * TAU);
    }
  }
};

Hole.prototype.drop = function (amount) {
  var a = Math.max(.25, Math.min(1.6, Math.sqrt(amount || 1) * .8));
  var life = 4.2 + Math.random() * 1.6;
  this.blobs.push({ r: this.rOut - 1, r0: this.rOut - 1, psi: Math.random() * TAU, age: 0, life: life, amp: a, amount: amount });
};

Hole.prototype.step = function (dt) {
  this.t += dt;
  for (var i = this.blobs.length - 1; i >= 0; i--) {
    var c = this.blobs[i];
    c.age += dt;
    var f = Math.min(1, c.age / c.life);
    c.r = c.r0 - (c.r0 - R_IN) * (f * f * (1.6 - .6 * f));
    c.psi += Math.pow(c.r, -1.5) * SPIN * dt;
    if (f >= 1) {
      this.blobs.splice(i, 1);
      this.flash = Math.min(1, this.flash + .35 + c.amp * .25);
      if (this.onEat) this.onEat(c);
    }
  }
  this.flash = Math.max(0, this.flash - dt * 1.6);
};

Hole.prototype.paint = function () {
  var w = this.w, n = w * this.h, px = this.px, B = this.B, CA = this.CA, SA = this.SA, D = this.D, SKY = this.SKY;
  var th = this.theta, sT = Math.sin(th), cT = Math.cos(th), t = this.t, rOut = this.rOut, s = this.s;
  var uIn = 1 / R_IN, uOut = 1 / rOut, bMax = rOut + 2.5;
  var expo = this.glow * (1 + this.flash * .6), jet = this.jet, flash = this.flash;
  var ringLo = BC + s * .05, ringHi = BC + s * .95;
  var blobs = this.blobs, nb = blobs.length, grain = this.grain;
  var clear = this.clear ? CLEAR : COL[1];
  var skyCol = [clear, COL[3], COL[4], COL[5], COL[6]];

  // the grain's two layers, cross-faded
  var ph0 = t / FLOW, ph1 = ph0 + .5, c0 = Math.floor(ph0), c1 = Math.floor(ph1), f0 = ph0 - c0, f1 = ph1 - c1;
  var w0 = 1 - Math.abs(2 * f0 - 1), w1 = 1 - w0, sh0 = f0 * FLOW * SPIN, sh1 = f1 * FLOW * SPIN;
  var o0 = c0 * 7.31, o1 = c1 * 7.31 + 3.7, G = 24 / TAU;

  // the jets run along the disk's axis, which is always the screen's vertical; they thin out over the last
  // stretch before the frame's top and bottom, so they never end in a cut
  var upFront = cT >= 0, jLen = 46 * sT * jet, tj = t * 5.5, jTop = this.h / 2 * s - s, jEdge = jTop * .3;

  function shade(r, phi, ca, sa, lam) {
    var sp = Math.sin(phi), cp = Math.cos(phi);
    var psi = Math.atan2(-cp * sT + sp * sa * cT, sp * ca);
    var om = Math.pow(r, -1.5), g = Math.sqrt(1 - 3 / r) / (1 + om * lam), g3 = g * g * g;
    var gr = .6;
    if (grain) {
      var lr = Math.log(r) * 6.5, a0 = (psi - om * sh0) * G, a1 = (psi - om * sh1) * G;
      var n0 = vnoise(a0, lr + o0, 24) * .62 + vnoise(a0 * 2 + 5, lr * 2.1 + o0, 48) * .38;
      var n1 = vnoise(a1, lr + o1, 24) * .62 + vnoise(a1 * 2 + 5, lr * 2.1 + o1, 48) * .38;
      gr = n0 * w0 + n1 * w1;
    }
    var I = emit(r, rOut) * (.28 + 1.5 * gr * gr);
    for (var q = 0; q < nb; q++) {
      var c = blobs[q], dr = r - c.r;
      if (dr > 3 || dr < -3) continue;
      var dp = psi - c.psi; dp -= TAU * Math.round(dp / TAU);
      var arc = dp * r, sg = arc < 0 ? 5.5 : 1.3;
      I += c.amp * 1.7 * Math.exp(-dr * dr / .8 - arc * arc / (sg * sg));
    }
    return I * g3;
  }

  for (var k = 0; k < n; k++) {
    var b = B[k], ca = CA[k], sa = SA[k], I = -1, sk = SKY[k];
    if (b < bMax) {
      var lam = b * ca * sT;
      var p1 = Math.atan2(-cT, sa * sT); if (p1 <= 0) p1 += PI;
      var u = ray(b, p1);
      if (u > uOut && u < uIn) I = shade(1 / u, p1, ca, sa, lam);
      else if (u < .5) {
        u = ray(b, p1 + PI);
        if (u > uOut && u < uIn) I = shade(1 / u, p1 + PI, ca, sa, lam) * .9;
      }
      if (I < 0 && b >= ringLo && b < ringHi) {
        var gR = .7071 / (1 + .068 * lam);
        I = (1.25 + flash * 1.5) * gR * gR * gR * (.55 + .45 * Math.min(1, rOut / 16));
      }
    }
    // the jets: the near one in front of everything, the far one only against the sky
    if (jet > 0) {
      var X = b * ca, Y = b * sa, ay = Y < 0 ? -Y : Y;
      if (ay > BC && ay < jLen && ay < jTop) {
        var front = (Y > 0) === upFront;
        if (front || (I < 0 && sk >= 0)) {
          var jw = s * .6 + ay * .03, ax = X < 0 ? -X : X;
          if (ax < jw * 2.6) {
            var q = ax / jw, core = q < .55 ? 1 : q < 1.3 ? .42 : .13 * (2.6 - q);
            var kn = Math.sin(ay * .42 - tj), knot = .5 + .5 * kn * kn * kn * kn;
            var fade = 1 - ay / jLen, base = Math.min(1, (ay - BC) / 2.5), edge = Math.min(1, (jTop - ay) / jEdge);
            var J = jet * core * (.45 + .9 * knot) * fade * base * edge * edge * 2.4;
            if (J > (I < 0 ? 0 : I)) I = J;
          }
        }
      }
    }
    if (I < 0) {
      px[k] = sk < 0 ? COL[0] : skyCol[sk > 0 ? sk : 0];
      continue;
    }
    var v = 1 - Math.exp(-I * expo);
    var x = v * (NR - .001), i = x | 0, f = x - i;
    f = (f - .5) / BAND + .5;
    if (f > D[k]) i++;
    if (i > NR - 1) i = NR - 1;
    px[k] = i > 0 ? COL[1 + i] : sk < 0 ? COL[0] : clear;
  }
  // a few stars breathe
  var tw = this.tw;
  if (tw.length && !reduced) for (var m = 0; m < tw.length; m += 2) {
    var kk = tw[m];
    if (px[kk] !== skyCol[SKY[kk]]) continue;
    var lvl = Math.sin(t * 1.3 + tw[m + 1]);
    px[kk] = lvl > .55 ? COL[6] : lvl < -.6 ? clear : skyCol[SKY[kk]];
  }
  this.ctx.putImageData(this.img, 0, 0);
};

/* ---------- the driver ---------- */
function run(hole, frame) {
  var on = true, vis = !document.hidden, raf = 0, last = 0, acc = 0, stopped = false, io = null;
  function tick(now) {
    raf = 0;
    if (stopped || !on || !vis) { last = 0; return; }
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    var dt = now - last; last = now; acc += dt;
    if (acc < 1000 / 31) return;
    var step = Math.min(acc, 100) / 1000; acc = 0;
    frame(step, now);
  }
  function wake() { if (!raf && !stopped && on && vis) raf = requestAnimationFrame(tick); }
  function onVis() { vis = !document.hidden; wake(); }
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(function (es) { on = es[es.length - 1].isIntersecting; wake(); });
    io.observe(hole.cv);
  }
  document.addEventListener('visibilitychange', onVis);
  wake();
  // stop lets go of everything it holds, so a page can make a new hole on the same canvas
  return { stop: function () {
    stopped = true; if (raf) cancelAnimationFrame(raf); raf = 0;
    if (io) io.disconnect(); io = null; document.removeEventListener('visibilitychange', onVis);
  }, wake: wake };
}

/* ================= a coin ================= */
function sol(x) { return typeof x === 'bigint' ? Number(x) / 1e9 : Number(x); }
function look(o) {
  o = o || {};
  var V = sol(o.virtualSol != null ? o.virtualSol : o.V), M = sol(o.graduationMcap != null ? o.graduationMcap : o.M), fee = Number(o.feeBps != null ? o.feeBps : o.fee);
  if (!(M > 0) && o.graduationSol != null) { var g = sol(o.graduationSol); M = (V + g) * (V + g) / V; }
  if (!(V > 0) || !isFinite(V) || !(M > V) || !isFinite(M)) { V = 30; M = 420; }
  if (!(fee >= 0) || !isFinite(fee)) fee = 100;
  var reach = Math.max(10.5, Math.min(28, 8 + 4.9 * Math.log(M / V)));
  return { V: V, M: M, fee: fee, G: Math.sqrt(M * V) - V, reach: reach, span: 2 * (reach + 2.4), heat: 1.5 + Math.min(300, fee) / 100 * .22, burn: 1e9 * V / M };
}
function stateOf(p) {
  p = p || {};
  var V = sol(p.virtualSol), G = p.graduationSol != null ? sol(p.graduationSol) : NaN;
  if (!(G > 0) || !(V > 0)) { var lk = look(p); V = lk.V; G = lk.G; }
  return { virtualSol: V, realSol: Math.max(0, sol(p.realSol) || 0), graduationSol: G, graduated: !!p.graduated };
}
function fromPool(p) {
  p = p || {}; var st = stateOf(p);
  return { look: look({ virtualSol: st.virtualSol, graduationMcap: p.graduationMcap, graduationSol: st.graduationSol, feeBps: p.feeBps }), state: st };
}
function progress(st) { return !st ? 0 : st.graduated ? 1 : st.graduationSol > 0 ? Math.max(0, Math.min(1, st.realSol / st.graduationSol)) : 0; }
function rAt(lk, pr) { return R0 + (lk.reach - R0) * Math.pow(Math.max(0, Math.min(1, pr)), .7); }
var R0 = 10;          // the disk's edge with nothing in: a thin bright ring of gas, so a new coin still reads as a hole

function devPx(px) { var r = window.devicePixelRatio || 1; return Math.max(1, Math.round(px * r)) / r; }
function fit(cv, px) { var d = devPx(px); cv.style.width = cv.width * d + 'px'; cv.style.height = cv.height * d + 'px'; return d; }
function fitPx(avail, n) { var r = window.devicePixelRatio || 1; return Math.max(1, Math.floor(avail * r / n)) / r; }

function still(cv, o) {
  o = o || {};
  var lk = o.look || look(o.settings), st = o.state, pr = o.progress != null ? o.progress : progress(st), grad = st ? !!st.graduated : pr >= 1 && !!o.graduated;
  var h = new Hole(cv, { w: o.w || 64, h: o.h || 40, span: lk.span * (o.zoom || 1), rOut: rAt(lk, pr), theta: o.theta || 1.43,
    glow: o.glow || lk.heat * (grad ? 1.12 : 1), jet: o.jet != null ? o.jet : grad ? 1 : 0, t: o.t != null ? o.t : 4, stars: o.stars, clear: o.clear });
  (o.blobs || []).forEach(function (f) { h.drop(2); var b = h.blobs[h.blobs.length - 1]; b.age = b.life * f; b.psi = f * 5; });
  h.step(0); h.flash = o.flash || 0; h.paint();
  if (o.px) fit(cv, o.px);
  return h;
}

/* a coin's hole that moves: trades come in as clumps, the disk's edge follows the SOL that has landed, a
   graduation plays once the last clump is in */
function live(cv, o) {
  o = o || {};
  var lk = o.look || look(), st = o.state || stateOf({}), w = o.w || 168, hh = o.h || 92, base = o.theta || 1.43, rock = o.rock !== false;
  var hole = new Hole(cv, { w: w, h: hh, span: lk.span, rOut: rAt(lk, progress(st)), theta: base, glow: lk.heat * (st.graduated ? 1.12 : 1), jet: st.graduated ? 1 : 0 });
  var ctl = { hole: hole, look: lk, state: st, shown: st.realSol, graduated: st.graduated, busy: false };
  var queue = [], clock = 0, leanGoal = 0, leanNow = 0, jetGoal = ctl.graduated ? 1 : 0, gradWaiting = false, loop = null;
  var seq = 0, gradSeq = 0;                          // every clump is numbered; a graduation waits for those up to gradSeq
  var frames = 0, sum = 0, worst = 0, t0 = 0;
  hole.onEat = function (c) {
    ctl.shown = Math.min(ctl.state.realSol, ctl.shown + c.amount);
    if (o.onLand) o.onLand(ctl.shown);
    settle();
  };
  function shownProgress() { return ctl.graduated ? 1 : lk.G > 0 ? Math.min(1, ctl.shown / lk.G) : 0; }
  // a clump numbered n or lower still waiting or falling
  function inFlight(n) {
    var i;
    for (i = 0; i < queue.length; i++) if (queue[i].seq <= n) return true;
    for (i = 0; i < hole.blobs.length; i++) if ((hole.blobs[i].seq || 0) <= n) return true;
    return false;
  }
  // the graduation plays once the clumps that came in up to the graduating trade have landed; later trades' clumps
  // do not hold it back
  function settle() {
    ctl.busy = queue.length > 0 || hole.blobs.length > 0;
    if (gradWaiting && !inFlight(gradSeq)) {
      gradWaiting = false; ctl.graduated = true; jetGoal = 1; hole.flash = 1;
      ctl.shown = Math.max(ctl.shown, ctl.state.realSol - owed());
      if (o.onGraduate) o.onGraduate();
    }
  }
  function draw() {
    if (reduced) { hole.rOut = rAt(lk, shownProgress()); hole.glow = lk.heat * (ctl.graduated ? 1.12 : 1); hole.jet = ctl.graduated ? 1 : 0; hole.theta = base; hole.flash = 0; }
    var a = performance.now(); hole.paint(); var ms = performance.now() - a;
    frames++; sum += ms; if (ms > worst) worst = ms; if (!t0) t0 = a;
  }
  // SOL still to land: clumps waiting their turn, and clumps falling in now
  function owed() {
    var s = 0, i;
    for (i = 0; i < queue.length; i++) s += queue[i].amount;
    for (i = 0; i < hole.blobs.length; i++) s += hole.blobs[i].amount || 0;
    return s;
  }
  ctl.show = function (next) {
    next = next || ctl.state;
    ctl.state = next;
    var startWait = next.graduated && !ctl.graduated && !gradWaiting;
    if (startWait) gradWaiting = true;
    if (!next.graduated && (ctl.graduated || gradWaiting)) { ctl.graduated = false; gradWaiting = false; jetGoal = 0; }
    if (reduced) { ctl.shown = next.realSol; queue.length = 0; hole.blobs.length = 0; }
    else {
      // what the disk and the clumps still to land do not yet account for
      var gap = next.realSol - ctl.shown - owed();
      if (gap > 1e-9) {
        var n = Math.max(1, Math.min(4, Math.ceil(gap / Math.max(lk.G / 16, .05)))), each = gap / n;
        for (var i = 0; i < n; i++) queue.push({ at: clock + i * .4, amount: each, seq: ++seq });
      } else if (gap < -1e-9) {
        // SOL went out (a sell): it leaves the disk now, and what it takes beyond the disk comes off the clumps
        // still to land; the clumps keep falling in
        var cut = -gap, off = Math.min(cut, ctl.shown);
        ctl.shown -= off; cut -= off;
        for (var j = queue.length - 1; j >= 0 && cut > 1e-12; j--) {
          var a = Math.min(cut, queue[j].amount); queue[j].amount -= a; cut -= a;
          if (queue[j].amount <= 1e-12) queue.splice(j, 1);
        }
        for (var k = 0; k < hole.blobs.length && cut > 1e-12; k++) {
          var b = hole.blobs[k], a2 = Math.min(cut, b.amount || 0); b.amount -= a2; cut -= a2;
        }
      }
    }
    if (startWait) gradSeq = seq;                    // the graduating trade's clumps, and those before them
    settle();
    if (reduced) { if (o.onLand) o.onLand(ctl.shown); draw(); }
    else if (loop) loop.wake();
  };
  ctl.follow = function (nlk, next) {
    if (nlk && (nlk.span !== lk.span || nlk.reach !== lk.reach || nlk.heat !== lk.heat)) {
      var spanChanged = nlk.span !== lk.span;
      lk = ctl.look = nlk;
      if (spanChanged) { hole.span = lk.span; hole.size(w, hh); }
    }
    ctl.show(next || ctl.state);
    if (reduced) draw();
  };
  ctl.put = function (nlk, next) {
    if (nlk) { lk = ctl.look = nlk; hole.span = lk.span; hole.size(w, hh); }
    if (next) ctl.state = next;
    queue.length = 0; hole.blobs.length = 0; gradWaiting = false;
    ctl.shown = ctl.state.realSol; ctl.graduated = ctl.state.graduated; jetGoal = ctl.graduated ? 1 : 0;
    hole.rOut = rAt(lk, shownProgress()); hole.jet = jetGoal; hole.glow = lk.heat * (ctl.graduated ? 1.12 : 1);
    settle(); draw();
  };
  ctl.lean = function (v) { leanGoal = Math.max(-1, Math.min(1, v || 0)) * .11; if (loop) loop.wake(); };
  ctl.size = function (px) { return fit(cv, px); };
  ctl.paint = draw;
  ctl.stop = function () { if (loop) loop.stop(); loop = null; };
  ctl.perf = function () { var s = t0 ? (performance.now() - t0) / 1000 : 0; return { frames: frames, fps: s > 0 ? frames / s : 0, avgMs: frames ? sum / frames : 0, worstMs: worst }; };
  ctl.clock = function () { return clock; };
  function frame(dt) {
    clock += dt;
    while (queue.length && queue[0].at <= clock) { var it = queue.shift(); hole.drop(it.amount); hole.blobs[hole.blobs.length - 1].seq = it.seq; }
    leanNow += (leanGoal - leanNow) * Math.min(1, dt * 2.5);
    hole.theta = Math.max(1.18, Math.min(1.53, base + (rock ? .085 * Math.sin(clock * TAU / 24) : 0) + leanNow));
    hole.rOut += (rAt(lk, shownProgress()) - hole.rOut) * Math.min(1, dt * 1.2);
    hole.glow += (lk.heat * (ctl.graduated ? 1.12 : 1) - hole.glow) * Math.min(1, dt * 1.5);
    hole.jet += (jetGoal - hole.jet) * Math.min(1, dt * 1.1);   // the jets go out as fast as they light
    hole.step(dt);
    draw();
    settle();
  }
  draw();
  if (!reduced) loop = run(hole, frame);
  return ctl;
}

/* ================= the page ================= */
var PAL = { k: HEX[0], d: HEX[2], p: HEX[3], v: HEX[4], l: HEX[5], y: HEX[6], w: HEX[7] };
var MARK = ['.........llv.........', '.......ylyylvv.......', '......ywykkkllv......', '.....ywkkkkkkklp.....', '.....ywkkkkkkklp.....', '.....wkkkkkkkkkv.....',
  '.....wkkkkkkkkkv.....', 'yyywwwyyyyyllllllvvvv', '......wkkkkkkkl......', '......wkkkkkkkl......', '.......wykkkll.......', '.........yyl.........'];
var FAV = ['......lllvv......', '.....ylyylvv.....', '....ywykkkllp....', '...yywkkkkklpp...', '...ywkkkkkkkvp...', '...ywkkkkkkkvp...',
  'yywwwyyyylllllvvv', '.....wkkkkkl.....', '.....wykkkll.....', '.......yyl.......'];
function sprite(cv, rows, oy, ink) {
  var c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  rows.forEach(function (r, y) { for (var x = 0; x < r.length; x++) { var col = PAL[r[x]]; if (col) { c.fillStyle = ink && r[x] !== 'k' ? ink : col; c.fillRect(x, y + (oy || 0), 1, 1); } } });
}
function mark(cv, px, ink) { cv.width = MARK[0].length; cv.height = MARK.length; sprite(cv, MARK, 0, ink); return fit(cv, px || 2); }
function favicon() {
  var cv = document.createElement('canvas'); cv.width = 17; cv.height = 17; sprite(cv, FAV, 3);
  var l = document.querySelector('link[rel="icon"]') || document.createElement('link'); l.rel = 'icon'; l.href = cv.toDataURL();
  if (!l.parentNode) document.head.appendChild(l);
}
function starTile(n) {
  var c = document.createElement('canvas'); c.width = c.height = n; var g = c.getContext('2d');
  g.fillStyle = HEX[1]; g.fillRect(0, 0, n, n);
  for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
    if (hash2(x * 7 + 3, y * 13 + 9005) < .011) {
      var l = hash2(x + 101, y + 8923);
      g.fillStyle = l < .62 ? HEX[3] : l < .9 ? HEX[4] : l < .975 ? HEX[5] : HEX[6]; g.fillRect(x, y, 1, 1);
    }
  }
  return c.toDataURL();
}

window.BH = {
  HEX: HEX, Hole: Hole, run: run, reduced: reduced, hash: hash2, BC: BC, R_IN: R_IN,
  look: look, stateOf: stateOf, fromPool: fromPool, progress: progress, rAt: rAt, still: still, live: live,
  mark: mark, favicon: favicon, starTile: starTile, devPx: devPx, fit: fit, fitPx: fitPx
};
})();
