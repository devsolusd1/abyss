// Property tests for the hook_pool math. Usage: node props.js [runs] [steps] [seed]
'use strict';
const { Pool, LAMPORTS, TOKEN, BPS } = require('./pool');

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
const U64_MAX = (1n << 64n) - 1n;

const stats = { trades: 0, buys: 0, sells: 0, grads: 0, gradOvershootBuys: 0, isoTests: 0, isoCrossGrad: 0,
  isoWorst: null, cycleTests: 0, kDropAtGradMin: 1, maxContinuityGap: 0, roundingChecks: 0, fullExitChecks: 0 };
const fail = (msg, ctx) => { console.error('FAIL:', msg, ctx || ''); process.exit(1); };

function checkInvariants(p, traders, ledger, where) {
  if (p.R < 0n) fail('R < 0', where);
  if (p.T <= 0n) fail('T <= 0', where);
  if (p.lamports !== p.rent + p.R + p.feesOwed()) fail('lamports != rent + R + fees', where);
  const held = traders.reduce((s, t) => s + t.tok, 0n);
  if (held + p.T + p.burned !== p.S) fail('token conservation', { where, held, T: p.T, burned: p.burned, S: p.S });
  const netIn = ledger.solIn - ledger.solOut;
  if (netIn !== p.R + p.feesOwed() + ledger.claimed) fail('SOL conservation', where);
  if (p.phase === 'curve' && p.x() * p.S < p.V * p.T) fail('curve price below opening price', where);
  for (const v of [p.R, p.T, p.lamports, p.feesCreator, p.feesTreasury]) if (v > U64_MAX) fail('u64 overflow', where);
}

// Everyone sells everything right now: the pool must still pay every sell and keep fees + rent.
function fullExit(p, traders, elapsed) {
  const q = p.clone();
  let paid = 0n;
  for (const t of traders) if (t.tok > 0n) paid += q.sell(t.tok, elapsed).out;
  if (q.R < 0n || q.lamports < q.rent + q.feesOwed()) fail('full exit leaves pool short');
  if (q.phase === 'curve' && q.T !== q.S) fail('curve full exit: T != S');
  stats.fullExitChecks++;
  return paid;
}

// A trader alone (nobody else trades) starting and ending with zero tokens must not gain SOL.
function isolationTest(p, elapsed, forceCross) {
  const q = p.clone();
  let solIn = 0n, solOut = 0n, tok = 0n, t = elapsed, crossed = false;
  const n = 1 + Math.floor(rnd() * 12);
  for (let i = 0; i < n; i++) {
    t += BigInt(Math.floor(rnd() * 20));
    if (tok === 0n || rnd() < 0.55 || (forceCross && i === 0)) {
      let amt = logUniform(1n, 3n * q.Rg + 1n);
      if (forceCross && i === 0 && q.phase === 'curve') amt = q.Rg - q.R + logUniform(1n, 2n * q.Rg);
      const r = q.buy(amt, t);
      solIn += amt - r.refund; tok += r.out; crossed = crossed || r.crossed;
    } else {
      const amt = rnd() < 0.3 ? tok : logUniform(1n, tok);
      solOut += q.sell(amt, t).out; tok -= amt;
    }
  }
  if (tok > 0n) solOut += q.sell(tok, t).out;
  stats.isoTests++; if (crossed) stats.isoCrossGrad++;
  const pnl = solOut - solIn;
  if (pnl > 0n) fail('isolated trader made a profit', { pnl, crossed, mode: p.gradMode });
  if (stats.isoWorst === null || pnl > stats.isoWorst) stats.isoWorst = pnl;
}

// A holder sells q tokens and buys back with exactly the SOL received: must not get more than q.
function cycleTest(p, holder, elapsed) {
  if (holder.tok === 0n) return;
  const q = p.clone();
  const amt = logUniform(1n, holder.tok);
  const got = q.sell(amt, elapsed).out;
  if (got === 0n) return;
  const back = q.buy(got, elapsed).out;
  stats.cycleTests++;
  if (back > amt) fail('sell-then-buy-back cycle gained tokens', { amt, back });
}

