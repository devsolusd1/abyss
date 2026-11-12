/* Nox DEX: the coin page's candle chart (window.NoxCoinChart), drawn by TradingView's Lightweight Charts
 * (vendor/lightweight-charts-5.3.0.js, Apache-2.0; its licence and notice beside it) in the dark look of a trading
 * terminal: green and red candles on black, the volume under them, the price on the right, the time along the bottom, a
 * cross that follows the pointer with its values on both axes. The chart keeps the library's TradingView logo, which
 * links to tradingview.com, as the licence asks. /sim keeps the pixel chart (assets/chart.js).
 *
 * It is driven as assets/chart.js is:
 *   var ch = new NoxCoinChart(el, { height: css px or a function, onHover(i), onView() })
 *   ch.set({ candles: [{ t, o, h, l, c, v, n }], fmt(value), tick(value, step), stamp(t), log, kind, goal: { v, label, title, col },
 *            events: [{ i, label }], marks: [{ i, buy }], lines: [{ v, label, title, col, word, soft }] }, view)
 *            view, optional: { off } puts the view that many candles back from the newest. The view stays put while new
 *            candles come in if it was dragged back, and follows the newest otherwise. goal is the graduation level;
 *            lines are other levels; a soft one (and the goal) does not stretch the scale: out of view, its words sit
 *            at the top or bottom edge with an arrow. kind names what is shown (series and unit): when it changes, a
 *            price axis dragged by hand fits itself again
 *   ch.zoom(+1 | -1), ch.fit(), ch.latest(), ch.pan(n candles back), ch.following, ch.off, ch.z, ch.resize(), ch.draw()
 *   ch.hover (the candle under the pointer, or -1); ch.select(i) marks a candle from outside (a row of a table), -1 none
 *   onView() is called when the view moves away from the newest candles or back to them
 * The values go to the library times a power of ten (SC), so a price of 0.00000003 SOL scales as well as a market cap;
 * every label divides it back out. Times go in as the visitor's wall clock (the library writes UTC), one second apart at
 * least, so one candle per trade works too. A mouse drags it sideways and ctrl+wheel zooms (the wheel alone scrolls
 * the page); a finger drags it sideways, a pinch zooms and a tap points.
 */
