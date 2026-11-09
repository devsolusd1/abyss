// Checks that assets/pool-math.js (the simulator's copy of the program's math) gives the same integers as
// chain/src/index.mjs on random pools, that the one curve keeps its promises (k never falls, the price never goes under
// the opening price, the token reserve never passes the supply, nobody gains by trading alone, graduated exactly while
// the market cap on the whole supply is at the line, and never by a sell), that the numbers the pages quote for a
// 30 / 420 coin are the math's, where the graduation line is in real SOL as a coin trades (lineSol) and what everyone
// selling leaves in the pool, and that a simulated market keeps every token and every lamport:
// `node site/chain/check-pool-math.mjs` (after `npm install` in site/chain).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const site = fileURLToPath(new URL("..", import.meta.url));
globalThis.window = globalThis;
new Function(readFileSync(site + "assets/pool-math.js", "utf8"))();
new Function(readFileSync(site + "assets/sim.js", "utf8"))();
const C = await import("./src/index.mjs");
const PM = window.PoolMath;

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const SOL = 1_000_000_000n, S = PM.SUPPLY;

let r = 12345;
const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
const big = (n) => BigInt(Math.floor(n));
// the program's rule written out again: x·S ≥ M·T, the market cap on the whole supply at the line or over it
const atTheLine = (p) => p.burned > 0n || (p.virtualSol + p.realSol) * S >= p.graduationMcap * p.tokens;
const mcapOf = (p) => C.priceOf(p).marketCap;

/* ---------- 1. the two copies of the math agree ---------- */
{
  let bad = 0;
  const same = (a, b) => a.fee === b.fee && a.poolFee === b.poolFee && a.after.realSol === b.after.realSol && a.after.tokens === b.after.tokens && a.after.graduated === b.after.graduated;
  for (let i = 0; i < 4000; i++) {
    const V = big(1 + rnd() * 999) * SOL, M = V * big(2 + rnd() * 98);
    const G = PM.graduationSol(V, M);
    if (G !== C.graduationSol(V, M)) bad++;
    // a third of them over the line; one in five graduated under the first rules (tokens burned, its virtual SOL gone)
    const over = rnd() < 0.3, legacy = rnd() < 0.2, burned = legacy ? big(1 + rnd() * 1e14) : 0n;
    const real = over ? G + big(rnd() * 1e11) : big(rnd() * Number(G));
    const share = [0, 2000, 10000, 12000, Math.floor(rnd() * 10001)][Math.floor(rnd() * 5)];
    const pool = { virtualSol: V, realSol: real, tokens: big(1e14 + rnd() * 8e14), graduationSol: G, graduationMcap: M, burned, poolShareBps: share, treasuryShareBps: Math.floor(rnd() * 10001) };
    pool.graduated = atTheLine(pool);
    if (PM.graduatedOf(pool) !== pool.graduated || C.graduatedOf(pool) !== pool.graduated) bad++;
    const fee = Math.floor(rnd() * 301), solIn = big(rnd() * 2e11) + 1n, unitsIn = big(rnd() * 1e14) + 1n;
    const a = PM.quoteBuy(pool, solIn, fee), b = C.quoteBuy(pool, solIn, fee);
    if (!same(a, b) || a.tokensOut !== b.tokensOut || a.graduates !== b.graduates || a.after.graduated !== atTheLine(a.after)) bad++;
    const c = PM.quoteSell(pool, unitsIn, fee), d = C.quoteSell(pool, unitsIn, fee);
    if (!same(c, d) || c.solOut !== d.solOut || c.after.graduated !== atTheLine(c.after) || (!pool.graduated && c.after.graduated)) bad++;
    if (PM.priceOf(pool).price !== C.priceOf(pool).price || PM.priceOf(pool).marketCap !== C.priceOf(pool).marketCap) bad++;
    if (PM.lineSol(pool) !== C.lineSol(pool) || (C.lineSol(pool) == null) !== legacy || PM.progressOf(pool) !== C.progressOf(pool)) bad++;
    // the real SOL at the line for the pool as it stands: the market cap there is the line, and a lamport less is under
    // it (0 for a state no trade reaches, with k under V²·S/M: over the line with no real SOL at all)
    const at = C.lineSol(pool);
    if (!legacy && at > 0n) {
      const T = pool.tokens, k = (V + real) * T;
      if ((V + at) * (V + at) * S < M * k || (V + at - 1n) * (V + at - 1n) * S >= M * k) bad++;
    }
    const f1 = PM.feeParts(a.fee, pool), f2 = C.feeParts(a.fee, pool);
    if (f1.pool !== f2.pool || f1.treasury !== f2.treasury || f1.creator !== f2.creator || f1.pool !== a.poolFee || f1.pool + f1.treasury + f1.creator !== a.fee) bad++;
    // the first rules' pools: no virtual SOL in the math, no part of the fee kept, graduated for good
    if (legacy && (a.poolFee !== 0n || !a.after.graduated || !c.after.graduated || C.curveVirtual(pool) !== 0n)) bad++;
  }
  line(!bad, `pool-math.js against chain/src: ${bad} mismatches in 4000 pools (a fifth from the first rules)`);
}

