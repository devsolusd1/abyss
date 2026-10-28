//! The two accounts the program keeps, and the limits nothing can move.

use {crate::math::Reserves, anchor_lang::prelude::*};

pub const CONFIG_SEED: &[u8] = b"config";
pub const POOL_SEED: &[u8] = b"pool";
/// A coin's mint is the program's own address for this seed, its creator and a number the creator picks: only the
/// program can make an account there, so nothing can have been made at it, or for it, before the launch.
pub const MINT_SEED: &[u8] = b"mint";

/// Every coin has the same supply and decimals.
pub const DECIMALS: u8 = 6;
pub const SUPPLY: u64 = 1_000_000_000 * 1_000_000;

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
/// lamports, above its own rent: the real reserve plus the fees nobody has claimed yet.
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
    pub graduation_sol: u64,
    /// Market cap on the full supply at graduation, as chosen at launch.
    pub graduation_mcap: u64,
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
    /// 0 until the curve graduates.
    pub graduated_at: i64,
    pub fee_bps: u16,
    pub treasury_share_bps: u16,
    pub graduated: u8,
    pub bump: u8,
    pub _pad: [u8; 2],
    /// Room for what the launchpad adds later, without moving any field above.
    pub _reserved: [u8; 64],
}

impl Pool {
    pub const LEN: usize = 8 + core::mem::size_of::<Pool>();

    pub fn reserves(&self) -> Reserves {
        Reserves {
            virtual_sol: self.virtual_sol,
            real_sol: self.real_sol,
            tokens: self.token_reserve,
            graduation_sol: self.graduation_sol,
            graduated: self.graduated != 0,
        }
    }

    pub fn set_reserves(&mut self, r: Reserves) {
        self.real_sol = r.real_sol;
        self.token_reserve = r.tokens;
        self.graduated = r.graduated as u8;
    }

    /// Splits a trading fee between the treasury and the creator, and counts it as owed.
    pub fn owe(&mut self, fee: u64) -> Result<()> {
        let treasury = (fee as u128 * self.treasury_share_bps as u128 / crate::math::BPS as u128) as u64;
        self.treasury_fees = self.treasury_fees.checked_add(treasury).ok_or(crate::PoolError::MathOverflow)?;
        self.creator_fees = self.creator_fees.checked_add(fee - treasury).ok_or(crate::PoolError::MathOverflow)?;
        Ok(())
    }

    /// Lamports the pool must hold above its rent.
    pub fn owed_lamports(&self) -> Option<u64> {
        self.real_sol.checked_add(self.creator_fees)?.checked_add(self.treasury_fees)
    }
}
