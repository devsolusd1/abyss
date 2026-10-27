// Reference implementation of the hook_pool curve math (DESIGN.md draft, 2026-10-22).
// Integer base units only: lamports for SOL, 6-decimal base units for tokens. BigInt stands
// in for u128. Every rounding goes the pool's way.
'use strict';

const LAMPORTS = 1_000_000_000n;          // 1 SOL
const TOKEN = 1_000_000n;                  // 1 token at 6 decimals
const BPS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

const ceilDiv = (a, b) => (a + b - 1n) / b;
const min = (a, b) => (a < b ? a : b);

function isqrt(n) {                         // floor(sqrt(n))
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}
const isqrtCeil = (n) => { const r = isqrt(n); return r * r === n ? r : r + 1n; };

function u128(v, what) {
  if (v < 0n || v > U128_MAX) throw new Error(`u128 overflow in ${what}: ${v}`);
  return v;
}

class Pool {
  /**
   * p.V       virtual SOL (lamports)
   * p.S       supply minted to the vault (base units)
   * p.Mg      graduation market cap on supply S (lamports)
   * p.feeBps  normal fee
   * p.snipeBps  starting anti-sniper fee (0 = off), decays linearly to feeBps over p.snipeSecs
   * p.gradMode  'overshoot' (whole buy on the curve, then graduate)
   *             'route'     (curve leg capped at the threshold, the rest through the AMM)
   *             'refund'    (curve leg capped at the threshold, the rest of the SOL refunded)
   * p.rent    rent-exempt minimum of the Pool account
   */
  constructor(p) {
    Object.assign(this, { feeBps: 100n, snipeBps: 0n, snipeSecs: 0n, gradMode: 'overshoot', rent: 2_000_000n }, p);
    this.phase = 'curve';
    this.R = 0n;                       // real SOL in the reserve
    this.T = this.S;                   // recorded token reserve
    this.burned = 0n;
    this.feesCreator = 0n;
    this.feesTreasury = 0n;
    this.lamports = this.rent;         // what the Pool account actually holds
    // Graduation threshold on real SOL: x_g = ceil(sqrt(Mg*V)), so mcap(S) >= Mg when R >= Rg.
    this.Rg = isqrtCeil(u128(this.Mg * this.V, 'Mg*V')) - this.V;
    this.gradEvent = null;
  }

  x() { return this.phase === 'curve' ? this.V + this.R : this.R; }
  k() { return u128(this.x() * this.T, 'k'); }
  feesOwed() { return this.feesCreator + this.feesTreasury; }

  // Fee rate at `elapsed` seconds after opening. Rounded up (pool's favour).
  feeBpsAt(elapsed) {
    if (this.snipeBps <= this.feeBps || this.snipeSecs === 0n) return this.feeBps;
    const e = elapsed < 0n ? 0n : elapsed;
    if (e >= this.snipeSecs) return this.feeBps;
    const span = this.snipeBps - this.feeBps;
    return this.snipeBps - (span * e) / this.snipeSecs;     // floor of the decrement = ceil of the fee
  }
  takeFee(fee) {
    const c = fee / 2n;                // creator gets the floor of half
    this.feesCreator += c;
    this.feesTreasury += fee - c;
  }

  // Constant-product step, exact input of the quote side. Returns tokens out (floor).
  _swapSolIn(net) {
    const x = this.x(), T = this.T;
    const k = u128(x * T, 'k');
    const newX = u128(x + net, 'x');
    const newT = ceilDiv(k, newX);
    const out = T - newT;
    this.R += net;
    this.T = newT;
    return out;
  }

  graduate() {
    const x = this.x();                           // V + R
    const Told = this.T;
    const burn = (Told * this.V) / x;             // floor: T' = ceil(T*R/x), price never rises
    this.T = Told - burn;
    this.burned += burn;
    this.phase = 'amm';
    this.gradEvent = { xBefore: x, Tbefore: Told, R: this.R, Tafter: this.T, burn };
  }

  buy(solIn, elapsed = 0n) {
    if (solIn <= 0n || solIn > U64_MAX) throw new Error('bad solIn');
    const bps = this.feeBpsAt(elapsed);
    let gross = solIn, refund = 0n;
    if (this.phase === 'curve' && this.gradMode === 'refund') {
      // Smallest gross g whose net reaches the threshold; the rest of the input is refunded
      // untouched (no fee charged on it).
      const room = this.Rg - this.R;
      let g = ceilDiv(room * BPS, BPS - bps);
      while (g - ceilDiv(g * bps, BPS) < room) g += 1n;
      while (g > 1n && (g - 1n) - ceilDiv((g - 1n) * bps, BPS) >= room) g -= 1n;
      if (g < solIn) { refund = solIn - g; gross = g; }
    }
    const fee = ceilDiv(gross * bps, BPS);
    let net = gross - fee;
    let out = 0n, crossed = false;
    if (this.phase === 'curve') {
      let leg = net;
      if (this.gradMode === 'route') leg = min(net, this.Rg - this.R);
      out += this._swapSolIn(leg);
      net -= leg;
      if (this.R >= this.Rg) { this.graduate(); crossed = true; }
    }
    if (net > 0n) out += this._swapSolIn(net);
    this.lamports += gross;
    this.takeFee(fee);
    return { out, fee, refund, crossed };
  }

  sell(tokIn, elapsed = 0n) {
    if (tokIn <= 0n) throw new Error('bad tokIn');
    const x = this.x(), T = this.T;
    const k = u128(x * T, 'k');
    const newT = T + tokIn;
    const newX = ceilDiv(k, newT);
    const gross = x - newX;
    const bps = this.feeBpsAt(elapsed);
    const fee = ceilDiv(gross * bps, BPS);
    const out = gross - fee;
    this.R -= gross;
    this.T = newT;
    if (this.R < 0n) throw new Error(`R < 0 after sell: ${this.R}`);
    this.lamports -= out;
    this.takeFee(fee);
    return { out, fee };
  }

  claim(which) {
    const amt = which === 'creator' ? this.feesCreator : this.feesTreasury;
    if (which === 'creator') this.feesCreator = 0n; else this.feesTreasury = 0n;
    this.lamports -= amt;
    return amt;
  }

  clone() {
    const p = Object.create(Pool.prototype);
    Object.assign(p, this);
    p.gradEvent = this.gradEvent && { ...this.gradEvent };
    return p;
  }
}

module.exports = { Pool, LAMPORTS, TOKEN, BPS, ceilDiv, isqrt, isqrtCeil };
