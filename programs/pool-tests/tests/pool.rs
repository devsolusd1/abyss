//! The compiled pool, run inside LiteSVM next to the real Token-2022.
//!
//! Build the program first (`cargo build-sbf` in `../pool`; test.sh does it) and point
//! `POOL_SO` at the binary if it is not in `~/dex-target`.

use {
    anchor_lang::{InstructionData, ToAccountMetas},
    dex::{
        math,
        state::{
            Pool, CONFIG_SEED, MINT_SEED, MIN_OPENING_SECS, OPENING_LOCK_SECS, OPENING_REFUND, OPENING_SETTLED, POOL_SEED, SEAT_SEED,
            SUPPLY,
        },
        token::{ATA_PROGRAM, TOKEN_2022},
        ConfigArgs, LaunchArgs, PoolError,
    },
    litesvm::{types::{TransactionMetadata, TransactionResult}, LiteSVM},
    solana_address::Address,
    solana_clock::Clock,
    solana_instruction::{account_meta::AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
    solana_system_interface::instruction::{create_account, transfer as send_sol},
    solana_transaction::Transaction,
    solana_transaction_error::TransactionError,
};

const SOL: u64 = 1_000_000_000;
const TOKEN: u64 = 1_000_000;
/// The numbers the user chose: open at 30 SOL of market cap, graduate at 420, 1% split evenly.
const VIRTUAL: u64 = 30 * SOL;
const GRADUATION_MCAP: u64 = 420 * SOL;
const FEE_BPS: u16 = 100;
const LAUNCH_FEE: u64 = SOL / 100;
const T0: i64 = 1_800_000_000;

const SYSTEM_PROGRAM: Address = Address::new_from_array([0; 32]);
const LOADER: Address = Address::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");
const COMPUTE_BUDGET: Address = Address::from_str_const("ComputeBudget111111111111111111111111111111");

fn so(var: &str, under_target: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| format!("{}/dex-target/{under_target}", std::env::var("HOME").unwrap()))
}

