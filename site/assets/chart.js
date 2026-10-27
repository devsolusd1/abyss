/* Nox: a candle chart in the site's pixels (window.NoxChart).
 *
 * Every mark sits on a grid of 2 css px cells in whole device pixels, like the hole, and uses the hole's colours:
 * a candle that closed up is yellow, one that closed down is lilac, an interval with no trade is a dim dash; the
 * volume sits in a strip under them. Only the text is drawn at full resolution.
 *
 *   var ch = new NoxChart(canvas, { height: css px or a function, onHover(i) })
 *   ch.set({ candles: [{ t, o, h, l, c, v, n }], fmt(value), tfmt(t), log, goal: { v, label }, events: [{ i, label }],
 *            marks: [{ i, buy }] })   draws on the next frame; the view stays put while new candles come in if it was
 *                                     dragged back, and follows the newest otherwise
 *   ch.zoom(+1 | -1), ch.latest(), ch.following, ch.hover (the candle under the pointer, or -1), ch.resize(), ch.draw()
 * A mouse drags the chart sideways, a pinch or ctrl+wheel zooms; a finger drags it sideways and a tap points.
 */
(function () {
'use strict';
var HEX = ['#07040d', '#120a1f', '#22123b', '#3b1e60', '#67378d', '#b296cf', '#f4e4a1', '#fffbe6'];
var MUTE = 'rgba(255, 251, 230, .6)';
var ZOOM = [[2, 1], [4, 3], [6, 5], [8, 5], [12, 9], [16, 13]];   // a candle's slot and its body, in cells
var AXIS = 64, TIME = 20, RIGHT = 3;                              // css px for the price axis and the time row; cells left empty after the newest

function nice(x) {
  var e = Math.pow(10, Math.floor(Math.log10(x))), f = x / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

function NoxChart(cv, o) {
  o = o || {};
  var self = this;
  this.cv = cv; this.ctx = cv.getContext('2d'); this.o = o;
  this.z = 2; this.auto = true; this.off = 0; this.hover = -1; this.hy = -1;
  this.d = { candles: [], marks: [], events: [] };
  this.raf = 0; this.L = null;
  cv.style.touchAction = 'pan-y';
  var drag = null;
  cv.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = { x: e.clientX, off: self.off, id: e.pointerId, moved: false };
  });
  cv.addEventListener('pointermove', function (e) {
    var r = cv.getBoundingClientRect();
    if (drag && (e.pointerType !== 'mouse' || e.buttons & 1)) {
      var dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) > 5) { drag.moved = true; try { cv.setPointerCapture(drag.id); } catch (_) {} cv.classList.add('dragging'); }
      if (drag.moved && self.L) { self.off = self.clampOff(drag.off + Math.round(dx / (self.L.cell * self.L.st))); }
    }
    self.pointAt(e.clientX - r.left, e.clientY - r.top);
  });
  function end() { drag = null; cv.classList.remove('dragging'); }
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') { end(); self.pointAt(-1, -1); } });
  cv.addEventListener('wheel', function (e) {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); self.zoom(e.deltaY < 0 ? 1 : -1); }
    else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5 && self.L) {
      e.preventDefault();
      self.off = self.clampOff(self.off + (e.deltaX < 0 ? 1 : -1) * Math.max(1, Math.round(Math.abs(e.deltaX) / (self.L.cell * self.L.st))));
      self.draw();
    }
  }, { passive: false });
  if ('ResizeObserver' in window) { var w0 = 0; new ResizeObserver(function () { var w = cv.parentNode.clientWidth; if (w !== w0) { w0 = w; self.resize(); } }).observe(cv.parentNode); }
  else addEventListener('resize', function () { self.resize(); });
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { self.draw(); }); } catch (e) {}
  this.resize();
}

Object.defineProperty(NoxChart.prototype, 'following', { get: function () { return this.off === 0; } });

