// Checks the draft's worked example and the large-overshoot case.
'use strict';
const { Pool, LAMPORTS, TOKEN, BPS, ceilDiv } = require('./pool');

const sol = (l) => (Number(l) / 1e9).toFixed(4);
const mtok = (b) => (Number(b) / 1e6 / 1e6).toFixed(4) + ' M';
const pct = (a, b) => (100 * Number(a) / Number(b)).toFixed(3) + '%';
// market cap on a given supply, in SOL: price x/T times supply
const mcap = (x, T, supply) => (Number(x) * Number(supply) / Number(T) / 1e9).toFixed(3);

const base = { V: 30n * LAMPORTS, S: 1_000_000_000n * TOKEN, Mg: 420n * LAMPORTS, feeBps: 100n };

console.log('=== Draft example: V=30 SOL, Mg=420 SOL, S=1e9, fee 1% ===');
{
  const V = 30, M = 420, S = 1e9;
  const xg = Math.sqrt(M * V);
  console.log('float: x_g', xg.toFixed(6), 'R_g', (xg - V).toFixed(6), 'T_g', (V * S / xg / 1e6).toFixed(4), 'M',
    'sold', ((S - V * S / xg) / 1e6).toFixed(4), 'M', 'burn', (V * S / xg * V / xg / 1e6).toFixed(4), 'M =', (100 * V / M).toFixed(4) + '%',
    "T'", ((xg - V) * (V * S / xg) / xg / 1e6).toFixed(4), 'M');
  const p = new Pool({ ...base });
  console.log('int: Rg =', p.Rg, 'lamports =', sol(p.Rg), 'SOL');
  // gross needed so that net == Rg at 1%
  let g = ceilDiv(p.Rg * BPS, BPS - 100n);
  while (g - ceilDiv(g * 100n, BPS) < p.Rg) g++;
  const r = p.buy(g, 1000n);
  const e = p.gradEvent;
  console.log('one buy of', sol(g), 'SOL gross (fee', sol(r.fee), ') -> tokens out', mtok(r.out), 'crossed', r.crossed);
  console.log('at graduation: x', sol(e.xBefore), 'R', sol(e.R), 'T', mtok(e.Tbefore), 'burn', mtok(e.burn), '(', pct(e.burn, base.S), ')',
    "T'", mtok(e.Tafter));
  console.log('mcap on S before burn', mcap(e.xBefore, e.Tbefore, base.S), 'SOL; after burn on S', mcap(e.R, e.Tafter, base.S),
    '; on circulating supply S-burn', mcap(e.R, e.Tafter, base.S - e.burn));
  console.log('price continuity: T\'*x - R*T =', e.Tafter * e.xBefore - e.R * e.Tbefore, '(must be in [0, x) =', e.xBefore, ')');
  console.log('k before', e.xBefore * e.Tbefore, 'k after', e.R * e.Tafter, 'ratio', (Number(e.R * e.Tafter) / Number(e.xBefore * e.Tbefore)).toFixed(4));
  // If every holder sells back after graduation: final price vs opening price
  const q = p.clone();
  const held = base.S - q.T - q.burned;
  const s = q.sell(held, 1000n);
  console.log('everyone sells', mtok(held), 'after graduation -> pool R', sol(q.R), 'price/opening price =',
    (Number(q.R) / Number(q.T) / (Number(base.V) / Number(base.S))).toFixed(4));
  // Same on the curve (no graduation): selling everything back returns R to ~0
  const c = new Pool({ ...base, Mg: 10_000n * LAMPORTS });
  const b = c.buy(g, 1000n);
  c.sell(b.out, 1000n);
  console.log('curve only, buy then sell all back: R left', c.R, 'lamports, price/opening =',
    (Number(c.x()) / Number(c.T) / (Number(base.V) / Number(base.S))).toFixed(9));
}

