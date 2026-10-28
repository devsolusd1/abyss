//! One pool per coin, for the coin's whole life.
//!
//! A coin launches into a bonding curve priced against virtual SOL. When enough real SOL has
//! come in, the curve graduates inside the buy that gets it there: the virtual SOL is dropped,
//! the tokens above the current price are burned, and the same pool goes on as a plain
//! constant-product pool. The coin never leaves this program, so whatever the pool does at
//! launch it still does years later.
//!
//! A coin may instead open with a batch: for a window chosen at launch nobody buys, wallets put
//! SOL into seats, and once the window is over one buy is made with all of it, every seat
//! getting its share of the tokens at that one price.
//!
//! Coins carry no transfer hook in this version. The trading path already passes a hook's
//! accounts along, for the version that adds one.
//!
//! Fees are taken in SOL and owed to the creator and to the treasury written into the pool at
//! launch. There is no LP token, the liquidity stays for good, and no instruction lets anyone
//! take a pool's SOL or tokens except by trading, claiming those fees, or taking back a seat in
//! the opening batch: `withdraw` and `claim_seat` pay a seat's owner only that seat's own SOL,
//! or its share of the batch's tokens.
//!
//! See DESIGN.md for the reasoning and `reference/` for the same math in JavaScript.

use anchor_lang::prelude::*;

pub mod math;
pub mod state;
pub mod token;

use {
    math::MathError,
    state::*,
    token::{Metadata, TOKEN_2022},
};

declare_id!("CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK");

#[program]
pub mod dex {
    use super::*;

    /// Creates the config. Only the program's upgrade authority can, so nobody gets there
    /// first between the deploy and this call.
    pub fn init_config(ctx: Context<InitConfig>, args: ConfigArgs) -> Result<()> {
        args.check(&ctx.accounts.treasury)?;
        let config = &mut ctx.accounts.config;
        args.write(config);
        config.bump = ctx.bumps.config;
        emit!(args.event());
        Ok(())
    }

    /// Changes the config. Coins already launched keep the treasury, fee and split they were
    /// born with.
    pub fn update_config(ctx: Context<UpdateConfig>, args: ConfigArgs) -> Result<()> {
        args.check(&ctx.accounts.treasury)?;
        args.write(&mut ctx.accounts.config);
        emit!(args.event());
        Ok(())
    }