(function () {
'use strict';
var LW = window.LightweightCharts;
var UP = '#26a69a', DOWN = '#ef5350', FLAT = '#4a4e5a', TEXT = '#b2b5be', MUTE = '#787b86', EDGE = '#1e222d', TAG = '#363a45';
var GRID = 'rgba(255, 255, 255, .045)';
var FONT = "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";
var RIGHT = 4, AUTO_MIN = 7, AUTO_MAX = 16, MIN = 2, MAX = 48;   // bars of room after the newest; a bar's width in css px
var TOP = .14, BOT = .24;                              // the price's margins, as shares of the pane: the volume takes the foot
var LOGO = 52;                                         // the library's TradingView logo, 35 px from 10 px in at the foot: words keep clear of it
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function fin(v) { return typeof v === 'number' && isFinite(v); }

// what the library draws besides the series: the candle marked from outside (a band behind it), the moment it
// graduated (a dotted upright), and the words of a level out of view at the edge it is past
function Overlay(ch) {
  var self = this;
  this.ch = ch; this.req = null; this.band = null; this.ups = []; this.edges = [];
  this.views = [
    { zOrder: function () { return 'bottom'; }, renderer: function () { return { draw: function (t) { self.back(t); } }; } },
    { zOrder: function () { return 'top'; }, renderer: function () { return { draw: function (t) { self.front(t); } }; } }];
}
Overlay.prototype.attached = function (p) { this.req = p.requestUpdate; };
Overlay.prototype.detached = function () { this.req = null; };
Overlay.prototype.paneViews = function () { return this.views; };
// the coordinates, worked out when the view moves (the library calls this before it paints)
Overlay.prototype.updateAllViews = function () {
  var ch = this.ch, ts = ch.chart.timeScale(), d = ch.d, n = d.candles.length;
  function x(i) { return i >= 0 && i < n ? ts.logicalToCoordinate(i) : null; }
  var w = n > 1 ? Math.abs((x(1) || 0) - (x(0) || 0)) : 8;
  this.band = ch.sel >= 0 && x(ch.sel) != null ? { x: x(ch.sel), w: Math.max(3, w) } : null;
  this.ups = (d.events || []).map(function (e) { return { x: x(e.i), label: e.label }; }).filter(function (u) { return u.x != null; });
  var edges = [];                                      // the pane's height is the renderer's to know: past it is under
  function edge(v, label, col) { var y = ch.cs.priceToCoordinate(v * ch.SC); if (y != null) edges.push({ y: y, label: label, col: col }); }
  if (d.goal && d.goal.v > 0) edge(d.goal.v, d.goal.label, d.goal.col || ch.goalCol);
  (d.lines || []).forEach(function (ln) { if (ln.v > 0 && ln.soft) edge(ln.v, ln.label, ln.word || ln.col); });
  this.edges = edges;
};
Overlay.prototype.back = function (target) {
  var b = this.band;
  if (!b) return;
  target.useMediaCoordinateSpace(function (s) {
    s.context.fillStyle = 'rgba(255, 255, 255, .07)';
    s.context.fillRect(Math.round(b.x - b.w / 2), 0, Math.round(b.w), s.mediaSize.height);
  });
};
Overlay.prototype.front = function (target) {
  var ups = this.ups, all = this.edges;
  if (!ups.length && !all.length) return;
  target.useMediaCoordinateSpace(function (s) {
    var c = s.context, W = s.mediaSize.width, H = s.mediaSize.height;
    var edges = all.filter(function (e) { return e.y < 0 || e.y > H; }).map(function (e) { return { up: e.y < 0, label: e.label, col: e.col }; });
    c.font = '11px ' + FONT; c.textBaseline = 'middle';
    // a word on a patch of the black, so a candle behind it does not cut it
    function word(t, x, y, col, right) {
      var w = c.measureText(t).width, x0 = right ? x - w : x;
      c.fillStyle = 'rgba(0, 0, 0, .78)'; c.fillRect(x0 - 4, y - 8, w + 8, 16);
      c.fillStyle = col; c.textAlign = 'left'; c.fillText(t, x0, y);
    }
    var past = -Infinity;                              // where the last word ended: a word that would run into it is left out
    ups.slice().sort(function (a, b) { return a.x - b.x; }).forEach(function (u) {
      var x = Math.round(u.x) + .5, w = c.measureText(u.label).width;
      c.strokeStyle = 'rgba(244, 228, 161, .6)'; c.lineWidth = 1; c.setLineDash([2, 3]);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); c.setLineDash([]);
      var right = x + 6 + w > W - 4, x0 = right ? x - 6 - w : x + 6;
      if (x0 - 4 < past) return;
      past = x0 + w + 4;
      word(u.label, x0, x0 - 4 < LOGO ? H - 41 : H - 12, '#f4e4a1');   // at the foot, clear of the legend at the top; over the logo at its corner
    });
    var top = 12, bot = H - 12;
    edges.forEach(function (e) {
      word((e.up ? '↑ ' : '↓ ') + e.label, W - 6, e.up ? top : bot, e.col, true);
      if (e.up) top += 18; else bot -= 18;
    });
  });
};

function NoxCoinChart(el, o) {
  o = o || {};
  var self = this;
  this.el = el; this.o = o;
  this.d = { candles: [], marks: [], events: [], lines: [] };
  this.n = null; this.key = ''; this.auto = true; this.fresh = true; this.bs = AUTO_MIN; this.pend = 0;
  this.hover = -1; this.sel = -1; this.SC = 1; this.times = []; this.at = {}; this.pl = []; this.keep = [];
  this.goalCol = '#f4e4a1'; this.wasF = true;
  el.style.height = this.height() + 'px';
  var ch = this.chart = LW.createChart(el, {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#000' }, textColor: TEXT, fontSize: 11, fontFamily: FONT, attributionLogo: true,
      panes: { separatorColor: EDGE } },
    grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
    crosshair: { mode: 0,                                // it follows the pointer, not the candles' prices
      vertLine: { color: '#758696', width: 1, style: 3, labelBackgroundColor: TAG },
      horzLine: { color: '#758696', width: 1, style: 3, labelBackgroundColor: TAG } },
    rightPriceScale: { borderColor: EDGE, scaleMargins: { top: TOP, bottom: BOT } },   // the volume takes the bottom fifth
    timeScale: { borderColor: EDGE, rightOffset: RIGHT, barSpacing: AUTO_MIN, minBarSpacing: MIN, maxBarSpacing: MAX, fixLeftEdge: true,
      timeVisible: true, secondsVisible: false, tickMarkFormatter: function (t, type) { return self.tickMark(t, type); } },
    localization: { locale: 'en-GB', timeFormatter: function (t) { return self.when(t); } },
    // the wheel is the page's: ctrl+wheel and a sideways swipe are caught below
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } },
    kineticScroll: { mouse: false, touch: true }
  });
  this.cs = ch.addSeries(LW.CandlestickSeries, {
    upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
    priceLineWidth: 1, priceLineStyle: 2,
    priceFormat: { type: 'custom', minMove: 1e-6,
      formatter: function (p) { return self.label(p); },
      tickmarksFormatter: function (ps) { return self.ticks(ps); } },
    // the levels the page keeps in view (not the soft ones, nor the graduation's) widen the scale. The volume's share at
    // the foot is the scale's too, under the lowest candle: it stops at nothing (a price or a market cap never goes under
    // it), so candles that span more than that reach down over the volume, as on a terminal
    autoscaleInfoProvider: function (base) {
      var r = base(), k = self.keep;
      if (!r || !r.priceRange) return r;
      var lo = r.priceRange.minValue, hi = r.priceRange.maxValue;
      k.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
      if (!self.d.log && lo >= 0 && hi > lo) {
        var H = self.paneH(), m = r.margins || {}, T = TOP * H + (m.above || 0), B = BOT * H + (m.below || 0);   // markers add px
        var f = H > T + B ? B / (H - T) : BOT / (1 - TOP);   // at the pane's foot the scale reads lo - (hi - lo) B / (H - T - B)
        if (lo < hi * f) lo = hi * f;
      }
      return { priceRange: { minValue: lo, maxValue: hi }, margins: r.margins };
    }
  });
  this.vs = ch.addSeries(LW.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false, baseLineVisible: false });
  ch.priceScale('vol').applyOptions({ scaleMargins: { top: .8, bottom: 0 }, visible: false });
  this.mk = LW.createSeriesMarkers(this.cs, []);
  this.ov = new Overlay(this); this.cs.attachPrimitive(this.ov);

  ch.subscribeCrosshairMove(function (p) { self.point(p); });
  // a tap on a phone: the cross goes where the finger was (a mouse has it there already)
  ch.subscribeClick(function (p) {
    var k = self.kAt(p);
    if (k < 0 || k === self.hover) return;
    var y = p.point ? self.cs.coordinateToPrice(p.point.y) : null;
    try { ch.setCrosshairPosition(y != null ? y : self.d.candles[k].c * self.SC, self.times[k], self.cs); } catch (e) {}
    self.setHover(k);
  });
  // the chart's width known or changed (a page laid out while hidden, a phone turned): the candles fit it again
  ch.timeScale().subscribeSizeChange(function () { if (self.auto) self.fitBars(); });
  ch.timeScale().subscribeVisibleLogicalRangeChange(function () {
    // a bar width the page did not ask for is a pinch or a drag on the time axis: the zoom is set by hand, new candles
    // no longer pick it, and − and + go on from it
    var s = self.spacing();
    if (!self.pend && s && Math.abs(s - self.bs) / self.bs > .01) { self.auto = false; self.bs = s; }
    var f = self.following;
    if (f !== self.wasF) { self.wasF = f; if (o.onView) o.onView(); }
  });
  // a trackpad sends many small wheel events: they add up, a step of zoom per 60 px of pinch, a candle of pan per
  // candle's width of swipe
  var zAcc = 0, xAcc = 0;
  el.addEventListener('wheel', function (e) {
    var unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zAcc += e.deltaY * unit;
      while (zAcc <= -60) { self.zoom(1); zAcc += 60; }
      while (zAcc >= 60) { self.zoom(-1); zAcc -= 60; }
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5) {
      e.preventDefault();
      xAcc += e.deltaX * unit;
      var w = self.spacing() || 8, n = xAcc < 0 ? Math.ceil(xAcc / w) : Math.floor(xAcc / w);
      if (n) { self.pan(-n); xAcc -= n * w; }
    }
  }, { passive: false });
}

