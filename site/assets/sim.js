/* Nox: a coin in the browser (window.NoxSim). One pool on the program's own math (assets/pool-math.js), a wallet
 * of play SOL for the visitor, who launched the coin, and a crowd of made-up traders who buy and sell on the
 * simulation's clock. Nothing here talks to a chain. The crowd is seeded: the same seed and the same clicks at
 * the same moments give the same market.
 *
 *   var s = NoxSim.create({ name, symbol, virtualSol, graduationMcap (lamports, BigInt), feeBps,
 *                           wallet (lamports, 100 SOL), first (lamports: the visitor's buy at launch), seed, mood })
 *   s.pool       { virtualSol, realSol, tokens, graduationSol, graduated, burned, feeBps, volume, creatorFees, treasuryFees }
 *   s.t          seconds since launch on the simulation's clock
 *   s.trades     [{ n, t, w (wallet index), buy, sol, tokens, fee, price, mcap, graduates, burned }]: sol, tokens, fee and
 *                burned BigInt; price (SOL per whole token) and mcap (SOL) Numbers, after the trade
 *   s.wallets    [{ name, sol, tokens, spent, got, you, whale }]; index 0 is the visitor
 *   s.buy(w, lamports), s.sell(w, units)   a trade now: the trade, or { error }
 *   s.run(dt)    moves the clock dt seconds; the crowd trades on the way; gives the trades made
 *   s.mood       quiet | steady | hype | panic (s.setMood); s.whale() a big buy; s.dump() the biggest holder sells all
 *   s.holders()  wallets holding tokens, most first; s.on(fn) fn(trade) after every trade
 *   NoxSim.launchPrice(s), NoxSim.MOODS
 */
