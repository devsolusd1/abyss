// The pool's math in JavaScript, integer for integer with src/math.rs (2026-11-09: one curve for life, a part of every
// fee kept in the pool, and the coin graduated while its market cap on the whole supply is at the line). Integer base
// units only: lamports for SOL, 6-decimal base units for tokens. BigInt stands in for u128. Every rounding goes the
// pool's way.
'use strict';

const LAMPORTS = 1_000_000_000n;          // 1 SOL
const TOKEN = 1_000_000n;                  // 1 token at 6 decimals
const BPS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

const ceilDiv = (a, b) => (a + b - 1n) / b;
const feeOf = (amount, bps) => ceilDiv(amount * bps, BPS);
// The pool's part of a fee: rounded down, the share held to the whole fee.
const poolPart = (fee, shareBps) => (fee * (shareBps < BPS ? shareBps : BPS)) / BPS;

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

// What the program refuses: a trade too small to move a base unit (MathError::ZeroOut).
class ZeroOut extends Error {}

class Pool {
  /**
   * p.V           virtual SOL (lamports)
   * p.S           supply minted to the vault (base units)
   * p.Mg          graduation market cap on supply S (lamports)
   * p.feeBps      fee on every trade
   * p.shareBps    the part of each fee that stays in the real SOL (POOL_SHARE_BPS, 2000; 0 for a coin launched before)
   * p.treasuryBps the treasury's part of the rest; the creator gets what is left
   * p.rent        rent-exempt minimum of the Pool account
   */
  constructor(p) {
    Object.assign(this, { feeBps: 100n, shareBps: 2000n, treasuryBps: 5000n, rent: 2_000_000n }, p);
    this.R = 0n;                       // real SOL in the reserve
    this.T = this.S;                   // recorded token reserve
    this.burned = 0n;                  // only a pool the first version graduated has burned
    this.feesCreator = 0n;
    this.feesTreasury = 0n;
    this.lamports = this.rent;         // what the Pool account actually holds
    // Real SOL that takes the pool, just launched, to its line: x_g = ceil(sqrt(Mg*V)). For reading, and for the first
    // version's math, whose line it was; the line is the market cap.
    this.Rg = isqrtCeil(u128(this.Mg * this.V, 'Mg*V')) - this.V;
    this.graduated = false;
  }

  // What Pool::reserves gives the math. A pool the first version graduated (burned > 0) goes on as that version left
  // it: no virtual SOL, a line of 0 so past it for good, the whole fee owed.
  legacy() { return this.burned > 0n; }
  v() { return this.legacy() ? 0n : this.V; }
  line() { return this.legacy() ? 0n : this.Mg; }
  share() { return this.legacy() ? 0n : this.shareBps; }

  x() { return this.v() + this.R; }
  k() { return u128(this.x() * this.T, 'k'); }
  feesOwed() { return this.feesCreator + this.feesTreasury; }
  // Reserves::over_the_line: the market cap on the whole supply, x·S/T, at the line or above it, with no division.
  overTheLine() { return u128(this.x() * this.S, 'x*S') >= u128(this.line() * this.T, 'M*T'); }
  // The market cap on the whole supply, in SOL (for reading).
  mcap() { return Number(this.x()) / 1e9 * Number(this.S) / Number(this.T); }
  // Real SOL at which the pool as it stands reaches its line, should only buys with none of their fee kept follow:
  // x² = M·k/S, rounded up. (x - V) / (that - V) is how far it has come.
  lineSol() { return isqrtCeil(ceilDiv(this.line() * this.k(), this.S)) - this.v(); }

  owe(owed) {
    const t = (owed * this.treasuryBps) / BPS;
    this.feesTreasury += t;
    this.feesCreator += owed - t;
  }

  // One leg on the curve, on either side of the line. The pool's part of the fee joins the real SOL after the leg.
  buy(solIn) {
    if (solIn < 0n || solIn > U64_MAX) throw new Error('bad solIn');
    const fee = feeOf(solIn, this.feeBps);
    const toPool = poolPart(fee, this.share());
    const rest = solIn - fee;
    const x = this.x();
    const left = ceilDiv(u128(x * this.T, 'k'), u128(x + rest, 'x'));
    const out = this.T - left;
    if (out === 0n) throw new ZeroOut('buy');
    const was = this.graduated;
    this.R += rest + toPool;
    this.T = left;
    this.graduated = this.overTheLine();
    this.lamports += solIn;
    this.owe(fee - toPool);
    return { out, fee, toPool, graduates: !was && this.graduated };
  }

  // Never under the virtual SOL: the real SOL saturates at zero instead of failing. Only dust is refused.
  sell(tokIn) {
    if (tokIn < 0n) throw new Error('bad tokIn');
    const v = this.v();
    const x = v + this.R;
    const k = u128(x * this.T, 'k');
    const newT = this.T + tokIn;
    let newX = ceilDiv(k, newT);
    if (newX < v) newX = v;
    const gross = x - newX;
    const fee = feeOf(gross, this.feeBps);
    const out = gross - fee;
    if (out === 0n) throw new ZeroOut('sell');
    const toPool = poolPart(fee, this.share());
    this.R = newX - v + toPool;
    this.T = newT;
    this.graduated = this.overTheLine();
    this.lamports -= out;
    this.owe(fee - toPool);
    return { out, fee, toPool };
  }

  claim(which) {
    const amt = which === 'creator' ? this.feesCreator : this.feesTreasury;
    if (which === 'creator') this.feesCreator = 0n; else this.feesTreasury = 0n;
    this.lamports -= amt;
    return amt;
  }

  clone() {
    return Object.assign(Object.create(Pool.prototype), this);
  }
}

// The first version's math, as it was until 2026-11-09: the curve stopped at the line, dropped the virtual SOL and
// burned T·V/x, and the pool went on as a plain x·y=k pool of real reserves. Here to graduate pools the old way and to
// hold them to it.
const first = {
  buy(r, solIn, feeBps) {
    const fee = feeOf(solIn, feeBps);
    let rest = solIn - fee;
    const a = { ...r };
    let out = 0n, burned = 0n;
    if (!a.graduated) {
      const room = a.Rg - a.R;
      const onCurve = rest < room ? rest : room;
      if (onCurve > 0n) {
        const x = a.V + a.R, left = ceilDiv(x * a.T, x + onCurve);
        out += a.T - left; a.T = left; a.R += onCurve; rest -= onCurve;
      }
      if (a.R === a.Rg) {
        burned = (a.T * a.V) / (a.V + a.R);
        a.T -= burned; a.graduated = true;
      }
    }
    if (a.graduated && rest > 0n) {
      const left = ceilDiv(a.R * a.T, a.R + rest);
      out += a.T - left; a.T = left; a.R += rest;
    }
    if (out === 0n) throw new ZeroOut('first buy');
    return { fee, out, burned, after: a };
  },
  sell(r, tokIn, feeBps) {
    const offset = r.graduated ? 0n : r.V;
    const x = offset + r.R;
    const newT = r.T + tokIn;
    const newX = ceilDiv(x * r.T, newT);
    const gross = x - newX, fee = feeOf(gross, feeBps), out = gross - fee;
    if (out === 0n) throw new ZeroOut('first sell');
    if (newX < offset) throw new Error('first version: R < 0');
    return { fee, out, after: { ...r, R: newX - offset, T: newT } };
  },
};

module.exports = { Pool, ZeroOut, first, LAMPORTS, TOKEN, BPS, U64_MAX, ceilDiv, feeOf, poolPart, isqrt, isqrtCeil };