fn ata(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

/// A coin's mint: the program's address for the creator and the salt.
fn mint_for(creator: &Address, salt: u64) -> Address {
    Address::find_program_address(&[MINT_SEED, creator.as_ref(), &salt.to_le_bytes()], &dex::ID).0
}

/// A salt no test has used yet.
fn fresh_salt() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Anchor's "a seeds constraint was violated" (ConstraintSeeds).
const WRONG_SEEDS: InstructionError = InstructionError::Custom(2006);

fn config_address() -> Address {
    Address::find_program_address(&[CONFIG_SEED], &dex::ID).0
}

fn program_data() -> Address {
    Address::find_program_address(&[dex::ID.as_ref()], &LOADER).0
}

/// A launched coin and the addresses that come with it.
#[derive(Clone, Copy)]
struct Coin {
    mint: Address,
    pool: Address,
    vault: Address,
}

impl Coin {
    fn of(mint: Address) -> Self {
        let pool = Address::find_program_address(&[POOL_SEED, mint.as_ref()], &dex::ID).0;
        Coin { mint, pool, vault: ata(&pool, &mint) }
    }
}

struct Env {
    svm: LiteSVM,
    /// The program's upgrade authority, and the config's admin.
    admin: Keypair,
    /// Allowed to launch while launches are closed.
    launcher: Keypair,
    treasury: Address,
    alice: Keypair,
    bob: Keypair,
}

impl Env {
    /// The program loaded, the admin as upgrade authority, no config yet.
    fn bare() -> Self {
        let mut svm = LiteSVM::new();
        let pool_so = so("POOL_SO", "pool/deploy/dex.so");
        svm.add_program_from_file(dex::ID, &pool_so)
            .unwrap_or_else(|e| panic!("build the program first; could not load {pool_so}: {e:?}"));
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = T0;
        svm.set_sysvar(&clock);

        let keys: [Keypair; 4] = std::array::from_fn(|_| Keypair::new());
        let [admin, launcher, alice, bob] = keys;
        for key in [&admin, &launcher, &alice, &bob] {
            svm.airdrop(&key.pubkey(), 10_000 * SOL).unwrap();
        }
        let treasury = Keypair::new().pubkey();
        svm.airdrop(&treasury, SOL).unwrap();

        // LiteSVM loads programs with no upgrade authority; give it to the admin.
        let mut data = svm.get_account(&program_data()).unwrap();
        data.data[12] = 1;
        data.data[13..45].copy_from_slice(admin.pubkey().as_ref());
        svm.set_account(program_data(), data).unwrap();

        Env { svm, admin, launcher, treasury, alice, bob }
    }

    /// Ready to launch: the config made by the admin, launches closed.
    fn new() -> Self {
        let mut env = Env::bare();
        let admin = env.admin.insecure_clone();
        let args = env.config_args();
        env.send(&admin, vec![env.init_config_ix(&admin.pubkey(), args)], &[]).unwrap();
        env
    }

    fn config_args(&self) -> ConfigArgs {
        ConfigArgs {
            admin: self.admin.pubkey(),
            launcher: self.launcher.pubkey(),
            treasury: self.treasury,
            launch_fee: LAUNCH_FEE,
            min_fee_bps: 100,
            treasury_share_bps: 5_000,
            launches_open: false,
        }
    }

    fn init_config_ix(&self, signer: &Address, args: ConfigArgs) -> Instruction {
        let accounts = dex::accounts::InitConfig {
            admin: *signer,
            config: config_address(),
            treasury: args.treasury,
            program: dex::ID,
            program_data: program_data(),
            system_program: SYSTEM_PROGRAM,
        };
        Instruction {
            program_id: dex::ID,
            accounts: accounts.to_account_metas(None),
            data: dex::instruction::InitConfig { args }.data(),
        }
    }

    fn update_config(&mut self, signer: &Keypair, args: ConfigArgs) -> TransactionResult {
        let accounts = dex::accounts::UpdateConfig { admin: signer.pubkey(), config: config_address(), treasury: args.treasury };
        let ix = Instruction {
            program_id: dex::ID,
            accounts: accounts.to_account_metas(None),
            data: dex::instruction::UpdateConfig { args }.data(),
        };
        self.send(signer, vec![ix], &[])
    }

    /// Sends `ixs` paid by `payer`, with room for every CPI the launch makes.
    fn send(&mut self, payer: &Keypair, ixs: Vec<Instruction>, signers: &[&Keypair]) -> TransactionResult {
        self.svm.expire_blockhash();
        let mut limit = vec![2];
        limit.extend_from_slice(&1_400_000u32.to_le_bytes());
        let mut all = vec![Instruction { program_id: COMPUTE_BUDGET, accounts: vec![], data: limit }];
        all.extend(ixs);
        let mut keys = vec![payer];
        keys.extend(signers);
        let message = Message::new(&all, Some(&payer.pubkey()));
        self.svm.send_transaction(Transaction::new(&keys, message, self.svm.latest_blockhash()))
    }

    fn args(&self) -> LaunchArgs {
        LaunchArgs {
            name: "Test coin".into(),
            symbol: "TEST".into(),
            uri: "https://example.com/test.json".into(),
            virtual_sol: VIRTUAL,
            graduation_mcap: GRADUATION_MCAP,
            fee_bps: FEE_BPS,
            max_launch_fee: LAUNCH_FEE,
            salt: 0,
            opening_secs: 0,
        }
    }

    fn launch_ix(&self, creator: &Address, mint: &Address, args: LaunchArgs) -> Instruction {
        let coin = Coin::of(*mint);
        let accounts = dex::accounts::Launch {
            creator: *creator,
            mint: *mint,
            config: config_address(),
            pool: coin.pool,
            vault: coin.vault,
            treasury: self.treasury,
            token_program: TOKEN_2022,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM_PROGRAM,
        };
        Instruction {
            program_id: dex::ID,
            accounts: accounts.to_account_metas(None),
            data: dex::instruction::Launch { args }.data(),
        }
    }

    /// A launch at the creator's next address (a fresh salt). Only the creator signs: the mint is the program's.
    fn launch_as(&mut self, creator: &Keypair, args: LaunchArgs) -> Result<Coin, InstructionError> {
        let args = LaunchArgs { salt: fresh_salt(), ..args };
        let mint = mint_for(&creator.pubkey(), args.salt);
        let coin = Coin::of(mint);
        let ix = self.launch_ix(&creator.pubkey(), &mint, args);
        self.send(creator, vec![ix], &[]).map(|_| coin).map_err(|e| match e.err {
            TransactionError::InstructionError(_, error) => error,
            other => panic!("failed outside the instruction: {other:?}"),
        })
    }

    /// A coin launched by the admin with the usual numbers.
    fn launch(&mut self) -> Coin {
        let admin = self.admin.insecure_clone();
        let args = self.args();
        self.launch_as(&admin, args).unwrap()
    }

    fn open_account_ix(payer: &Address, owner: &Address, mint: &Address) -> Instruction {
        Instruction {
            program_id: ATA_PROGRAM,
            accounts: vec![
                AccountMeta::new(*payer, true),
                AccountMeta::new(ata(owner, mint), false),
                AccountMeta::new_readonly(*owner, false),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
                AccountMeta::new_readonly(TOKEN_2022, false),
            ],
            data: vec![1],
        }
    }

    fn swap_ix(coin: &Coin, trader: &Address, trader_tokens: Address, data: Vec<u8>) -> Instruction {
        let accounts = dex::accounts::Swap {
            trader: *trader,
            pool: coin.pool,
            mint: coin.mint,
            vault: coin.vault,
            trader_tokens,
            token_program: TOKEN_2022,
            system_program: SYSTEM_PROGRAM,
        }
        .to_account_metas(None);
        Instruction { program_id: dex::ID, accounts, data }
    }

    fn buy(&mut self, coin: &Coin, trader: &Keypair, sol_in: u64) -> TransactionResult {
        self.buy_min(coin, trader, sol_in, 0)
    }

    fn buy_min(&mut self, coin: &Coin, trader: &Keypair, sol_in: u64, min_tokens_out: u64) -> TransactionResult {
        let who = trader.pubkey();
        let data = dex::instruction::Buy { sol_in, min_tokens_out }.data();
        let ixs = vec![
            Env::open_account_ix(&who, &who, &coin.mint),
            Env::swap_ix(coin, &who, ata(&who, &coin.mint), data),
        ];
        self.send(trader, ixs, &[])
    }

    fn sell(&mut self, coin: &Coin, trader: &Keypair, tokens_in: u64) -> TransactionResult {
        let who = trader.pubkey();
        let data = dex::instruction::Sell { tokens_in, min_sol_out: 0 }.data();
        let ix = Env::swap_ix(coin, &who, ata(&who, &coin.mint), data);
        self.send(trader, vec![ix], &[])
    }

    fn claim_creator(&mut self, coin: &Coin, creator: &Keypair) -> TransactionResult {
        let accounts = dex::accounts::ClaimCreatorFees { creator: creator.pubkey(), pool: coin.pool };
        let ix = Instruction {
            program_id: dex::ID,
            accounts: accounts.to_account_metas(None),
            data: dex::instruction::ClaimCreatorFees {}.data(),
        };
        self.send(creator, vec![ix], &[])
    }

    fn claim_treasury(&mut self, coin: &Coin, caller: &Keypair) -> TransactionResult {
        let accounts = dex::accounts::ClaimTreasuryFees { pool: coin.pool, treasury: self.treasury };
        let ix = Instruction {
            program_id: dex::ID,
            accounts: accounts.to_account_metas(None),
            data: dex::instruction::ClaimTreasuryFees {}.data(),
        };
        self.send(caller, vec![ix], &[])
    }

    fn seat_of(coin: &Coin, owner: &Address) -> Address {
        Address::find_program_address(&[SEAT_SEED, coin.pool.as_ref(), owner.as_ref()], &dex::ID).0
    }

    fn commit_ix(coin: &Coin, owner: &Address, sol: u64) -> Instruction {
        let accounts = dex::accounts::Commit { owner: *owner, pool: coin.pool, seat: Env::seat_of(coin, owner), system_program: SYSTEM_PROGRAM };
        Instruction { program_id: dex::ID, accounts: accounts.to_account_metas(None), data: dex::instruction::Commit { sol }.data() }
    }

    fn commit(&mut self, coin: &Coin, owner: &Keypair, sol: u64) -> TransactionResult {
        let ix = Env::commit_ix(coin, &owner.pubkey(), sol);
        self.send(owner, vec![ix], &[])
    }

    fn withdraw_ix(coin: &Coin, owner: &Address, sol: u64) -> Instruction {
        let accounts = dex::accounts::Withdraw { owner: *owner, pool: coin.pool, seat: Env::seat_of(coin, owner) };
        Instruction { program_id: dex::ID, accounts: accounts.to_account_metas(None), data: dex::instruction::Withdraw { sol }.data() }
    }

    fn withdraw(&mut self, coin: &Coin, owner: &Keypair, sol: u64) -> TransactionResult {
        let ix = Env::withdraw_ix(coin, &owner.pubkey(), sol);
        self.send(owner, vec![ix], &[])
    }

    /// The seat's SOL, or None once it is closed.
    fn seat_sol(&self, coin: &Coin, owner: &Address) -> Option<u64> {
        let account = self.svm.get_account(&Env::seat_of(coin, owner)).filter(|a| a.lamports > 0)?;
        // discriminator, owner, pool, then the SOL
        Some(u64::from_le_bytes(account.data[72..80].try_into().unwrap()))
    }

    fn settle(&mut self, coin: &Coin, caller: &Keypair) -> TransactionResult {
        let accounts = dex::accounts::Settle { pool: coin.pool, mint: coin.mint, vault: coin.vault, token_program: TOKEN_2022 };
        let ix = Instruction { program_id: dex::ID, accounts: accounts.to_account_metas(None), data: dex::instruction::Settle {}.data() };
        self.send(caller, vec![ix], &[])
    }

    /// The seat's tokens into the owner's account (opened in the same transaction), or its SOL back.
    fn claim_seat(&mut self, coin: &Coin, owner: &Keypair, open_account: bool) -> TransactionResult {
        let who = owner.pubkey();
        let accounts = dex::accounts::ClaimSeat {
            owner: who, pool: coin.pool, seat: Env::seat_of(coin, &who), mint: coin.mint, vault: coin.vault,
            owner_tokens: ata(&who, &coin.mint), token_program: TOKEN_2022,
        };
        let mut ixs = vec![];
        if open_account {
            ixs.push(Env::open_account_ix(&who, &who, &coin.mint));
        }
        ixs.push(Instruction { program_id: dex::ID, accounts: accounts.to_account_metas(None), data: dex::instruction::ClaimSeat {}.data() });
        self.send(owner, ixs, &[])
    }

    fn warp(&mut self, to: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = to;
        self.svm.set_sysvar(&clock);
    }

    fn pool(&self, coin: &Coin) -> Pool {
        let account = self.svm.get_account(&coin.pool).unwrap();
        bytemuck::pod_read_unaligned(&account.data[8..8 + std::mem::size_of::<Pool>()])
    }

    fn tokens(&self, owner: &Address, coin: &Coin) -> u64 {
        self.tokens_at(&ata(owner, &coin.mint))
    }

    fn tokens_at(&self, account: &Address) -> u64 {
        match self.svm.get_account(account) {
            Some(account) => u64::from_le_bytes(account.data[64..72].try_into().unwrap()),
            None => 0,
        }
    }

    fn lamports(&self, address: &Address) -> u64 {
        self.svm.get_balance(address).unwrap_or(0)
    }

    /// The mint's supply, mint authority option and freeze authority option.
    fn mint(&self, coin: &Coin) -> (u64, u32, u32) {
        let data = self.svm.get_account(&coin.mint).unwrap().data;
        let supply = u64::from_le_bytes(data[36..44].try_into().unwrap());
        let mint_auth = u32::from_le_bytes(data[0..4].try_into().unwrap());
        let freeze = u32::from_le_bytes(data[46..50].try_into().unwrap());
        (supply, mint_auth, freeze)
    }

    /// The books every trade has to leave straight: the pool's SOL covers its rent, reserve,
    /// fees owed and the opening batch's SOL, and the vault holds the reserve plus the batch's
    /// unclaimed tokens.
    fn check_books(&self, coin: &Coin) {
        let p = self.pool(coin);
        let account = self.svm.get_account(&coin.pool).unwrap();
        let rent = self.svm.minimum_balance_for_rent_exemption(account.data.len());
        assert_eq!(account.lamports, rent + p.real_sol + p.creator_fees + p.treasury_fees + p.opening_sol, "pool lamports");
        assert_eq!(self.tokens_at(&coin.vault), p.token_reserve + p.opening_tokens_left, "vault balance");
        assert_eq!(self.mint(coin).0, SUPPLY - p.burned, "supply");
    }
}

/// The instruction error a failed transaction ended with.
fn error(result: TransactionResult) -> InstructionError {
    match result.expect_err("transaction should have failed").err {
        TransactionError::InstructionError(_, error) => error,
        other => panic!("failed outside the instruction: {other:?}"),
    }
}

/// The pool's own errors, numbered from 7000.
fn pool_error(e: PoolError) -> InstructionError {
    InstructionError::Custom(7000 + e as u32)
}

/// Compute units a successful transaction used, the compute-budget instruction included.
fn units(result: TransactionResult) -> u64 {
    result.unwrap().compute_units_consumed
}

/// Calls the pool made to the System Program in a transaction, read off its logs: a `commit` makes two when it creates
/// the seat (create_account, then the transfer) and one when the seat was already there.
fn system_calls(meta: &TransactionMetadata) -> usize {
    meta.logs.iter().filter(|l| *l == "Program 11111111111111111111111111111111 invoke [2]").count()
}

fn reserves(p: &Pool) -> math::Reserves {
    math::Reserves {
        virtual_sol: p.virtual_sol,
        real_sol: p.real_sol,
        tokens: p.token_reserve,
        graduation_sol: p.graduation_sol,
        graduated: p.graduated != 0,
    }
}

#[test]
fn only_the_upgrade_authority_creates_the_config() {
    let mut env = Env::bare();
    let stranger = env.alice.insecure_clone();
    let args = env.config_args();
    let ix = env.init_config_ix(&stranger.pubkey(), args.clone());
    assert_eq!(error(env.send(&stranger, vec![ix], &[])), pool_error(PoolError::NotUpgradeAuthority));

    let admin = env.admin.insecure_clone();
    let ix = env.init_config_ix(&admin.pubkey(), args.clone());
    env.send(&admin, vec![ix], &[]).unwrap();
    // Once only.
    let ix = env.init_config_ix(&admin.pubkey(), args);
    assert!(env.send(&admin, vec![ix], &[]).is_err());
}

#[test]
fn launch_builds_a_sealed_coin() {
    let mut env = Env::new();
    let before = env.lamports(&env.treasury);
    let coin = env.launch();

    let (supply, mint_authority, freeze_authority) = env.mint(&coin);
    assert_eq!((supply, mint_authority, freeze_authority), (SUPPLY, 0, 0));
    assert_eq!(env.tokens_at(&coin.vault), SUPPLY);
    assert_eq!(env.lamports(&env.treasury), before + LAUNCH_FEE);

    let p = env.pool(&coin);
    assert_eq!(p.mint, coin.mint);
    assert_eq!(p.creator, env.admin.pubkey());
    assert_eq!(p.treasury, env.treasury);
    assert_eq!(p.vault, coin.vault);
    assert_eq!(p.hook_program, Address::default());
    assert_eq!((p.virtual_sol, p.real_sol, p.token_reserve), (VIRTUAL, 0, SUPPLY));
    assert_eq!(p.graduation_sol, math::graduation_sol(VIRTUAL, GRADUATION_MCAP).unwrap());
    assert_eq!((p.fee_bps, p.treasury_share_bps, p.graduated), (FEE_BPS, 5_000, 0));
    assert_eq!(p.opened_at, T0);
    env.check_books(&coin);
}

#[test]
fn launches_are_closed_to_the_public_until_opened() {
    let mut env = Env::new();
    let (alice, launcher, admin) = (env.alice.insecure_clone(), env.launcher.insecure_clone(), env.admin.insecure_clone());
    let args = env.args();
    assert_eq!(env.launch_as(&alice, args.clone()).err(), Some(pool_error(PoolError::LaunchesClosed)));
    env.launch_as(&launcher, args.clone()).unwrap();

    // Only the admin can open them.
    let open = ConfigArgs { launches_open: true, ..env.config_args() };
    assert!(env.update_config(&alice, open.clone()).is_err());
    env.update_config(&admin, open).unwrap();
    env.launch_as(&alice, args).unwrap();
}

#[test]
fn launch_numbers_stay_inside_the_bounds() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let base = env.args();
    let refused = [
        (LaunchArgs { fee_bps: 301, ..base.clone() }, PoolError::OutOfBounds),
        // Below the config's minimum of 1%.
        (LaunchArgs { fee_bps: 50, ..base.clone() }, PoolError::OutOfBounds),
        (LaunchArgs { virtual_sol: SOL / 2, graduation_mcap: 10 * SOL, ..base.clone() }, PoolError::OutOfBounds),
        (LaunchArgs { graduation_mcap: VIRTUAL * 3 / 2, ..base.clone() }, PoolError::OutOfBounds),
        (LaunchArgs { graduation_mcap: VIRTUAL * 101, ..base.clone() }, PoolError::OutOfBounds),
        (LaunchArgs { max_launch_fee: LAUNCH_FEE - 1, ..base.clone() }, PoolError::LaunchFeeTooHigh),
        (LaunchArgs { name: "x".repeat(33), ..base.clone() }, PoolError::MetadataTooLong),
    ];
    for (args, expected) in refused {
        assert_eq!(env.launch_as(&admin, args).err(), Some(pool_error(expected)));
    }
    // A config can't set a minimum fee above the program's ceiling either.
    let too_high = ConfigArgs { min_fee_bps: 301, ..env.config_args() };
    assert_eq!(error(env.update_config(&admin, too_high)), pool_error(PoolError::OutOfBounds));
}

