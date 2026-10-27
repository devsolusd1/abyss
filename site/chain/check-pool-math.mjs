// Checks that assets/pool-math.js (the simulator's copy of the program's math) gives the same integers as
// chain/src/index.mjs on random pools, and that a simulated market keeps every token: `node site/chain/check-pool-math.mjs`
// (after `npm install` in site/chain).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const site = fileURLToPath(new URL("..", import.meta.url));
globalThis.window = globalThis;
new Function(readFileSync(site + "assets/pool-math.js", "utf8"))();
new Function(readFileSync(site + "assets/sim.js", "utf8"))();
const C = await import("./src/index.mjs");
const PM = window.PoolMath;

let r = 12345, bad = 0;
const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
for (let i = 0; i < 4000; i++) {
  const V = BigInt(Math.floor(1 + rnd() * 999)) * 1000000000n, M = V * BigInt(Math.floor(2 + rnd() * 98));
  const G = PM.graduationSol(V, M);
  if (G !== C.graduationSol(V, M)) bad++;
  const grad = rnd() < 0.3, real = grad ? G + BigInt(Math.floor(rnd() * 1e11)) : BigInt(Math.floor(rnd() * Number(G)));
  const pool = { virtualSol: V, realSol: real, tokens: BigInt(Math.floor(1e14 + rnd() * 8e14)), graduationSol: G, graduated: grad };
  const fee = Math.floor(rnd() * 301), solIn = BigInt(Math.floor(rnd() * 2e11)) + 1n, unitsIn = BigInt(Math.floor(rnd() * 1e14)) + 1n;
  const a = PM.quoteBuy(pool, solIn, fee), b = C.quoteBuy(pool, solIn, fee);
  if (a.fee !== b.fee || a.tokensOut !== b.tokensOut || a.burned !== b.burned || a.after.realSol !== b.after.realSol || a.after.tokens !== b.after.tokens || a.after.graduated !== b.after.graduated) bad++;
  const c = PM.quoteSell(pool, unitsIn, fee), d = C.quoteSell(pool, unitsIn, fee);
  if (c.fee !== d.fee || c.solOut !== d.solOut || c.after.realSol !== d.after.realSol || c.after.tokens !== d.after.tokens) bad++;
  if (PM.priceOf(pool, 5n).price !== C.priceOf(pool, 5n).price) bad++;
}
console.log(`pool-math.js against chain/src: ${bad} mismatches in 4000 pools`);

let lost = 0;
for (const mood of Object.keys(window.NoxSim.MOODS)) {
  const s = window.NoxSim.create({ seed: 7, mood, first: 1000000000n });
  for (let k = 0; k < 1200; k++) s.run(1);
  const held = s.wallets.reduce((x, w) => x + w.tokens, 0n) + s.pool.tokens + s.pool.burned;
  if (held !== PM.SUPPLY) lost++;
  console.log(`${mood}: ${s.trades.length} trades in 20 min, ${(Number(s.pool.realSol) / 1e9).toFixed(2)} SOL in, graduated ${s.pool.graduated}, tokens all accounted for ${held === PM.SUPPLY}`);
}
process.exit(bad || lost ? 1 : 0);