    /// Creates a coin and its pool in one go: the mint with its metadata, the vault, the whole
    /// supply in it, and every authority removed. The creator's first buy, if any, is a `buy`
    /// after this one in the same transaction; with an opening batch (`opening_secs` > 0) it is
    /// a `commit` instead, since nobody buys until the batch is settled.
    pub fn launch(ctx: Context<Launch>, args: LaunchArgs) -> Result<()> {
        let config = &ctx.accounts.config;
        let creator = ctx.accounts.creator.key();
        require!(
            config.launches_open || creator == config.admin || creator == config.launcher,
            PoolError::LaunchesClosed
        );
        require!(
            args.name.len() <= MAX_NAME_LEN && args.symbol.len() <= MAX_SYMBOL_LEN && args.uri.len() <= MAX_URI_LEN,
            PoolError::MetadataTooLong
        );
        require!(args.fee_bps >= config.min_fee_bps && args.fee_bps <= MAX_FEE_BPS, PoolError::OutOfBounds);
        let v = args.virtual_sol;
        require!((MIN_VIRTUAL_SOL..=MAX_VIRTUAL_SOL).contains(&v), PoolError::OutOfBounds);
        require!(
            args.graduation_mcap >= v * MIN_GRADUATION_MULTIPLE && args.graduation_mcap <= v * MAX_GRADUATION_MULTIPLE,
            PoolError::OutOfBounds
        );
        let graduation_sol = math::graduation_sol(v, args.graduation_mcap).ok_or(PoolError::MathOverflow)?;
        require!(config.launch_fee <= args.max_launch_fee, PoolError::LaunchFeeTooHigh);
        require!(
            args.opening_secs == 0 || (MIN_OPENING_SECS..=MAX_OPENING_SECS).contains(&args.opening_secs),
            PoolError::BadOpening
        );

        let a = &ctx.accounts;
        if config.launch_fee > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    System::id(),
                    anchor_lang::system_program::Transfer {
                        from: a.creator.to_account_info(),
                        to: a.treasury.to_account_info(),
                    },
                ),
                config.launch_fee,
            )?;
        }

        let mint_key = a.mint.key();
        let pool_bump = ctx.bumps.pool;
        let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[pool_bump]];
        let salt = args.salt.to_le_bytes();
        let mint_seeds: &[&[u8]] = &[MINT_SEED, creator.as_ref(), &salt, &[ctx.bumps.mint]];
        // No hook in this version.
        let hook: Option<&Pubkey> = None;
        let metadata = Metadata { name: &args.name, symbol: &args.symbol, uri: &args.uri };
        let (creator_info, mint, pool) = (a.creator.to_account_info(), a.mint.to_account_info(), a.pool.to_account_info());
        let (system, token_program) = (a.system_program.to_account_info(), a.token_program.to_account_info());

        token::create_mint_account(&creator_info, &mint, &system, hook.is_some(), &metadata, &pool.key(), mint_seeds)?;
        token::initialize_mint(&mint, &pool, &token_program, hook, &metadata, seeds)?;
        token::top_up_rent(&creator_info, &mint, &system)?;
        let vault = a.vault.to_account_info();
        token::create_vault(&creator_info, &vault, &pool, &mint, &system, &token_program)?;
        token::seal(&mint, &vault, &pool, SUPPLY, seeds)?;
        token::check_mint(&mint, hook, &metadata, SUPPLY)?;

        let now = Clock::get()?.unix_timestamp;
        let mut p = a.pool.load_init()?;
        p.mint = mint_key;
        p.creator = creator;
        p.treasury = config.treasury;
        p.vault = vault.key();
        p.hook_program = hook.copied().unwrap_or_default();
        p.virtual_sol = v;
        p.token_reserve = SUPPLY;
        p.graduation_sol = graduation_sol;
        p.graduation_mcap = args.graduation_mcap;
        p.opened_at = now;
        p.fee_bps = args.fee_bps;
        p.treasury_share_bps = config.treasury_share_bps;
        p.bump = pool_bump;
        if args.opening_secs > 0 {
            p.opens_at = now + args.opening_secs as i64;
            p.opening_state = OPENING_OPEN;
        }

        emit!(Launched {
            mint: mint_key,
            creator,
            hook_program: p.hook_program,
            virtual_sol: v,
            graduation_sol,
            fee_bps: args.fee_bps,
            opens_at: p.opens_at,
        });
        Ok(())
    }

    /// Spends `sol_in` lamports, fee included, on the coin. Fails unless at least
    /// `min_tokens_out` arrive. A coin with a hook would take its accounts after the listed ones.
    pub fn buy<'info>(ctx: Context<'info, Swap<'info>>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        let a = &ctx.accounts;
        let recipient = token::check_buyer_account(&a.trader_tokens, a.mint.key, &a.pool.key())?;

        let (outcome, hook, mint_key, bump, by_creator) = {
            let mut p = a.pool.load_mut()?;
            // a coin with an opening batch is bought through the batch until it is settled
            require!(p.opening_state != OPENING_OPEN, PoolError::NotOpenYet);
            let outcome = math::buy(p.reserves(), sol_in, p.fee_bps).map_err(PoolError::from)?;
            require!(outcome.tokens_out >= min_tokens_out, PoolError::Slippage);
            p.set_reserves(outcome.after);
            p.owe(outcome.fee)?;
            p.volume_sol = p.volume_sol.saturating_add(sol_in);
            if outcome.burned > 0 {
                p.burned = outcome.burned;
                p.graduated_at = Clock::get()?.unix_timestamp;
            }
            let hook = (p.hook_program != Pubkey::default()).then_some(p.hook_program);
            (outcome, hook, p.mint, p.bump, a.trader.key() == p.creator)
            // The borrow ends here: Token-2022 is about to be handed this account as a signer.
        };

        anchor_lang::system_program::transfer(
            CpiContext::new(
                System::id(),
                anchor_lang::system_program::Transfer { from: a.trader.to_account_info(), to: a.pool.to_account_info() },
            ),
            sol_in,
        )?;
        let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[bump]];
        let (pool, mint, vault) = (a.pool.to_account_info(), a.mint.to_account_info(), a.vault.to_account_info());
        token::transfer(
            &vault,
            &mint,
            &a.trader_tokens.to_account_info(),
            &pool,
            hook.as_ref(),
            ctx.remaining_accounts,
            outcome.tokens_out,
            &[seeds],
        )?;
        if outcome.burned > 0 {
            token::burn(&vault, &mint, &pool, outcome.burned, seeds)?;
            emit!(Graduated {
                mint: mint_key,
                real_sol: outcome.after.graduation_sol,
                token_reserve: outcome.after.tokens,
                burned: outcome.burned,
            });
        }
        check_solvent(&a.pool)?;
        emit!(TradeEvent {
            mint: mint_key,
            trader: a.trader.key(),
            recipient,
            buy: true,
            sol: sol_in,
            tokens: outcome.tokens_out,
            fee: outcome.fee,
            real_sol: outcome.after.real_sol,
            token_reserve: outcome.after.tokens,
            graduated: outcome.after.graduated,
            by_creator,
        });
        Ok(())
    }

    /// Sells `tokens_in` of the coin. Fails unless at least `min_sol_out` lamports arrive,
    /// after the fee. A coin with a hook would take its accounts after the listed ones.
    pub fn sell<'info>(ctx: Context<'info, Swap<'info>>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        let a = &ctx.accounts;
        let (outcome, hook, mint_key, by_creator) = {
            let mut p = a.pool.load_mut()?;
            let outcome = math::sell(p.reserves(), tokens_in, p.fee_bps).map_err(PoolError::from)?;
            require!(outcome.sol_out >= min_sol_out, PoolError::Slippage);
            p.set_reserves(outcome.after);
            p.owe(outcome.fee)?;
            p.volume_sol = p.volume_sol.saturating_add(outcome.sol_out + outcome.fee);
            let hook = (p.hook_program != Pubkey::default()).then_some(p.hook_program);
            (outcome, hook, p.mint, a.trader.key() == p.creator)
        };

        token::transfer(
            &a.trader_tokens.to_account_info(),
            &a.mint.to_account_info(),
            &a.vault.to_account_info(),
            &a.trader.to_account_info(),
            hook.as_ref(),
            ctx.remaining_accounts,
            tokens_in,
            &[],
        )?;
        // Moved by hand, and only after the last call into another program: the runtime
        // refuses a call made while lamports moved this way are still unbalanced.
        pay(&a.pool.to_account_info(), &a.trader.to_account_info(), outcome.sol_out)?;
        check_solvent(&a.pool)?;
        emit!(TradeEvent {
            mint: mint_key,
            trader: a.trader.key(),
            recipient: a.trader.key(),
            buy: false,
            sol: outcome.sol_out,
            tokens: tokens_in,
            fee: outcome.fee,
            real_sol: outcome.after.real_sol,
            token_reserve: outcome.after.tokens,
            graduated: outcome.after.graduated,
            by_creator,
        });
        Ok(())
    }

    /// Puts `sol` lamports into the coin's opening batch, adding to this wallet's seat (a new one if it has none),
    /// until the batch's last minute.
    pub fn commit(ctx: Context<Commit>, sol: u64) -> Result<()> {
        require!(sol >= MIN_COMMIT, PoolError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let (mint, total, fresh) = {
            let mut p = ctx.accounts.pool.load_mut()?;
            require!(p.opening_state == OPENING_OPEN, PoolError::NoOpening);
            require!(now < p.opens_at, PoolError::OpeningClosed);
            // the last minute takes no new SOL, so every seat sees the final total while it can still leave
            require!(now < p.opens_at - OPENING_LOCK_SECS, PoolError::OpeningLocked);
            p.opening_sol = p.opening_sol.checked_add(sol).ok_or(PoolError::MathOverflow)?;
            let fresh = ctx.accounts.seat.sol == 0;
            if fresh {
                p.opening_seats = p.opening_seats.checked_add(1).ok_or(PoolError::MathOverflow)?;
            }
            (p.mint, p.opening_sol, fresh)
        };
        let seat = &mut ctx.accounts.seat;
        if fresh {
            seat.owner = ctx.accounts.owner.key();
            seat.pool = ctx.accounts.pool.key();
            seat.bump = ctx.bumps.seat;
        }
        seat.sol = seat.sol.checked_add(sol).ok_or(PoolError::MathOverflow)?;
        let seat_sol = seat.sol;
        anchor_lang::system_program::transfer(
            CpiContext::new(
                System::id(),
                anchor_lang::system_program::Transfer { from: ctx.accounts.owner.to_account_info(), to: ctx.accounts.pool.to_account_info() },
            ),
            sol,
        )?;
        check_solvent(&ctx.accounts.pool)?;
        emit!(Committed { mint, owner: ctx.accounts.owner.key(), sol, seat_sol, total });
        Ok(())
    }

    /// Takes `sol` lamports back out of this wallet's seat, until the batch closes. A seat left empty closes, its
    /// rent back to the owner.
    pub fn withdraw(ctx: Context<Withdraw>, sol: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(sol > 0, PoolError::ZeroAmount);
        require!(sol <= ctx.accounts.seat.sol, PoolError::OutOfBounds);
        let left = ctx.accounts.seat.sol - sol;
        let (mint, total) = {
            let mut p = ctx.accounts.pool.load_mut()?;
            require!(p.opening_state == OPENING_OPEN, PoolError::NoOpening);
            require!(now < p.opens_at, PoolError::OpeningClosed);
            p.opening_sol = p.opening_sol.checked_sub(sol).ok_or(PoolError::MathOverflow)?;
            if left == 0 {
                p.opening_seats = p.opening_seats.saturating_sub(1);
            }
            (p.mint, p.opening_sol)
        };
        ctx.accounts.seat.sol = left;
        let owner = ctx.accounts.owner.to_account_info();
        pay(&ctx.accounts.pool.to_account_info(), &owner, sol)?;
        if left == 0 {
            ctx.accounts.seat.close(owner)?;
        }
        check_solvent(&ctx.accounts.pool)?;
        emit!(Withdrawn { mint, owner: ctx.accounts.owner.key(), sol, seat_sol: left, total });
        Ok(())
    }

    /// Ends the opening batch, once its window is over: one buy with all its SOL, and the tokens kept in the vault for
    /// the seats. Anyone may call. A batch under MIN_BATCH, or one the math refuses, buys nothing: the coin opens as
    /// it is and every seat takes its SOL back.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let a = &ctx.accounts;
        let now = Clock::get()?.unix_timestamp;
        let (outcome, mint_key, bump, total, seats) = {
            let mut p = a.pool.load_mut()?;
            require!(p.opening_state == OPENING_OPEN, PoolError::NoOpening);
            require!(now >= p.opens_at, PoolError::OpeningNotOver);
            let total = p.opening_sol;
            let outcome = if total >= MIN_BATCH { math::buy(p.reserves(), total, p.fee_bps).ok() } else { None };
            p.opening_total_sol = total;
            match &outcome {
                Some(o) => {
                    p.set_reserves(o.after);
                    p.owe(o.fee)?;
                    p.volume_sol = p.volume_sol.saturating_add(total);
                    if o.burned > 0 {
                        p.burned = o.burned;
                        p.graduated_at = now;
                    }
                    p.opening_tokens = o.tokens_out;
                    p.opening_tokens_left = o.tokens_out;
                    p.opening_sol = 0;
                    p.opening_state = OPENING_SETTLED;
                }
                // nothing bought: the SOL stays owed to the seats until each takes it back
                None => p.opening_state = if total == 0 { OPENING_SETTLED } else { OPENING_REFUND },
            }
            (outcome, p.mint, p.bump, total, p.opening_seats)
        };
        let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[bump]];
        if let Some(o) = &outcome {
            if o.burned > 0 {
                token::burn(&a.vault.to_account_info(), &a.mint.to_account_info(), &a.pool.to_account_info(), o.burned, seeds)?;
                emit!(Graduated { mint: mint_key, real_sol: o.after.graduation_sol, token_reserve: o.after.tokens, burned: o.burned });
            }
        }
        check_solvent(&a.pool)?;
        emit!(Settled { mint: mint_key, sol: total, tokens: outcome.as_ref().map_or(0, |o| o.tokens_out), seats, refund: outcome.is_none() && total > 0 });
        if let Some(o) = &outcome {
            // the batch's buy, as a trade by the pool itself: one price for every seat
            emit!(TradeEvent {
                mint: mint_key,
                trader: a.pool.key(),
                recipient: a.pool.key(),
                buy: true,
                sol: total,
                tokens: o.tokens_out,
                fee: o.fee,
                real_sol: o.after.real_sol,
                token_reserve: o.after.tokens,
                graduated: o.after.graduated,
                by_creator: false,
            });
        }
        Ok(())
    }

    /// After the settle: this wallet's share of the batch's tokens, for its SOL, into its token account; or, when the
    /// batch bought nothing, its SOL back. The seat closes and its rent goes back to the owner.
    pub fn claim_seat(ctx: Context<ClaimSeat>) -> Result<()> {
        let a = &ctx.accounts;
        let sol = a.seat.sol;
        let (refund, tokens, mint_key, bump) = {
            let mut p = a.pool.load_mut()?;
            let refund = match p.opening_state {
                OPENING_SETTLED => false,
                OPENING_REFUND => true,
                OPENING_OPEN => return err!(PoolError::OpeningNotOver),
                _ => return err!(PoolError::NoOpening),
            };
            let tokens = if refund || p.opening_total_sol == 0 {
                0
            } else {
                (p.opening_tokens as u128 * sol as u128 / p.opening_total_sol as u128) as u64
            };
            if refund {
                p.opening_sol = p.opening_sol.checked_sub(sol).ok_or(PoolError::MathOverflow)?;
            } else {
                p.opening_tokens_left = p.opening_tokens_left.checked_sub(tokens).ok_or(PoolError::MathOverflow)?;
            }
            p.opening_seats = p.opening_seats.saturating_sub(1);
            (refund, tokens, p.mint, p.bump)
        };
        if refund {
            pay(&a.pool.to_account_info(), &a.owner.to_account_info(), sol)?;
        } else if tokens > 0 {
            token::check_buyer_account(&a.owner_tokens, a.mint.key, &a.pool.key())?;
            let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[bump]];
            let pool = a.pool.to_account_info();
            token::transfer(&a.vault.to_account_info(), &a.mint.to_account_info(), &a.owner_tokens.to_account_info(), &pool, None, &[], tokens, &[seeds])?;
        }
        check_solvent(&a.pool)?;
        emit!(SeatClaimed { mint: mint_key, owner: a.owner.key(), sol, tokens, refund });
        Ok(())
    }

    /// Pays the creator everything the pool owes them.
    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        let (amount, mint) = {
            let mut p = ctx.accounts.pool.load_mut()?;
            let amount = p.creator_fees;
            require!(amount > 0, PoolError::NothingToClaim);
            p.creator_fees = 0;
            p.creator_fees_paid = p.creator_fees_paid.saturating_add(amount);
            (amount, p.mint)
        };
        let to = ctx.accounts.creator.key();
        pay(&ctx.accounts.pool.to_account_info(), &ctx.accounts.creator.to_account_info(), amount)?;
        check_solvent(&ctx.accounts.pool)?;
        emit!(FeesClaimed { mint, to, amount, creator: true });
        Ok(())
    }

    /// Pays the treasury written into the pool everything the pool owes it. Anyone may call:
    /// the SOL has only one place to go.
    pub fn claim_treasury_fees(ctx: Context<ClaimTreasuryFees>) -> Result<()> {
        let (amount, mint) = {
            let mut p = ctx.accounts.pool.load_mut()?;
            let amount = p.treasury_fees;
            require!(amount > 0, PoolError::NothingToClaim);
            p.treasury_fees = 0;
            p.treasury_fees_paid = p.treasury_fees_paid.saturating_add(amount);
            (amount, p.mint)
        };
        let to = ctx.accounts.treasury.key();
        pay(&ctx.accounts.pool.to_account_info(), &ctx.accounts.treasury.to_account_info(), amount)?;
        check_solvent(&ctx.accounts.pool)?;
        emit!(FeesClaimed { mint, to, amount, creator: false });
        Ok(())
    }

    /// Hands the creator's rights to someone else. Fees owed until now are paid to the
    /// creator who earned them, in the same call; the new creator collects from here on.
    pub fn set_creator(ctx: Context<SetCreator>, new_creator: Pubkey) -> Result<()> {
        // Nobody can sign for either address, so fees sent there would be stuck for good.
        require!(
            new_creator != Pubkey::default() && new_creator != ctx.accounts.pool.key(),
            PoolError::WrongAccount
        );
        let (settled, mint) = {
            let mut p = ctx.accounts.pool.load_mut()?;
            let settled = p.creator_fees;
            p.creator_fees = 0;
            p.creator_fees_paid = p.creator_fees_paid.saturating_add(settled);
            p.creator = new_creator;
            (settled, p.mint)
        };
        let from = ctx.accounts.creator.key();
        if settled > 0 {
            pay(&ctx.accounts.pool.to_account_info(), &ctx.accounts.creator.to_account_info(), settled)?;
        }
        check_solvent(&ctx.accounts.pool)?;
        emit!(CreatorChanged { mint, from, to: new_creator, settled });
        Ok(())
    }
}