#[test]
fn trades_follow_the_math() {
    let mut env = Env::new();
    let coin = env.launch();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.insecure_clone());

    let expected = math::buy(reserves(&env.pool(&coin)), SOL, FEE_BPS).unwrap();
    env.buy(&coin, &alice, SOL).unwrap();
    assert_eq!(env.tokens(&alice.pubkey(), &coin), expected.tokens_out);
    let p = env.pool(&coin);
    assert_eq!(p.real_sol, SOL - expected.fee);
    assert_eq!(p.treasury_fees, expected.fee / 2);
    assert_eq!(p.creator_fees, expected.fee - expected.fee / 2);
    env.check_books(&coin);

    env.buy(&coin, &bob, 2 * SOL).unwrap();
    let half = env.tokens(&alice.pubkey(), &coin) / 2;
    let expected = math::sell(reserves(&env.pool(&coin)), half, FEE_BPS).unwrap();
    let before = env.lamports(&alice.pubkey());
    env.sell(&coin, &alice, half).unwrap();
    // Alice pays the transaction fee herself.
    assert_eq!(env.lamports(&alice.pubkey()) + 5_000, before + expected.sol_out);
    env.check_books(&coin);

    // A minimum that can't be met fails the buy and moves nothing.
    let quote = math::buy(reserves(&env.pool(&coin)), SOL, FEE_BPS).unwrap().tokens_out;
    assert_eq!(error(env.buy_min(&coin, &bob, SOL, quote + 1)), pool_error(PoolError::Slippage));
    env.buy_min(&coin, &bob, SOL, quote).unwrap();
}

