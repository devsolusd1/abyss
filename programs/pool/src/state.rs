//! The two accounts the program keeps, and the limits nothing can move.

use {crate::math::Reserves, anchor_lang::prelude::*};

pub const CONFIG_SEED: &[u8] = b"config";
pub const POOL_SEED: &[u8] = b"pool";
/// A coin's mint is the program's own address for this seed, its creator and a number the creator picks: only the
/// program can make an account there, so nothing can have been made at it, or for it, before the launch.
pub const MINT_SEED: &[u8] = b"mint";
/// A wallet's place in a coin's opening batch: `["seat", pool, owner]`.
pub const SEAT_SEED: &[u8] = b"seat";

/// Every coin has the same supply and decimals.
pub const DECIMALS: u8 = 6;
pub const SUPPLY: u64 = 1_000_000_000 * 1_000_000;
// The math measures the graduation line on this same supply.
const _: () = assert!(SUPPLY == crate::math::SUPPLY);

const SOL: u64 = 1_000_000_000;
/// Ceilings written into the program, which neither the config nor a creator can pass. A fee
/// above them would do what a refused sell does: take almost everything on the way out.
pub const MAX_FEE_BPS: u16 = 300;
pub const MIN_VIRTUAL_SOL: u64 = SOL;
pub const MAX_VIRTUAL_SOL: u64 = 1_000 * SOL;
/// Graduation sits between 2× and 100× the opening market cap.
pub const MIN_GRADUATION_MULTIPLE: u64 = 2;
pub const MAX_GRADUATION_MULTIPLE: u64 = 100;
pub const MAX_LAUNCH_FEE: u64 = SOL;
/// The part of every trading fee that stays in the pool's real SOL, written into each pool at launch. The creator and
/// the treasury split the rest by the config's `treasury_share_bps`.
pub const POOL_SHARE_BPS: u16 = 2_000;
/// The opening batch: a window of 2 to 15 minutes before the first trade, in which anyone puts in SOL and may take it
/// back out; at its end one buy is made with all of it, and every seat gets tokens for its share, at one price.
pub const MIN_OPENING_SECS: u32 = 120;
pub const MAX_OPENING_SECS: u32 = 900;
/// The batch's last minute takes no new SOL, while withdrawals stay open to the end: every seat sees the final total
/// for a minute and can still leave, so nobody can slip a large commitment in at the last second, settle, and be first
/// to sell above the batch's price, out of the other seats' SOL.
pub const OPENING_LOCK_SECS: i64 = 60;
/// The smallest commitment, and the smallest batch that buys: a batch under MIN_BATCH, or one the math refuses, is
/// not bought with, and every seat takes its SOL back.
pub const MIN_COMMIT: u64 = SOL / 1_000;
pub const MIN_BATCH: u64 = SOL / 100;
/// Pool::opening_state
pub const OPENING_NONE: u8 = 0;
pub const OPENING_OPEN: u8 = 1;
pub const OPENING_SETTLED: u8 = 2;
pub const OPENING_REFUND: u8 = 3;
/// The usual Metaplex limits, which wallets and indexers expect.
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_URI_LEN: usize = 200;

/// One for the whole program. Its settings only reach coins launched after a change.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Changes the config. Meant to be a multisig once the program is live.
    pub admin: Pubkey,
    /// May launch while launches are closed, besides the admin.
    pub launcher: Pubkey,
    /// Where the platform's share goes, for coins launched from now on.
    pub treasury: Pubkey,
    /// Lamports a launch pays the treasury.
    pub launch_fee: u64,
    /// The lowest trading fee a coin may choose.
    pub min_fee_bps: u16,
    /// The treasury's part of each trading fee; the creator gets the rest.
    pub treasury_share_bps: u16,
    pub launches_open: bool,
    pub bump: u8,
}