/// Moves lamports out of the pool, which this program owns.
fn pay<'info>(pool: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    let left = pool.lamports().checked_sub(amount).ok_or(PoolError::Insolvent)?;
    let paid = to.lamports().checked_add(amount).ok_or(PoolError::MathOverflow)?;
    **pool.try_borrow_mut_lamports()? = left;
    **to.try_borrow_mut_lamports()? = paid;
    Ok(())
}

/// The pool must always hold its rent plus its reserve plus every fee it owes, and the opening batch's SOL.
fn check_solvent(pool: &AccountLoader<Pool>) -> Result<()> {
    let owed = pool.load()?.owed_lamports().ok_or(PoolError::MathOverflow)?;
    let info = pool.to_account_info();
    let floor = Rent::get()?.minimum_balance(info.data_len()).checked_add(owed).ok_or(PoolError::MathOverflow)?;
    require!(info.lamports() >= floor, PoolError::Insolvent);
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ConfigArgs {
    pub admin: Pubkey,
    pub launcher: Pubkey,
    pub treasury: Pubkey,
    pub launch_fee: u64,
    pub min_fee_bps: u16,
    pub treasury_share_bps: u16,
    pub launches_open: bool,
}

impl ConfigArgs {
    /// `treasury` is the account the args name, already checked to be a plain wallet.
    fn check(&self, treasury: &SystemAccount) -> Result<()> {
        require!(
            self.launch_fee <= MAX_LAUNCH_FEE
                && self.min_fee_bps <= MAX_FEE_BPS
                && self.treasury_share_bps as u64 <= math::BPS,
            PoolError::OutOfBounds
        );
        // Every pool keeps the treasury it was launched with. One that can't take a payment
        // would lock those pools' treasury fees, and every launch fee, for good.
        require!(treasury.lamports() >= Rent::get()?.minimum_balance(0), PoolError::UnusableTreasury);
        Ok(())
    }

    fn event(&self) -> ConfigUpdated {
        ConfigUpdated {
            admin: self.admin,
            launcher: self.launcher,
            treasury: self.treasury,
            launch_fee: self.launch_fee,
            min_fee_bps: self.min_fee_bps,
            treasury_share_bps: self.treasury_share_bps,
            launches_open: self.launches_open,
        }
    }

    fn write(&self, config: &mut Config) {
        config.admin = self.admin;
        config.launcher = self.launcher;
        config.treasury = self.treasury;
        config.launch_fee = self.launch_fee;
        config.min_fee_bps = self.min_fee_bps;
        config.treasury_share_bps = self.treasury_share_bps;
        config.launches_open = self.launches_open;
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LaunchArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
    /// Virtual SOL, which is also the opening market cap on the full supply.
    pub virtual_sol: u64,
    /// Market cap on the full supply at which the curve graduates.
    pub graduation_mcap: u64,
    pub fee_bps: u16,
    /// The most the creator agrees to pay as launch fee, in case the config changes first.
    pub max_launch_fee: u64,
    /// Picks the coin's address: the mint is the program's address for [MINT_SEED, creator, salt]. Any number the
    /// creator has not launched with before.
    pub salt: u64,
    /// 0 to open at once, or the opening batch's window in seconds (MIN_OPENING_SECS to MAX_OPENING_SECS).
    pub opening_secs: u32,
}

#[derive(Accounts)]
#[instruction(args: ConfigArgs)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// The treasury the args name. Writable, owned by the system program and holding its rent:
    /// an address that can receive SOL. The runtime makes programs and sysvars read-only.
    #[account(mut, address = args.treasury @ PoolError::UnusableTreasury)]
    pub treasury: SystemAccount<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ PoolError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::Dex>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ PoolError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ConfigArgs)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    /// As in `InitConfig`.
    #[account(mut, address = args.treasury @ PoolError::UnusableTreasury)]
    pub treasury: SystemAccount<'info>,
}