#[test]
fn graduation_burns_and_the_pool_carries_on() {
    let mut env = Env::new();
    let coin = env.launch();
    let alice = env.alice.insecure_clone();
    let line = env.pool(&coin).graduation_sol;

    // One buy far past the line: the curve stops at it, the rest goes through the new pool.
    let expected = math::buy(reserves(&env.pool(&coin)), 200 * SOL, FEE_BPS).unwrap();
    env.buy(&coin, &alice, 200 * SOL).unwrap();
    let p = env.pool(&coin);
    assert_eq!(p.graduated, 1);
    assert_eq!(p.graduated_at, T0);
    assert_eq!(p.burned, expected.burned);
    assert!(p.burned.abs_diff(SUPPLY / 14) <= TOKEN, "about 7.14% burned, got {}", p.burned);
    assert_eq!(p.real_sol, 198 * SOL);
    assert!(line < 83 * SOL);
    assert_eq!(env.tokens(&alice.pubkey(), &coin), expected.tokens_out);
    env.check_books(&coin);

    // After graduation the same pool trades, both ways.
    env.sell(&coin, &alice, 100_000_000 * TOKEN).unwrap();
    env.buy(&coin, &alice, SOL).unwrap();
    env.check_books(&coin);

    // Everyone can still leave.
    let held = env.tokens(&alice.pubkey(), &coin);
    env.sell(&coin, &alice, held).unwrap();
    env.check_books(&coin);
}

#[test]
fn fees_go_to_the_creator_and_the_recorded_treasury() {
    let mut env = Env::new();
    let coin = env.launch();
    let (admin, alice, bob) = (env.admin.insecure_clone(), env.alice.insecure_clone(), env.bob.insecure_clone());
    for _ in 0..5 {
        env.buy(&coin, &alice, 3 * SOL).unwrap();
    }
    let held = env.tokens(&alice.pubkey(), &coin);
    env.sell(&coin, &alice, held / 3).unwrap();

    // A later change to the config does not redirect this coin's fees.
    let elsewhere = ConfigArgs { treasury: bob.pubkey(), ..env.config_args() };
    env.update_config(&admin, elsewhere).unwrap();

    let p = env.pool(&coin);
    assert!(p.creator_fees > 0 && p.treasury_fees > 0);
    assert_eq!(error(env.claim_creator(&coin, &alice)), pool_error(PoolError::WrongAccount));

    let before = env.lamports(&admin.pubkey());
    env.claim_creator(&coin, &admin).unwrap();
    assert_eq!(env.lamports(&admin.pubkey()) + 5_000, before + p.creator_fees);

    // Anyone can push the treasury's share to the treasury.
    let before = env.lamports(&env.treasury);
    env.claim_treasury(&coin, &bob).unwrap();
    assert_eq!(env.lamports(&env.treasury), before + p.treasury_fees);

    assert_eq!(error(env.claim_creator(&coin, &admin)), pool_error(PoolError::NothingToClaim));
    assert_eq!(error(env.claim_treasury(&coin, &bob)), pool_error(PoolError::NothingToClaim));
    let p = env.pool(&coin);
    assert_eq!((p.creator_fees, p.treasury_fees), (0, 0));
    env.check_books(&coin);

    // The creator can hand the coin over. What was owed until then goes to the old creator in
    // the same call; the new one collects from there on.
    env.buy(&coin, &alice, 2 * SOL).unwrap();
    let owed = env.pool(&coin).creator_fees;
    let set_creator = |new_creator: Address| {
        let accounts = dex::accounts::SetCreator { creator: admin.pubkey(), pool: coin.pool };
        Instruction {
            program_id: dex::ID,
            accounts: accounts.to_account_metas(None),
            data: dex::instruction::SetCreator { new_creator }.data(),
        }
    };
    // Nobody can sign for these, so fees sent there would be stuck.
    for nobody in [Address::default(), coin.pool] {
        assert_eq!(error(env.send(&admin, vec![set_creator(nobody)], &[])), pool_error(PoolError::WrongAccount));
    }
    let before = env.lamports(&admin.pubkey());
    env.send(&admin, vec![set_creator(bob.pubkey())], &[]).unwrap();
    assert_eq!(env.lamports(&admin.pubkey()) + 5_000, before + owed);
    assert_eq!(env.pool(&coin).creator, bob.pubkey());
    env.buy(&coin, &alice, SOL).unwrap();
    assert_eq!(error(env.claim_creator(&coin, &admin)), pool_error(PoolError::WrongAccount));
    env.claim_creator(&coin, &bob).unwrap();
    env.check_books(&coin);
}

#[test]
fn the_treasury_must_be_able_to_take_a_payment() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    // A fresh address holds no rent: a small fee payment to it would fail.
    let empty = ConfigArgs { treasury: Keypair::new().pubkey(), ..env.config_args() };
    assert_eq!(error(env.update_config(&admin, empty)), pool_error(PoolError::UnusableTreasury));
    // A program can never be written to.
    let program = ConfigArgs { treasury: TOKEN_2022, ..env.config_args() };
    assert!(env.update_config(&admin, program).is_err());
    // A funded wallet is fine.
    let wallet = ConfigArgs { treasury: env.bob.pubkey(), ..env.config_args() };
    env.update_config(&admin, wallet).unwrap();
}