NoxChart.prototype.set = function (d) {
  for (var k in d) this.d[k] = d[k];
  var n = this.d.candles.length, grew = this.n != null && d.candles ? n - this.n : 0;   // the list can be the same array, grown
  this.n = n;
  if (this.off > 0 && grew > 0) this.off += grew;          // dragged back: the same candles stay in view
  this.off = this.clampOff(this.off);
  this.draw();
};
NoxChart.prototype.clampOff = function (v) { return Math.max(0, Math.min(Math.max(0, this.d.candles.length - 4), v)); };
NoxChart.prototype.zoom = function (dir) { this.auto = false; this.z = Math.max(0, Math.min(ZOOM.length - 1, this.z + dir)); this.draw(); return this.z; };
NoxChart.prototype.latest = function () { this.off = 0; this.n = null; this.draw(); };
// back to the newest candles, as wide as they fit: while there are few, they grow to fill the chart
NoxChart.prototype.fit = function () { this.auto = true; this.z = 2; this.latest(); };
NoxChart.prototype.resize = function () {
  var dpr = window.devicePixelRatio || 1, w = this.cv.parentNode.clientWidth, h = typeof this.o.height === 'function' ? this.o.height() : this.o.height || 360;
  if (!(w > 0)) return;
  this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
  this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
  this.paint();
};
NoxChart.prototype.draw = function () {
  var self = this;
  if (!this.raf) this.raf = requestAnimationFrame(function () { self.raf = 0; self.paint(); });
};
NoxChart.prototype.pointAt = function (x, y) {
  var L = this.L, k = -1;
  if (L && x >= 0 && y >= 0) {
    var col = Math.floor(x * L.dpr / L.U), j = Math.floor((L.plot - RIGHT - 1 - col) / L.st);
    if (col < L.plot && j >= 0) { k = L.last - j; if (k < L.first || k > L.last) k = -1; }
  }
  var hy = k >= 0 ? Math.floor(y * L.dpr / L.U) : -1;
  if (k === this.hover && hy === this.hy) return;
  var changed = k !== this.hover;
  this.hover = k; this.hy = hy;
  this.draw();
  if (changed && this.o.onHover) this.o.onHover(k);
};