/* ---------- 2. the numbers of a 30 / 420 coin ---------- */
{
  const launch = (feeBps = 0) => ({ virtualSol: 30n * SOL, realSol: 0n, tokens: S, graduationSol: C.graduationSol(30n * SOL, 420n * SOL), graduationMcap: 420n * SOL, graduated: false, burned: 0n, poolShareBps: C.POOL_SHARE_BPS, treasuryShareBps: 5000, feeBps });
  const p0 = launch(), G = p0.graduationSol, open = C.priceOf(p0).price;
  const at = C.quoteBuy(p0, G, 0), line0 = at.after, px = C.priceOf(line0);
  const short = C.quoteBuy(p0, G - 1n, 0).after, withFee = C.quoteBuy(p0, G, 100).after;
  line(G === 82_249_721_604n && line0.graduated && at.graduates && !short.graduated && !withFee.graduated,
    `the line: a ${C.sol(G).toFixed(2)} SOL buy with no fee takes the market cap to 420 and graduates; a lamport less does not, nor the same SOL with a 1% fee (${mcapOf(withFee).toFixed(2)})`);
  line(Math.abs(C.tokens(line0.tokens) / 1e6 - 267.26) < 0.01, `${(C.tokens(line0.tokens) / 1e6).toFixed(1)}M tokens in the pool there`);
  line(Math.abs(C.sol(C.curveVirtual(line0) + line0.realSol) - 112.25) < 0.005, `the curve's SOL there: ${C.sol(C.curveVirtual(line0) + line0.realSol).toFixed(2)} (30 virtual and the real)`);
  line(Math.abs(px.price * 1e6 - 0.42) < 1e-6 && Math.abs(px.marketCap - 420) < 1e-3, `price ${(px.price * 1e6).toFixed(4)} SOL per 1M, market cap ${px.marketCap.toFixed(2)} SOL: nothing burned, nothing drops`);
  line(C.lineSol(p0) === G && C.progressOf(p0) === 0 && C.progressOf(line0) === 1, `at launch the line is ${C.sol(C.lineSol(p0)).toFixed(2)} real SOL away, the graduation_sol the program writes down`);
  // where V·M is a square: a buy of exactly graduation_sol lands a hair under the line, as math.rs says, and a lamport more on it
  const sq = { ...launch(), virtualSol: 10n * SOL, graduationMcap: 90n * SOL }, g9 = C.graduationSol(10n * SOL, 90n * SOL);
  line(g9 === 20n * SOL && !C.quoteBuy(sq, g9, 0).after.graduated && C.quoteBuy(sq, g9 + 1n, 0).after.graduated,
    `10 / 90: ${C.sol(g9)} SOL leaves the market cap at ${mcapOf(C.quoteBuy(sq, g9, 0).after).toFixed(12)}, under the line; one lamport more graduates`);
  // and where nothing is left to round, on the line itself, which counts as over it: 10 / 40, 10 SOL buy down to half the
  // supply, x·S = M·T; the bar is full and the line is the real SOL in, in each copy
  const eq = { ...launch(), virtualSol: 10n * SOL, graduationMcap: 40n * SOL }, g4 = C.graduationSol(10n * SOL, 40n * SOL);
  for (const [name, L] of [["chain/src", C], ["assets/pool-math.js", PM]]) {
    const on = L.quoteBuy(eq, g4, 0), a = on.after;
    line(g4 === 10n * SOL && a.tokens === S / 2n && (10n * SOL + a.realSol) * S === eq.graduationMcap * a.tokens && on.graduates && a.graduated &&
      L.graduatedOf(a) && L.lineSol(a) === a.realSol && L.progressOf(a) === 1 && !L.graduatedOf({ ...a, tokens: a.tokens + 1n }) && !L.quoteBuy(eq, g4 - 1n, 0).after.graduated,
      `10 / 40 (${name}): ${C.sol(g4)} SOL leaves half the supply in the pool, a market cap of exactly ${mcapOf(a)}, graduated; one token unit more in the pool is under`);
  }
  const ten = C.priceOf(C.quoteBuy(line0, 10n * SOL, 0).after).price / px.price - 1;
  line(Math.abs(ten - 0.186) < 0.001, `10 SOL bought at the line moves the price ${(ten * 100).toFixed(1)}%`);
  // everyone sells, from the line: the sellers take out the real SOL, less the fee, and the price goes back to the
  // opening one; with 20% of the fee kept in the pool, the later sellers get some of that back, and a little SOL stays
  for (const [fee, share, want] of [[0, 2000, 82.25], [100, 0, 81.43], [100, 2000, null]]) {
    let p = { ...line0, poolShareBps: share }, got = 0n;
    const out = S - p.tokens, parts = [out / 3n, out / 3n, out - 2n * (out / 3n)];
    for (const t of parts) { const q = C.quoteSell(p, t, fee); got += q.solOut; p = q.after; }
    const back = C.priceOf(p).price / open - 1;
    line(p.tokens === S && back >= 0 && back < (fee ? 0.01 : 1e-9) && !p.graduated && (want == null ? got > 81_430_000_000n : Math.abs(C.sol(got) - want) < 0.005),
      `${fee / 100}% fee, ${share / 100}% of it kept: everyone sells from the line and gets ${C.sol(got).toFixed(2)} of the ${C.sol(line0.realSol).toFixed(2)} real SOL; the price ends ${(back * 100).toFixed(3)}% over the opening one, ${C.sol(p.realSol).toFixed(4)} SOL left in the pool`);
  }
  const fee = C.feeParts(1_000_000n, { poolShareBps: C.POOL_SHARE_BPS, treasuryShareBps: 5000 });
  line(fee.pool === 200_000n && fee.treasury === 400_000n && fee.creator === 400_000n, `a fee of 0.001 SOL: ${C.sol(fee.creator)} creator, ${C.sol(fee.treasury)} platform, ${C.sol(fee.pool)} stays in the pool`);
  const t3750 = C.feeParts(1_000_000n, { poolShareBps: C.POOL_SHARE_BPS, treasuryShareBps: 3750 });
  line(t3750.creator === 500_000n && t3750.treasury === 300_000n, `with the config's treasury share at 3,750 the creator keeps half: ${C.sol(t3750.creator)} creator, ${C.sol(t3750.treasury)} platform`);
}