/// The old attack: someone who holds a mint's key creates a non-transferable mint at that
/// address, opens an account for a target wallet, closes the mint and launches the real coin
/// there; the old account keeps its non-transferable mark, so tokens bought into it could never
/// leave. Now a coin can only be at the program's own address, which has no key: a launch at an
/// address someone holds is refused, planted or not.
#[test]
fn a_coin_cannot_be_launched_where_someone_planted_accounts() {
    let mut env = Env::new();
    let (admin, alice) = (env.admin.insecure_clone(), env.alice.insecure_clone());
    let mint = Keypair::new();
    let m = mint.pubkey();

    // Base mint, account type, MintCloseAuthority (4 + 32) and NonTransferable (4 + 0).
    let space = 165 + 1 + 36 + 4;
    let lamports = env.svm.minimum_balance_for_rent_exemption(space);
    let mut close_authority = vec![25, 1];
    close_authority.extend_from_slice(admin.pubkey().as_ref());
    let mut init_mint = vec![20, 6];
    init_mint.extend_from_slice(admin.pubkey().as_ref());
    init_mint.push(0);
    let only_mint = |data: Vec<u8>| Instruction { program_id: TOKEN_2022, accounts: vec![AccountMeta::new(m, false)], data };
    let planting = vec![
        create_account(&admin.pubkey(), &m, lamports, space as u64, &TOKEN_2022),
        only_mint(close_authority),
        only_mint(vec![32]),
        only_mint(init_mint),
        Env::open_account_ix(&admin.pubkey(), &alice.pubkey(), &m),
    ];
    env.send(&admin, planting, &[&mint]).unwrap();
    let close = Instruction {
        program_id: TOKEN_2022,
        accounts: vec![AccountMeta::new(m, false), AccountMeta::new(admin.pubkey(), false), AccountMeta::new_readonly(admin.pubkey(), true)],
        data: vec![9],
    };
    env.send(&admin, vec![close], &[]).unwrap();
    assert!(env.svm.get_account(&m).is_none_or(|a| a.lamports == 0));

    // A launch there is refused, whatever salt goes with it: it is not the program's address.
    for salt in [0, 1, u64::MAX] {
        let ix = env.launch_ix(&admin.pubkey(), &m, LaunchArgs { salt, ..env.args() });
        assert_eq!(error(env.send(&admin, vec![ix], &[])), WRONG_SEEDS);
    }
    // The coin goes to its own address, and the target's account there is a fresh one.
    let coin = env.launch_as(&admin, env.args()).unwrap();
    env.buy(&coin, &alice, SOL).unwrap();
    assert!(env.tokens(&alice.pubkey(), &coin) > 0);
    env.check_books(&coin);
}

/// The address is the creator's own: another launcher can't take it, and one salt makes one coin.
#[test]
fn a_coin_address_belongs_to_its_creator_and_salt() {
    let mut env = Env::new();
    let (admin, launcher) = (env.admin.insecure_clone(), env.launcher.insecure_clone());
    let salt = fresh_salt();
    let admins = mint_for(&admin.pubkey(), salt);
    // the launcher, allowed to launch, signs with the admin's address and salt: refused
    let ix = env.launch_ix(&launcher.pubkey(), &admins, LaunchArgs { salt, ..env.args() });
    assert_eq!(error(env.send(&launcher, vec![ix], &[])), WRONG_SEEDS);
    // the admin launches there; a second launch with the same salt can't
    let ix = env.launch_ix(&admin.pubkey(), &admins, LaunchArgs { salt, ..env.args() });
    env.send(&admin, vec![ix], &[]).unwrap();
    let again = env.launch_ix(&admin.pubkey(), &admins, LaunchArgs { salt, ..env.args() });
    assert!(env.send(&admin, vec![again], &[]).is_err());
    // the launcher's own address for the same salt is another coin, and launches
    let theirs = mint_for(&launcher.pubkey(), salt);
    assert_ne!(theirs, admins);
    let ix = env.launch_ix(&launcher.pubkey(), &theirs, LaunchArgs { salt, ..env.args() });
    env.send(&launcher, vec![ix], &[]).unwrap();
    env.check_books(&Coin::of(admins));
    env.check_books(&Coin::of(theirs));
}

#[test]
fn the_creator_buys_in_the_launch_transaction_even_on_a_prefunded_address() {
    let mut env = Env::new();
    let (admin, alice) = (env.admin.insecure_clone(), env.alice.insecure_clone());
    let who = admin.pubkey();
    let salt = fresh_salt();
    let mint = mint_for(&who, salt);
    // Someone sends SOL to the coin's address before the launch, to block it.
    env.send(&alice, vec![send_sol(&alice.pubkey(), &mint, SOL / 1_000)], &[]).unwrap();

    let coin = Coin::of(mint);
    let data = dex::instruction::Buy { sol_in: 2 * SOL, min_tokens_out: 0 }.data();
    let ixs = vec![
        env.launch_ix(&who, &mint, LaunchArgs { salt, ..env.args() }),
        Env::open_account_ix(&who, &who, &coin.mint),
        Env::swap_ix(&coin, &who, ata(&who, &coin.mint), data),
    ];
    env.send(&admin, ixs, &[]).unwrap();
    assert!(env.tokens(&who, &coin) > 0);
    env.check_books(&coin);
}

#[test]
fn metadata_of_any_allowed_length_launches() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    // 4 + 4 + 29 = 37 bytes, which puts the mint at a length Token-2022 rounds up.
    let odd = LaunchArgs {
        name: "Test".into(),
        symbol: "TEST".into(),
        uri: "https://example.com/abcd.json".into(),
        ..env.args()
    };
    env.launch_as(&admin, odd).unwrap();
    let longest = LaunchArgs { name: "n".repeat(32), symbol: "s".repeat(10), uri: "u".repeat(200), ..env.args() };
    env.launch_as(&admin, longest).unwrap();
}

#[test]
fn the_pool_is_not_fooled() {
    let mut env = Env::new();
    let coin = env.launch();
    let other = env.launch();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.insecure_clone());
    env.buy(&coin, &alice, 5 * SOL).unwrap();

    // Tokens and SOL sent straight to the pool change nothing: the next buy prices exactly as
    // the recorded reserves say, and the gift stays where it was sent.
    let gift = env.tokens(&alice.pubkey(), &coin) / 2;
    let mut transfer = vec![12];
    transfer.extend_from_slice(&gift.to_le_bytes());
    transfer.push(6);
    let accounts = vec![
        AccountMeta::new(ata(&alice.pubkey(), &coin.mint), false),
        AccountMeta::new_readonly(coin.mint, false),
        AccountMeta::new(coin.vault, false),
        AccountMeta::new_readonly(alice.pubkey(), true),
    ];
    let ixs = vec![
        Instruction { program_id: TOKEN_2022, accounts, data: transfer },
        send_sol(&alice.pubkey(), &coin.pool, 3 * SOL),
    ];
    env.send(&alice, ixs, &[]).unwrap();
    let expected = math::buy(reserves(&env.pool(&coin)), SOL, FEE_BPS).unwrap();
    env.buy(&coin, &bob, SOL).unwrap();
    assert_eq!(env.tokens(&bob.pubkey(), &coin), expected.tokens_out);

    // Buying into the pool's own token account would pay for nothing.
    let who = bob.pubkey();
    let data = dex::instruction::Buy { sol_in: SOL, min_tokens_out: 0 }.data();
    let ix = Env::swap_ix(&coin, &who, coin.vault, data.clone());
    assert_eq!(error(env.send(&bob, vec![ix], &[])), pool_error(PoolError::PoolAsBuyer));

    // Another coin's vault or mint can't stand in for this pool's.
    let mut mixed = coin;
    mixed.vault = other.vault;
    let ix = Env::swap_ix(&mixed, &who, ata(&who, &coin.mint), data.clone());
    assert_eq!(error(env.send(&bob, vec![ix], &[])), pool_error(PoolError::WrongAccount));
    let mut mixed = coin;
    mixed.mint = other.mint;
    let ix = Env::swap_ix(&mixed, &who, ata(&who, &coin.mint), data);
    assert_eq!(error(env.send(&bob, vec![ix], &[])), pool_error(PoolError::WrongAccount));
}