for (let run = 0; run < RUNS; run++) {
  const V = logUniform(LAMPORTS / 10n, 200n * LAMPORTS);
  const ratio = 1.2 + rnd() * 60;
  const Mg = big(Number(V) * ratio);
  const S = pick([1_000_000n, 1_000_000_000n, 1_000_000_000_000n]) * TOKEN;
  const feeBps = pick([0n, 1n, 25n, 100n, 300n, 1000n]);
  const snipe = rnd() < 0.5;
  const gradMode = pick(['overshoot', 'route', 'refund']);
  const p = new Pool({ V, S, Mg, feeBps, snipeBps: snipe ? 5000n : 0n, snipeSecs: snipe ? BigInt(1 + Math.floor(rnd() * 300)) : 0n, gradMode });
  const traders = Array.from({ length: 8 }, () => ({ tok: 0n }));
  const ledger = { solIn: 0n, solOut: 0n, claimed: 0n };
  let elapsed = 0n, graduated = false;
  checkInvariants(p, traders, ledger, 'start');

  for (let step = 0; step < STEPS; step++) {
    elapsed += BigInt(Math.floor(rnd() * 4));
    const who = pick(traders);
    const before = { phase: p.phase, k: p.k(), x: p.x(), T: p.T, R: p.R };
    const nearGrad = p.phase === 'curve' && p.R * 10n >= p.Rg * 9n;
    let op;
    const roll = rnd();
    if (nearGrad && roll < 0.3) op = 'gradbuy';
    else if (roll < 0.52 || who.tok === 0n) op = 'buy';
    else if (roll < 0.97) op = 'sell';
    else op = 'claim';

    if (op === 'buy' || op === 'gradbuy') {
      let amt;
      if (op === 'gradbuy') amt = p.Rg - p.R + logUniform(1n, 20n * p.Rg);   // overshoot by up to 20x the threshold
      else amt = rnd() < 0.001 ? logUniform(p.Rg, 10n * p.Rg) : logUniform(1n, (p.Rg / 40n) + 1n);
      if (amt > U64_MAX) amt = U64_MAX / 4n;
      const r = p.buy(amt, elapsed);
      who.tok += r.out; ledger.solIn += amt - r.refund;
      stats.buys++;
      // rounding: never more tokens than the exact real-number amount (single-phase buys)
      if (!r.crossed) {
        const net = amt - r.refund - r.fee;
        if (r.out * (before.x + net) > before.T * net) fail('buy rounded in trader favour');
        stats.roundingChecks++;
      }
      if (r.crossed) {
        stats.grads++; graduated = true;
        const e = p.gradEvent;
        const gap = e.Tafter * e.xBefore - e.R * e.Tbefore;          // T' vs exact R*T/x, scaled by x
        if (gap < 0n || gap >= e.xBefore) fail('price jump at graduation', e);
        stats.maxContinuityGap = Math.max(stats.maxContinuityGap, Number(gap) / Number(e.xBefore));
        const kRatio = Number(e.R * e.Tafter) / Number(e.xBefore * e.Tbefore);
        stats.kDropAtGradMin = Math.min(stats.kDropAtGradMin, kRatio);
        if (e.R > p.Rg) stats.gradOvershootBuys++;
        if (p.gradMode !== 'overshoot' && e.R - p.Rg > 2n) fail('capped mode overshot', e);
        // sells right after graduation
        for (let j = 0; j < 5; j++) {
          const h = pick(traders);
          if (h.tok === 0n) continue;
          const amt2 = rnd() < 0.3 ? h.tok : logUniform(1n, h.tok);
          const kb = p.k();
          const s = p.sell(amt2, elapsed);
          h.tok -= amt2; ledger.solOut += s.out;
          if (p.k() < kb) fail('k fell on post-graduation sell');
          checkInvariants(p, traders, ledger, 'post-grad sell');
        }
      } else {
        if (p.k() < before.k) fail('k fell on buy', { before, after: p.k() });
        if (p.x() * before.T < before.x * p.T) fail('price fell on buy');
      }
    } else if (op === 'sell') {
      const amt = rnd() < 0.2 ? who.tok : (rnd() < 0.05 ? 1n : logUniform(1n, who.tok));
      const s = p.sell(amt, elapsed);
      who.tok -= amt; ledger.solOut += s.out;
      stats.sells++;
      if (p.k() < before.k) fail('k fell on sell');
      if (p.x() * before.T > before.x * p.T) fail('price rose on sell');
      if ((s.out + s.fee) * (before.T + amt) > before.x * amt) fail('sell rounded in trader favour');
      stats.roundingChecks++;
    } else {
      ledger.claimed += p.claim(rnd() < 0.5 ? 'creator' : 'treasury');
    }
    stats.trades++; if (p.phase === "curve") stats.curveTrades = (stats.curveTrades || 0) + 1;
    checkInvariants(p, traders, ledger, { run, step, op });

    if (step % 40 === 0) isolationTest(p, elapsed, false);
    if (p.phase === 'curve' && p.R * 2n >= p.Rg && step % 10 === 0) isolationTest(p, elapsed, true);
    if (step % 25 === 0) cycleTest(p, pick(traders), elapsed);
    if (step % 200 === 0) fullExit(p, traders, elapsed);
  }
  fullExit(p, traders, elapsed);
}

console.log('ALL PROPERTIES HELD');
console.log(JSON.stringify(stats, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