#[derive(Accounts)]
#[instruction(args: LaunchArgs)]
pub struct Launch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: the new coin, created by `launch` at the program's own address for the creator and the salt, so no
    /// one else can have made it, or an account for it, before.
    #[account(mut, seeds = [MINT_SEED, creator.key().as_ref(), &args.salt.to_le_bytes()], bump)]
    pub mint: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = creator, space = Pool::LEN, seeds = [POOL_SEED, mint.key().as_ref()], bump)]
    pub pool: AccountLoader<'info, Pool>,
    /// CHECK: the pool's associated token account, created here.
    #[account(mut, address = token::associated_address(&pool.key(), &mint.key()) @ PoolError::WrongAccount)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: receives the launch fee.
    #[account(mut, address = config.treasury @ PoolError::WrongAccount)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: Token-2022, by address.
    #[account(address = TOKEN_2022 @ PoolError::WrongAccount)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: the associated token program, by address.
    #[account(address = token::ATA_PROGRAM @ PoolError::WrongAccount)]
    pub associated_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut, has_one = mint @ PoolError::WrongAccount, has_one = vault @ PoolError::WrongAccount)]
    pub pool: AccountLoader<'info, Pool>,
    /// CHECK: the pool's mint, by `has_one`. Writable because the buy that graduates the
    /// curve burns, which changes the supply.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the pool's vault, by `has_one`.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the trader's account for this coin. Token-2022 checks that it is of this mint
    /// and, on a sell, that the trader owns it.
    #[account(mut)]
    pub trader_tokens: UncheckedAccount<'info>,
    /// CHECK: Token-2022, by address.
    #[account(address = TOKEN_2022 @ PoolError::WrongAccount)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Commit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(
        init_if_needed, payer = owner, space = 8 + Seat::INIT_SPACE,
        seeds = [SEAT_SEED, pool.key().as_ref(), owner.key().as_ref()], bump
    )]
    pub seat: Account<'info, Seat>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(
        mut, seeds = [SEAT_SEED, pool.key().as_ref(), owner.key().as_ref()], bump = seat.bump,
        has_one = owner @ PoolError::WrongAccount, has_one = pool @ PoolError::WrongAccount
    )]
    pub seat: Account<'info, Seat>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, has_one = mint @ PoolError::WrongAccount, has_one = vault @ PoolError::WrongAccount)]
    pub pool: AccountLoader<'info, Pool>,
    /// CHECK: the pool's mint, by `has_one`. Writable: a batch that graduates burns.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the pool's vault, by `has_one`.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Token-2022, by address.
    #[account(address = TOKEN_2022 @ PoolError::WrongAccount)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimSeat<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = mint @ PoolError::WrongAccount, has_one = vault @ PoolError::WrongAccount)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(
        mut, close = owner, seeds = [SEAT_SEED, pool.key().as_ref(), owner.key().as_ref()], bump = seat.bump,
        has_one = owner @ PoolError::WrongAccount, has_one = pool @ PoolError::WrongAccount
    )]
    pub seat: Account<'info, Seat>,
    /// CHECK: the pool's mint, by `has_one`.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the pool's vault, by `has_one`.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the owner's account for this coin; the pool checks it is clean, Token-2022 that it is of this mint.
    /// Not touched when the batch bought nothing.
    #[account(mut)]
    pub owner_tokens: UncheckedAccount<'info>,
    /// CHECK: Token-2022, by address.
    #[account(address = TOKEN_2022 @ PoolError::WrongAccount)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator @ PoolError::WrongAccount)]
    pub pool: AccountLoader<'info, Pool>,
}