/* ---------- 2b. as a coin trades: where the line is in real SOL, and what everyone selling leaves ---------- */
// 40 SOL bought, then 100 round trips of 5 SOL under the line at a 1% fee: 1,000 SOL traded (README.md's example)
for (const share of [C.POOL_SHARE_BPS, 0]) {
  const V = 30n * SOL, M = 420n * SOL, G = C.graduationSol(V, M);
  let p = C.quoteBuy({ virtualSol: V, realSol: 0n, tokens: S, graduationSol: G, graduationMcap: M, graduated: false, burned: 0n, poolShareBps: share, treasuryShareBps: 5000 }, 40n * SOL, 100).after;
  for (let i = 0; i < 100; i++) { const b = C.quoteBuy(p, 5n * SOL, 100); p = C.quoteSell(b.after, b.tokensOut, 100).after; }
  const said = C.lineSol(p), k = (V + p.realSol) * p.tokens, open = C.priceOf({ virtualSol: V, realSol: 0n, tokens: S }).price;
  // everyone sells: the price ends at k/S² or over it (the sells' own pool part), and that much real SOL stays
  let all = p;
  const out = S - p.tokens;
  for (const t of [out / 2n, out - out / 2n]) all = C.quoteSell(all, t, 100).after;
  const stays = k / S - V, end = C.priceOf(all).price, floor = C.sol(V + p.realSol) * C.tokens(p.tokens) / C.tokens(S) ** 2;   // coin.html's floorPrice
  // the climb to the line in 0.01 SOL buys: graduated flips where the market cap reaches 420, at about the real SOL said
  let up = p, below = p;
  while (!up.graduated) { below = up; up = C.quoteBuy(up, SOL / 100n, 100).after; }
  const at = up.realSol;
  line(mcapOf(below) < 420 && mcapOf(up) >= 420 && Math.abs(Number(at) / Number(said) - 1) < 0.002
    && (share ? said > G + SOL && said < G + 3n * SOL && all.realSol >= stays && stays > SOL / 2n && end >= floor * (1 - 1e-12) && floor > open * 1.02
      : said - G < SOL / 100n && all.realSol < 1000n && Math.abs(end / open - 1) < 1e-8),
    `${share / 100}% of the fee kept, 1,000 SOL traded: the line is ${C.sol(said).toFixed(2)} real SOL in (${C.sol(G).toFixed(2)} at launch), graduated flips at ${C.sol(at).toFixed(2)}, ` +
    `the market cap going from ${mcapOf(below).toFixed(2)} to ${mcapOf(up).toFixed(2)}; everyone sells and ${C.sol(all.realSol).toFixed(4)} real SOL stays, the price ${((end / open - 1) * 100).toFixed(2)}% over the opening one`);
}