#[test]
fn random_trading_keeps_every_book_straight() {
    let mut env = Env::new();
    let coin = env.launch();
    let traders: Vec<Keypair> = (0..5).map(|_| Keypair::new()).collect();
    for t in &traders {
        env.svm.airdrop(&t.pubkey(), 1_000 * SOL).unwrap();
    }
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move |n: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % n.max(1)
    };
    let mut graduated_on = None;
    for step in 0..300 {
        let trader = &traders[next(5) as usize];
        let held = env.tokens(&trader.pubkey(), &coin);
        let before = reserves(&env.pool(&coin));
        if held == 0 || next(3) > 0 {
            let sol_in = next(8 * SOL) + 1_000_000;
            let expected = math::buy(before, sol_in, FEE_BPS).unwrap();
            env.buy(&coin, trader, sol_in).unwrap();
            assert_eq!(env.tokens(&trader.pubkey(), &coin), held + expected.tokens_out, "step {step}");
            if expected.burned > 0 {
                graduated_on = Some(step);
            }
        } else {
            let amount = next(held) + 1;
            match math::sell(before, amount, FEE_BPS) {
                Ok(_) => env.sell(&coin, trader, amount).unwrap(),
                Err(_) => continue,
            };
            assert_eq!(env.tokens(&trader.pubkey(), &coin), held - amount, "step {step}");
        }
        env.check_books(&coin);
        let holders: u64 = traders.iter().map(|t| env.tokens(&t.pubkey(), &coin)).sum();
        let p = env.pool(&coin);
        assert_eq!(holders + p.token_reserve + p.burned, SUPPLY, "step {step}");
    }
    assert!(graduated_on.is_some(), "the walk should cross the line");

    // Everyone sells out at the end, and the pool still owes nothing it doesn't hold.
    for t in &traders {
        let held = env.tokens(&t.pubkey(), &coin);
        if held > 0 {
            env.sell(&coin, t, held).unwrap();
        }
    }
    env.check_books(&coin);
}

/// What each step costs, so the site can ask for the right compute limit. Printed, and held
/// under limits with room to spare.
#[test]
fn compute_units() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let launch = |env: &mut Env, args: LaunchArgs| {
        let args = LaunchArgs { salt: fresh_salt(), ..args };
        let mint = mint_for(&admin.pubkey(), args.salt);
        let ix = env.launch_ix(&admin.pubkey(), &mint, args);
        (units(env.send(&admin, vec![ix], &[])), Coin::of(mint))
    };
    let args = env.args();
    let (usual, coin) = launch(&mut env, args.clone());
    let longest = LaunchArgs { name: "n".repeat(32), symbol: "s".repeat(10), uri: "u".repeat(200), ..args };
    let (long, _) = launch(&mut env, longest);

    let alice = env.alice.insecure_clone();
    let first_buy = units(env.buy(&coin, &alice, SOL));
    let buy = units(env.buy(&coin, &alice, SOL));
    let sell = units(env.sell(&coin, &alice, 1_000 * TOKEN));
    let graduating = units(env.buy(&coin, &alice, 100 * SOL));
    let after = units(env.buy(&coin, &alice, SOL));
    println!(
        "compute units: launch {usual} (longest metadata {long}); first buy with account creation {first_buy}, \
         buy {buy}, sell {sell}, graduating buy {graduating}, buy after graduation {after}"
    );
    assert!(usual.max(long) < 300_000);
    assert!(first_buy.max(buy).max(sell).max(graduating).max(after) < 120_000);

    // The opening batch, held under the limits the site's package asks for (site/chain/src/index.mjs).
    let launch_batch = |env: &mut Env| {
        let args = LaunchArgs { salt: fresh_salt(), opening_secs: 300, ..env.args() };
        let mint = mint_for(&admin.pubkey(), args.salt);
        let coin = Coin::of(mint);
        let ixs = vec![env.launch_ix(&admin.pubkey(), &mint, args), Env::commit_ix(&coin, &admin.pubkey(), SOL)];
        (units(env.send(&admin, ixs, &[])), coin)
    };
    let (launch_commit, small) = launch_batch(&mut env);
    let (_, big) = launch_batch(&mut env);
    let bob = env.bob.insecure_clone();
    let new_seat = units(env.commit(&small, &alice, SOL));
    let same_seat = units(env.commit(&small, &alice, SOL));
    let part = units(env.withdraw(&small, &alice, SOL / 2));
    let all = units(env.withdraw(&small, &alice, 3 * SOL / 2));
    env.commit(&small, &bob, SOL).unwrap();
    env.commit(&big, &bob, 100 * SOL).unwrap();
    env.warp(env.pool(&small).opens_at);
    let settle = units(env.settle(&small, &bob));
    let settle_graduating = units(env.settle(&big, &bob));
    assert_eq!((env.pool(&small).graduated, env.pool(&big).graduated), (0, 1));
    let claim = units(env.claim_seat(&small, &bob, true));
    println!(
        "compute units, opening batch: launch with the creator's commitment {launch_commit}; commitment into a new seat \
         {new_seat}, into the same seat {same_seat}; withdrawal of part {part}, of all {all}; settle {settle}, \
         graduating {settle_graduating}; seat claim with account creation {claim}"
    );
    assert!(launch_commit < 200_000);
    assert!(new_seat.max(same_seat) < 50_000);
    assert!(part.max(all) < 20_000);
    assert!(settle.max(settle_graduating) < 60_000);
    assert!(claim < 80_000);
}

/* ---------------- the opening batch ---------------- */

/// The pool's reserves as a coin opens, with the usual numbers.
fn opening_reserves() -> math::Reserves {
    math::Reserves {
        virtual_sol: VIRTUAL,
        real_sol: 0,
        tokens: SUPPLY,
        graduation_sol: math::graduation_sol(VIRTUAL, GRADUATION_MCAP).unwrap(),
        graduated: false,
    }
}

