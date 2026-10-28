//! One pool per coin, for the coin's whole life.
//!
//! A coin launches into a bonding curve priced against virtual SOL. When enough real SOL has
//! come in, the curve graduates inside the buy that gets it there: the virtual SOL is dropped,
//! the tokens above the current price are burned, and the same pool goes on as a plain
//! constant-product pool. The coin never leaves this program, so whatever the pool does at
//! launch it still does years later.
//!
//! Coins carry no transfer hook in this version. The trading path already passes a hook's
//! accounts along, for the version that adds one.
//!
//! Fees are taken in SOL and owed to the creator and to the treasury written into the pool at
//! launch. There is no LP token, the liquidity stays for good, and no instruction lets anyone
//! take a pool's SOL or tokens except by trading or claiming those fees.
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
    /// after this one in the same transaction.
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

        emit!(Launched {
            mint: mint_key,
            creator,
            hook_program: p.hook_program,
            virtual_sol: v,
            graduation_sol,
            fee_bps: args.fee_bps,
        });
        Ok(())
    }

    /// Spends `sol_in` lamports, fee included, on the coin. Fails unless at least
    /// `min_tokens_out` arrive. A coin with a hook would take its accounts after the listed ones.
    pub fn buy<'info>(ctx: Context<'info, Swap<'info>>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        let a = &ctx.accounts;
        let recipient = token::check_buyer_account(&a.trader_tokens, a.mint.key, &a.pool.key())?;

        let (outcome, hook, mint_key, bump) = {
            let mut p = a.pool.load_mut()?;
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
            (outcome, hook, p.mint, p.bump)
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
        });
        Ok(())
    }

    /// Sells `tokens_in` of the coin. Fails unless at least `min_sol_out` lamports arrive,
    /// after the fee. A coin with a hook would take its accounts after the listed ones.
    pub fn sell<'info>(ctx: Context<'info, Swap<'info>>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        let a = &ctx.accounts;
        let (outcome, hook, mint_key) = {
            let mut p = a.pool.load_mut()?;
            let outcome = math::sell(p.reserves(), tokens_in, p.fee_bps).map_err(PoolError::from)?;
            require!(outcome.sol_out >= min_sol_out, PoolError::Slippage);
            p.set_reserves(outcome.after);
            p.owe(outcome.fee)?;
            p.volume_sol = p.volume_sol.saturating_add(outcome.sol_out + outcome.fee);
            let hook = (p.hook_program != Pubkey::default()).then_some(p.hook_program);
            (outcome, hook, p.mint)
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
        });
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

/// The pool must always hold its rent plus its reserve plus every fee it owes.
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
}

impl From<MathError> for PoolError {
    fn from(e: MathError) -> Self {
        match e {
            MathError::Overflow => PoolError::MathOverflow,
            MathError::ZeroOut => PoolError::ZeroAmount,
        }
    }
}
