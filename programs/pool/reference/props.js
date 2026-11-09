// Property tests for the pool math: one curve for life, a part of every fee kept in the pool, the coin graduated while
// its market cap on the whole supply is at the line, and pools the first version graduated held to its integers.
// Usage: node props.js [runs] [steps] [seed]
'use strict';
const { Pool, ZeroOut, first, LAMPORTS, TOKEN, U64_MAX } = require('./pool');

const RUNS = Number(process.argv[2] || 60);
const STEPS = Number(process.argv[3] || 3000);
let seed = Number(process.argv[4] || 12345) >>> 0;
function rnd() {                                   // mulberry32
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const big = (f) => BigInt(Math.floor(f));
const logUniform = (lo, hi) => { // BigInt in [lo, hi], log-uniform
  const v = Math.exp(Math.log(Number(lo)) + rnd() * (Math.log(Number(hi)) - Math.log(Number(lo))));
  let b = big(v); if (b < lo) b = lo; if (b > hi) b = hi; return b;
};
// A trade the program would refuse as dust gives null; anything else that throws is a failure.
const attempt = (f) => { try { return f(); } catch (e) { if (e instanceof ZeroOut) return null; throw e; } };

const stats = { trades: 0, buys: 0, sells: 0, dust: 0, crossingsUp: 0, crossingsDown: 0, legacyRuns: 0, legacyTrades: 0,
  isoTests: 0, isoCrossed: 0, isoWorst: null, cycleTests: 0, roundingChecks: 0, fullExitChecks: 0, keptInPool: 0n,
  lineBuys: 0, lineBuysShort: 0, volumeTrips: 0, volumeMcapAtOldLine: null, volumeMcapAtLine: null };
const fail = (msg, ctx) => { console.error('FAIL:', msg, ctx || ''); process.exit(1); };

// The rule written out again: graduated while x·S ≥ M·T (the market cap on the whole supply at the line chosen at
// launch or above it), and for good in a pool the first version graduated, which reads a line of 0.
const atTheLine = (p) => p.legacy() || p.x() * p.S >= p.Mg * p.T;

function checkInvariants(p, traders, ledger, where) {
  if (p.R < 0n) fail('R < 0', where);
  if (p.T <= 0n) fail('T <= 0', where);
  if (p.T > p.S - p.burned) fail('token reserve past the supply', where);
  if (p.lamports !== p.rent + p.R + p.feesOwed()) fail('lamports != rent + R + fees owed', where);
  const held = traders.reduce((s, t) => s + t.tok, 0n);
  if (held + p.T + p.burned !== p.S) fail('token conservation', { where, held, T: p.T, burned: p.burned, S: p.S });
  const netIn = ledger.solIn - ledger.solOut;
  if (netIn !== p.R + p.feesOwed() + ledger.claimed - ledger.startR) fail('SOL conservation', where);
  if (!p.legacy() && p.x() * p.S < p.V * p.T) fail('price below the opening price', where);
  if (p.graduated !== atTheLine(p) || p.graduated !== p.overTheLine()) fail('graduated is not x·S >= M·T', where);
  if (p.legacy() && !p.graduated) fail('a pool the first version graduated fell back under its line', where);
  for (const v of [p.R, p.T, p.lamports, p.feesCreator, p.feesTreasury]) if (v > U64_MAX) fail('u64 overflow', where);
}

// Everyone sells everything right now: no sell is refused but dust, and the pool keeps its rent and the fees owed.
function fullExit(p, traders) {
  const q = p.clone();
  let paid = 0n;
  for (const t of traders) {
    if (t.tok === 0n) continue;
    const s = attempt(() => q.sell(t.tok));
    if (s) paid += s.out; else stats.dust++;
  }
  if (q.R < 0n || q.lamports < q.rent + q.feesOwed()) fail('full exit leaves the pool short');
  if (!q.legacy() && q.x() * q.S < q.V * q.T) fail('full exit: price below the opening price');
  stats.fullExitChecks++;
  return paid;
}

// A trader alone (nobody else trades) starting and ending with zero tokens must not gain SOL.
function isolationTest(p, forceCross) {
  const q = p.clone();
  let solIn = 0n, solOut = 0n, tok = 0n, crossed = false;
  const n = 1 + Math.floor(rnd() * 12);
  for (let i = 0; i < n; i++) {
    if (tok === 0n || rnd() < 0.55 || (forceCross && i === 0)) {
      let amt = logUniform(1n, 3n * q.Rg + 1n);
      if (forceCross && i === 0 && !q.graduated) amt = ((q.lineSol() - q.R) * 11n) / 10n + logUniform(1n, 2n * q.Rg);
      const r = attempt(() => q.buy(amt));
      if (!r) continue;
      solIn += amt; tok += r.out; crossed = crossed || r.graduates;
    } else {
      const amt = rnd() < 0.3 ? tok : logUniform(1n, tok);
      const s = attempt(() => q.sell(amt));
      if (!s) continue;
      solOut += s.out; tok -= amt;
    }
  }
  if (tok > 0n) { const s = attempt(() => q.sell(tok)); if (s) solOut += s.out; }
  stats.isoTests++; if (crossed) stats.isoCrossed++;
  const pnl = solOut - solIn;
  if (pnl > 0n) fail('isolated trader made a profit', { pnl, crossed });
  if (stats.isoWorst === null || pnl > stats.isoWorst) stats.isoWorst = pnl;
}

// A holder sells q tokens and buys back with exactly the SOL received: must not get more than q.
function cycleTest(p, holder) {
  if (holder.tok === 0n) return;
  const q = p.clone();
  const amt = logUniform(1n, holder.tok);
  const s = attempt(() => q.sell(amt));
  if (!s) return;
  const b = attempt(() => q.buy(s.out));
  stats.cycleTests++;
  if (b && b.out > amt) fail('sell-then-buy-back cycle gained tokens', { amt, back: b.out });
}

// A pool graduated by the first version: the curve stopped at the line and burned, the rest went through its plain
// pool. Returns the pool as the program reads it after the upgrade, with its old twin and the holders' tokens.
function graduatedByTheFirstVersion(params) {
  const p = new Pool({ ...params, shareBps: 0n });
  const opened = { V: p.V, R: 0n, T: p.S, Rg: p.Rg, graduated: false };
  const amt = p.Rg * 2n + logUniform(1n, p.Rg) + LAMPORTS;
  const b = first.buy(opened, amt, p.feeBps);
  p.R = b.after.R; p.T = b.after.T; p.burned = b.burned; p.graduated = true;
  p.lamports += amt; p.owe(b.fee);
  return { p, old: b.after, bought: b.out, paid: amt };
}

for (let run = 0; run < RUNS; run++) {
  const V = logUniform(LAMPORTS / 10n, 200n * LAMPORTS);
  const ratio = 2 + rnd() * 60;
  const Mg = big(Number(V) * ratio);
  const S = pick([1_000_000n, 1_000_000_000n, 1_000_000_000_000n]) * TOKEN;
  const feeBps = pick([0n, 1n, 25n, 100n, 300n]);
  // mostly the fifth every new coin keeps; also none (a coin launched before it) and all of it
  const shareBps = pick([2000n, 2000n, 2000n, 0n, 10_000n]);
  const legacy = run % 6 === 5;
  const traders = Array.from({ length: 8 }, () => ({ tok: 0n }));
  const ledger = { solIn: 0n, solOut: 0n, claimed: 0n, startR: 0n };
  let p, old = null;
  if (legacy) {
    const g = graduatedByTheFirstVersion({ V, S, Mg, feeBps });
    ({ p, old } = g);
    traders[0].tok = g.bought; ledger.solIn = g.paid;
    stats.legacyRuns++;
  } else {
    p = new Pool({ V, S, Mg, feeBps, shareBps });
    // One buy of exactly the line's real SOL into the pool just launched, with no fee: on the line, or a hair under it
    // where the token reserve it leaves is rounded up, by less than one base unit at the line's price. A lamport less
    // is always under it.
    const q = new Pool({ V, S, Mg, feeBps: 0n, shareBps }), less = q.clone();
    q.buy(q.Rg); less.buy(less.Rg - 1n);
    if (q.R !== q.Rg || q.graduated !== atTheLine(q) || q.x() * q.S + q.Mg <= q.Mg * q.T) fail('a buy of the line\'s real SOL', { V, Mg, S });
    if (less.graduated) fail('a lamport less than the line\'s real SOL graduated', { V, Mg, S });
    stats.lineBuys++; if (!q.graduated) stats.lineBuysShort++;
  }
  checkInvariants(p, traders, ledger, 'start');
  // stretches of mostly buys, then of mostly sells, so the walk crosses the line both ways
  const stretch = 100 + Math.floor(rnd() * 400);

  for (let step = 0; step < STEPS; step++) {
    const who = pick(traders);
    const before = { k: p.k(), x: p.x(), T: p.T, R: p.R, graduated: p.graduated };
    const buying = Math.floor(step / stretch) % 2 === 0 ? rnd() < 0.7 : rnd() < 0.3;
    const roll = rnd();
    const op = roll < 0.02 ? 'claim' : (buying || who.tok === 0n ? 'buy' : 'sell');

    if (op === 'buy') {
      let amt = rnd() < 0.002 ? logUniform(p.Rg, 10n * p.Rg) : logUniform(1n, (p.Rg / 20n) + 1n);
      if (!p.graduated && rnd() < 0.05) amt = p.lineSol() - p.R + logUniform(1n, 2n * p.Rg);   // one that crosses
      const r = attempt(() => p.buy(amt));
      if (!r) { stats.dust++; continue; }
      if (old) {
        // the pool the first version graduated: to the integer as that version
        const o = first.buy(old, amt, p.feeBps);
        if (o.out !== r.out || o.fee !== r.fee || o.after.R !== p.R || o.after.T !== p.T || r.toPool !== 0n) {
          fail('first-version pool bought off its old integers', { o, r });
        }
        old = o.after; stats.legacyTrades++;
      }
      who.tok += r.out; ledger.solIn += amt;
      stats.buys++; stats.keptInPool += r.toPool;
      if (r.graduates !== (!before.graduated && p.graduated)) fail('graduates is not the crossing up');
      if (r.graduates) stats.crossingsUp++;
      // rounding: never more tokens than the exact real-number amount
      const rest = amt - r.fee;
      if (r.out * (before.x + rest) > before.T * rest) fail('buy rounded in trader favour');
      stats.roundingChecks++;
      if (p.k() < before.k) fail('k fell on buy', { before, after: p.k() });
      if (p.x() * before.T < before.x * p.T) fail('price fell on buy');
    } else if (op === 'sell') {
      const amt = rnd() < 0.2 ? who.tok : (rnd() < 0.05 ? 1n : logUniform(1n, who.tok));
      const o = old && attempt(() => first.sell(old, amt, p.feeBps));
      const s = attempt(() => p.sell(amt));
      if (old && (o === null) !== (s === null)) fail('first-version pool: dust differs', { o, s });
      if (!s) { stats.dust++; continue; }
      if (old) {
        if (o.out !== s.out || o.fee !== s.fee || o.after.R !== p.R || o.after.T !== p.T || s.toPool !== 0n) {
          fail('first-version pool sold off its old integers', { o, s });
        }
        old = o.after; stats.legacyTrades++;
      }
      who.tok -= amt; ledger.solOut += s.out;
      stats.sells++; stats.keptInPool += s.toPool;
      if (p.R > before.R) fail('a sell added real SOL');
      if (!before.graduated && p.graduated) fail('a sell took the coin over the line');
      if (before.graduated && !p.graduated) stats.crossingsDown++;
      if (p.k() < before.k) fail('k fell on sell');
      if (p.x() * before.T > before.x * p.T) fail('price rose on sell');
      if ((s.out + s.fee) * (before.T + amt) > before.x * amt) fail('sell rounded in trader favour');
      stats.roundingChecks++;
    } else {
      ledger.claimed += p.claim(rnd() < 0.5 ? 'creator' : 'treasury');
    }
    stats.trades++;
    checkInvariants(p, traders, ledger, { run, step, op });

    if (step % 40 === 0) isolationTest(p, false);
    if (!p.graduated && step % 10 === 0) isolationTest(p, true);
    if (step % 25 === 0) cycleTest(p, pick(traders));
    if (step % 200 === 0) fullExit(p, traders);
  }
  fullExit(p, traders);
}

// Much volume and little buying: 10 SOL held in a 30 / 420 coin at 1%, then round trips of 10 SOL. A fifth of each fee
// stays in the real SOL, which passes the 82.25 SOL that takes a pool just launched to the line while the market cap is
// still far under 420. The coin is graduated at 420, and not before.
{
  const p = new Pool({ V: 30n * LAMPORTS, S: 1_000_000_000n * TOKEN, Mg: 420n * LAMPORTS, feeBps: 100n });
  p.buy(10n * LAMPORTS);
  let past = null;
  for (let trip = 0; past === null || trip < past + 100; trip++) {
    const b = p.buy(10n * LAMPORTS);
    if (p.graduated || p.mcap() >= 420) fail('a round trip\'s buy graduated the coin', { trip, mcap: p.mcap() });
    p.sell(b.out);
    if (p.graduated || atTheLine(p)) fail('round trips graduated the coin', { trip, mcap: p.mcap() });
    stats.volumeTrips++;
    if (past === null && p.R >= p.Rg) { past = trip; stats.volumeMcapAtOldLine = +p.mcap().toFixed(2); }
    if (trip > 5000) fail('the round trips never took the real SOL past the line');
  }
  for (;;) {
    const before = p.mcap(), r = p.buy(LAMPORTS / 10n);
    if (r.graduates) {
      if (!(before < 420 && p.mcap() >= 420 && p.R > p.Rg + 50n * LAMPORTS)) fail('graduated off the market cap', { before, after: p.mcap() });
      stats.volumeMcapAtLine = +p.mcap().toFixed(2);
      break;
    }
    if (p.graduated) fail('graduated without a crossing');
  }
}

if (stats.crossingsUp < 2 || stats.crossingsDown < 1 || stats.legacyTrades === 0) fail('the walks did not cover the line', stats);
console.log('ALL PROPERTIES HELD');
console.log(JSON.stringify(stats, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