#[derive(Accounts)]
pub struct ClaimTreasuryFees<'info> {
    #[account(mut, has_one = treasury @ PoolError::WrongAccount)]
    pub pool: AccountLoader<'info, Pool>,
    /// CHECK: the treasury written into the pool, by `has_one`.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetCreator<'info> {
    /// Writable: it receives the fees owed so far.
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator @ PoolError::WrongAccount)]
    pub pool: AccountLoader<'info, Pool>,
}

#[event]
pub struct Launched {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub hook_program: Pubkey,
    pub virtual_sol: u64,
    pub graduation_sol: u64,
    pub fee_bps: u16,
    /// When the opening batch closes; 0 when the coin opened at once.
    pub opens_at: i64,
}

#[event]
pub struct Committed {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub sol: u64,
    /// The seat's SOL after it, and the batch's.
    pub seat_sol: u64,
    pub total: u64,
}

#[event]
pub struct Withdrawn {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub sol: u64,
    pub seat_sol: u64,
    pub total: u64,
}

#[event]
pub struct Settled {
    pub mint: Pubkey,
    /// The batch's SOL, the tokens it bought, and the seats sharing them. `refund`: it bought nothing, each seat
    /// takes its SOL back.
    pub sol: u64,
    pub tokens: u64,
    pub seats: u32,
    pub refund: bool,
}

