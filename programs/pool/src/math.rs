//! The curve and pool arithmetic, kept free of accounts so it runs and is tested on the host.
//!
//! Units are lamports for SOL and base units for tokens; products go through u128. Every
//! division rounds the pool's way, so no sequence of trades takes out more than went in.
//! `reference/pool.js` is the same math in JavaScript, with the property tests that shaped it.
//!
//! During the curve the pool prices against `virtual + real` SOL. When the real SOL reaches the
//! graduation line, the virtual SOL is dropped and the tokens that would sit above the current
//! price are burned, so the price carries on unchanged in a plain x·y=k pool of real reserves.

/// Basis points in one whole.
pub const BPS: u64 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MathError {
    Overflow,
    /// The trade is too small to move a single base unit.
    ZeroOut,
}

/// The numbers the math reads and writes; the pool account keeps them between trades.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reserves {
    pub virtual_sol: u64,
    pub real_sol: u64,
    pub tokens: u64,
    /// Real SOL at which the curve graduates.
    pub graduation_sol: u64,
    pub graduated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Buy {
    /// Taken from the SOL paid, before it reaches the reserves.
    pub fee: u64,
    pub tokens_out: u64,
    /// Burned from the vault when this buy graduates the curve, 0 otherwise.
    pub burned: u64,
    pub after: Reserves,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sell {
    /// Taken from the SOL the pool pays out.
    pub fee: u64,
    /// What the seller receives, after the fee.
    pub sol_out: u64,
    pub after: Reserves,
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a.div_ceil(b)
}

/// `amount × bps / 10,000`, rounded up.
pub fn fee_of(amount: u64, fee_bps: u16) -> u64 {
    // Fits: amount < 2^64 and bps < 2^16, and the result is at most `amount`.
    ceil_div(amount as u128 * fee_bps as u128, BPS as u128) as u64
}

/// Floor of the square root.
fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // Newton's method from above: starts at a power of two past the root and only falls.
    let mut x = 1u128 << (128 - n.leading_zeros()).div_ceil(2);
    loop {
        let next = (x + n / x) / 2;
        if next >= x {
            return x;
        }
        x = next;
    }
}

/// Real SOL that takes the curve to `graduation_mcap`, measured on the full supply.
///
/// With all supply `S` in the pool at launch, `k = V·S`, the price is `x/T` and the market cap
/// `x·S/T = x²/V`. So the curve reaches `M` when `x = √(M·V)`, that is after `√(M·V) − V` of
/// real SOL. Rounded up, so the line is never reached a lamport early.
pub fn graduation_sol(virtual_sol: u64, graduation_mcap: u64) -> Option<u64> {
    let product = (virtual_sol as u128).checked_mul(graduation_mcap as u128)?;
    let root = isqrt(product);
    let root = if root * root == product { root } else { root + 1 };
    u64::try_from(root.checked_sub(virtual_sol as u128)?).ok()
}

/// One constant-product leg: `sol` and `tokens` in the pool, `sol_in` arriving. Returns the
/// tokens paid out and the token reserve left, which is rounded up.
fn leg(sol: u128, tokens: u64, sol_in: u64) -> Result<(u64, u64), MathError> {
    let k = sol.checked_mul(tokens as u128).ok_or(MathError::Overflow)?;
    let new_sol = sol.checked_add(sol_in as u128).ok_or(MathError::Overflow)?;
    if new_sol == 0 {
        return Err(MathError::ZeroOut);
    }
    let left = u64::try_from(ceil_div(k, new_sol)).map_err(|_| MathError::Overflow)?;
    Ok((tokens - left, left))
}

/// A buy of `sol_in` lamports, fee included.
///
/// The curve only takes SOL up to the graduation line. A buy that crosses it graduates the
/// pool on the spot and spends the rest in the graduated pool, so graduation always happens at
/// the same price and burns the same amount, whatever the size of the buy.
pub fn buy(r: Reserves, sol_in: u64, fee_bps: u16) -> Result<Buy, MathError> {
    let fee = fee_of(sol_in, fee_bps);
    let mut rest = sol_in - fee;
    let mut after = r;
    let mut tokens_out = 0u64;
    let mut burned = 0u64;

    if !after.graduated {
        let room = after.graduation_sol.checked_sub(after.real_sol).ok_or(MathError::Overflow)?;
        let on_curve = rest.min(room);
        if on_curve > 0 {
            let x = after.virtual_sol as u128 + after.real_sol as u128;
            let (out, left) = leg(x, after.tokens, on_curve)?;
            tokens_out += out;
            after.tokens = left;
            after.real_sol += on_curve;
            rest -= on_curve;
        }
        if after.real_sol == after.graduation_sol {
            // Keep the price x/T: with only R of SOL left, the pool may hold R·T/x tokens.
            // The rest goes, rounded down, so the price never rises at graduation.
            let x = after.virtual_sol as u128 + after.real_sol as u128;
            burned = (after.tokens as u128 * after.virtual_sol as u128 / x) as u64;
            after.tokens -= burned;
            after.graduated = true;
        }
    }
    if after.graduated && rest > 0 {
        let (out, left) = leg(after.real_sol as u128, after.tokens, rest)?;
        tokens_out += out;
        after.tokens = left;
        after.real_sol = after.real_sol.checked_add(rest).ok_or(MathError::Overflow)?;
    }
    if tokens_out == 0 {
        return Err(MathError::ZeroOut);
    }
    Ok(Buy { fee, tokens_out, burned, after })
}