/// A coin launched with an opening batch of `secs`, the creator's commitment in the launch transaction.
fn launch_with_batch(env: &mut Env, secs: u32, creator_sol: u64) -> Coin {
    let admin = env.admin.insecure_clone();
    let salt = fresh_salt();
    let mint = mint_for(&admin.pubkey(), salt);
    let coin = Coin::of(mint);
    let mut ixs = vec![env.launch_ix(&admin.pubkey(), &mint, LaunchArgs { salt, opening_secs: secs, ..env.args() })];
    if creator_sol > 0 {
        ixs.push(Env::commit_ix(&coin, &admin.pubkey(), creator_sol));
    }
    env.send(&admin, ixs, &[]).unwrap();
    coin
}

#[test]
fn an_opening_batch_gives_every_seat_one_price() {
    let mut env = Env::new();
    let (admin, alice, bob) = (env.admin.insecure_clone(), env.alice.insecure_clone(), env.bob.insecure_clone());
    let coin = launch_with_batch(&mut env, 300, SOL);
    let opens = env.pool(&coin).opens_at;
    assert_eq!(opens, T0 + 300);

    // until the settle nobody buys: the batch takes the SOL
    assert_eq!(error(env.buy(&coin, &alice, SOL)), pool_error(PoolError::NotOpenYet));
    env.commit(&coin, &alice, 2 * SOL).unwrap();
    env.commit(&coin, &bob, SOL).unwrap();
    env.withdraw(&coin, &bob, SOL / 2).unwrap();
    assert_eq!(error(env.commit(&coin, &bob, 1_000)), pool_error(PoolError::ZeroAmount));
    assert_eq!(error(env.withdraw(&coin, &bob, 0)), pool_error(PoolError::ZeroAmount));
    assert_eq!(error(env.withdraw(&coin, &bob, SOL)), pool_error(PoolError::OutOfBounds), "more than the seat holds");
    env.check_books(&coin);
    assert_eq!(env.pool(&coin).opening_seats, 3);
    assert_eq!(error(env.settle(&coin, &bob)), pool_error(PoolError::OpeningNotOver));
    assert_eq!(error(env.claim_seat(&coin, &alice, false)), pool_error(PoolError::OpeningNotOver));

    // the last minute: no new SOL, withdrawals still, so every seat sees the final total and can leave
    env.warp(opens - OPENING_LOCK_SECS - 1);
    env.commit(&coin, &bob, SOL).unwrap();
    env.warp(opens - OPENING_LOCK_SECS);
    assert_eq!(error(env.commit(&coin, &alice, SOL)), pool_error(PoolError::OpeningLocked));
    let late = Keypair::new();
    env.svm.airdrop(&late.pubkey(), 10 * SOL).unwrap();
    assert_eq!(error(env.commit(&coin, &late, SOL)), pool_error(PoolError::OpeningLocked), "nor into a new seat");
    assert_eq!(env.seat_sol(&coin, &late.pubkey()), None);
    env.warp(opens - 1);
    assert_eq!(error(env.commit(&coin, &bob, SOL)), pool_error(PoolError::OpeningLocked));
    env.withdraw(&coin, &bob, SOL / 2).unwrap();
    env.check_books(&coin);
    env.warp(opens);
    assert_eq!(error(env.commit(&coin, &alice, SOL)), pool_error(PoolError::OpeningClosed));
    assert_eq!(error(env.withdraw(&coin, &alice, SOL)), pool_error(PoolError::OpeningClosed));
    assert_eq!(env.seat_sol(&coin, &bob.pubkey()), Some(SOL));

    // anyone settles: one buy of the 4 SOL
    env.settle(&coin, &bob).unwrap();
    let p = env.pool(&coin);
    let expected = math::buy(opening_reserves(), 4 * SOL, FEE_BPS).unwrap();
    assert_eq!(p.opening_state, OPENING_SETTLED);
    assert_eq!((p.opening_total_sol, p.opening_tokens, p.token_reserve), (4 * SOL, expected.tokens_out, expected.after.tokens));
    assert_eq!(p.creator_fees + p.treasury_fees, expected.fee);
    assert_eq!(error(env.settle(&coin, &bob)), pool_error(PoolError::NoOpening));
    env.check_books(&coin);

    // each seat its share, one price; the seat closes
    for (who, sol) in [(&admin, SOL), (&alice, 2 * SOL), (&bob, SOL)] {
        env.claim_seat(&coin, who, true).unwrap();
        let share = (expected.tokens_out as u128 * sol as u128 / (4 * SOL) as u128) as u64;
        assert_eq!(env.tokens(&who.pubkey(), &coin), share);
        assert!(env.svm.get_account(&Env::seat_of(&coin, &who.pubkey())).is_none_or(|a| a.lamports == 0));
    }
    assert!(env.claim_seat(&coin, &alice, false).is_err(), "a seat is claimed once");
    let p = env.pool(&coin);
    assert_eq!(p.opening_seats, 0);
    assert!(p.opening_tokens_left < 3, "only the rounding dust stays in the vault");
    env.check_books(&coin);

    // and the coin trades
    env.buy(&coin, &alice, SOL).unwrap();
    env.sell(&coin, &bob, 1_000 * TOKEN).unwrap();
    env.check_books(&coin);
}