#[event]
pub struct SeatClaimed {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub sol: u64,
    pub tokens: u64,
    pub refund: bool,
}

#[event]
pub struct TradeEvent {
    pub mint: Pubkey,
    /// Who signed and paid.
    pub trader: Pubkey,
    /// Who owns the tokens: on a buy, the owner of the account paid into, which may not be
    /// the payer; on a sell, the trader.
    pub recipient: Pubkey,
    pub buy: bool,
    /// Paid in, fee included, on a buy; received, after the fee, on a sell.
    pub sol: u64,
    pub tokens: u64,
    pub fee: u64,
    pub real_sol: u64,
    pub token_reserve: u64,
    pub graduated: bool,
    /// The trader is the pool's creator at the time.
    pub by_creator: bool,
}

#[event]
pub struct Graduated {
    pub mint: Pubkey,
    pub real_sol: u64,
    pub token_reserve: u64,
    pub burned: u64,
}

#[event]
pub struct FeesClaimed {
    pub mint: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    /// The creator's share, or the treasury's.
    pub creator: bool,
}

#[event]
pub struct CreatorChanged {
    pub mint: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    /// Fees owed to `from`, paid in the same call.
    pub settled: u64,
}

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub launcher: Pubkey,
    pub treasury: Pubkey,
    pub launch_fee: u64,
    pub min_fee_bps: u16,
    pub treasury_share_bps: u16,
    pub launches_open: bool,
}