/// A sell of `tokens_in` base units.
pub fn sell(r: Reserves, tokens_in: u64, fee_bps: u16) -> Result<Sell, MathError> {
    // The curve prices against virtual SOL too; the graduated pool against real SOL only.
    let offset = if r.graduated { 0 } else { r.virtual_sol as u128 };
    let x = offset + r.real_sol as u128;
    let k = x.checked_mul(r.tokens as u128).ok_or(MathError::Overflow)?;
    let new_tokens = r.tokens.checked_add(tokens_in).ok_or(MathError::Overflow)?;
    // Rounded up, so the pool keeps the odd lamport.
    let new_x = ceil_div(k, new_tokens as u128);
    let gross = (x - new_x) as u64;
    let fee = fee_of(gross, fee_bps);
    let sol_out = gross - fee;
    if sol_out == 0 {
        return Err(MathError::ZeroOut);
    }
    // On the curve `new_x` never drops under the virtual SOL: k only grows from V·S, and no
    // more than S tokens can ever be in the pool. Checked anyway.
    let real_sol = u64::try_from(new_x.checked_sub(offset).ok_or(MathError::Overflow)?)
        .map_err(|_| MathError::Overflow)?;
    let after = Reserves { real_sol, tokens: new_tokens, ..r };
    Ok(Sell { fee, sol_out, after })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;
    const SUPPLY: u64 = 1_000_000_000_000_000;

    fn launch(v: u64, mcap: u64) -> Reserves {
        Reserves {
            virtual_sol: v,
            real_sol: 0,
            tokens: SUPPLY,
            graduation_sol: graduation_sol(v, mcap).unwrap(),
            graduated: false,
        }
    }

    /// A small deterministic generator, so a failure always comes back the same way.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n.max(1)
        }
    }

    #[test]
    fn square_roots() {
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, u64::MAX as u128, (u64::MAX as u128) * 7, u128::MAX] {
            let r = isqrt(n);
            assert!(r * r <= n, "{n}");
            assert!((r + 1).checked_mul(r + 1).is_none_or(|sq| sq > n), "{n}");
        }
    }

    #[test]
    fn graduation_line_for_thirty_to_four_twenty() {
        // √(420 · 30) = 112.2497216… SOL, so 82.2497216… SOL of real SOL.
        let line = graduation_sol(30 * SOL, 420 * SOL).unwrap();
        assert_eq!(line, 82_249_721_604);
    }

    #[test]
    fn the_draft_numbers() {
        let r = launch(30 * SOL, 420 * SOL);
        // A buy far past the line: the curve stops at it, the rest goes through the pool.
        let b = buy(r, 500 * SOL, 100).unwrap();
        assert!(b.after.graduated);
        assert_eq!(b.fee, 5 * SOL);
        // S·V/M = 1e9 · 30/420 tokens. The line is a whole lamport, rounded up from √(M·V),
        // which moves the burn by about a thousandth of a token.
        let burn = SUPPLY / 14;
        assert!(b.burned.abs_diff(burn) <= 1_000_000, "burned {}", b.burned);
        assert_eq!(b.after.real_sol, 495 * SOL);
    }

    #[test]
    fn graduation_keeps_the_price() {
        let mut rng = Rng(7);
        for _ in 0..2_000 {
            let v = (1 + rng.below(999)) * SOL;
            let mcap = v * (2 + rng.below(99));
            let mut r = launch(v, mcap);
            // Walk partway up, then land exactly on the line.
            for _ in 0..rng.below(20) {
                let step = rng.below((r.graduation_sol - r.real_sol) / 4) + 1;
                r = buy(r, step, 0).unwrap().after;
            }
            let b = buy(r, r.graduation_sol - r.real_sol, 0).unwrap();
            assert!(b.after.graduated);
            assert_eq!(b.after.real_sol, b.after.graduation_sol);
            // Price on the curve at the line: x/T. In the pool after the burn: R/T'.
            let x = (v + b.after.real_sol) as u128;
            let t = (b.after.tokens + b.burned) as u128;
            let gap = b.after.tokens as u128 * x - b.after.real_sol as u128 * t;
            assert!(gap < x, "the price moved by more than a base unit");
            // The burn is V/x of what was left: S·V/M at an exact landing, give or take one.
            assert_eq!(b.burned as u128, t * v as u128 / x);
        }
    }

    #[test]
    fn crossing_the_line_in_one_buy_or_two_is_the_same() {
        let mut rng = Rng(5);
        for _ in 0..500 {
            let v = (1 + rng.below(200)) * SOL;
            let r = launch(v, v * (2 + rng.below(99)));
            let extra = rng.below(1_000 * SOL) + 1;
            let one = buy(r, r.graduation_sol + extra, 0).unwrap();
            let first = buy(r, r.graduation_sol, 0).unwrap();
            let second = buy(first.after, extra, 0).unwrap();
            assert_eq!(one.burned, first.burned);
            assert_eq!(one.after, second.after);
            assert_eq!(one.tokens_out, first.tokens_out + second.tokens_out);
        }
    }

    #[test]
    fn nobody_gains_by_trading_alone() {
        let mut rng = Rng(42);
        for round in 0..400 {
            let v = (1 + rng.below(500)) * SOL;
            let mcap = v * (2 + rng.below(60));
            let fee_bps = rng.below(301) as u16;
            let mut r = launch(v, mcap);
            // Someone else may have bought first, so the trader can start on either side.
            if round % 2 == 1 {
                r = buy(r, rng.below(2 * r.graduation_sol) + 1_000_000, fee_bps).unwrap().after;
            }
            let start = r;
            let mut paid: u128 = 0;
            let mut got: u128 = 0;
            let mut held: u64 = 0;
            for _ in 0..20 {
                if held == 0 || rng.below(2) == 0 {
                    let amount = rng.below(r.graduation_sol) + 1_000;
                    if let Ok(b) = buy(r, amount, fee_bps) {
                        paid += amount as u128;
                        held += b.tokens_out;
                        r = b.after;
                    }
                } else {
                    let amount = 1 + rng.below(held);
                    if let Ok(s) = sell(r, amount, fee_bps) {
                        got += s.sol_out as u128;
                        held -= amount;
                        r = s.after;
                    }
                }
            }
            if held > 0 {
                if let Ok(s) = sell(r, held, fee_bps) {
                    got += s.sol_out as u128;
                    r = s.after;
                }
            }
            let _ = r;
            assert!(got <= paid, "round {round}: paid {paid}, got {got}, start {start:?}");
        }
    }

    #[test]
    fn curve_price_never_below_opening() {
        let mut rng = Rng(3);
        let mut r = launch(30 * SOL, 420 * SOL);
        let mut held = 0u64;
        for _ in 0..20_000 {
            if r.graduated {
                break;
            }
            if held == 0 || rng.below(3) > 0 {
                if let Ok(b) = buy(r, rng.below(2 * SOL) + 1, 100) {
                    if b.after.graduated {
                        continue;
                    }
                    held += b.tokens_out;
                    r = b.after;
                }
            } else {
                let amount = 1 + rng.below(held);
                if let Ok(s) = sell(r, amount, 100) {
                    held -= amount;
                    r = s.after;
                }
            }
            // x·S ≥ V·T: the marginal price x/T is at least V/S.
            let x = (r.virtual_sol + r.real_sol) as u128;
            assert!(x * SUPPLY as u128 >= r.virtual_sol as u128 * r.tokens as u128);
        }
    }

    #[test]
    fn everyone_can_leave() {
        let mut rng = Rng(11);
        for _ in 0..200 {
            let mut r = launch(30 * SOL, 420 * SOL);
            let mut holders = vec![];
            for _ in 0..(1 + rng.below(30)) {
                let b = buy(r, rng.below(20 * SOL) + 1_000, 100).unwrap();
                holders.push(b.tokens_out);
                r = b.after;
            }
            for held in holders {
                // A sell may be dust, worth nothing after rounding; that is the only refusal.
                match sell(r, held, 100) {
                    Ok(s) => r = s.after,
                    Err(MathError::ZeroOut) => {}
                    Err(e) => panic!("{e:?}"),
                }
            }
            assert!(r.real_sol < r.graduation_sol || r.graduated);
        }
    }

    #[test]
    fn dust_is_refused() {
        let r = launch(30 * SOL, 420 * SOL);
        assert_eq!(buy(r, 0, 100), Err(MathError::ZeroOut));
        assert_eq!(sell(buy(r, SOL, 100).unwrap().after, 0, 100), Err(MathError::ZeroOut));
    }
}
