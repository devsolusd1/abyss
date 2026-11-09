/* Nox: the pool program's math in the browser (window.PoolMath), without the chain code.
 *
 * The same integers as programs/pool/src/math.rs and site/chain/src/index.mjs (quoteBuy, quoteSell, priceOf):
 * a page that only needs the numbers, like the simulator, loads this and not the 330 KB chain bundle.
 * Units: lamports and token units (6 decimals) as BigInt; priceOf gives Numbers (SOL per whole token, SOL).
 *
 * One constant-product curve for the coin's whole life, on virtual + real SOL: the virtual SOL never leaves and
 * nothing is burned. Graduation is the market cap on the whole supply at the line chosen at launch or over it. 20% of
 * each fee (POOL_SHARE_BPS) stays in the pool's real SOL. A pool that graduated under the program's first rules
 * (burned > 0) trades on its real SOL alone, stays graduated and keeps no part of the fee.
 *
 *   PoolMath.quoteBuy(r, lamportsIn, feeBps)  { fee, poolFee, tokensOut, graduates, after }
 *   PoolMath.quoteSell(r, unitsIn, feeBps)    { fee, poolFee, solOut, after }
 *   PoolMath.priceOf(r, burned)               { price, marketCap }
 *   PoolMath.feeParts(fee, r)                 { pool, treasury, creator }: a fee as the program shares it
 *   PoolMath.graduatedOf(r)                   the market cap at the line or over it, x·S ≥ M·T, as the program has it
 *   PoolMath.graduationSol(virtualSol, mcap)  the real SOL that takes a pool just launched to its line (for reading)
 *   PoolMath.lineSol(r)                       the real SOL at the line for the pool as it stands (null: no line)
 *   PoolMath.progressOf(r)                    0..1 of the way there: the real SOL against lineSol, 1 while graduated
 *   r is { virtualSol, realSol, tokens, graduationMcap, graduated, burned, poolShareBps, treasuryShareBps }, as chain.js
 *   reads a pool.
 */
(function () {
'use strict';

var LAMPORTS = 1000000000n;
var SUPPLY = 1000000000n * 1000000n;
var LAUNCH = { virtualSol: 30n * LAMPORTS, graduationMcap: 420n * LAMPORTS, feeBps: 100 };
var BOUNDS = { minVirtualSol: LAMPORTS, maxVirtualSol: 1000n * LAMPORTS, minMultiple: 2n, maxMultiple: 100n, maxFeeBps: 300 };
var POOL_SHARE_BPS = 2000;

function ceilDiv(a, b) { return (a + b - 1n) / b; }
function feeOf(amount, bps) { return ceilDiv(amount * BigInt(bps), 10000n); }

function isqrtCeil(n) {
  if (n < 2n) return n;
  var x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x * x === n ? x : x + 1n;
}
function graduationSol(virtualSol, mcap) { return isqrtCeil(virtualSol * mcap) - virtualSol; }

function isLegacy(r) { return r.burned > 0n; }
function curveVirtual(r) { return isLegacy(r) ? 0n : r.virtualSol; }
function poolShareOf(r) { return isLegacy(r) ? 0 : Math.min(10000, Number(r.poolShareBps) || 0); }
function graduatedOf(r) { return isLegacy(r) || (r.graduationMcap != null && (curveVirtual(r) + r.realSol) * SUPPLY >= r.graduationMcap * r.tokens); }
// x² = M·k/S, rounded up, less the virtual SOL: where the pool as it stands reaches its line, were only buys to come
// and none of their fee kept. graduationSol at launch; more as the pool's part of each fee lifts k
function lineSol(r) {
  if (isLegacy(r) || r.graduationMcap == null) return null;
  var x = isqrtCeil(ceilDiv(r.graduationMcap * (r.virtualSol + r.realSol) * r.tokens, SUPPLY));
  return x > r.virtualSol ? x - r.virtualSol : 0n;
}
function progressOf(r) {
  if (r.graduated) return 1;
  var to = lineSol(r);
  return to ? Math.min(1, Number(r.realSol) / Number(to)) : 0;
}
function feeParts(fee, r) {
  fee = BigInt(fee);
  var pool = fee * BigInt(poolShareOf(r)) / 10000n, rest = fee - pool, treasury = rest * BigInt(Number(r.treasuryShareBps) || 0) / 10000n;
  return { pool: pool, treasury: treasury, creator: rest - treasury };
}

function leg(sol, tokens, solIn) {
  var left = ceilDiv(sol * tokens, sol + solIn);
  return [tokens - left, left];
}

function quoteBuy(r, solIn, feeBps) {
  solIn = BigInt(solIn);
  var fee = feeOf(solIn, feeBps), poolFee = fee * BigInt(poolShareOf(r)) / 10000n, rest = solIn - fee;
  var o = leg(curveVirtual(r) + r.realSol, r.tokens, rest);
  var after = Object.assign({}, r, { realSol: r.realSol + rest + poolFee, tokens: o[1] });
  after.graduated = graduatedOf(after);
  return { fee: fee, poolFee: poolFee, tokensOut: o[0], graduates: !(isLegacy(r) || r.graduated) && after.graduated, after: after };
}

// the price never ends higher than it was: a sell never graduates a coin
function quoteSell(r, tokensIn, feeBps) {
  tokensIn = BigInt(tokensIn);
  var offset = curveVirtual(r), x = offset + r.realSol, tokens = r.tokens + tokensIn;
  var newX = ceilDiv(x * r.tokens, tokens);
  if (newX < offset) newX = offset;
  var gross = x - newX, fee = feeOf(gross, feeBps), poolFee = fee * BigInt(poolShareOf(r)) / 10000n;
  var after = Object.assign({}, r, { realSol: newX - offset + poolFee, tokens: tokens });
  after.graduated = graduatedOf(after);
  return { fee: fee, poolFee: poolFee, solOut: gross - fee, after: after };
}

function priceOf(r, burned) {
  if (burned == null) burned = r.burned || 0n;
  var price = (Number(curveVirtual(r) + r.realSol) / 1e9) / (Number(r.tokens) / 1e6);
  return { price: price, marketCap: price * (Number(SUPPLY - burned) / 1e6) };
}

window.PoolMath = {
  LAMPORTS: LAMPORTS, SUPPLY: SUPPLY, LAUNCH: LAUNCH, BOUNDS: BOUNDS, POOL_SHARE_BPS: POOL_SHARE_BPS,
  feeOf: feeOf, isqrtCeil: isqrtCeil, graduationSol: graduationSol, isLegacy: isLegacy, curveVirtual: curveVirtual,
  poolShareOf: poolShareOf, graduatedOf: graduatedOf, lineSol: lineSol, progressOf: progressOf, feeParts: feeParts,
  quoteBuy: quoteBuy, quoteSell: quoteSell, priceOf: priceOf
};
})();