/* ---------- 2c. much volume and little buying: no graduation before the market cap ---------- */
// 10 SOL held, then round trips of 10 SOL at 1%: the real SOL passes the 82.25 that takes a pool just launched to the
// line while the market cap is far under 420. Measured on the real SOL, as until 2026-11-09, the coin graduated there.
{
  const V = 30n * SOL, M = 420n * SOL, G = C.graduationSol(V, M);
  let p = C.quoteBuy({ virtualSol: V, realSol: 0n, tokens: S, graduationSol: G, graduationMcap: M, graduated: false, burned: 0n, poolShareBps: C.POOL_SHARE_BPS, treasuryShareBps: 5000 }, 10n * SOL, 100).after;
  let trips = 0, early = 0, past = null;
  while (past == null || trips < past + 100) {
    const b = C.quoteBuy(p, 10n * SOL, 100), s = C.quoteSell(b.after, b.tokensOut, 100);
    if (b.after.graduated || s.after.graduated || atTheLine(b.after) || atTheLine(s.after)) early++;
    p = s.after; trips++;
    if (past == null && p.realSol >= G) past = trips;
    if (trips > 5000) break;
  }
  const real = p.realSol, capThen = mcapOf(p), lineNow = C.lineSol(p), barNow = C.progressOf(p);
  let below = p;
  while (!p.graduated) { below = p; p = C.quoteBuy(p, SOL / 10n, 100).after; }
  line(past != null && !early && capThen < 170 && real > G && lineNow > real && barNow < 0.7 && mcapOf(below) < 420 && mcapOf(p) >= 420 && p.realSol > G + 50n * SOL,
    `${trips} round trips of 10 SOL: ${C.sol(real).toFixed(2)} real SOL in, past the ${C.sol(G).toFixed(2)} of launch after ${past}, at a ${capThen.toFixed(2)} SOL market cap: ` +
    `not graduated (${early} early), the bar at ${(barNow * 100).toFixed(1)}% of the ${C.sol(lineNow).toFixed(2)} real SOL the line needs now; buys graduate it at ${mcapOf(p).toFixed(2)}, ${C.sol(p.realSol).toFixed(2)} real SOL in`);
}

