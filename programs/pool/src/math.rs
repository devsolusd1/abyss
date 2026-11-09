//! The curve and pool arithmetic, kept free of accounts so it runs and is tested on the host.
//!
//! Units are lamports for SOL and base units for tokens; products go through u128. Every
//! division rounds the pool's way, so no sequence of trades takes out more than went in.
//! `reference/pool.js` is the same math in JavaScript, with the property tests that shaped it.
//!
//! One curve for the coin's whole life: every buy and every sell is one constant-product leg
//! against `virtual + real` SOL and the token reserve. The virtual SOL never leaves and nothing
//! is burned, so the price never goes under the opening price. A part of every fee stays in the
//! real SOL. The graduation line is a mark on the way: a coin is graduated while the curve's
//! market cap on the whole supply is at the one chosen at launch or above it, and nothing happens
//! to the reserves or the price there.

/// Basis points in one whole.
pub const BPS: u64 = 10_000;

/// Every coin's supply in base units, all of it minted to the pool at launch (`state::SUPPLY`).
/// Nothing is burned in a pool launched now, so the market cap on it is the market cap.
pub const SUPPLY: u64 = 1_000_000_000 * 1_000_000;

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
    /// Market cap on the whole supply at which the coin counts as graduated; 0 for a pool past its
    /// line for good.
    pub graduation_mcap: u64,
    /// The market cap is at the line or above it.
    pub graduated: bool,
    /// The part of each fee that stays in the real SOL.
    pub pool_share_bps: u16,
}

