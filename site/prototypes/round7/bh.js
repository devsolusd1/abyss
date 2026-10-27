/* forma, round 7: the symbol is a black hole, drawn on a few pixels in dark purple and light yellow.
 *
 * The light is bent the way a Schwarzschild black hole bends it (mass M = 1: horizon at r = 2, the
 * shadow's edge at impact parameter b = 3√3, the disk's inner edge at r = 6). A ray's path depends only
 * on its impact parameter, so one table of 1/r along the path, per b, serves every pixel at every tilt:
 * the disk in front, its far side lifted over and under the shadow, the thin second image that hugs
 * the shadow, and the stars behind, pulled into rings near the edge. The side of the disk that comes
 * towards us is blue-shifted and bright, the side going away is dim: that is the yellow and the purple.
 *
 * window.BH = { HEX, Hole, run, reduced, hash }
 *   new BH.Hole(canvas, { w, h, span, rOut, theta, stars, clear, grain })
 *     .theta (radians, π/2 is edge-on), .rOut (the disk's outer edge, in M), .t (disk time, s),
 *     .glow (exposure), .jet (0..1), .flash (0..1)
 *     .drop(amount) sends a clump of matter in from the disk's edge; .step(dt) moves time on;
 *     .onEat(clump) is called when a clump reaches the inner edge; .paint() draws a frame.
 *   BH.run(hole, frame) drives frame(dt, now) at up to 30 fps while the canvas is on screen and the
 *   tab is visible; returns { stop, wake }.
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

function look(b, phi) {
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
  var f = (rOut - r) / 5;
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

  // the jets run along the disk's axis, which is always the screen's vertical
  var upFront = cT >= 0, jLen = 46 * sT * jet, tj = t * 5.5;

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
      var u = look(b, p1);
      if (u > uOut && u < uIn) I = shade(1 / u, p1, ca, sa, lam);
      else if (u < .5) {
        u = look(b, p1 + PI);
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
      if (ay > BC && ay < jLen) {
        var front = (Y > 0) === upFront;
        if (front || (I < 0 && sk >= 0)) {
          var jw = s * .6 + ay * .03, ax = X < 0 ? -X : X;
          if (ax < jw * 2.6) {
            var q = ax / jw, core = q < .55 ? 1 : q < 1.3 ? .42 : .13 * (2.6 - q);
            var kn = Math.sin(ay * .42 - tj), knot = .5 + .5 * kn * kn * kn * kn;
            var fade = 1 - ay / jLen, base = Math.min(1, (ay - BC) / 2.5);
            var J = jet * core * (.45 + .9 * knot) * fade * base * 2.4;
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
  var on = true, vis = !document.hidden, raf = 0, last = 0, acc = 0, stopped = false;
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
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) { on = es[es.length - 1].isIntersecting; wake(); }).observe(hole.cv);
  }
  document.addEventListener('visibilitychange', function () { vis = !document.hidden; wake(); });
  wake();
  return { stop: function () { stopped = true; if (raf) cancelAnimationFrame(raf); raf = 0; }, wake: wake };
}

window.BH = { HEX: HEX, Hole: Hole, run: run, reduced: reduced, hash: hash2, BC: BC, R_IN: R_IN };
})();