/// Numbered from 7000, clear of Anchor's default 6000, where a transfer hook written with
/// Anchor would number its own: a hook's failure surfaces on this program's instruction.
#[error_code(offset = 7000)]
pub enum PoolError {
    #[msg("Only the program's upgrade authority can create the config")]
    NotUpgradeAuthority,
    #[msg("Launches are closed to the public for now")]
    LaunchesClosed,
    #[msg("A number is outside what the program allows")]
    OutOfBounds,
    #[msg("The launch fee is higher than the creator accepted")]
    LaunchFeeTooHigh,
    #[msg("Name, symbol or link is too long")]
    MetadataTooLong,
    #[msg("The mint address already holds data or belongs to a program")]
    MintTaken,
    #[msg("The new mint is not exactly what the program built")]
    MintMismatch,
    #[msg("An account is not the one this pool expects")]
    WrongAccount,
    #[msg("The trade would pay out less than the minimum asked")]
    Slippage,
    #[msg("The trade is too small to move anything")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Tokens cannot be bought into the pool's own account")]
    PoolAsBuyer,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("The pool would hold less SOL than it owes")]
    Insolvent,
    #[msg("The account to pay into is frozen or carries extensions from an earlier mint")]
    UnsafeBuyerAccount,
    #[msg("The treasury must be a wallet that already holds its rent")]
    UnusableTreasury,
    #[msg("The opening window must be 2 to 15 minutes, or none")]
    BadOpening,
    #[msg("This coin has no opening batch going on")]
    NoOpening,
    #[msg("The opening batch has closed")]
    OpeningClosed,
    #[msg("Commitments close in the opening batch's last minute")]
    OpeningLocked,
    #[msg("The opening batch is still open")]
    OpeningNotOver,
    #[msg("Buying opens once the opening batch is settled")]
    NotOpenYet,
}

impl From<MathError> for PoolError {
    fn from(e: MathError) -> Self {
        match e {
            MathError::Overflow => PoolError::MathOverflow,
            MathError::ZeroOut => PoolError::ZeroAmount,
        }
    }
}