NoxCoinChart.prototype.height = function () { var h = this.o.height; return typeof h === 'function' ? h() : h || 380; };
// the candles' pane in css px, the axis under it left out (0 before it is laid out)
NoxCoinChart.prototype.paneH = function () { try { return this.chart.paneSize(0).height || 0; } catch (e) { return 0; } };
// the width of a bar as last drawn, in css px (the time scale's options carry the one in use, a pinch's too)
NoxCoinChart.prototype.spacing = function () { return +this.chart.timeScale().options().barSpacing || 0; };
// candles hidden past the right edge: 0 while the newest is in view
Object.defineProperty(NoxCoinChart.prototype, 'off', { get: function () {
  if (!this.d.candles.length) return 0;
  return Math.max(0, Math.round(-this.chart.timeScale().scrollPosition()));
} });
Object.defineProperty(NoxCoinChart.prototype, 'following', { get: function () { return this.off === 0; } });
Object.defineProperty(NoxCoinChart.prototype, 'z', { get: function () { return Math.round(this.bs * 10) / 10; } });

// labels: the page's own formats, on the values divided back by SC. The axis's lines share one number of digits,
// from the step between them (none on a log scale, whose steps differ). Under nothing (an axis dragged down by hand)
// there is no label
NoxCoinChart.prototype.label = function (p) { var v = p / this.SC, f = this.d.fmt; return p < 0 ? '' : f ? f(v) : String(+v.toPrecision(4)); };
NoxCoinChart.prototype.ticks = function (ps) {
  var self = this, step = null;
  if (!this.d.log) for (var i = 1; i < ps.length; i++) { var s = Math.abs(ps[i] - ps[i - 1]) / this.SC; if (s > 0 && (step == null || s < step)) step = s; }
  return ps.map(function (p) { return p < 0 ? '' : self.d.tick ? self.d.tick(p / self.SC, step) : self.label(p); });
};
// the times along the bottom, on the visitor's clock: the year, the month, the day where they change, else the hour
NoxCoinChart.prototype.tickMark = function (t, type) {
  var d = new Date(t * 1000), m = MONTHS[d.getUTCMonth()];
  return type === 0 ? String(d.getUTCFullYear()) : type === 1 ? m : type === 2 ? d.getUTCDate() + ' ' + m : pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
};
// the cross's time: the candle's own, in the page's words
NoxCoinChart.prototype.when = function (t) {
  var k = this.at[t], c = k != null ? this.d.candles[k] : null;
  if (c && this.d.stamp) return this.d.stamp(c.t);
  var d = new Date(t * 1000); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
};