impl Reserves {
    /// The curve's market cap on the whole supply, `x·S/T`, is at `graduation_mcap` or above it:
    /// `x·S ≥ M·T`, with no division to round. It fits in u128: x < 2^65 and S < 2^50, M and T
    /// are u64s.
    pub fn over_the_line(&self) -> bool {
        let x = self.virtual_sol as u128 + self.real_sol as u128;
        x * SUPPLY as u128 >= self.graduation_mcap as u128 * self.tokens as u128
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Buy {
    /// Taken from the SOL paid, before it reaches the curve.
    pub fee: u64,
    /// The part of the fee that stays in the real SOL.
    pub to_pool: u64,
    pub tokens_out: u64,
    /// The buy takes the market cap from under the line to the line or past it.
    pub graduates: bool,
    pub after: Reserves,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sell {
    /// Taken from the SOL the pool pays out.
    pub fee: u64,
    /// The part of the fee that stays in the real SOL.
    pub to_pool: u64,
    /// What the seller receives, after the fee.
    pub sol_out: u64,
    pub after: Reserves,
}

impl Buy {
    /// The fee less the pool's part: what the creator and the treasury are owed.
    pub fn owed(&self) -> u64 {
        self.fee - self.to_pool
    }
}

impl Sell {
    /// The fee less the pool's part: what the creator and the treasury are owed.
    pub fn owed(&self) -> u64 {
        self.fee - self.to_pool
    }
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a.div_ceil(b)
}

/// `amount × bps / 10,000`, rounded up.
pub fn fee_of(amount: u64, fee_bps: u16) -> u64 {
    // Fits: amount < 2^64 and bps < 2^16, and the result is at most `amount`.
    ceil_div(amount as u128 * fee_bps as u128, BPS as u128) as u64
}

/// The part of `fee` that stays in the pool: `fee × share / 10,000`, rounded down, with the
/// share held to the whole fee.
pub fn pool_part(fee: u64, pool_share_bps: u16) -> u64 {
    let share = (pool_share_bps as u64).min(BPS);
    (fee as u128 * share as u128 / BPS as u128) as u64
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

/// Real SOL that takes a pool just launched to `graduation_mcap`, measured on the full supply: for
/// reading only, since the line is the market cap itself (`Reserves::over_the_line`).
///
/// With all supply `S` in the pool at launch, `k = V·S`, the price is `x/T` and the market cap
/// `x·S/T = x²/V`. So the curve reaches `M` when `x = √(M·V)`, that is after `√(M·V) − V` of
/// real SOL. Rounded up: one lamport less is always under the line. One buy of exactly this much,
/// with no fee, can still land a hair under it, since the token reserve it leaves is rounded up
/// (10 virtual SOL and a 90 SOL line need a lamport more). The pool's part of each fee lifts k,
/// and with it the real SOL at the line: after trading, a coin needs more than this.
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

/// A buy of `sol_in` lamports, fee included: one leg on the curve, on either side of the line.
pub fn buy(r: Reserves, sol_in: u64, fee_bps: u16) -> Result<Buy, MathError> {
    let fee = fee_of(sol_in, fee_bps);
    let to_pool = pool_part(fee, r.pool_share_bps);
    let rest = sol_in - fee;
    let (tokens_out, left) = leg(r.virtual_sol as u128 + r.real_sol as u128, r.tokens, rest)?;
    if tokens_out == 0 {
        return Err(MathError::ZeroOut);
    }
    // The pool's part of the fee joins the real SOL after the leg: the buyer pays it, and no
    // token is priced on it.
    let real_sol = r.real_sol.checked_add(rest).and_then(|s| s.checked_add(to_pool)).ok_or(MathError::Overflow)?;
    let mut after = Reserves { real_sol, tokens: left, ..r };
    after.graduated = after.over_the_line();
    Ok(Buy { fee, to_pool, tokens_out, graduates: !r.graduated && after.graduated, after })
}

/// A sell of `tokens_in` base units. Only dust is refused: the real SOL saturates at what is
/// there, so no sell fails on the pool's books.
pub fn sell(r: Reserves, tokens_in: u64, fee_bps: u16) -> Result<Sell, MathError> {
    let offset = r.virtual_sol as u128;
    let x = offset + r.real_sol as u128;
    let k = x.checked_mul(r.tokens as u128).ok_or(MathError::Overflow)?;
    let new_tokens = r.tokens.checked_add(tokens_in).ok_or(MathError::Overflow)?;
    // Rounded up, so the pool keeps the odd lamport. k only grows from V·S and no more than S
    // tokens can ever be in the pool, so this never falls under the virtual SOL; held there
    // anyway, so the real SOL never goes under zero.
    let new_x = ceil_div(k, new_tokens as u128).max(offset);
    // At most the real SOL, so it fits.
    let gross = (x - new_x) as u64;
    let fee = fee_of(gross, fee_bps);
    let sol_out = gross - fee;
    if sol_out == 0 {
        return Err(MathError::ZeroOut);
    }
    // The pool's part of the fee never leaves the pool. It is a piece of the gross the curve paid
    // out, so the curve's SOL ends at most where it was while the token reserve grows: a sell
    // never lifts the price, and never takes the coin over the line.
    let to_pool = pool_part(fee, r.pool_share_bps);
    let real_sol = ((new_x - offset) as u64).saturating_add(to_pool);
    let mut after = Reserves { real_sol, tokens: new_tokens, ..r };
    after.graduated = after.over_the_line();
    Ok(Sell { fee, to_pool, sol_out, after })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;
    /// The share every new pool keeps (state::POOL_SHARE_BPS).
    const SHARE: u16 = 2_000;

    fn launch(v: u64, mcap: u64) -> Reserves {
        launch_with(v, mcap, SHARE)
    }

    fn launch_with(v: u64, mcap: u64, pool_share_bps: u16) -> Reserves {
        Reserves { virtual_sol: v, real_sol: 0, tokens: SUPPLY, graduation_mcap: mcap, graduated: false, pool_share_bps }
    }

    /// The rule written out again, to hold `over_the_line` to it: the market cap on the whole
    /// supply, x·S/T, at the line or above it.
    fn at_the_line(r: &Reserves) -> bool {
        (r.virtual_sol + r.real_sol) as u128 * SUPPLY as u128 >= r.graduation_mcap as u128 * r.tokens as u128
    }

    /// The market cap on the whole supply, in SOL.
    fn mcap(r: &Reserves) -> f64 {
        (r.virtual_sol + r.real_sol) as f64 / 1e9 * SUPPLY as f64 / r.tokens as f64
    }

    /// Real SOL at which the reserves as they stand would reach the line, were only buys to come
    /// and none of their fee kept: x² = M·k/S. In floats, to walk a test up to the line; the
    /// program needs no such number.
    fn line_sol(r: &Reserves) -> u64 {
        let k = (r.virtual_sol + r.real_sol) as f64 * r.tokens as f64;
        let x = (r.graduation_mcap as f64 * k / SUPPLY as f64).sqrt();
        (x.ceil() as u64).saturating_sub(r.virtual_sol)
    }

    /// The marginal price x/T in SOL per million tokens.
    fn price(r: &Reserves) -> f64 {
        (r.virtual_sol + r.real_sol) as f64 / 1e9 / (r.tokens as f64 / 1e6) * 1e6
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

    /// The first version's math, exactly as it was until 2026-11-09: the curve stopped at the
    /// line, dropped the virtual SOL and burned, and the pool went on with its real reserves. The
    /// pools it graduated are held to it.
    mod first {
        use super::super::{ceil_div, fee_of, leg, MathError};

        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub struct R {
            pub virtual_sol: u64,
            pub real_sol: u64,
            pub tokens: u64,
            pub graduation_sol: u64,
            pub graduated: bool,
        }

        /// The fee, the tokens out, the burn and the reserves after.
        pub fn buy(r: R, sol_in: u64, fee_bps: u16) -> Result<(u64, u64, u64, R), MathError> {
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
            Ok((fee, tokens_out, burned, after))
        }

        /// The fee, the SOL out and the reserves after.
        pub fn sell(r: R, tokens_in: u64, fee_bps: u16) -> Result<(u64, u64, R), MathError> {
            let offset = if r.graduated { 0 } else { r.virtual_sol as u128 };
            let x = offset + r.real_sol as u128;
            let k = x.checked_mul(r.tokens as u128).ok_or(MathError::Overflow)?;
            let new_tokens = r.tokens.checked_add(tokens_in).ok_or(MathError::Overflow)?;
            let new_x = ceil_div(k, new_tokens as u128);
            let gross = (x - new_x) as u64;
            let fee = fee_of(gross, fee_bps);
            let sol_out = gross - fee;
            if sol_out == 0 {
                return Err(MathError::ZeroOut);
            }
            let real_sol = u64::try_from(new_x.checked_sub(offset).ok_or(MathError::Overflow)?)
                .map_err(|_| MathError::Overflow)?;
            Ok((fee, sol_out, R { real_sol, tokens: new_tokens, ..r }))
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
    fn the_line_fits_in_u128() {
        // the largest numbers the u64s can hold: the products stay under 2^128, and nothing panics
        let most = Reserves {
            virtual_sol: u64::MAX,
            real_sol: u64::MAX,
            tokens: u64::MAX,
            graduation_mcap: u64::MAX,
            graduated: false,
            pool_share_bps: SHARE,
        };
        assert!(!most.over_the_line());
        assert!(Reserves { tokens: 1, ..most }.over_the_line());
        assert!(Reserves { graduation_mcap: 0, real_sol: 0, virtual_sol: 0, ..most }.over_the_line());
        // and the program's own ceilings: 1,000 virtual SOL, a line at 100× it, every token in the pool
        let top = launch(1_000 * SOL, 100_000 * SOL);
        assert!(!top.over_the_line() && Reserves { real_sol: u64::MAX, ..top }.over_the_line());
    }

    #[test]
    fn the_numbers_at_the_line() {
        // No fee, so these are the curve's own numbers: one buy that lands on the line.
        let r = launch(30 * SOL, 420 * SOL);
        let line = graduation_sol(30 * SOL, 420 * SOL).unwrap();
        let b = buy(r, line, 0).unwrap();
        let at = b.after;
        assert!(b.graduates && at.graduated && at_the_line(&at));
        assert_eq!(at.real_sol, 82_249_721_604);
        // one lamport less and the market cap is under it
        let short = buy(r, line - 1, 0).unwrap();
        assert!(!short.graduates && !short.after.graduated && !at_the_line(&short.after));
        // 112.25 SOL priced against 267.3 M tokens: 0.42 SOL a million, 420 SOL on the whole
        // supply, which is all still there.
        let x = (at.virtual_sol + at.real_sol) as u128;
        assert_eq!(at.tokens as u128, ceil_div(30 * SOL as u128 * SUPPLY as u128, x));
        assert!((at.tokens as f64 / 1e12 - 267.26).abs() < 0.01, "{}", at.tokens);
        assert!((price(&at) - 0.42).abs() < 1e-6, "{}", price(&at));
        assert!((mcap(&at) - 420.0).abs() < 1e-3);
        assert_eq!(b.tokens_out + at.tokens, SUPPLY);

        // 10 SOL at the line moves the price 18.6%; the first version's plain pool of real
        // reserves moved it 25.8%.
        let ten = buy(at, 10 * SOL, 0).unwrap().after;
        let moved = price(&ten) / price(&at);
        assert!((moved - 1.186).abs() < 0.001, "{moved}");
        let pool = 82.249_721_604f64;
        assert!(((pool + 10.0) * (pool + 10.0) / (pool * pool) - 1.258).abs() < 0.001);

        // Everyone sells it all back: the price is the opening one again, and the sellers get
        // the 82.25 real SOL, 81.43 of it with a 1% fee.
        let held = SUPPLY - at.tokens;
        let back = sell(at, held, 0).unwrap();
        assert_eq!(back.after.tokens, SUPPLY);
        assert!(back.after.real_sol <= 1 && at.real_sol - back.sol_out <= 1);
        let with_fee = sell(at, held, 100).unwrap();
        assert!((with_fee.sol_out as f64 / 1e9 - 81.43).abs() < 0.005, "{}", with_fee.sol_out);
        // and a fifth of that fee stays in the pool
        assert_eq!(with_fee.to_pool, with_fee.fee / 5);
        assert_eq!(with_fee.after.real_sol, with_fee.to_pool + back.after.real_sol);
    }

    #[test]
    fn buying_the_line_s_real_sol_into_a_new_pool() {
        // Where V·M is a square, √(M·V) is whole and so is graduation_sol, but the token reserve
        // the buy leaves is rounded up: the market cap ends a hair under the line, and one lamport
        // more takes it there. 10 and 90: 20 SOL buy down to 333,333,333.333334 tokens, worth
        // 89.99999999999982 SOL.
        let r = launch(10 * SOL, 90 * SOL);
        let line = graduation_sol(10 * SOL, 90 * SOL).unwrap();
        assert_eq!(line, 20 * SOL);
        let b = buy(r, line, 0).unwrap();
        assert!(!b.graduates && !b.after.graduated && !at_the_line(&b.after));
        assert_eq!((b.after.real_sol, b.after.tokens), (20 * SOL, 333_333_333_333_334));
        assert!(buy(r, line + 1, 0).unwrap().graduates);

        // Where the reserve divides with nothing to round, the buy lands on the line itself, and the
        // line counts as over it: 10 and 40, 10 SOL buy down to half the supply, x·S = M·T.
        let r = launch(10 * SOL, 40 * SOL);
        let line = graduation_sol(10 * SOL, 40 * SOL).unwrap();
        assert_eq!(line, 10 * SOL);
        let b = buy(r, line, 0).unwrap();
        assert_eq!((b.after.real_sol, b.after.tokens), (10 * SOL, SUPPLY / 2));
        assert_eq!(20 * SOL as u128 * SUPPLY as u128, 40 * SOL as u128 * b.after.tokens as u128);
        assert!(b.graduates && b.after.graduated && b.after.over_the_line() && at_the_line(&b.after));
        // one token's base unit more in the pool and it is under
        assert!(!Reserves { tokens: SUPPLY / 2 + 1, ..b.after }.over_the_line());
        assert!(!buy(r, line - 1, 0).unwrap().after.graduated);

        let mut rng = Rng(23);
        let (mut on, mut short, mut exact) = (0u32, 0u32, 0u32);
        for _ in 0..5_000 {
            let v = (1 + rng.below(999)) * SOL;
            // A quarter of them with M = c²·V, so √(M·V) = c·V is whole: the buy leaves S/c tokens,
            // exactly on the line where c divides S (2, 4, 5, 8, 10), a hair under it otherwise.
            let c = 2 + rng.below(9);
            let m = if rng.below(4) == 0 { v * c * c } else { v * (2 + rng.below(99)) + rng.below(SOL) };
            let r = launch(v, m);
            let line = graduation_sol(v, m).unwrap();
            let b = buy(r, line, 0).unwrap();
            assert_eq!(b.after.real_sol, line);
            assert_eq!((b.graduates, b.after.graduated), (at_the_line(&b.after), at_the_line(&b.after)));
            // short of the line, if at all, by less than one token's base unit at the line's price:
            // T is rounded up by less than one, and x·S ≥ M·V·S/x
            let x = (v + line) as u128;
            assert!(x * SUPPLY as u128 + m as u128 > m as u128 * b.after.tokens as u128);
            // a lamport less is always under it
            assert!(!buy(r, line - 1, 0).unwrap().after.graduated);
            // and with a fee the same SOL buys less: under the line
            assert!(!buy(r, line, 100).unwrap().after.graduated);
            if x * SUPPLY as u128 == m as u128 * b.after.tokens as u128 {
                assert!(b.graduates && b.after.graduated);
                exact += 1;
            }
            if b.graduates {
                on += 1;
            } else {
                short += 1;
            }
        }
        assert!(on > 3_500 && short > 0 && exact > 0, "on the line {on} ({exact} exactly), a hair under it {short}");
    }

    #[test]
    fn crossing_the_line_moves_neither_price_nor_supply() {
        let mut rng = Rng(7);
        for _ in 0..2_000 {
            let v = (1 + rng.below(999)) * SOL;
            let mcap = v * (2 + rng.below(99));
            let fee_bps = rng.below(301) as u16;
            let line = graduation_sol(v, mcap).unwrap();
            let mut r = launch(v, mcap);
            // Walk partway up, then cross.
            for _ in 0..rng.below(20) {
                let room = line_sol(&r).saturating_sub(r.real_sol);
                if let Ok(b) = buy(r, rng.below(room / 4) + 1_000, fee_bps) {
                    if b.after.graduated {
                        break;
                    }
                    r = b.after;
                }
            }
            // past the line whatever the fee takes
            let room = line_sol(&r).saturating_sub(r.real_sol);
            let amount = room + room / 16 + rng.below(3 * line) + 1_000;
            let b = buy(r, amount, fee_bps).unwrap();
            assert!(b.graduates && b.after.graduated && at_the_line(&b.after) && !at_the_line(&r));
            // The same buy with the line out of reach: the very same numbers. The line only marks.
            let far = buy(Reserves { graduation_mcap: u64::MAX, ..r }, amount, fee_bps).unwrap();
            assert_eq!((far.fee, far.to_pool, far.tokens_out), (b.fee, b.to_pool, b.tokens_out));
            assert_eq!((far.after.real_sol, far.after.tokens), (b.after.real_sol, b.after.tokens));
            assert!(!far.graduates && !far.after.graduated);
            // Nothing burned: every token is in the pool or with a buyer.
            assert_eq!(SUPPLY - r.tokens + b.tokens_out + b.after.tokens, SUPPLY);
            // The virtual SOL stays, the line stays where it was chosen, and the price only goes up.
            assert_eq!((b.after.virtual_sol, b.after.graduation_mcap), (v, mcap));
            let (x0, x1) = ((v + r.real_sol) as u128, (v + b.after.real_sol) as u128);
            assert!(x1 * r.tokens as u128 >= x0 * b.after.tokens as u128);
        }
    }

    #[test]
    fn crossing_the_line_in_one_buy_or_two_prices_the_same() {
        let mut rng = Rng(5);
        for _ in 0..500 {
            let v = (1 + rng.below(200)) * SOL;
            let m = v * (2 + rng.below(99));
            let r = launch(v, m);
            let split = rng.below(graduation_sol(v, m).unwrap() + 1_000 * SOL) + 1;
            let extra = rng.below(1_000 * SOL) + 1;
            let one = buy(r, split + extra, 0).unwrap();
            let first = buy(r, split, 0).unwrap();
            let second = buy(first.after, extra, 0).unwrap();
            // Wherever the split falls, before the line or after it, the two legs are the one leg
            // but for the rounding, which favours the pool: a unit or two fewer tokens out, the
            // same units more in the pool.
            assert_eq!(one.after.real_sol, second.after.real_sol);
            let two = first.tokens_out + second.tokens_out;
            assert!(two <= one.tokens_out && one.tokens_out - two <= 2, "{} {two}", one.tokens_out);
            assert_eq!(second.after.tokens - one.after.tokens, one.tokens_out - two);
            assert_eq!(one.after.graduated, second.after.graduated);
            assert_eq!(one.graduates, first.graduates || second.graduates);
            assert!(!(first.graduates && second.graduates), "only one of them crosses");
        }
    }

    /// The pool's lamports above its rent and the opening batch, as the program keeps them: the
    /// real SOL plus the fees owed. Each trade moves them by the SOL that crossed.
    struct Books {
        lamports: u128,
        owed: u128,
    }

    impl Books {
        fn new(r: &Reserves) -> Self {
            Books { lamports: r.real_sol as u128, owed: 0 }
        }
        fn bought(&mut self, sol_in: u64, b: &Buy) {
            self.lamports += sol_in as u128;
            self.owed += b.owed() as u128;
            self.check(&b.after);
        }
        fn sold(&mut self, s: &Sell) {
            self.lamports -= s.sol_out as u128;
            self.owed += s.owed() as u128;
            self.check(&s.after);
        }
        fn check(&self, r: &Reserves) {
            assert_eq!(self.lamports, r.real_sol as u128 + self.owed, "the books do not close");
        }
    }

    #[test]
    fn nobody_gains_by_trading_alone_and_the_books_close_at_every_step() {
        let mut rng = Rng(42);
        for round in 0..1_200 {
            let v = (1 + rng.below(500)) * SOL;
            let mcap = v * (2 + rng.below(60));
            let fee_bps = rng.below(301) as u16;
            let line = graduation_sol(v, mcap).unwrap();
            // Mostly the 20% every new pool keeps; also none, as an old pool has, and all of it.
            let share = [SHARE, SHARE, 0, 10_000][round % 4];
            let mut r = launch_with(v, mcap, share);
            // Someone else may have bought first, so the trader can start on either side of the line.
            if round % 3 > 0 {
                r = buy(r, rng.below(3 * line) + 1_000_000, fee_bps).unwrap().after;
            }
            let start = r;
            let mut books = Books::new(&r);
            let mut paid: u128 = 0;
            let mut got: u128 = 0;
            let mut held: u64 = 0;
            for _ in 0..20 {
                if held == 0 || rng.below(2) == 0 {
                    let amount = rng.below(line) + 1_000;
                    if let Ok(b) = buy(r, amount, fee_bps) {
                        paid += amount as u128;
                        held += b.tokens_out;
                        books.bought(amount, &b);
                        r = b.after;
                    }
                } else {
                    let amount = 1 + rng.below(held);
                    if let Ok(s) = sell(r, amount, fee_bps) {
                        got += s.sol_out as u128;
                        held -= amount;
                        books.sold(&s);
                        r = s.after;
                    }
                }
            }
            if held > 0 {
                if let Ok(s) = sell(r, held, fee_bps) {
                    got += s.sol_out as u128;
                    books.sold(&s);
                    r = s.after;
                }
            }
            assert!(got <= paid, "round {round}: paid {paid}, got {got}, start {start:?}");
            // what the trader left behind is in the pool, or owed to the creator and the treasury
            assert!(r.real_sol >= start.real_sol || held > 0, "round {round}: the pool lost SOL");
        }
    }

    #[test]
    fn the_fee_is_counted_once() {
        assert_eq!((pool_part(7, SHARE), pool_part(10, SHARE), pool_part(0, SHARE)), (1, 2, 0));
        assert_eq!((pool_part(99, 0), pool_part(99, 10_000), pool_part(99, u16::MAX)), (0, 99, 99));

        let mut rng = Rng(9);
        let mut r = launch(30 * SOL, 420 * SOL);
        let mut books = Books::new(&r);
        let (mut held, mut kept) = (0u64, 0u128);
        for _ in 0..5_000 {
            if held == 0 || rng.below(2) == 0 {
                let amount = rng.below(20 * SOL) + 1_000;
                let b = buy(r, amount, 100).unwrap();
                assert_eq!(b.to_pool, pool_part(b.fee, SHARE));
                // the leg is priced on the SOL less the whole fee; the pool's part comes in after it
                assert_eq!(b.after.real_sol, r.real_sol + (amount - b.fee) + b.to_pool);
                books.bought(amount, &b);
                (held, kept, r) = (held + b.tokens_out, kept + b.to_pool as u128, b.after);
            } else {
                let amount = 1 + rng.below(held);
                let Ok(s) = sell(r, amount, 100) else { continue };
                assert_eq!(s.to_pool, pool_part(s.fee, SHARE));
                books.sold(&s);
                (held, kept, r) = (held - amount, kept + s.to_pool as u128, s.after);
            }
        }
        // Owing the whole fee as well as keeping the pool's part in the real SOL would owe more
        // than the pool holds, by every part it kept: the program's solvency check would refuse.
        assert!(kept > SOL as u128);
        let owed_twice = books.owed + kept;
        assert_eq!(r.real_sol as u128 + owed_twice, books.lamports + kept);
    }

    #[test]
    fn the_curve_holds_for_life() {
        let mut rng = Rng(3);
        let mut r = launch(30 * SOL, 420 * SOL);
        let (mut held, mut up, mut down) = (0u64, 0u32, 0u32);
        for i in 0..40_000 {
            let before = r;
            let k0 = (r.virtual_sol + r.real_sol) as u128 * r.tokens as u128;
            let (x0, t0) = ((r.virtual_sol + r.real_sol) as u128, r.tokens as u128);
            // stretches of mostly buys, then of mostly sells, so the walk crosses the line both ways
            let buying = if (i / 400) % 2 == 0 { rng.below(4) > 0 } else { rng.below(4) == 0 };
            if held == 0 || buying {
                if let Ok(b) = buy(r, rng.below(15 * SOL) + 1, 100) {
                    assert_eq!(b.graduates, !before.graduated && b.after.graduated);
                    up += b.graduates as u32;
                    held += b.tokens_out;
                    r = b.after;
                }
            } else {
                let amount = 1 + rng.below(held / 4);
                if let Ok(s) = sell(r, amount, 100) {
                    assert!(s.after.real_sol <= before.real_sol, "a sell never adds real SOL");
                    // nor lifts the price, the pool's part of its fee included: it never graduates
                    let (x1, t1) = ((s.after.virtual_sol + s.after.real_sol) as u128, s.after.tokens as u128);
                    assert!(x1 * t0 <= x0 * t1, "a sell lifted the price");
                    assert!(before.graduated || !s.after.graduated, "a sell took the coin over the line");
                    down += (before.graduated && !s.after.graduated) as u32;
                    held -= amount;
                    r = s.after;
                }
            }
            // k never falls, the reserve never passes the supply, the virtual SOL never leaves,
            assert!((r.virtual_sol + r.real_sol) as u128 * r.tokens as u128 >= k0);
            assert!(r.tokens <= SUPPLY && held + r.tokens == SUPPLY);
            assert_eq!(r.virtual_sol, 30 * SOL);
            // x·S ≥ V·T: the marginal price x/T is at least the opening V/S,
            let x = (r.virtual_sol + r.real_sol) as u128;
            assert!(x * SUPPLY as u128 >= r.virtual_sol as u128 * r.tokens as u128);
            // and the coin is graduated exactly while its market cap is at the line or above it.
            assert_eq!(r.graduated, at_the_line(&r));
            assert!(r.graduated || mcap(&r) < 420.0);
        }
        assert!(up > 1 && down > 0, "the walk should cross the line up more than once ({up}) and down ({down})");
    }

    #[test]
    fn graduated_follows_the_line_and_only_the_way_up_graduates() {
        let r = launch(30 * SOL, 420 * SOL);
        let line = graduation_sol(30 * SOL, 420 * SOL).unwrap();
        // the line's SOL with a 1% fee: the fee comes off first, so the market cap stays under the line
        let under = buy(r, line, 100).unwrap();
        assert!(!under.graduates && !under.after.graduated && mcap(&under.after) < 420.0);
        let mut r = under.after;
        let mut held = under.tokens_out;
        for round in 0..5 {
            let over = buy(r, line_sol(&r).saturating_sub(r.real_sol) * 11 / 10 + SOL, 100).unwrap();
            assert!(over.graduates && over.after.graduated && mcap(&over.after) >= 420.0, "round {round}");
            let more = buy(over.after, SOL, 100).unwrap();
            assert!(!more.graduates && more.after.graduated, "already over the line");
            held += over.tokens_out + more.tokens_out;
            // sold back under the line: no longer graduated, and nothing else changes
            let back = sell(more.after, held / 8, 100).unwrap();
            assert!(!back.after.graduated && mcap(&back.after) < 420.0, "round {round}");
            assert_eq!((back.after.virtual_sol, back.after.graduation_mcap), (30 * SOL, 420 * SOL));
            held -= held / 8;
            r = back.after;
        }
    }

    #[test]
    fn volume_alone_does_not_graduate_a_coin_before_its_market_cap() {
        // 10 SOL held, then round trips of 10 SOL at 1%: a fifth of each fee stays in the real SOL,
        // k grows, and the real SOL passes the 82.25 SOL that takes a pool just launched to the
        // line while the market cap is still far under 420. Measured on real SOL, the line came at
        // a market cap of 149 SOL here. The coin is graduated at 420, and not before.
        let line = graduation_sol(30 * SOL, 420 * SOL).unwrap();
        let mut r = buy(launch(30 * SOL, 420 * SOL), 10 * SOL, 100).unwrap().after;
        let (mut trips, mut past) = (0u32, None);
        while past.is_none_or(|at| trips < at + 200) {
            let b = buy(r, 10 * SOL, 100).unwrap();
            let s = sell(b.after, b.tokens_out, 100).unwrap();
            for after in [&b.after, &s.after] {
                assert_eq!(after.graduated, at_the_line(after), "trip {trips}");
                assert!(!after.graduated && mcap(after) < 420.0, "trip {trips}: graduated at a {} SOL market cap", mcap(after));
            }
            r = s.after;
            trips += 1;
            if past.is_none() && r.real_sol >= line {
                past = Some(trips);
                assert!((mcap(&r) - 149.3).abs() < 0.5, "{}", mcap(&r));
            }
            assert!(trips < 5_000, "the round trips should take the real SOL past the line");
        }
        // Then buys of 0.1 SOL: graduated by the one that takes the market cap to 420, with far more
        // real SOL in than a pool just launched needs.
        loop {
            let b = buy(r, SOL / 10, 100).unwrap();
            if b.graduates {
                assert!(mcap(&r) < 420.0 && mcap(&b.after) >= 420.0 && b.after.graduated);
                assert!(b.after.real_sol > line + 50 * SOL, "{}", b.after.real_sol);
                break;
            }
            assert_eq!(b.after.graduated, at_the_line(&b.after));
            r = b.after;
        }
    }

    #[test]
    fn everyone_can_leave() {
        let mut rng = Rng(11);
        for round in 0..400 {
            // with no fee the curve gives back all the real SOL, to the rounding
            let (fee_bps, share) = [(0, SHARE), (100, SHARE), (300, 0), (100, 10_000)][round % 4];
            let mut r = launch_with(30 * SOL, 420 * SOL, share);
            let mut holders = vec![];
            let mut trades = 0u64;
            for _ in 0..(1 + rng.below(30)) {
                let b = buy(r, rng.below(40 * SOL) + 1_000, fee_bps).unwrap();
                holders.push(b.tokens_out);
                r = b.after;
                trades += 1;
            }
            for held in holders {
                // A sell may be dust, worth nothing after rounding; that is the only refusal.
                match sell(r, held, fee_bps) {
                    Ok(s) => r = s.after,
                    Err(MathError::ZeroOut) => {}
                    Err(e) => panic!("{e:?}"),
                }
                trades += 1;
            }
            assert!(SUPPLY - r.tokens < 1_000_000, "round {round}: only dust stays out");
            assert_eq!(r.graduated, at_the_line(&r));
            assert!(!r.graduated, "round {round}: sold out, under the line");
            if fee_bps == 0 {
                assert!(r.real_sol <= trades, "round {round}: {} lamports left", r.real_sol);
            }
        }
    }

    #[test]
    fn a_sell_saturates_instead_of_failing() {
        // Reserves no trade can reach: a curve that would ask for less than the virtual SOL. The
        // sell pays out the real SOL there is, less the fee, and the pool keeps its part of it.
        let r = Reserves { real_sol: 5_000, ..launch(30 * SOL, 420 * SOL) };
        let s = sell(r, 1_000_000_000, 100).unwrap();
        assert_eq!((s.fee, s.sol_out), (50, 4_950));
        assert_eq!((s.to_pool, s.after.real_sol), (10, 10));
        let s = sell(Reserves { real_sol: 1, ..r }, u64::MAX / 2, 0).unwrap();
        assert_eq!((s.sol_out, s.after.real_sol), (1, 0));
        // and what rounds to nothing is dust, refused as always
        assert_eq!(sell(Reserves { real_sol: 1, ..r }, u64::MAX / 2, 100), Err(MathError::ZeroOut));
        assert_eq!(sell(Reserves { real_sol: 0, ..r }, u64::MAX / 2, 0), Err(MathError::ZeroOut));
    }

    /// A pool the first version graduated (it burned, so `burned` > 0): what Pool::reserves gives
    /// the math for it, from the account as that version left it, its launch's market cap included.
    fn legacy(old: first::R, mcap: u64, burned: u64) -> Reserves {
        let mut p: crate::state::Pool = bytemuck::Zeroable::zeroed();
        p.virtual_sol = old.virtual_sol;
        p.real_sol = old.real_sol;
        p.token_reserve = old.tokens;
        p.graduation_sol = old.graduation_sol;
        p.graduation_mcap = mcap;
        p.graduated = old.graduated as u8;
        p.burned = burned;
        p.reserves()
    }

    #[test]
    fn pools_the_first_version_graduated_trade_to_the_integer_as_before() {
        let mut rng = Rng(13);
        for round in 0..300 {
            let v = (1 + rng.below(300)) * SOL;
            let mcap = v * (2 + rng.below(99));
            let fee_bps = (100 + rng.below(201)) as u16;
            let line = graduation_sol(v, mcap).unwrap();
            let opened = first::R { virtual_sol: v, real_sol: 0, tokens: SUPPLY, graduation_sol: line, graduated: false };
            // the first version graduates it, with a buy past the line
            let (_, bought, burned, mut old) = first::buy(opened, line * 2 + rng.below(line) + SOL, fee_bps).unwrap();
            assert!(old.graduated && burned > 0);
            // no virtual SOL, a line of 0 (graduated for good), no part of the fee kept
            let mut new = legacy(old, mcap, burned);
            assert_eq!((new.virtual_sol, new.graduation_mcap, new.pool_share_bps, new.graduated), (0, 0, 0, true));
            let mut held = bought;
            for step in 0..60 {
                if held == 0 || rng.below(2) == 0 {
                    let amount = rng.below(50 * SOL) + 1_000;
                    let (fee, out, _, after) = first::buy(old, amount, fee_bps).unwrap();
                    let b = buy(new, amount, fee_bps).unwrap();
                    assert_eq!((b.fee, b.owed(), b.tokens_out), (fee, fee, out), "round {round}, step {step}");
                    assert_eq!((b.after.real_sol, b.after.tokens), (after.real_sol, after.tokens));
                    assert!(!b.graduates && b.after.graduated);
                    (old, new, held) = (after, b.after, held + out);
                } else {
                    // down to the last tokens, far under the line the coin once crossed
                    let amount = if rng.below(4) == 0 { held } else { 1 + rng.below(held) };
                    match (first::sell(old, amount, fee_bps), sell(new, amount, fee_bps)) {
                        (Ok((fee, out, after)), Ok(s)) => {
                            assert_eq!((s.fee, s.owed(), s.sol_out), (fee, fee, out), "round {round}, step {step}");
                            assert_eq!((s.after.real_sol, s.after.tokens), (after.real_sol, after.tokens));
                            assert!(s.after.graduated, "graduated for good");
                            (old, new, held) = (after, s.after, held - amount);
                        }
                        (was, now) => assert_eq!(was.err(), now.err(), "round {round}, step {step}"),
                    }
                }
                // what the program writes back reads the same next time, graduated for good
                assert_eq!(legacy(old, mcap, burned), new);
                assert!(new.graduated && new.over_the_line());
            }
        }
    }

    #[test]
    fn pools_the_first_version_left_under_the_line_trade_as_before_until_it() {
        let mut rng = Rng(17);
        for round in 0..300 {
            let v = (1 + rng.below(300)) * SOL;
            let mcap = v * (2 + rng.below(99));
            let line = graduation_sol(v, mcap).unwrap();
            let fee_bps = (100 + rng.below(201)) as u16;
            let mut old = first::R { virtual_sol: v, real_sol: 0, tokens: SUPPLY, graduation_sol: line, graduated: false };
            // An old pool reads its share from bytes that were padding: zero.
            let mut new = legacy(old, mcap, 0);
            assert_eq!(new, Reserves { pool_share_bps: 0, ..launch(v, mcap) });
            let mut held = 0u64;
            for _ in 0..40 {
                if held == 0 || rng.below(2) == 0 {
                    let amount = rng.below(line / 8) + 1_000;
                    let (fee, out, burned, after) = first::buy(old, amount, fee_bps).unwrap();
                    if burned > 0 {
                        break;
                    }
                    let b = buy(new, amount, fee_bps).unwrap();
                    assert_eq!((b.fee, b.owed(), b.tokens_out, b.after.real_sol), (fee, fee, out, after.real_sol), "round {round}");
                    // under the first version's line of real SOL is under the market cap: k ≥ V·S
                    assert!(!b.after.graduated, "round {round}");
                    (old, new, held) = (after, b.after, held + out);
                } else {
                    let amount = 1 + rng.below(held);
                    match (first::sell(old, amount, fee_bps), sell(new, amount, fee_bps)) {
                        (Ok((_, out, after)), Ok(s)) => {
                            assert_eq!((s.sol_out, s.after.real_sol, s.after.tokens), (out, after.real_sol, after.tokens), "round {round}");
                            (old, new, held) = (after, s.after, held - amount);
                        }
                        (was, now) => assert_eq!(was.err(), now.err(), "round {round}"),
                    }
                }
            }
            // then the line: the first version would burn, this one carries on along the curve
            let amount = (line - new.real_sol) * 11 / 10 + SOL;
            let b = buy(new, amount, fee_bps).unwrap();
            assert!(b.graduates && b.after.virtual_sol == v && b.after.tokens + held + b.tokens_out == SUPPLY);
        }
    }

    #[test]
    fn dust_is_refused() {
        let r = launch(30 * SOL, 420 * SOL);
        assert_eq!(buy(r, 0, 100), Err(MathError::ZeroOut));
        assert_eq!(sell(buy(r, SOL, 100).unwrap().after, 0, 100), Err(MathError::ZeroOut));
    }
}