/* ---------- 3. the curve's promises, on random markets ---------- */
{
  let kFell = 0, under = 0, over = 0, gained = 0, refused = 0, trades = 0, flips = 0, sellUp = 0;
  for (let round = 0; round < 300; round++) {
    const V = big(1 + rnd() * 500) * SOL, M = V * big(2 + rnd() * 60), fee = Math.floor(rnd() * 301);
    let p = { virtualSol: V, realSol: 0n, tokens: S, graduationSol: C.graduationSol(V, M), graduationMcap: M, graduated: false, burned: 0n, poolShareBps: rnd() < 0.5 ? C.POOL_SHARE_BPS : 0, treasuryShareBps: 5000 };
    if (round % 2) p = C.quoteBuy(p, big(rnd() * 2 * Number(p.graduationSol)) + 1_000_000n, fee).after;   // someone bought first
    let paid = 0n, got = 0n, held = 0n;
    const step = (q, k0, was) => {
      const x = C.curveVirtual(q.after) + q.after.realSol;
      if (x * q.after.tokens < k0) kFell++;
      if (x * S < V * q.after.tokens) under++;                // the price x/T at least V/S
      if (q.after.tokens > S) over++;
      if (q.after.graduated !== atTheLine(q.after)) flips++;   // graduated exactly while x·S ≥ M·T
      if (q.solOut != null && !was.graduated && q.after.graduated) sellUp++;
      trades++;
    };
    for (let i = 0; i < 40; i++) {
      const k0 = (C.curveVirtual(p) + p.realSol) * p.tokens;
      if (held === 0n || rnd() < 0.5) {
        const amount = big(rnd() * Number(p.graduationSol)) + 1000n, q = C.quoteBuy(p, amount, fee);
        if (q.tokensOut === 0n) continue;
        step(q, k0, p); paid += amount; held += q.tokensOut; p = q.after;
      } else {
        const amount = 1n + big(rnd() * Number(held)), q = C.quoteSell(p, amount, fee);
        if (q.solOut === 0n) { refused++; continue; }
        step(q, k0, p); got += q.solOut; held -= amount; p = q.after;
      }
    }
    if (held > 0n) { const k0 = (C.curveVirtual(p) + p.realSol) * p.tokens, q = C.quoteSell(p, held, fee); if (q.solOut > 0n) { step(q, k0, p); got += q.solOut; p = q.after; } }
    if (got > paid) gained++;
  }
  line(!kFell && !under && !over && !flips && !sellUp, `${trades} trades: k fell ${kFell} times, the price went under the opening one ${under}, the reserve past the supply ${over}, graduated off the market cap's line ${flips}, by a sell ${sellUp}`);
  line(!gained, `300 traders alone on a pool: ${gained} took out more than they put in (${refused} dust sells refused)`);
}

/* ---------- 4. a simulated market keeps every token and every lamport ---------- */
for (const mood of Object.keys(window.NoxSim.MOODS)) {
  const s = window.NoxSim.create({ seed: 7, mood, first: 1000000000n });
  let crossed = 0;
  s.on((tr) => { if (tr.graduates) crossed++; });
  for (let k = 0; k < 1200; k++) s.run(1);
  const p = s.pool, held = s.wallets.reduce((x, w) => x + w.tokens, 0n) + p.tokens;
  const net = s.wallets.reduce((x, w) => x + w.spent - w.got, 0n), owed = p.realSol + p.creatorFees + p.treasuryFees;
  const live = p.graduated === atTheLine({ ...p, burned: 0n }) && (p.graduated || mcapOf(p) < Number(p.graduationMcap) / 1e9);
  line(held === S && net === owed && live && (p.poolFees === 0n || p.realSol > 0n),
    `${mood}: ${s.trades.length} trades in 20 min, ${C.sol(p.realSol).toFixed(2)} SOL in (${C.sol(p.poolFees).toFixed(4)} of it the pool's part of the fees), graduated ${p.graduated}${crossed ? ` (crossed up ${crossed}×)` : ""}; tokens all accounted for ${held === S}, SOL ${net === owed}`);
}
process.exit(failed ? 1 : 0);