NoxCoinChart.prototype.kAt = function (p) {
  var n = this.d.candles.length;
  if (!p || !p.point || p.time == null || p.logical == null) return -1;
  var k = Math.round(p.logical);
  return k >= 0 && k < n ? k : -1;
};
NoxCoinChart.prototype.point = function (p) { this.setHover(this.kAt(p)); };
NoxCoinChart.prototype.setHover = function (k) {
  if (k === this.hover) return;
  this.hover = k;
  if (this.o.onHover) this.o.onHover(k);
};

NoxCoinChart.prototype.set = function (d, view) {
  for (var k in d) this.d[k] = d[k];
  var cs = this.d.candles || [], n = cs.length, ts = this.chart.timeScale();
  var grew = this.n != null && d.candles ? n - this.n : 0, was = this.off;   // the list can be the same array, grown
  var off = this.fresh ? 0 : view && view.off != null ? view.off : was > 0 && grew > 0 ? was + grew : was;   // dragged back: the same candles stay in view
  this.n = n;
  if (this.sel >= n) this.sel = -1;
  if (this.hover >= n) this.setHover(-1);
  // a power of ten that puts the biggest value between 1 and 10,000, kept while it stays between 0.1 and 100,000
  var top = 0;
  cs.forEach(function (c) { if (fin(c.h) && c.h > top) top = c.h; });
  (this.d.lines || []).forEach(function (ln) { if (fin(ln.v) && ln.v > top) top = ln.v; });
  var m = top * this.SC;
  if (top > 0 && !(m >= .1 && m < 1e5)) this.SC = Math.pow(10, 2 - Math.floor(Math.log10(top)));
  var SC = this.SC;
  // the series, set again only when the candles changed (a quote typed in the panel draws the chart again)
  var key = n ? [n, SC, cs[0].t, cs[0].o, cs[0].c, cs[n - 1].t, cs[n - 1].o, cs[n - 1].h, cs[n - 1].l, cs[n - 1].c, cs[n - 1].v, cs[n - 1].n].join('|') : '0';
  if (key !== this.key) {
    this.key = key;
    var bars = [], vols = [], at = {}, times = [], prev = -Infinity;
    cs.forEach(function (c, i) {
      var t = Math.floor(c.t - new Date(c.t * 1000).getTimezoneOffset() * 60);
      if (!(t > prev)) t = prev + 1;                       // one candle per trade: two trades in one second
      prev = t; times.push(t); at[t] = i;
      if (!(fin(c.o) && fin(c.h) && fin(c.l) && fin(c.c))) { bars.push({ time: t }); vols.push({ time: t }); return; }
      var b = { time: t, open: c.o * SC, high: c.h * SC, low: c.l * SC, close: c.c * SC };
      if (!c.n) b.color = b.borderColor = b.wickColor = FLAT;   // an interval with no trade: a grey dash at the last price
      bars.push(b);
      // no trade, no bar: a zero would still be drawn a pixel high, a dotted line across a quiet stretch
      vols.push(c.v > 0 ? { time: t, value: c.v, color: c.c >= c.o ? 'rgba(38, 166, 154, .45)' : 'rgba(239, 83, 80, .45)' } : { time: t });
    });
    this.times = times; this.at = at;
    this.cs.setData(bars); this.vs.setData(vols);
  }
  // the price axis dragged by hand stays where it was put (a double click fits it again), until what the chart shows
  // changes: another series, unit, scale or power of ten
  var ps = this.chart.priceScale('right'), mode = [SC, !!this.d.log, this.d.kind || ''].join('|');
  ps.applyOptions(mode !== this.mode ? { mode: this.d.log ? 1 : 0, autoScale: true } : { mode: this.d.log ? 1 : 0 });
  this.mode = mode;
  // the visitor's own trades: an arrow under a candle for a buy, over it for a sell, one of each per candle at most
  var self = this, seen = {}, marks = [];
  (this.d.marks || []).forEach(function (mk) {
    var id = mk.i + (mk.buy ? 'b' : 's');
    if (mk.i < 0 || mk.i >= n || seen[id]) return;
    seen[id] = 1;
    marks.push({ time: self.times[mk.i], position: mk.buy ? 'belowBar' : 'aboveBar', shape: mk.buy ? 'arrowUp' : 'arrowDown', color: '#f4e4a1', size: 1 });
  });
  marks.sort(function (a, b) { return a.time - b.time; });
  this.mk.setMarkers(marks);
  this.levels();
  if (this.auto) this.fitBars();
  if (this.fresh) { this.fresh = false; ts.scrollToPosition(RIGHT, false); }
  else if (off > 0) ts.scrollToPosition(-off, false);
  else if (was === 0 && this.off > 0) ts.scrollToPosition(RIGHT, false);   // it was following: it still is
  this.draw();
};
// the levels: a line across with its words and its value on the axis while it is in view (the overlay writes the
// words of a soft one out of view at the edge)
NoxCoinChart.prototype.levels = function () {
  var self = this, SC = this.SC, d = this.d, keep = [];
  this.pl.forEach(function (l) { self.cs.removePriceLine(l); });
  this.pl = [];
  function line(v, title, col, style) {
    self.pl.push(self.cs.createPriceLine({ price: v * SC, color: col, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title,
      axisLabelColor: col, axisLabelTextColor: '#000' }));
  }
  if (d.goal && d.goal.v > 0) line(d.goal.v, d.goal.title || d.goal.label, d.goal.col || this.goalCol, 1);
  (d.lines || []).forEach(function (ln) {
    if (!(ln.v > 0)) return;
    line(ln.v, ln.title || ln.label, ln.col || TEXT, 2);
    if (!ln.soft) keep.push(ln.v * SC);
  });
  this.keep = keep;
};
// as wide as the candles fit, from AUTO_MIN to AUTO_MAX px: a young coin's few candles fill the chart from the left
NoxCoinChart.prototype.fitBars = function () {
  var w = this.chart.timeScale().width(), n = this.d.candles.length;
  if (!(w > 0)) return;
  var s = Math.max(AUTO_MIN, Math.min(AUTO_MAX, n ? w / (n + RIGHT + 1) : AUTO_MAX));
  this.ask(Math.round(s * 10) / 10);
};
// a bar width asked of the library, which takes it on its next frame (its options say the old one until then, and a
// scroll meanwhile reports the view with it): pend, until two frames on, when bs becomes what it took. bs is the width
// asked last, or the one a pinch left. The library keeps a bar under half the chart's width
NoxCoinChart.prototype.ask = function (s) {
  var self = this;
  s = Math.max(MIN, Math.min(MAX, this.chart.timeScale().width() / 2 || MAX, s));
  this.bs = s; this.pend = (this.pend || 0) + 1;
  this.chart.timeScale().applyOptions({ barSpacing: s });
  requestAnimationFrame(function () { requestAnimationFrame(function () { if (--self.pend === 0) self.bs = self.spacing() || self.bs; }); });
  return s;
};
NoxCoinChart.prototype.zoom = function (dir) {
  this.auto = false;
  return this.ask(dir > 0 ? this.bs * 1.4 : this.bs / 1.4);
};
NoxCoinChart.prototype.pan = function (n) { var ts = this.chart.timeScale(); ts.scrollToPosition(ts.scrollPosition() - n, false); };
NoxCoinChart.prototype.latest = function () { this.chart.timeScale().scrollToPosition(RIGHT, false); };
// back to the newest candles, as wide as they fit. For a new set of candles (another interval, another coin): the next
// set() starts the count of new candles afresh
NoxCoinChart.prototype.fit = function () {
  this.auto = true; this.n = null; this.fresh = true; this.fitBars(); this.latest();
  this.chart.priceScale('right').applyOptions({ autoScale: true });
};
NoxCoinChart.prototype.select = function (k) { k = k == null || k < 0 ? -1 : k; if (k !== this.sel) { this.sel = k; this.draw(); } };
NoxCoinChart.prototype.resize = function () {
  var h = this.height() + 'px';
  if (this.el.style.height !== h) this.el.style.height = h;   // the width follows the box by itself (autoSize)
  if (this.auto) this.fitBars();
};
NoxCoinChart.prototype.draw = function () { if (this.ov.req) this.ov.req(); };

window.NoxCoinChart = LW ? NoxCoinChart : null;
})();
