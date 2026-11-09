// The numbers of the one curve with the user's choices (30 SOL virtual, line at 420 SOL of market cap, 1e9 tokens),
// next to what the first version did at the line. Usage: node numbers.js
'use strict';
const { Pool, first, LAMPORTS, TOKEN } = require('./pool');

const sol = (l) => (Number(l) / 1e9).toFixed(4);
const mtok = (b) => (Number(b) / 1e6 / 1e6).toFixed(2) + ' M';
// price in SOL per million tokens, and market cap in SOL on a given supply
const perMillion = (x, T) => (Number(x) / 1e9) / (Number(T) / 1e6) * 1e6;
const mcap = (x, T, supply) => (Number(x) * Number(supply) / Number(T) / 1e9).toFixed(2);
const S = 1_000_000_000n * TOKEN;
const base = { V: 30n * LAMPORTS, S, Mg: 420n * LAMPORTS };

console.log('=== At the line, no fee ===');
const p = new Pool({ ...base, feeBps: 0n });
const r = p.buy(p.Rg);
console.log('real SOL', sol(p.R), '| pool tokens', mtok(p.T), '| sold', mtok(r.out), '| x', sol(p.x()),
  '| price', perMillion(p.x(), p.T).toFixed(4), 'SOL per million | market cap', mcap(p.x(), p.T, S), 'SOL | graduated', p.graduated);

console.log('\n=== 10 SOL at the line ===');
{
  const q = p.clone();
  const before = perMillion(q.x(), q.T);
  q.buy(10n * LAMPORTS);
  const now = perMillion(q.x(), q.T);
  // the first version: a plain pool of the real SOL and what was left after the burn, at the same price
  const old = first.buy({ V: base.V, R: 0n, T: S, Rg: p.Rg, graduated: false }, p.Rg, 0n).after;
  const oldBefore = perMillion(old.R, old.T);
  const o = first.buy(old, 10n * LAMPORTS, 0n).after;
  console.log('price moves', ((now / before - 1) * 100).toFixed(1) + '% on the curve;',
    ((perMillion(o.R, o.T) / oldBefore - 1) * 100).toFixed(1) + '% in the first version\'s pool after the burn');
  console.log('the first version burned', mtok(S - old.T - r.out), '| its market cap on what was left', mcap(old.R, old.T, S - (S - old.T - r.out)), 'SOL');
}

console.log('\n=== Everyone sells it all back from the line, in one sell ===');
for (const [feeBps, shareBps] of [[0n, 2000n], [100n, 2000n], [100n, 0n]]) {
  // to the line with no fee, so each starts from the same 82.25 SOL
  const q = new Pool({ ...base, feeBps: 0n, shareBps });
  const held = q.buy(q.Rg).out;
  q.feeBps = feeBps;
  const before = q.clone();
  const s = q.sell(held);
  console.log(`fee ${feeBps} bps, ${shareBps / 100n}% kept: sellers get ${sol(s.out)} of ${sol(before.R)} real SOL;`,
    `left ${sol(q.R)} SOL, price / opening = ${(Number(q.x()) / Number(q.T) / (Number(base.V) / Number(S))).toFixed(6)}`);
}

console.log('\n=== A fifth of the fee in the pool: 1,000 round trips of 1 SOL at 1% ===');
{
  const q = new Pool({ ...base, feeBps: 100n });
  q.buy(40n * LAMPORTS);
  const start = q.R;
  for (let i = 0; i < 1000; i++) q.sell(q.buy(LAMPORTS).out);
  console.log('real SOL grew by', sol(q.R - start), 'SOL; owed to creator and treasury', sol(q.feesOwed()), 'SOL');
}

// The line is the market cap on the whole supply. The pool's part of every fee joins the real SOL without taking tokens
// out, so k grows and the price at the same real SOL (x²/k) is lower: the coin crosses at 420 whatever came before, and
// it takes more real SOL to get there. Measured on the real SOL, as until 2026-11-09, the line came at a lower market
// cap (419.6, 385.8, 290.2 and 149.3 SOL here for 1%).
console.log('\n=== Where the line is crossed, after round trips of 10 SOL (buy, then sell it all) ===');
for (const [feeBps, shareBps] of [[100n, 2000n], [300n, 2000n], [100n, 0n]]) {
  const row = [];
  for (const trips of [0, 500, 2000, 5000]) {
    const q = new Pool({ ...base, feeBps, shareBps });
    q.buy(10n * LAMPORTS);                  // the holders
    let volume = 10n * LAMPORTS;
    let by = null;                          // where the round trips alone carried it past the line
    for (let i = 0; i < trips && !q.graduated; i++) {
      const b = q.buy(10n * LAMPORTS);
      if (q.graduated && by === null) by = i + 1;
      const s = q.sell(b.out);
      volume += 10n * LAMPORTS + s.out + s.fee;   // the buy, and the sale's gross
    }
    let before = null;                      // the market cap before the buy of 0.5 SOL that crossed
    while (!q.graduated) { before = q.mcap(); q.buy(LAMPORTS / 2n); volume += LAMPORTS / 2n; }
    row.push(`${q.mcap().toFixed(2)}` + (before == null ? '' : ` (${before.toFixed(2)} before the buy that crossed)`) +
      ` with ${sol(q.R)} real SOL, after ${(Number(volume) / 1e9).toFixed(0)} SOL of volume` +
      (by ? ` (the round trips alone took it there: the ${by}th's buy crossed, and the fees it kept held it)` : ''));
  }
  console.log(`fee ${feeBps} bps, ${shareBps / 100n}% kept:\n  ${row.join(';\n  ')}`);
}