(function () {
'use strict';
var PM = window.PoolMath;
var SHARE = 5000n;                        // the platform's half of each fee, as the devnet config has it
var MIN_TRADE = 10000n;                   // lamports: below this the pages call a trade too small
var MAX_WALLETS = 600;

// trades a minute, the chance a trade is a buy, the typical buy in SOL, the chance a sell is the whole bag
var MOODS = {
  quiet:  { rate: 2.5, buy: .54, size: .25, dump: .3 },
  steady: { rate: 8,   buy: .56, size: .5,  dump: .35 },
  hype:   { rate: 22,  buy: .7,  size: 1.1, dump: .3 },
  panic:  { rate: 15,  buy: .3,  size: .4,  dump: .7 }
};
var RUSH = 40;                            // seconds after launch when the first buyers pile in

function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function lam(n) { return Number(n) / 1e9; }
function toLam(sol) { return BigInt(Math.max(0, Math.round(sol * 1e9))); }

function create(o) {
  o = o || {};
  var V = BigInt(o.virtualSol != null ? o.virtualSol : PM.LAUNCH.virtualSol);
  var M = BigInt(o.graduationMcap != null ? o.graduationMcap : PM.LAUNCH.graduationMcap);
  var fee = o.feeBps != null ? Number(o.feeBps) : PM.LAUNCH.feeBps;
  var seed = (o.seed != null ? Number(o.seed) : Math.floor(Math.random() * 2147483647)) | 0;
  var rand = mulberry(seed);
  function gauss() { var u = rand() || 1e-9, v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function key() { var s = ''; for (var i = 0; i < 8; i++) s += B58[Math.floor(rand() * 58)]; return s.slice(0, 4) + '…' + s.slice(4); }

  var s = {
    name: o.name || 'MOTE', symbol: o.symbol || 'MOTE', seed: seed, t: 0, mood: MOODS[o.mood] ? o.mood : 'steady',
    pool: { virtualSol: V, realSol: 0n, tokens: PM.SUPPLY, graduationSol: PM.graduationSol(V, M), graduated: false, burned: 0n,
      feeBps: fee, graduationMcap: M, volume: 0n, creatorFees: 0n, treasuryFees: 0n },
    trades: [], wallets: [], gradAt: null, rand: rand
  };
  var fns = [], next = null, ema = 0;

  function wallet(sol, whale) { s.wallets.push({ name: key(), sol: toLam(sol), tokens: 0n, spent: 0n, got: 0n, you: false, whale: !!whale }); return s.wallets.length - 1; }
  s.wallets.push({ name: 'you', sol: o.wallet != null ? BigInt(o.wallet) : 100n * PM.LAMPORTS, tokens: 0n, spent: 0n, got: 0n, you: true, whale: false });
  function newcomer() { return wallet(Math.min(250, Math.max(.08, Math.exp(Math.log(2.2) + 1.05 * gauss())))); }
  for (var i = 0; i < 60; i++) newcomer();
  for (var j = 0; j < 4; j++) wallet(40 + rand() * 160, true);

  function reserves() { var p = s.pool; return { virtualSol: p.virtualSol, realSol: p.realSol, tokens: p.tokens, graduationSol: p.graduationSol, graduated: p.graduated }; }
  function priceNow() { return PM.priceOf(reserves(), s.pool.burned).price; }
  ema = priceNow();
  function split(f) { var toT = f * SHARE / 10000n; s.pool.treasuryFees += toT; s.pool.creatorFees += f - toT; }
  function record(tr) {
    var pr = PM.priceOf(reserves(), s.pool.burned);
    tr.n = s.trades.length; tr.t = s.t; tr.price = pr.price; tr.mcap = pr.marketCap;
    s.trades.push(tr);
    ema = ema * .9 + pr.price * .1;
    for (var k = 0; k < fns.length; k++) fns[k](tr);
    return tr;
  }

  s.quoteBuy = function (lamports) { return PM.quoteBuy(reserves(), BigInt(lamports), s.pool.feeBps); };
  s.quoteSell = function (units) { return PM.quoteSell(reserves(), BigInt(units), s.pool.feeBps); };
  s.price = priceNow;
  s.marketCap = function () { return PM.priceOf(reserves(), s.pool.burned).marketCap; };

  s.buy = function (w, lamports) {
    var W = s.wallets[w]; lamports = BigInt(lamports);
    if (!W) return { error: 'No such wallet.' };
    if (lamports < MIN_TRADE) return { error: 'Too small to trade.' };
    if (lamports > W.sol) return { error: 'Not enough SOL.' };
    var q = s.quoteBuy(lamports);
    if (q.tokensOut <= 0n) return { error: 'Too small to trade.' };
    var p = s.pool, a = q.after;
    p.realSol = a.realSol; p.tokens = a.tokens; p.graduated = a.graduated; p.burned += q.burned; p.volume += lamports;
    split(q.fee);
    W.sol -= lamports; W.tokens += q.tokensOut; W.spent += lamports;
    if (q.graduates) s.gradAt = s.t;
    return record({ w: w, buy: true, sol: lamports, tokens: q.tokensOut, fee: q.fee, graduates: q.graduates, burned: q.burned });
  };
  s.sell = function (w, units) {
    var W = s.wallets[w]; units = BigInt(units);
    if (!W) return { error: 'No such wallet.' };
    if (units <= 0n) return { error: 'Too small to trade.' };
    if (units > W.tokens) return { error: 'Not that many tokens.' };
    var q = s.quoteSell(units);
    if (q.solOut <= 0n) return { error: 'Too small to trade.' };
    var p = s.pool;
    p.realSol = q.after.realSol; p.tokens = q.after.tokens; p.volume += q.solOut + q.fee;
    split(q.fee);
    W.tokens -= units; W.sol += q.solOut; W.got += q.solOut;
    return record({ w: w, buy: false, sol: q.solOut, tokens: units, fee: q.fee, graduates: false, burned: 0n });
  };

  /* ---------- the crowd ---------- */
  function holdersOf(bots) {
    var out = [];
    for (var i = bots ? 1 : 0; i < s.wallets.length; i++) if (s.wallets[i].tokens > 0n) out.push(i);
    return out;
  }
  function crowdBuy(m, big) {
    var w = -1, tries = 0;
    if (big) {
      for (var i = 1; i < s.wallets.length; i++) if (s.wallets[i].whale && (w < 0 || s.wallets[i].sol > s.wallets[w].sol)) w = i;
    } else if (rand() < .14 && s.wallets.length < MAX_WALLETS) w = newcomer();
    while (w < 0 && tries++ < 12) { var c = 1 + Math.floor(rand() * (s.wallets.length - 1)); if (s.wallets[c].sol > 20000000n) w = c; }
    if (w < 0) { if (s.wallets.length >= MAX_WALLETS) return null; w = newcomer(); }
    var W = s.wallets[w], size = big ? 15 + rand() * 25 : m.size * Math.exp(.9 * gauss());
    if (!big && W.whale && rand() < .3) size *= 4 + rand() * 8;
    var amt = Math.min(size, lam(W.sol) - .01);
    if (amt < .005) return null;
    var r = s.buy(w, toLam(amt));
    return r.error ? null : r;
  }
  function crowdSell(m, holders, all) {
    // the bigger the bag and the further it is up, the likelier it sells
    var px = priceNow(), weights = [], sum = 0, i;
    for (i = 0; i < holders.length; i++) {
      var W = s.wallets[holders[i]], val = Number(W.tokens) / 1e6 * px, cost = lam(W.spent) - lam(W.got);
      var up = cost > 0 ? Math.max(0, val / cost - 1) : 1;
      var wt = Math.sqrt(val + .01) * (1 + Math.min(4, up));
      weights.push(wt); sum += wt;
    }
    var pick = rand() * sum, at = 0;
    for (i = 0; i < weights.length; i++) { pick -= weights[i]; if (pick <= 0) { at = i; break; } }
    var w = holders[at], tokens = s.wallets[w].tokens;
    var frac = all || rand() < m.dump ? 1 : rand() < .5 ? .5 : .25;
    var units = frac === 1 ? tokens : BigInt(Math.floor(Number(tokens) * frac));
    var r = s.sell(w, units);
    return r.error ? null : r;
  }
  function crowdTrade() {
    var m = MOODS[s.mood], holders = holdersOf(true), px = priceNow();
    var mom = ema > 0 ? px / ema - 1 : 0, chase = Math.max(-.16, Math.min(.16, mom * 2.2));
    var pb = m.buy + (s.mood === 'panic' ? -chase * .5 : chase);
    if (s.t < RUSH && s.mood !== 'panic') pb = Math.max(pb, .88);
    if (!holders.length || rand() < pb) return crowdBuy(m, false);
    return crowdSell(m, holders, false);
  }
  function rate() {
    var m = MOODS[s.mood], r = m.rate / 60;
    if (s.t < RUSH && s.mood !== 'quiet') r *= 3;
    return r;
  }
  s.run = function (dt) {
    var end = s.t + Math.max(0, dt), made = [];
    while (true) {
      if (next == null) next = s.t + -Math.log(rand() || 1e-9) / rate();
      if (next > end) break;
      s.t = next; next = null;
      var tr = crowdTrade(); if (tr) made.push(tr);
    }
    s.t = end;
    return made;
  };
  s.setMood = function (md) { if (MOODS[md] && md !== s.mood) { s.mood = md; next = null; } };
  s.whale = function () { return crowdBuy(MOODS[s.mood], true); };
  s.dump = function () {
    var holders = holdersOf(true), top = -1;
    holders.forEach(function (w) { if (top < 0 || s.wallets[w].tokens > s.wallets[top].tokens) top = w; });
    return top < 0 ? null : (function () { var r = s.sell(top, s.wallets[top].tokens); return r.error ? null : r; })();
  };
  s.holders = function () { return holdersOf(false).sort(function (a, b) { var d = s.wallets[b].tokens - s.wallets[a].tokens; return d > 0n ? 1 : d < 0n ? -1 : 0; }); };
  s.on = function (fn) { fns.push(fn); };

  if (o.first && BigInt(o.first) > 0n) s.buy(0, BigInt(o.first));
  return s;
}

function launchPrice(s) { return lam(s.pool.virtualSol) / 1e9; }   // SOL per whole token at launch: V over the 1B made

window.NoxSim = { create: create, MOODS: MOODS, launchPrice: launchPrice };
})();