#[test]
fn a_seat_emptied_by_withdraw_closes_and_a_new_commitment_opens_it_again() {
    let mut env = Env::new();
    let (admin, alice, bob) = (env.admin.insecure_clone(), env.alice.insecure_clone(), env.bob.insecure_clone());
    let carol = Keypair::new();
    env.svm.airdrop(&carol.pubkey(), 10 * SOL).unwrap();
    let coin = launch_with_batch(&mut env, 300, SOL);
    let opens = env.pool(&coin).opens_at;
    let rent = env.svm.minimum_balance_for_rent_exemption(8 + 32 + 32 + 8 + 1);
    let who = bob.pubkey();
    // a commitment that creates its seat calls the System Program twice, one into a seat already there once
    assert_eq!(system_calls(&env.commit(&coin, &alice, SOL).unwrap()), 2);
    assert_eq!(system_calls(&env.commit(&coin, &alice, SOL).unwrap()), 1);
    env.commit(&coin, &bob, SOL).unwrap();
    env.commit(&coin, &carol, SOL).unwrap();
    assert_eq!(env.pool(&coin).opening_seats, 4);
    env.check_books(&coin);

    // all of it back: the seat closes, its rent goes back to the owner, the batch has one seat fewer
    let before = env.lamports(&who);
    env.withdraw(&coin, &bob, SOL).unwrap();
    assert!(env.svm.get_account(&Env::seat_of(&coin, &who)).is_none_or(|a| a.lamports == 0));
    assert_eq!(env.lamports(&who), before + SOL + rent - 5_000);
    let p = env.pool(&coin);
    assert_eq!((p.opening_seats, p.opening_sol), (3, 4 * SOL));
    env.check_books(&coin);
    assert!(env.withdraw(&coin, &bob, 1).is_err(), "a closed seat has nothing to take back");

    // a new commitment opens it again, in a transaction of its own
    assert_eq!(system_calls(&env.commit(&coin, &bob, SOL / 2).unwrap()), 2);
    assert_eq!(env.seat_sol(&coin, &who), Some(SOL / 2));
    assert_eq!(env.pool(&coin).opening_seats, 4);
    env.check_books(&coin);

    // or in the same transaction as the withdrawal that closed it: the rent goes out and comes back, and the
    // commitment creates the seat again (the withdrawal calls no program)
    let before = env.lamports(&who);
    let ixs = vec![Env::withdraw_ix(&coin, &who, SOL / 2), Env::commit_ix(&coin, &who, SOL / 4)];
    assert_eq!(system_calls(&env.send(&bob, ixs, &[]).unwrap()), 2, "the seat was closed and created again");
    assert_eq!(env.seat_sol(&coin, &who), Some(SOL / 4));
    assert_eq!(env.lamports(&who) + 5_000, before + SOL / 4);
    let p = env.pool(&coin);
    assert_eq!((p.opening_seats, p.opening_sol), (4, 4 * SOL + SOL / 4));
    env.check_books(&coin);

    // in the last minute a seat can still empty and close, but not open again
    env.warp(opens - 1);
    let ixs = vec![Env::withdraw_ix(&coin, &carol.pubkey(), SOL), Env::commit_ix(&coin, &carol.pubkey(), SOL)];
    assert_eq!(error(env.send(&carol, ixs, &[])), pool_error(PoolError::OpeningLocked));
    assert_eq!(env.seat_sol(&coin, &carol.pubkey()), Some(SOL), "the refused transaction moved nothing");
    env.withdraw(&coin, &carol, SOL).unwrap();
    assert_eq!(env.seat_sol(&coin, &carol.pubkey()), None);
    let p = env.pool(&coin);
    assert_eq!((p.opening_seats, p.opening_sol), (3, 3 * SOL + SOL / 4));
    env.check_books(&coin);

    // the settle buys with the seats as they are now, and the opened-again seat's claim pays its share
    let total = 3 * SOL + SOL / 4;
    env.warp(opens);
    env.settle(&coin, &carol).unwrap();
    let expected = math::buy(opening_reserves(), total, FEE_BPS).unwrap();
    let p = env.pool(&coin);
    assert_eq!((p.opening_total_sol, p.opening_tokens, p.opening_seats), (total, expected.tokens_out, 3));
    env.check_books(&coin);
    for (owner, sol) in [(&bob, SOL / 4), (&admin, SOL), (&alice, 2 * SOL)] {
        env.claim_seat(&coin, owner, true).unwrap();
        let share = (expected.tokens_out as u128 * sol as u128 / total as u128) as u64;
        assert_eq!(env.tokens(&owner.pubkey(), &coin), share);
        assert_eq!(env.seat_sol(&coin, &owner.pubkey()), None);
        env.check_books(&coin);
    }
    assert!(env.claim_seat(&coin, &carol, true).is_err(), "a seat closed before the settle has nothing to claim");
    let p = env.pool(&coin);
    assert_eq!(p.opening_seats, 0);
    assert!(p.opening_tokens_left < 3, "only the rounding dust stays in the vault");
    env.check_books(&coin);
}

#[test]
fn a_batch_too_small_to_buy_with_gives_the_sol_back() {
    let mut env = Env::new();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.insecure_clone());
    let coin = launch_with_batch(&mut env, 120, 0);
    env.commit(&coin, &alice, SOL / 200).unwrap();
    let before = env.lamports(&alice.pubkey());
    env.warp(env.pool(&coin).opens_at);
    env.settle(&coin, &bob).unwrap();
    let p = env.pool(&coin);
    assert_eq!((p.opening_state, p.real_sol, p.token_reserve), (OPENING_REFUND, 0, SUPPLY));
    env.check_books(&coin);
    env.claim_seat(&coin, &alice, false).unwrap();
    let rent = env.svm.minimum_balance_for_rent_exemption(8 + 32 + 32 + 8 + 1);
    assert_eq!(env.lamports(&alice.pubkey()), before + SOL / 200 + rent - 5_000, "the SOL and the seat's rent back, less the network fee");
    assert_eq!(env.pool(&coin).opening_sol, 0);
    env.check_books(&coin);
    // the coin opened as it was: it trades
    env.buy(&coin, &bob, SOL).unwrap();
    env.check_books(&coin);
}

#[test]
fn a_batch_past_the_graduation_line_graduates_and_shares_what_is_left() {
    let mut env = Env::new();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.insecure_clone());
    let coin = launch_with_batch(&mut env, 120, 0);
    env.commit(&coin, &alice, 60 * SOL).unwrap();
    env.commit(&coin, &bob, 40 * SOL).unwrap();
    env.warp(env.pool(&coin).opens_at);
    env.settle(&coin, &alice).unwrap();
    let p = env.pool(&coin);
    let expected = math::buy(opening_reserves(), 100 * SOL, FEE_BPS).unwrap();
    assert!(p.graduated == 1 && p.burned == expected.burned && p.burned > 0);
    assert_eq!(p.opening_tokens, expected.tokens_out);
    env.check_books(&coin);
    env.claim_seat(&coin, &alice, true).unwrap();
    env.claim_seat(&coin, &bob, true).unwrap();
    assert_eq!(env.tokens(&alice.pubkey(), &coin), (expected.tokens_out as u128 * 60 / 100) as u64);
    env.sell(&coin, &bob, 1_000 * TOKEN).unwrap();
    env.check_books(&coin);
}

#[test]
fn the_opening_window_stays_in_its_bounds() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    for secs in [1, 119, 901, 86_400] {
        assert_eq!(env.launch_as(&admin, LaunchArgs { opening_secs: secs, ..env.args() }).err(), Some(pool_error(PoolError::BadOpening)));
    }
    for secs in [120, 900] {
        env.launch_as(&admin, LaunchArgs { opening_secs: secs, ..env.args() }).unwrap();
    }
    // the shortest window still takes the creator's commitment in the launch transaction, before its last minute
    let coin = launch_with_batch(&mut env, MIN_OPENING_SECS, SOL);
    assert_eq!(env.seat_sol(&coin, &admin.pubkey()), Some(SOL));
    env.check_books(&coin);
}

/// A TradeEvent's last field, read off a transaction's logs.
fn traded_by_creator(meta: &TransactionMetadata) -> Option<bool> {
    let tag = <dex::TradeEvent as anchor_lang::Discriminator>::DISCRIMINATOR;
    meta.logs.iter().filter_map(|l| l.strip_prefix("Program data: ")).map(base64).find(|b| b.starts_with(tag)).map(|b| b[b.len() - 1] == 1)
}

fn base64(s: &str) -> Vec<u8> {
    let value = |c: u8| match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' => 62, _ => 63 };
    let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() { n |= (value(c) as u32) << (18 - 6 * i); }
        for i in 0..chunk.len().saturating_sub(1) { out.push((n >> (16 - 8 * i)) as u8); }
    }
    out
}

#[test]
fn every_trade_says_whether_the_creator_made_it() {
    let mut env = Env::new();
    let (admin, alice) = (env.admin.insecure_clone(), env.alice.insecure_clone());
    let coin = env.launch();
    assert_eq!(traded_by_creator(&env.buy(&coin, &admin, SOL).unwrap()), Some(true));
    assert_eq!(traded_by_creator(&env.buy(&coin, &alice, SOL).unwrap()), Some(false));
    assert_eq!(traded_by_creator(&env.sell(&coin, &admin, 1_000 * TOKEN).unwrap()), Some(true));
    assert_eq!(traded_by_creator(&env.sell(&coin, &alice, 1_000 * TOKEN).unwrap()), Some(false));
}