NoxChart.prototype.paint = function () {
  var cv = this.cv, ctx = this.ctx, d = this.d, cs = d.candles || [];
  var dpr = window.devicePixelRatio || 1, U = Math.max(1, Math.round(2 * dpr));
  var cols = Math.floor(cv.width / U), rows = Math.floor(cv.height / U);
  var axis = Math.ceil(AXIS * dpr / U), timeR = Math.ceil(TIME * dpr / U);
  var plot = cols - axis, volR = Math.max(4, Math.round((rows - timeR) * .15)), gapR = 3, priceR = rows - timeR - volR - gapR - 2, top = 2;
  if (this.auto) { var z = 2; while (z < ZOOM.length - 1 && cs.length * ZOOM[z + 1][0] <= plot - RIGHT) z++; this.z = z; }
  var st = ZOOM[this.z][0], bw = ZOOM[this.z][1];
  var slots = Math.max(1, Math.floor((plot - RIGHT) / st));
  var last = cs.length - 1 - this.off, first = Math.max(0, last - slots + 1);
  this.L = { U: U, dpr: dpr, cell: U / dpr, plot: plot, st: st, first: first, last: last };
  ctx.clearRect(0, 0, cv.width, cv.height);
  var font = Math.round(10 * dpr) + 'px "Martian Mono", ui-monospace, monospace';
  ctx.font = font; ctx.textBaseline = 'middle';
  function cell(c, r, w, h, col) { ctx.fillStyle = col; ctx.fillRect(c * U, r * U, w * U, h * U); }
  function text(s, x, y, col, align) { ctx.fillStyle = col; ctx.textAlign = align || 'left'; ctx.fillText(s, x, y); }
  if (!cs.length || last < 0) return;

  // the range: the visible candles, padded
  var lo = Infinity, hi = -Infinity, vmax = 0, k;
  for (k = first; k <= last; k++) { var c0 = cs[k]; if (c0.l < lo) lo = c0.l; if (c0.h > hi) hi = c0.h; if (c0.v > vmax) vmax = c0.v; }
  var log = !!d.log && lo > 0;
  var f = log ? Math.log : function (v) { return v; };
  var flo = f(lo), fhi = f(hi);
  if (!(fhi - flo > Math.abs(fhi) * 1e-9)) { var e0 = Math.abs(fhi) * .02 || 1e-9; flo -= e0; fhi += e0; }
  var pad = (fhi - flo) * .08; flo -= pad; fhi += pad;
  if (!log && lo >= 0 && flo < 0) flo = 0;                 // a price or a market cap never goes under nothing
  function row(v) { return top + Math.round((1 - (f(v) - flo) / (fhi - flo)) * (priceR - 1)); }
  function unrow(r) { var fv = flo + (1 - (r - top) / (priceR - 1)) * (fhi - flo); return log ? Math.exp(fv) : fv; }
  var vlo = log ? Math.exp(flo) : flo, vhi = log ? Math.exp(fhi) : fhi;
  function slotOf(i) { var j = last - i, right = plot - RIGHT - j * st; return right - st + Math.floor((st - bw) / 2); }   // the body's left cell
  var volTop = top + priceR + gapR, volBot = volTop + volR;
  var fmt = d.fmt || function (v) { return String(+v.toPrecision(4)); };

  // the candle under the pointer: a dark column behind it
  if (this.hover >= first && this.hover <= last) cell(slotOf(this.hover) - Math.floor((st - bw) / 2), top, st, volBot - top, HEX[2]);

  // the price lines, about every 56 css px
  // the lines' labels share one number of decimals, from the step between them
  var ticks = [], want = Math.max(2, Math.round(priceR * U / dpr / 56)), tfmt0 = fmt;
  if (log && vhi / vlo > 2.5) {
    for (var ex = Math.floor(Math.log10(vlo)); ex <= Math.ceil(Math.log10(vhi)); ex++) [1, 2, 5].forEach(function (m) { var v = m * Math.pow(10, ex); if (v >= vlo && v <= vhi) ticks.push(v); });
  } else {
    var step = nice((vhi - vlo) / want), dec = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
    if (Math.abs(step / Math.pow(10, -dec) - 2.5) < 1e-6) dec++;
    tfmt0 = function (v) { return v.toFixed(Math.min(8, dec)); };
    for (var v = Math.ceil(vlo / step) * step; v <= vhi + step * 1e-9; v += step) ticks.push(v);
  }
  var axX = (plot + 2) * U;
  ticks.forEach(function (v) {
    var r = row(v);
    if (r < top || r > top + priceR - 1) return;
    for (var c = 0; c < plot; c += 3) cell(c, r, 1, 1, HEX[2]);
    text(tfmt0(v), axX, (r + .5) * U, MUTE);
  });

  // the graduation level, while there is one ahead: a cream dotted line, or a word at the top when it is above
  if (d.goal && d.goal.v > 0) {
    var gr = row(d.goal.v);
    if (gr >= top && gr < top + priceR) {
      for (var c2 = 0; c2 < plot; c2 += 4) cell(c2, gr, 2, 1, HEX[7]);
      text(d.goal.label, 4 * dpr, (gr - 2) * U - 5 * dpr, HEX[7]);
    } else if (gr < top) text('↑ ' + d.goal.label, 4 * dpr, 9 * dpr, HEX[7]);
  }

  // the moment it graduated: a cream dotted column
  (d.events || []).forEach(function (ev) {
    if (ev.i < first || ev.i > last) return;
    var cx = slotOf(ev.i) + (bw - 1) / 2;
    for (var r = top; r < volBot; r += 3) cell(cx, r, 1, 2, HEX[7]);
    var tx = (cx + 3) * U, w = ctx.measureText(ev.label).width;
    text(ev.label, tx + w > plot * U ? (cx - 2) * U : tx, top * U + 8 * dpr, HEX[7], tx + w > plot * U ? 'right' : 'left');
  });

  // candles and volume
  for (k = first; k <= last; k++) {
    var c = cs[k], x = slotOf(k), mid = x + (bw - 1) / 2, up = c.c >= c.o;
    if (!c.n) { cell(x, row(c.c), bw, 1, HEX[3]); continue; }
    var col = up ? HEX[6] : HEX[5], rh = row(c.h), rl = row(c.l), ro = row(c.o), rc = row(c.c);
    cell(mid, rh, 1, rl - rh + 1, col);
    cell(x, Math.min(ro, rc), bw, Math.abs(ro - rc) + 1, col);
    if (vmax > 0 && c.v > 0) { var vh = Math.max(1, Math.round(c.v / vmax * volR)); cell(x, volBot - vh, bw, vh, up ? HEX[4] : HEX[3]); }
  }

  // the visitor's own trades: a cream arrow under a candle for a buy, over it for a sell
  (d.marks || []).forEach(function (m) {
    if (m.i < first || m.i > last) return;
    var cc = cs[m.i], mx = slotOf(m.i) + (bw - 1) / 2;
    if (m.buy) { var r1 = Math.min(top + priceR - 1, row(cc.l) + 3); cell(mx, r1, 1, 1, HEX[7]); cell(mx - 1, r1 + 1, 3, 1, HEX[7]); }
    else { var r2 = Math.max(top + 1, row(cc.h) - 3); cell(mx, r2, 1, 1, HEX[7]); cell(mx - 1, r2 - 1, 3, 1, HEX[7]); }
  });

  // the times along the bottom, about every 80 css px, on whole multiples so they do not slide
  var every = Math.max(1, Math.ceil(80 * dpr / (st * U))), tfmt = d.tfmt || String;
  ctx.textAlign = 'center';
  for (k = Math.ceil(first / every) * every; k <= last; k += every) {
    var tx2 = (slotOf(k) + bw / 2) * U;
    if (tx2 < 20 * dpr || tx2 > plot * U - 20 * dpr) continue;
    cell(slotOf(k) + (bw - 1) / 2, volBot + 1, 1, 2, HEX[4]);
    text(tfmt(cs[k].t), tx2, (volBot + timeR / 2 + 2) * U, MUTE, 'center');
  }

  // the newest price, if it is in view: a yellow dotted line and a yellow tag on the axis
  function tag(v, bg, fg) {
    var r = row(v); if (r < top || r > top + priceR - 1) return;
    var h = Math.round(16 * dpr), y = Math.round((r + .5) * U - h / 2);
    ctx.fillStyle = bg; ctx.fillRect(plot * U + U, y, cv.width - plot * U - U, h);
    text(fmt(v), axX, y + h / 2, fg);
  }
  var lc = cs[cs.length - 1].c;
  if (this.off === 0) for (var c3 = 0; c3 < plot; c3 += 2) { var lr = row(lc); if (lr >= top && lr < top + priceR) cell(c3, lr, 1, 1, HEX[6]); }
  tag(lc, HEX[6], HEX[1]);

  // the pointer: a lilac cross and its value on the axis
  if (this.hover >= first && this.hover <= last) {
    var hx = slotOf(this.hover) + (bw - 1) / 2;
    for (var r3 = top; r3 < volBot; r3 += 2) cell(hx, r3, 1, 1, HEX[5]);
    if (this.hy >= top && this.hy < top + priceR) {
      for (var c4 = 0; c4 < plot; c4 += 2) cell(c4, this.hy, 1, 1, HEX[5]);
      tag(unrow(this.hy), HEX[5], HEX[1]);
    }
  }
};

window.NoxChart = NoxChart;
})();