/// One per coin, at `["pool", mint]`. It owns the coin's vault and holds the pool's SOL as
/// lamports, above its own rent: the real reserve plus the fees nobody has claimed yet, and the opening batch's SOL.
#[account(zero_copy)]
pub struct Pool {
    pub mint: Pubkey,
    pub creator: Pubkey,
    /// Fixed at launch, so a later change to the config can't redirect this coin's fees.
    pub treasury: Pubkey,
    /// The pool's token account for the mint.
    pub vault: Pubkey,
    /// The coin's transfer hook, or the default address when it has none.
    pub hook_program: Pubkey,
    pub virtual_sol: u64,
    pub real_sol: u64,
    /// Tokens the pool counts as its own. Read from here, never from the vault's balance, so
    /// tokens sent straight to the vault don't move the price.
    pub token_reserve: u64,
    /// Real SOL that takes the pool, just launched, to its line (`math::graduation_sol`): for reading only. The
    /// pool's part of each fee lifts k, and with it the real SOL at the line.
    pub graduation_sol: u64,
    /// The graduation line, chosen at launch: the coin is graduated while the market cap on the full supply is at it
    /// or above it (`math::Reserves::over_the_line`), exactly, after every buy, sell and settle.
    pub graduation_mcap: u64,
    /// Tokens the first version burned when the coin graduated. 0 for every coin since, which burns nothing: above 0,
    /// the pool goes on as that version left it (`reserves`).
    pub burned: u64,
    /// Owed and not yet claimed.
    pub creator_fees: u64,
    pub treasury_fees: u64,
    /// Claimed so far.
    pub creator_fees_paid: u64,
    pub treasury_fees_paid: u64,
    /// Every lamport that crossed the pool in trades, fees included.
    pub volume_sol: u64,
    pub opened_at: i64,
    /// When the market cap first reached the line; 0 until then. Kept when it falls back under it.
    pub graduated_at: i64,
    pub fee_bps: u16,
    pub treasury_share_bps: u16,
    /// 1 while the market cap on the full supply is at the line or above it, 0 under it.
    pub graduated: u8,
    pub bump: u8,
    pub _pad: [u8; 2],
    // The opening batch, in what was 64 reserved bytes (a coin launched before it reads zeros: no batch).
    /// When the batch closes; 0 for a coin that opened at once.
    pub opens_at: i64,
    /// SOL in the batch and not yet bought with (or, after a refused batch, not yet taken back). It sits in this
    /// account, above the reserve.
    pub opening_sol: u64,
    /// At the settle: the batch's SOL and the tokens it bought, shared among the seats by their SOL.
    pub opening_total_sol: u64,
    pub opening_tokens: u64,
    /// Bought for the seats and not yet claimed: they wait in the vault, outside the reserve.
    pub opening_tokens_left: u64,
    pub opening_seats: u32,
    /// OPENING_NONE, OPENING_OPEN, OPENING_SETTLED or OPENING_REFUND.
    pub opening_state: u8,
    pub _pad2: u8,
    /// POOL_SHARE_BPS at launch, in what were padding bytes: a coin launched before it reads 0, and keeps the whole fee
    /// for its creator and the treasury.
    pub pool_share_bps: u16,
    /// Room for what comes later, without moving any field above.
    pub _reserved: [u8; 16],
}

/// A wallet's place in a coin's opening batch, at `["seat", pool, owner]`: the SOL it put in. Closed (its rent back to
/// the owner) when the owner takes its tokens, or all its SOL back; a later commitment opens a new one.
#[account]
#[derive(InitSpace)]
pub struct Seat {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub sol: u64,
    pub bump: u8,
}

impl Pool {
    pub const LEN: usize = 8 + core::mem::size_of::<Pool>();

    /// The pool as the math reads it.
    ///
    /// A pool the first version graduated (`burned` > 0) dropped its virtual SOL and burned there, and went on as a
    /// plain pool of its real reserves. It stays one: no virtual SOL (the field keeps it, for display), a line of 0 so
    /// it is past it for good, and the whole fee owed as before. Read any other way, its price would jump 36% and its
    /// last sells would ask for SOL that is not there.
    pub fn reserves(&self) -> Reserves {
        let first_version = self.burned > 0;
        Reserves {
            virtual_sol: if first_version { 0 } else { self.virtual_sol },
            real_sol: self.real_sol,
            tokens: self.token_reserve,
            graduation_mcap: if first_version { 0 } else { self.graduation_mcap },
            graduated: first_version || self.graduated != 0,
            pool_share_bps: if first_version { 0 } else { self.pool_share_bps },
        }
    }

    pub fn set_reserves(&mut self, r: Reserves) {
        self.real_sol = r.real_sol;
        self.token_reserve = r.tokens;
        self.graduated = r.graduated as u8;
    }

    /// Notes the first time the market cap reached the line.
    pub fn reached_the_line(&mut self, now: i64) {
        if self.graduated_at == 0 {
            self.graduated_at = now;
        }
    }

    /// Splits what a trade owes, the fee less the pool's part, between the treasury and the creator, and counts it as
    /// owed.
    pub fn owe(&mut self, owed: u64) -> Result<()> {
        let treasury = (owed as u128 * self.treasury_share_bps as u128 / crate::math::BPS as u128) as u64;
        self.treasury_fees = self.treasury_fees.checked_add(treasury).ok_or(crate::PoolError::MathOverflow)?;
        self.creator_fees = self.creator_fees.checked_add(owed - treasury).ok_or(crate::PoolError::MathOverflow)?;
        Ok(())
    }

    /// Lamports the pool must hold above its rent: the reserve, the fees owed, and the opening batch's SOL.
    pub fn owed_lamports(&self) -> Option<u64> {
        self.real_sol.checked_add(self.creator_fees)?.checked_add(self.treasury_fees)?.checked_add(self.opening_sol)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pool_keeps_its_size_and_every_field_its_place() {
        // what clients read by position: 8 bytes of discriminator, then the fields
        let at = |offset: usize| 8 + offset;
        assert_eq!(Pool::LEN, 8 + 336);
        assert_eq!(at(core::mem::offset_of!(Pool, virtual_sol)), 168);
        assert_eq!(at(core::mem::offset_of!(Pool, burned)), 208);
        assert_eq!(at(core::mem::offset_of!(Pool, graduated)), 276);
        assert_eq!(at(core::mem::offset_of!(Pool, opening_state)), 324);
        // the pool's share, in what were the padding bytes after opening_state
        assert_eq!(at(core::mem::offset_of!(Pool, _pad2)), 325);
        assert_eq!(at(core::mem::offset_of!(Pool, pool_share_bps)), 326);
        assert_eq!(at(core::mem::offset_of!(Pool, _reserved)), 328);
    }
}