console.log('\n=== Many 1-SOL buys to graduation (last buy overshoots a little) ===');
{
  const p = new Pool({ ...base });
  let n = 0, last;
  while (p.phase === 'curve') { last = p.buy(1n * LAMPORTS, 1000n); n++; }
  const e = p.gradEvent;
  console.log('buys', n, 'R at grad', sol(e.R), 'overshoot', sol(e.R - p.Rg), 'burn', pct(e.burn, base.S), 'mcap on S', mcap(e.xBefore, e.Tbefore, base.S));
}

console.log('\n=== One 500 SOL buy at launch ===');
for (const [name, extra, t] of [
  ['overshoot, 1% fee', { gradMode: 'overshoot' }, 1000n],
  ['overshoot, anti-sniper 50% at t=0', { gradMode: 'overshoot', snipeBps: 5000n, snipeSecs: 180n }, 0n],
  ['route (cap curve leg, rest via AMM), 1%', { gradMode: 'route' }, 1000n],
  ['refund (cap curve leg, refund rest), 1%', { gradMode: 'refund' }, 1000n],
]) {
  const p = new Pool({ ...base, ...extra });
  const r = p.buy(500n * LAMPORTS, t);
  const e = p.gradEvent;
  console.log(`-- ${name}`);
  console.log('  buyer gets', mtok(r.out), '(', pct(r.out, base.S), 'of supply ), fee', sol(r.fee), 'refund', sol(r.refund));
  console.log('  at grad: R', sol(e.R), 'x', sol(e.xBefore), 'mcap on S', mcap(e.xBefore, e.Tbefore, base.S), 'SOL, burn', mtok(e.burn), '(', pct(e.burn, base.S), ')');
  console.log("  continuity: T'*x - R*T =", e.Tafter * e.xBefore - e.R * e.Tbefore, '< x');
  console.log('  after the buy: R', sol(p.R), 'T', mtok(p.T), 'price x/T (SOL per token)', (Number(p.R) / Number(p.T) * 1e6 / 1e9).toExponential(4),
    'mcap on S-burn', mcap(p.R, p.T, base.S - p.burned));
  const q = p.clone();
  const back = q.sell(r.out, 1000n);
  console.log('  buyer sells it all straight back: gets', sol(back.out), 'SOL of', sol(500n * LAMPORTS - r.refund), 'paid');
}

console.log('\n=== Who pays for an overshoot? Holders bought 80 SOL net on the curve, then one 500 SOL buy, then holders exit first ===');
for (const mode of ['overshoot', 'route', 'refund']) {
  const p = new Pool({ ...base, gradMode: mode });
  let hIn = 0n, hTok = 0n;
  while (p.R + LAMPORTS < 80n * LAMPORTS) { const r = p.buy(LAMPORTS, 1000n); hIn += LAMPORTS; hTok += r.out; }
  const w = p.buy(500n * LAMPORTS, 1000n);
  const hOut = p.sell(hTok, 1000n).out;
  const wOut = p.sell(w.out, 1000n).out;
  console.log(`${mode.padEnd(9)} holders paid ${sol(hIn)} got ${sol(hOut)} (pnl ${sol(hOut - hIn)}); whale paid ${sol(500n * LAMPORTS - w.refund)} for ${mtok(w.out)}, exits with ${sol(wOut)} (pnl ${sol(wOut - 500n * LAMPORTS + w.refund)}); burned ${pct(p.burned, base.S)}`);
}
console.log('\n=== Same, but the whale exits first ===');
for (const mode of ['overshoot', 'route', 'refund']) {
  const p = new Pool({ ...base, gradMode: mode });
  let hIn = 0n, hTok = 0n;
  while (p.R + LAMPORTS < 80n * LAMPORTS) { const r = p.buy(LAMPORTS, 1000n); hIn += LAMPORTS; hTok += r.out; }
  const w = p.buy(500n * LAMPORTS, 1000n);
  const wOut = p.sell(w.out, 1000n).out;
  const hOut = p.sell(hTok, 1000n).out;
  console.log(`${mode.padEnd(9)} whale pnl ${sol(wOut - 500n * LAMPORTS + w.refund)}; holders pnl ${sol(hOut - hIn)}`);
}
