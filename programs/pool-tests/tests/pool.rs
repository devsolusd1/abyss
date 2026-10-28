//! The compiled pool, run inside LiteSVM next to the real Token-2022.
//!
//! Build the program first (`cargo build-sbf` in `../pool`; test.sh does it) and point
//! `POOL_SO` at the binary if it is not in `~/dex-target`.

use {
    anchor_lang::{InstructionData, ToAccountMetas},
    dex::{
        math,
        state::{Pool, CONFIG_SEED, MINT_SEED, POOL_SEED, SUPPLY},
        token::{ATA_PROGRAM, TOKEN_2022},
        ConfigArgs, LaunchArgs, PoolError,
    },
    litesvm::{types::TransactionResult, LiteSVM},
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

    /// The books every trade has to leave straight: the pool's SOL covers its rent, reserve
    /// and fees owed, and the vault holds what the pool counts.
    fn check_books(&self, coin: &Coin) {
        let p = self.pool(coin);
        let account = self.svm.get_account(&coin.pool).unwrap();
        let rent = self.svm.minimum_balance_for_rent_exemption(account.data.len());
        assert_eq!(account.lamports, rent + p.real_sol + p.creator_fees + p.treasury_fees, "pool lamports");
        assert_eq!(self.tokens_at(&coin.vault), p.token_reserve, "vault balance");
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
}
