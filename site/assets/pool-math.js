/* Nox: the pool program's math in the browser (window.PoolMath), without the chain code.
 *
 * The same integers as programs/pool/src/math.rs and site/chain/src/index.mjs (quoteBuy, quoteSell, priceOf):
 * a page that only needs the numbers, like the simulator, loads this and not the 330 KB chain bundle.
 * Units: lamports and token units (6 decimals) as BigInt; priceOf gives Numbers (SOL per whole token, SOL).
 *
 *   PoolMath.quoteBuy(r, lamportsIn, feeBps)  { fee, tokensOut, burned, graduates, after }
 *   PoolMath.quoteSell(r, unitsIn, feeBps)    { fee, solOut, after }
 *   PoolMath.priceOf(r, burned)               { price, marketCap }
 *   PoolMath.graduationSol(virtualSol, mcap)  the real SOL in the pool when it graduates
 *   r is { virtualSol, realSol, tokens, graduationSol, graduated }, as chain.js reads a pool.
 */
(function () {
'use strict';

var LAMPORTS = 1000000000n;
var SUPPLY = 1000000000n * 1000000n;
var LAUNCH = { virtualSol: 30n * LAMPORTS, graduationMcap: 420n * LAMPORTS, feeBps: 100 };
var BOUNDS = { minVirtualSol: LAMPORTS, maxVirtualSol: 1000n * LAMPORTS, minMultiple: 2n, maxMultiple: 100n, maxFeeBps: 300 };

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

function leg(sol, tokens, solIn) {
  var left = ceilDiv(sol * tokens, sol + solIn);
  return [tokens - left, left];
}

function quoteBuy(r, solIn, feeBps) {
  solIn = BigInt(solIn);
  var fee = feeOf(solIn, feeBps), rest = solIn - fee, after = Object.assign({}, r), out = 0n, burned = 0n, o;
  if (!after.graduated) {
    var room = after.graduationSol - after.realSol, onCurve = rest < room ? rest : room;
    if (onCurve > 0n) {
      o = leg(after.virtualSol + after.realSol, after.tokens, onCurve);
      out += o[0]; after.tokens = o[1]; after.realSol += onCurve; rest -= onCurve;
    }
    if (after.realSol === after.graduationSol) {
      burned = after.tokens * after.virtualSol / (after.virtualSol + after.realSol);
      after.tokens -= burned;
      after.graduated = true;
    }
  }
  if (after.graduated && rest > 0n) {
    o = leg(after.realSol, after.tokens, rest);
    out += o[0]; after.tokens = o[1]; after.realSol += rest;
  }
  return { fee: fee, tokensOut: out, burned: burned, graduates: burned > 0n, after: after };
}

function quoteSell(r, tokensIn, feeBps) {
  tokensIn = BigInt(tokensIn);
  var offset = r.graduated ? 0n : r.virtualSol, x = offset + r.realSol;
  var newX = ceilDiv(x * r.tokens, r.tokens + tokensIn), gross = x - newX, fee = feeOf(gross, feeBps);
  return { fee: fee, solOut: gross - fee, after: Object.assign({}, r, { realSol: newX - offset, tokens: r.tokens + tokensIn }) };
}

function priceOf(r, burned) {
  var sol = r.graduated ? r.realSol : r.virtualSol + r.realSol;
  var price = (Number(sol) / 1e9) / (Number(r.tokens) / 1e6);
  return { price: price, marketCap: price * (Number(SUPPLY - (burned || 0n)) / 1e6) };
}

window.PoolMath = {
  LAMPORTS: LAMPORTS, SUPPLY: SUPPLY, LAUNCH: LAUNCH, BOUNDS: BOUNDS,
  feeOf: feeOf, isqrtCeil: isqrtCeil, graduationSol: graduationSol, quoteBuy: quoteBuy, quoteSell: quoteSell, priceOf: priceOf
};
})();
