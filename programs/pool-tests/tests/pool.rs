//! The compiled pool, run inside LiteSVM next to the real Token-2022.
//!
//! Build the program first (`cargo build-sbf` in `../pool`; test.sh does it) and point
//! `POOL_SO` at the binary if it is not in `~/dex-target`. The upgrade from the version
//! before the opening batch also needs that version's binary, in `POOL_SO_OLD`: it is ignored
//! unless asked for, and upgrade-test.sh builds both binaries and runs it. The upgrade in the
//! middle of a batch starts from the binary in `POOL_SO_LIVE`, the one live on chain, when given.

use {
    anchor_lang::{InstructionData, ToAccountMetas},
    dex::{
        math,
        state::{
            Pool, CONFIG_SEED, MAX_OPENING_SECS, MINT_SEED, MIN_BATCH, MIN_COMMIT, MIN_OPENING_SECS, OPENING_LOCK_SECS,
            OPENING_NONE, OPENING_OPEN, OPENING_REFUND, OPENING_SETTLED, POOL_SEED, SEAT_SEED, SUPPLY,
        },
        token::{ATA_PROGRAM, TOKEN_2022},
        ConfigArgs, LaunchArgs, PoolError,
    },
    litesvm::{types::{TransactionMetadata, TransactionResult}, LiteSVM},
    solana_account::Account,
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
const RENT_SYSVAR: Address = Address::from_str_const("SysvarRent111111111111111111111111111111111");
const CLOCK_SYSVAR: Address = Address::from_str_const("SysvarC1ock11111111111111111111111111111111");

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
/// Anchor's "the account is not initialized" (AccountNotInitialized): here, a seat that does not exist.
const NO_SEAT: InstructionError = InstructionError::Custom(3012);

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
        Env::bare_from(&so("POOL_SO", "pool/deploy/dex.so"))
    }

    /// The same with the binary at `pool_so`, such as an earlier version's.
    fn bare_from(pool_so: &str) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(dex::ID, pool_so)
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
        Env::new_from(&so("POOL_SO", "pool/deploy/dex.so"))
    }

    fn new_from(pool_so: &str) -> Self {
        let mut env = Env::bare_from(pool_so);
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

    fn settle_accounts(coin: &Coin) -> dex::accounts::Settle {
        dex::accounts::Settle { pool: coin.pool, mint: coin.mint, vault: coin.vault, token_program: TOKEN_2022 }
    }

    fn settle(&mut self, coin: &Coin, caller: &Keypair) -> TransactionResult {
        let ix = pool_ix(Env::settle_accounts(coin), dex::instruction::Settle {});
        self.send(caller, vec![ix], &[])
    }

    /// The accounts of `owner`'s claim on their seat in `coin`, paid into their own token account.
    fn claim_seat_accounts(coin: &Coin, owner: &Address) -> dex::accounts::ClaimSeat {
        dex::accounts::ClaimSeat {
            owner: *owner, pool: coin.pool, seat: Env::seat_of(coin, owner), mint: coin.mint, vault: coin.vault,
            owner_tokens: ata(owner, &coin.mint), token_program: TOKEN_2022,
        }
    }

    /// A seat's claim, after the owner's token account is opened when `open_account`.
    fn claim_seat_ixs(coin: &Coin, owner: &Address, open_account: bool) -> Vec<Instruction> {
        let mut ixs = vec![];
        if open_account {
            ixs.push(Env::open_account_ix(owner, owner, &coin.mint));
        }
        ixs.push(pool_ix(Env::claim_seat_accounts(coin, owner), dex::instruction::ClaimSeat {}));
        ixs
    }

    /// The seat's tokens into the owner's account (opened in the same transaction), or its SOL back.
    fn claim_seat(&mut self, coin: &Coin, owner: &Keypair, open_account: bool) -> TransactionResult {
        let ixs = Env::claim_seat_ixs(coin, &owner.pubkey(), open_account);
        self.send(owner, ixs, &[])
    }

    /// A new wallet holding `sol`.
    fn wallet(&mut self, sol: u64) -> Keypair {
        let key = Keypair::new();
        self.svm.airdrop(&key.pubkey(), sol).unwrap();
        key
    }

    /// The rent a seat holds, which goes back to its owner when it closes.
    fn seat_rent(&self) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(8 + 32 + 32 + 8 + 1)
    }

    /// The accounts at these addresses as they are now, to show that a refused call moved nothing.
    fn snapshot(&self, addresses: &[Address]) -> Vec<Option<Account>> {
        addresses.iter().map(|a| self.svm.get_account(a)).collect()
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

/// One of the pool's instructions, from its accounts (which a test may have swapped) and its data.
fn pool_ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction { program_id: dex::ID, accounts: accounts.to_account_metas(None), data: data.data() }
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

/// Calls a transaction's instructions made to the System Program, read off its logs: a `commit` makes two when it
/// creates the seat (create_account, then the transfer) and one when the seat was already there. Opening an account at
/// an address already sent SOL takes three calls instead of create_account: the rest of the rent, allocate, assign.
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
/// under the limits the site asks for.
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
    // under the limits the site's package asks for (site/chain/src/index.mjs); a_first_buy_fits_the_compute_the_site_asks_for
    // and a_launch_fits_the_compute_the_site_asks_for take them at their dearest
    assert!(usual.max(long) < 200_000);
    assert!(first_buy.max(buy).max(graduating).max(after) < 80_000);
    assert!(sell < 40_000);

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

/// Every event of type `E` in a transaction's logs, in order, once each of the pool's events in them has been read
/// where the site reads it (check_wire).
fn events<E: anchor_lang::Event>(meta: &TransactionMetadata) -> Vec<E> {
    check_wire(meta);
    meta.logs.iter().filter_map(|l| l.strip_prefix("Program data: ")).map(base64).filter_map(|b| decoded::<E>(&b)).collect()
}

/// The event of type `E` in one "Program data:" line, its tag included, or None if the line holds another kind.
fn decoded<E: anchor_lang::Event>(bytes: &[u8]) -> Option<E> {
    let tag = <E as anchor_lang::Discriminator>::DISCRIMINATOR;
    bytes.strip_prefix(tag).map(|mut rest| <E as anchor_lang::AnchorDeserialize>::deserialize(&mut rest).unwrap())
}

/// Each of the pool's events in a transaction's logs, read at the places the site reads it (by the position of its
/// bytes, tag included: server/birth.mjs, and site/chain/src/index.mjs in order) and held against the event as the
/// program wrote it, with its length. A field moved, added or taken out fails here, and not only on the site.
fn check_wire(meta: &TransactionMetadata) {
    let key = |b: &[u8], at: usize| Address::new_from_array(b[at..at + 32].try_into().unwrap());
    let num = |b: &[u8], at: usize| u64::from_le_bytes(b[at..at + 8].try_into().unwrap());
    let flag = |b: &[u8], at: usize| match b[at] {
        0 => false,
        1 => true,
        other => panic!("a bool byte of {other}"),
    };
    for b in meta.logs.iter().filter_map(|l| l.strip_prefix("Program data: ")).map(base64) {
        if let Some(e) = decoded::<dex::TradeEvent>(&b) {
            assert_eq!(b.len(), 147, "TradeEvent's length");
            assert_eq!((key(&b, 8), key(&b, 40), key(&b, 72), flag(&b, 104)), (e.mint, e.trader, e.recipient, e.buy));
            let amounts = [num(&b, 105), num(&b, 113), num(&b, 121), num(&b, 129), num(&b, 137)];
            assert_eq!(amounts, [e.sol, e.tokens, e.fee, e.real_sol, e.token_reserve]);
            assert_eq!((flag(&b, 145), flag(&b, 146)), (e.graduated, e.by_creator));
        } else if let Some(e) = decoded::<dex::Launched>(&b) {
            assert_eq!(b.len(), 130, "Launched's length");
            assert_eq!((key(&b, 8), key(&b, 40), key(&b, 72)), (e.mint, e.creator, e.hook_program));
            let fee_bps = u16::from_le_bytes(b[120..122].try_into().unwrap());
            let opens_at = i64::from_le_bytes(b[122..130].try_into().unwrap());
            assert_eq!((num(&b, 104), num(&b, 112), fee_bps, opens_at), (e.virtual_sol, e.graduation_sol, e.fee_bps, e.opens_at));
        } else if let Some(e) = decoded::<dex::Committed>(&b) {
            assert_eq!(b.len(), 96, "Committed's length");
            assert_eq!((key(&b, 8), key(&b, 40), [num(&b, 72), num(&b, 80), num(&b, 88)]), (e.mint, e.owner, [e.sol, e.seat_sol, e.total]));
        } else if let Some(e) = decoded::<dex::Withdrawn>(&b) {
            assert_eq!(b.len(), 96, "Withdrawn's length");
            assert_eq!((key(&b, 8), key(&b, 40), [num(&b, 72), num(&b, 80), num(&b, 88)]), (e.mint, e.owner, [e.sol, e.seat_sol, e.total]));
        } else if let Some(e) = decoded::<dex::Settled>(&b) {
            assert_eq!(b.len(), 61, "Settled's length");
            let seats = u32::from_le_bytes(b[56..60].try_into().unwrap());
            assert_eq!((key(&b, 8), num(&b, 40), num(&b, 48), seats, flag(&b, 60)), (e.mint, e.sol, e.tokens, e.seats, e.refund));
        } else if let Some(e) = decoded::<dex::SeatClaimed>(&b) {
            assert_eq!(b.len(), 89, "SeatClaimed's length");
            assert_eq!((key(&b, 8), key(&b, 40), num(&b, 72), num(&b, 80), flag(&b, 88)), (e.mint, e.owner, e.sol, e.tokens, e.refund));
        } else if let Some(e) = decoded::<dex::Graduated>(&b) {
            assert_eq!(b.len(), 64, "Graduated's length");
            assert_eq!((key(&b, 8), num(&b, 40), num(&b, 48), num(&b, 56)), (e.mint, e.real_sol, e.token_reserve, e.burned));
        } else if let Some(e) = decoded::<dex::FeesClaimed>(&b) {
            assert_eq!(b.len(), 81, "FeesClaimed's length");
            assert_eq!((key(&b, 8), key(&b, 40), num(&b, 72), flag(&b, 80)), (e.mint, e.to, e.amount, e.creator));
        } else if let Some(e) = decoded::<dex::CreatorChanged>(&b) {
            assert_eq!(b.len(), 112, "CreatorChanged's length");
            assert_eq!((key(&b, 8), key(&b, 40), key(&b, 72), num(&b, 104)), (e.mint, e.from, e.to, e.settled));
        }
    }
}

/// The one event of type `E` in a transaction's logs.
fn event<E: anchor_lang::Event>(meta: &TransactionMetadata) -> E {
    let mut all = events::<E>(meta);
    assert_eq!(all.len(), 1, "one event of the kind");
    all.pop().unwrap()
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

/// Once the batch is settled a seat's SOL is spent, or owed back: no withdrawal takes it out and no commitment adds to
/// it, so a seat can never take its SOL back and its tokens too. After a refund only the claim gives the SOL back.
#[test]
fn after_the_settle_a_seat_can_only_be_claimed() {
    let mut env = Env::new();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.insecure_clone());
    let carol = env.wallet(10 * SOL);
    let (who, rent) = (bob.pubkey(), env.seat_rent());
    // a batch that buys, and one under the smallest batch, which gives the SOL back
    for (alice_sol, bob_sol) in [(2 * SOL, SOL), (2 * MIN_COMMIT, MIN_COMMIT)] {
        let coin = launch_with_batch(&mut env, 300, 0);
        let opens = env.pool(&coin).opens_at;
        env.commit(&coin, &alice, alice_sol).unwrap();
        env.commit(&coin, &bob, bob_sol).unwrap();
        env.warp(opens);
        env.settle(&coin, &carol).unwrap();
        let p = env.pool(&coin);
        let bought = bob_sol == SOL;
        assert_eq!(p.opening_state, if bought { OPENING_SETTLED } else { OPENING_REFUND });

        let watched = [coin.pool, coin.vault, Env::seat_of(&coin, &who), ata(&who, &coin.mint), Env::seat_of(&coin, &carol.pubkey())];
        let before = env.snapshot(&watched);
        // at the settle's own second, and long after
        for at in [opens, opens + 3_600] {
            env.warp(at);
            for sol in [bob_sol / 2, bob_sol] {
                assert_eq!(error(env.withdraw(&coin, &bob, sol)), pool_error(PoolError::NoOpening));
            }
            // more than the seat holds is refused first, before the batch is read
            assert_eq!(error(env.withdraw(&coin, &bob, bob_sol + 1)), pool_error(PoolError::OutOfBounds));
            assert_eq!(error(env.commit(&coin, &bob, SOL)), pool_error(PoolError::NoOpening));
            assert_eq!(error(env.commit(&coin, &carol, SOL)), pool_error(PoolError::NoOpening), "nor into a new seat");
            // a withdrawal next to the claim, before it or after it, fails the whole transaction
            let mut ixs = vec![Env::withdraw_ix(&coin, &who, bob_sol)];
            ixs.extend(Env::claim_seat_ixs(&coin, &who, bought));
            assert_eq!(error(env.send(&bob, ixs, &[])), pool_error(PoolError::NoOpening));
            let mut ixs = Env::claim_seat_ixs(&coin, &who, bought);
            ixs.push(Env::withdraw_ix(&coin, &who, bob_sol));
            assert_eq!(error(env.send(&bob, ixs, &[])), NO_SEAT, "the claim closed the seat");
            assert_eq!(env.snapshot(&watched), before, "the refused calls moved nothing");
        }

        // the claim pays the seat as the settle left it
        let lamports = env.lamports(&who);
        env.claim_seat(&coin, &bob, bought).unwrap();
        if bought {
            let share = (p.opening_tokens as u128 * bob_sol as u128 / p.opening_total_sol as u128) as u64;
            assert_eq!(env.tokens(&who, &coin), share);
        } else {
            assert_eq!(env.lamports(&who), lamports + bob_sol + rent - 5_000, "the SOL and the seat's rent back, less the network fee");
        }
        env.claim_seat(&coin, &alice, bought).unwrap();
        let p = env.pool(&coin);
        assert_eq!((p.opening_seats, p.opening_sol), (0, 0));
        env.check_books(&coin);
    }
}

/// A batch under the smallest that buys, with four seats, one of them partly taken back, and trades and fee claims
/// before anyone takes their SOL back: every seat gets exactly its SOL back, in any order, and nothing else reaches it.
#[test]
fn a_refused_batch_gives_every_seat_its_sol_back_whatever_comes_first() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let coin = launch_with_batch(&mut env, 120, 0);
    let wallets: Vec<Keypair> = (0..4).map(|_| env.wallet(10 * SOL)).collect();
    let (caller, trader) = (env.wallet(SOL), env.wallet(10 * SOL));
    let seats = [2 * MIN_COMMIT, 3 * MIN_COMMIT, MIN_COMMIT, 3 * MIN_COMMIT];
    for (i, (w, sol)) in wallets.iter().zip(seats).enumerate() {
        if i == 1 {
            // this one puts in 0.005 SOL and takes 0.002 back
            env.commit(&coin, w, sol + 2 * MIN_COMMIT).unwrap();
            env.withdraw(&coin, w, 2 * MIN_COMMIT).unwrap();
        } else {
            env.commit(&coin, w, sol).unwrap();
        }
        env.check_books(&coin);
    }
    let total: u64 = seats.iter().sum();
    assert!(total < MIN_BATCH);
    env.warp(env.pool(&coin).opens_at);
    env.settle(&coin, &caller).unwrap();
    let p = env.pool(&coin);
    assert_eq!((p.opening_state, p.opening_total_sol, p.opening_sol, p.opening_seats), (OPENING_REFUND, total, total, 4));
    assert_eq!((p.real_sol, p.token_reserve, p.opening_tokens), (0, SUPPLY, 0));
    env.check_books(&coin);

    // the coin trades before anyone takes the SOL back, and both fees are claimed
    env.buy(&coin, &trader, SOL).unwrap();
    env.check_books(&coin);
    let held = env.tokens(&trader.pubkey(), &coin);
    env.sell(&coin, &trader, held / 2).unwrap();
    env.check_books(&coin);
    env.claim_creator(&coin, &admin).unwrap();
    env.claim_treasury(&coin, &caller).unwrap();
    assert_eq!(env.pool(&coin).opening_sol, total);
    env.check_books(&coin);

    // each seat its SOL and its rent back, in another order than they came in
    let rent = env.seat_rent();
    for i in [3, 0, 2, 1] {
        let (w, sol) = (&wallets[i], seats[i]);
        let before = env.lamports(&w.pubkey());
        env.claim_seat(&coin, w, false).unwrap();
        assert_eq!(env.lamports(&w.pubkey()), before + sol + rent - 5_000, "seat {i}");
        assert_eq!((env.seat_sol(&coin, &w.pubkey()), env.tokens(&w.pubkey(), &coin)), (None, 0), "seat {i}");
        env.check_books(&coin);
    }
    let p = env.pool(&coin);
    assert_eq!((p.opening_sol, p.opening_seats), (0, 0));
    // and the trader can still leave
    let held = env.tokens(&trader.pubkey(), &coin);
    env.sell(&coin, &trader, held).unwrap();
    env.check_books(&coin);
}

/// A batch over the smallest that buys falls under it when a seat leaves in the last second, when no commitment can top
/// it up any more: it buys nothing, and the seat left takes its SOL back.
#[test]
fn a_batch_that_falls_under_the_minimum_at_the_last_second_gives_the_sol_back() {
    let mut env = Env::new();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.insecure_clone());
    let coin = launch_with_batch(&mut env, 120, 0);
    let opens = env.pool(&coin).opens_at;
    env.commit(&coin, &alice, 6 * MIN_COMMIT).unwrap();
    env.commit(&coin, &bob, 5 * MIN_COMMIT).unwrap();
    assert!(env.pool(&coin).opening_sol >= MIN_BATCH);
    env.warp(opens - 1);
    env.withdraw(&coin, &bob, 5 * MIN_COMMIT).unwrap();
    assert_eq!(error(env.commit(&coin, &alice, 4 * MIN_COMMIT)), pool_error(PoolError::OpeningLocked));
    env.warp(opens);
    env.settle(&coin, &bob).unwrap();
    let p = env.pool(&coin);
    assert_eq!((p.opening_state, p.opening_sol, p.opening_seats), (OPENING_REFUND, 6 * MIN_COMMIT, 1));
    env.check_books(&coin);
    let before = env.lamports(&alice.pubkey());
    env.claim_seat(&coin, &alice, false).unwrap();
    assert_eq!(env.lamports(&alice.pubkey()), before + 6 * MIN_COMMIT + env.seat_rent() - 5_000);
    assert_eq!(error(env.claim_seat(&coin, &bob, false)), NO_SEAT, "the seat that left has nothing to claim");
    assert_eq!(env.pool(&coin).opening_sol, 0);
    env.check_books(&coin);
}

/// The batch's instructions take only their own accounts. Another wallet's seat, another coin's seat, mint or vault,
/// another token program, a token account that is not the owner's for this coin, or a coin with no batch: the call is
/// refused, and nothing moves.
#[test]
fn the_batch_is_not_fooled() {
    const LEGACY_TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    let mut env = Env::new();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.insecure_clone());
    let (al, bo) = (alice.pubkey(), bob.pubkey());
    let (a, b) = (launch_with_batch(&mut env, 300, 0), launch_with_batch(&mut env, 300, 0));
    let plain = env.launch();
    for coin in [&a, &b] {
        env.commit(coin, &alice, 2 * SOL).unwrap();
        env.commit(coin, &bob, SOL).unwrap();
    }
    let watched = [
        a.pool, b.pool, a.vault, b.vault, Env::seat_of(&a, &al), Env::seat_of(&a, &bo), Env::seat_of(&b, &al),
        Env::seat_of(&b, &bo), Env::seat_of(&plain, &bo),
    ];
    let before = env.snapshot(&watched);

    // while the batch is open, bob names alice's seat, or his own seat in the other coin
    let commit = |owner: Address, pool: Address, seat: Address| {
        pool_ix(dex::accounts::Commit { owner, pool, seat, system_program: SYSTEM_PROGRAM }, dex::instruction::Commit { sol: SOL })
    };
    let withdraw = |owner: Address, pool: Address, seat: Address| {
        pool_ix(dex::accounts::Withdraw { owner, pool, seat }, dex::instruction::Withdraw { sol: SOL })
    };
    for seat in [Env::seat_of(&a, &al), Env::seat_of(&b, &bo)] {
        assert_eq!(error(env.send(&bob, vec![commit(bo, a.pool, seat)], &[])), WRONG_SEEDS);
        assert_eq!(error(env.send(&bob, vec![withdraw(bo, a.pool, seat)], &[])), WRONG_SEEDS);
    }
    // a coin with no batch takes no seat: the refused commitment leaves none behind
    assert_eq!(error(env.commit(&plain, &bob, SOL)), pool_error(PoolError::NoOpening));
    assert_eq!(error(env.withdraw(&plain, &bob, SOL)), NO_SEAT);
    assert_eq!(error(env.settle(&plain, &bob)), pool_error(PoolError::NoOpening));
    assert_eq!(error(env.claim_seat(&plain, &bob, true)), NO_SEAT);
    assert_eq!(env.snapshot(&watched), before);

    // the settle: another coin's mint or vault, or another token program, can't stand in for the batch's own
    env.warp(env.pool(&a).opens_at);
    let mixed = [
        dex::accounts::Settle { mint: b.mint, ..Env::settle_accounts(&a) },
        dex::accounts::Settle { vault: b.vault, ..Env::settle_accounts(&a) },
        dex::accounts::Settle { token_program: LEGACY_TOKEN, ..Env::settle_accounts(&a) },
    ];
    for accounts in mixed {
        let ix = pool_ix(accounts, dex::instruction::Settle {});
        assert_eq!(error(env.send(&bob, vec![ix], &[])), pool_error(PoolError::WrongAccount));
    }
    assert_eq!(env.snapshot(&watched), before);
    env.settle(&a, &bob).unwrap();
    env.settle(&b, &bob).unwrap();
    let before = env.snapshot(&watched);

    // the claim: with no token account of his own for the coin yet, bob's claim fails and his seat stays
    let claim = |accounts: dex::accounts::ClaimSeat| pool_ix(accounts, dex::instruction::ClaimSeat {});
    let bobs = || Env::claim_seat_accounts(&a, &bo);
    assert_eq!(error(env.send(&bob, vec![claim(bobs())], &[])), pool_error(PoolError::WrongAccount));
    env.send(&bob, vec![Env::open_account_ix(&bo, &bo, &a.mint), Env::open_account_ix(&bo, &bo, &b.mint)], &[]).unwrap();
    let mixed = [
        (dex::accounts::ClaimSeat { seat: Env::seat_of(&a, &al), ..bobs() }, WRONG_SEEDS),
        (dex::accounts::ClaimSeat { seat: Env::seat_of(&b, &bo), ..bobs() }, WRONG_SEEDS),
        (dex::accounts::ClaimSeat { mint: b.mint, ..bobs() }, pool_error(PoolError::WrongAccount)),
        (dex::accounts::ClaimSeat { vault: b.vault, ..bobs() }, pool_error(PoolError::WrongAccount)),
        (dex::accounts::ClaimSeat { token_program: LEGACY_TOKEN, ..bobs() }, pool_error(PoolError::WrongAccount)),
        // the pool's own vault, and bob's account for the other coin
        (dex::accounts::ClaimSeat { owner_tokens: a.vault, ..bobs() }, pool_error(PoolError::PoolAsBuyer)),
        (dex::accounts::ClaimSeat { owner_tokens: ata(&bo, &b.mint), ..bobs() }, pool_error(PoolError::WrongAccount)),
    ];
    for (accounts, expected) in mixed {
        assert_eq!(error(env.send(&bob, vec![claim(accounts)], &[])), expected);
    }
    assert_eq!(env.snapshot(&watched), before);
    assert_eq!(env.tokens(&bo, &a) + env.tokens(&bo, &b), 0);

    // each seat claims its own, once
    for coin in [&a, &b] {
        let p = env.pool(coin);
        for (who, sol) in [(&alice, 2 * SOL), (&bob, SOL)] {
            env.claim_seat(coin, who, true).unwrap();
            assert_eq!(env.tokens(&who.pubkey(), coin), (p.opening_tokens as u128 * sol as u128 / (3 * SOL) as u128) as u64);
        }
        assert_eq!(env.pool(coin).opening_seats, 0);
        env.check_books(coin);
    }
}

/// A random walk through a batch, with a fixed seed: commitments and withdrawals across the window, seats closed and
/// opened again, the lock, the settle at a random time, then the claims in a random order among buys and sells, the
/// buy that graduates among them. The books are checked at every step.
#[test]
fn random_batches_keep_every_book_straight() {
    let mut env = Env::new();
    let coin = launch_with_batch(&mut env, MAX_OPENING_SECS, 0);
    let opens = env.pool(&coin).opens_at;
    let wallets: Vec<Keypair> = (0..8).map(|_| env.wallet(1_000 * SOL)).collect();
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = move |n: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % n.max(1)
    };

    // the window, with what each seat should hold
    let mut seats = [0u64; 8];
    let mut closed = [false; 8];
    let (mut reopened, mut locked, mut last_minute, mut step) = (0u32, 0u32, 0u32, 0u32);
    let mut now = T0;
    loop {
        now += next(12) as i64;
        if now >= opens {
            break;
        }
        env.warp(now);
        let i = next(8) as usize;
        let w = &wallets[i];
        let lock = now >= opens - OPENING_LOCK_SECS;
        if next(10) == 0 {
            // nobody buys or settles while the window is open
            assert_eq!(error(env.buy(&coin, w, SOL)), pool_error(PoolError::NotOpenYet), "step {step}");
            assert_eq!(error(env.settle(&coin, w)), pool_error(PoolError::OpeningNotOver), "step {step}");
        } else if seats[i] == 0 || next(2) == 0 {
            let sol = next(3 * SOL) + MIN_COMMIT;
            if lock {
                assert_eq!(error(env.commit(&coin, w, sol)), pool_error(PoolError::OpeningLocked), "step {step}");
                locked += 1;
            } else {
                env.commit(&coin, w, sol).unwrap();
                reopened += (seats[i] == 0 && closed[i]) as u32;
                seats[i] += sol;
            }
        } else {
            // all of it a third of the time, which closes the seat
            let sol = if next(3) == 0 { seats[i] } else { next(seats[i]) + 1 };
            env.withdraw(&coin, w, sol).unwrap();
            seats[i] -= sol;
            closed[i] |= seats[i] == 0;
            last_minute += lock as u32;
        }
        env.check_books(&coin);
        let p = env.pool(&coin);
        assert_eq!(p.opening_sol, seats.iter().sum::<u64>(), "step {step}");
        assert_eq!(p.opening_seats as usize, seats.iter().filter(|&&sol| sol > 0).count(), "step {step}");
        for (w, &sol) in wallets.iter().zip(&seats) {
            assert_eq!(env.seat_sol(&coin, &w.pubkey()), (sol > 0).then_some(sol), "step {step}");
        }
        step += 1;
    }
    assert!(
        reopened > 0 && locked > 0 && last_minute > 0,
        "the walk should open a closed seat again ({reopened}), meet the lock ({locked}) and leave in the last minute ({last_minute})"
    );

    // settled some time after the window, by a wallet with no seat
    env.warp(opens + next(600) as i64);
    let total: u64 = seats.iter().sum();
    assert!(total >= MIN_BATCH);
    let batch = math::buy(opening_reserves(), total, FEE_BPS).unwrap();
    let stranger = env.wallet(SOL);
    env.settle(&coin, &stranger).unwrap();
    let p = env.pool(&coin);
    assert_eq!((p.opening_state, p.opening_total_sol, p.opening_tokens), (OPENING_SETTLED, total, batch.tokens_out));
    env.check_books(&coin);
    let share = |sol: u64| (batch.tokens_out as u128 * sol as u128 / total as u128) as u64;

    // then the claims, in a random order, among buys and sells
    let mut unclaimed: Vec<usize> = (0..8).filter(|&i| seats[i] > 0).collect();
    let seated = unclaimed.len();
    let (mut sold_before_a_claim, mut claimed_after_graduation, mut step) = (false, false, 0u32);
    while !unclaimed.is_empty() || step < 200 {
        let w = &wallets[next(8) as usize];
        let held = env.tokens(&w.pubkey(), &coin);
        let before = reserves(&env.pool(&coin));
        if !unclaimed.is_empty() && next(16) == 0 {
            let j = unclaimed.swap_remove(next(unclaimed.len() as u64) as usize);
            let owner = &wallets[j];
            let held = env.tokens(&owner.pubkey(), &coin);
            claimed_after_graduation |= before.graduated;
            env.claim_seat(&coin, owner, true).unwrap();
            assert_eq!(env.tokens(&owner.pubkey(), &coin), held + share(seats[j]), "step {step}");
            assert_eq!(env.seat_sol(&coin, &owner.pubkey()), None, "step {step}");
        } else if held == 0 || next(3) > 0 {
            let sol_in = next(8 * SOL) + 1_000_000;
            let expected = math::buy(before, sol_in, FEE_BPS).unwrap();
            env.buy(&coin, w, sol_in).unwrap();
            assert_eq!(env.tokens(&w.pubkey(), &coin), held + expected.tokens_out, "step {step}");
        } else {
            let amount = next(held) + 1;
            if math::sell(before, amount, FEE_BPS).is_err() {
                continue;
            }
            env.sell(&coin, w, amount).unwrap();
            assert_eq!(env.tokens(&w.pubkey(), &coin), held - amount, "step {step}");
            sold_before_a_claim |= !unclaimed.is_empty();
        }
        env.check_books(&coin);
        let p = env.pool(&coin);
        let holders: u64 = wallets.iter().map(|w| env.tokens(&w.pubkey(), &coin)).sum();
        assert_eq!(holders + p.token_reserve + p.opening_tokens_left + p.burned, SUPPLY, "step {step}");
        assert_eq!(p.opening_seats as usize, unclaimed.len(), "step {step}");
        step += 1;
    }
    assert!(sold_before_a_claim && claimed_after_graduation, "the walk should sell, and graduate, before the last claim");

    // everyone sells out at the end, and the pool still owes nothing it doesn't hold
    for w in &wallets {
        let held = env.tokens(&w.pubkey(), &coin);
        if held > 0 {
            env.sell(&coin, w, held).unwrap();
        }
    }
    env.check_books(&coin);
    let p = env.pool(&coin);
    assert_eq!(p.opening_seats, 0);
    assert!(p.opening_tokens_left < seated as u64, "only the rounding dust stays in the vault");
}

/// The coin trades, and graduates, while the seats' tokens still wait in the vault: buys and the burn come out of the
/// reserve alone, every seat still gets the share the settle gave it, and everyone can sell out after, as the math says.
#[test]
fn the_coin_trades_and_graduates_before_the_seats_claim() {
    let mut env = Env::new();
    let (admin, alice, bob) = (env.admin.insecure_clone(), env.alice.insecure_clone(), env.bob.insecure_clone());
    let carol = env.wallet(1_000 * SOL);
    let coin = launch_with_batch(&mut env, 300, SOL);
    env.commit(&coin, &alice, 2 * SOL).unwrap();
    env.commit(&coin, &bob, SOL).unwrap();
    env.warp(env.pool(&coin).opens_at);
    env.settle(&coin, &carol).unwrap();
    let batch = math::buy(opening_reserves(), 4 * SOL, FEE_BPS).unwrap();
    let share = |sol: u64| (batch.tokens_out as u128 * sol as u128 / (4 * SOL) as u128) as u64;
    assert_eq!(env.pool(&coin).opening_tokens_left, batch.tokens_out);

    // a buy and a sell before any claim, priced on the reserve alone
    let quote = math::buy(reserves(&env.pool(&coin)), SOL, FEE_BPS).unwrap();
    env.buy(&coin, &carol, SOL).unwrap();
    assert_eq!(env.tokens(&carol.pubkey(), &coin), quote.tokens_out);
    env.check_books(&coin);
    let half = quote.tokens_out / 2;
    let quote = math::sell(reserves(&env.pool(&coin)), half, FEE_BPS).unwrap();
    env.sell(&coin, &carol, half).unwrap();
    assert_eq!(reserves(&env.pool(&coin)), quote.after);
    env.check_books(&coin);

    // the buy that graduates burns from the same vault, out of the reserve
    let quote = math::buy(reserves(&env.pool(&coin)), 200 * SOL, FEE_BPS).unwrap();
    env.buy(&coin, &carol, 200 * SOL).unwrap();
    let p = env.pool(&coin);
    assert!(p.graduated == 1 && quote.burned > 0);
    assert_eq!((p.burned, p.opening_tokens_left), (quote.burned, batch.tokens_out));
    env.check_books(&coin);

    // only now do the seats claim, each the share the settle gave it
    for (who, sol) in [(&bob, SOL), (&admin, SOL), (&alice, 2 * SOL)] {
        env.claim_seat(&coin, who, true).unwrap();
        assert_eq!(env.tokens(&who.pubkey(), &coin), share(sol));
        env.check_books(&coin);
    }
    let p = env.pool(&coin);
    assert_eq!(p.opening_seats, 0);
    assert!(p.opening_tokens_left < 3, "only the rounding dust stays in the vault");

    // everyone sells out, each sale as the math says, down to the pool's floor
    for who in [&alice, &carol, &bob, &admin] {
        let held = env.tokens(&who.pubkey(), &coin);
        let quote = math::sell(reserves(&env.pool(&coin)), held, FEE_BPS).unwrap();
        env.sell(&coin, who, held).unwrap();
        assert_eq!(reserves(&env.pool(&coin)), quote.after);
        env.check_books(&coin);
    }
    let p = env.pool(&coin);
    assert_eq!(p.token_reserve + p.opening_tokens_left + p.burned, SUPPLY, "every token back in the pool, or burned");
}

/// The edges of the batch's numbers: the smallest commitment, the smallest batch that buys, the last second before the
/// settle, and a batch everyone left.
#[test]
fn the_batch_limits_sit_where_they_say() {
    let mut env = Env::new();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.insecure_clone());

    // the smallest commitment is taken, a lamport less is not
    let coin = launch_with_batch(&mut env, 120, 0);
    assert_eq!(error(env.commit(&coin, &alice, MIN_COMMIT - 1)), pool_error(PoolError::ZeroAmount));
    assert_eq!(env.seat_sol(&coin, &alice.pubkey()), None);
    env.commit(&coin, &alice, MIN_COMMIT).unwrap();
    assert_eq!(env.seat_sol(&coin, &alice.pubkey()), Some(MIN_COMMIT));

    // the smallest batch buys, a lamport less gives the SOL back; neither settles a second before the window ends
    let (exact, short) = (launch_with_batch(&mut env, 120, 0), launch_with_batch(&mut env, 120, 0));
    env.commit(&exact, &alice, MIN_BATCH).unwrap();
    env.commit(&short, &alice, MIN_BATCH - 1).unwrap();
    let opens = env.pool(&exact).opens_at;
    env.warp(opens - 1);
    for coin in [&exact, &short] {
        assert_eq!(error(env.settle(coin, &bob)), pool_error(PoolError::OpeningNotOver));
    }
    env.warp(opens);
    env.settle(&exact, &bob).unwrap();
    env.settle(&short, &bob).unwrap();
    let expected = math::buy(opening_reserves(), MIN_BATCH, FEE_BPS).unwrap();
    let p = env.pool(&exact);
    assert_eq!((p.opening_state, p.opening_total_sol, p.opening_tokens), (OPENING_SETTLED, MIN_BATCH, expected.tokens_out));
    let p = env.pool(&short);
    assert_eq!((p.opening_state, p.opening_sol, p.token_reserve), (OPENING_REFUND, MIN_BATCH - 1, SUPPLY));
    env.claim_seat(&exact, &alice, true).unwrap();
    assert_eq!(env.tokens(&alice.pubkey(), &exact), expected.tokens_out, "the only seat takes every token");
    let before = env.lamports(&alice.pubkey());
    env.claim_seat(&short, &alice, false).unwrap();
    assert_eq!(env.lamports(&alice.pubkey()), before + MIN_BATCH - 1 + env.seat_rent() - 5_000);
    env.check_books(&exact);
    env.check_books(&short);

    // a batch everyone left has nothing to buy with: settled, no trade, and the coin opens as it was launched
    let empty = launch_with_batch(&mut env, 120, 0);
    env.commit(&empty, &alice, SOL).unwrap();
    env.withdraw(&empty, &alice, SOL).unwrap();
    env.warp(env.pool(&empty).opens_at);
    let settled = env.settle(&empty, &bob).unwrap();
    assert!(events::<dex::TradeEvent>(&settled).is_empty(), "no buy, so no trade");
    let s = event::<dex::Settled>(&settled);
    assert_eq!((s.sol, s.tokens, s.seats, s.refund), (0, 0, 0, false));
    let p = env.pool(&empty);
    assert_eq!((p.opening_state, p.opening_total_sol, p.opening_tokens, p.opening_seats), (OPENING_SETTLED, 0, 0, 0));
    assert_eq!((p.real_sol, p.token_reserve, p.creator_fees + p.treasury_fees), (0, SUPPLY, 0));
    env.check_books(&empty);
    assert_eq!(error(env.claim_seat(&empty, &alice, false)), NO_SEAT);
    let quote = math::buy(opening_reserves(), SOL, FEE_BPS).unwrap();
    env.buy(&empty, &bob, SOL).unwrap();
    assert_eq!(env.tokens(&bob.pubkey(), &empty), quote.tokens_out, "priced as a coin that opened at once");
    env.check_books(&empty);
}

/// What the batch's events say: each commitment, withdrawal, settle and claim, and the batch's buy as a trade by the
/// pool itself, never by the creator. Every event decoded here is also read where the site reads it (check_wire).
#[test]
fn the_batch_events_say_what_happened() {
    let mut env = Env::new();
    let (admin, alice, bob) = (env.admin.insecure_clone(), env.alice.insecure_clone(), env.bob.insecure_clone());
    let carol = env.wallet(10 * SOL);
    let creator = admin.pubkey();
    let salt = fresh_salt();
    let coin = Coin::of(mint_for(&creator, salt));
    let ixs = vec![
        env.launch_ix(&creator, &coin.mint, LaunchArgs { salt, opening_secs: 300, ..env.args() }),
        Env::commit_ix(&coin, &creator, SOL),
    ];
    let launched = env.send(&admin, ixs, &[]).unwrap();
    let l = event::<dex::Launched>(&launched);
    assert_eq!((l.mint, l.creator, l.opens_at), (coin.mint, creator, T0 + 300));
    let c = event::<dex::Committed>(&launched);
    assert_eq!((c.mint, c.owner, c.sol, c.seat_sol, c.total), (coin.mint, creator, SOL, SOL, SOL));

    // each commitment and withdrawal: what moved, the seat after it, and the batch after it
    let c = event::<dex::Committed>(&env.commit(&coin, &alice, 2 * SOL).unwrap());
    assert_eq!((c.mint, c.owner, c.sol, c.seat_sol, c.total), (coin.mint, alice.pubkey(), 2 * SOL, 2 * SOL, 3 * SOL));
    let c = event::<dex::Committed>(&env.commit(&coin, &alice, SOL).unwrap());
    assert_eq!((c.sol, c.seat_sol, c.total), (SOL, 3 * SOL, 4 * SOL));
    let w = event::<dex::Withdrawn>(&env.withdraw(&coin, &alice, SOL).unwrap());
    assert_eq!((w.mint, w.owner, w.sol, w.seat_sol, w.total), (coin.mint, alice.pubkey(), SOL, 2 * SOL, 3 * SOL));
    let c = event::<dex::Committed>(&env.commit(&coin, &bob, SOL).unwrap());
    assert_eq!((c.owner, c.sol, c.seat_sol, c.total), (bob.pubkey(), SOL, SOL, 4 * SOL));
    env.commit(&coin, &carol, SOL).unwrap();
    let w = event::<dex::Withdrawn>(&env.withdraw(&coin, &carol, SOL).unwrap());
    assert_eq!((w.owner, w.sol, w.seat_sol, w.total), (carol.pubkey(), SOL, 0, 4 * SOL), "a seat emptied");

    // the settle: the batch, and its buy as the pool's own trade, though the creator holds a seat
    env.warp(env.pool(&coin).opens_at);
    let settled = env.settle(&coin, &bob).unwrap();
    let batch = math::buy(opening_reserves(), 4 * SOL, FEE_BPS).unwrap();
    let s = event::<dex::Settled>(&settled);
    assert_eq!((s.mint, s.sol, s.tokens, s.seats, s.refund), (coin.mint, 4 * SOL, batch.tokens_out, 3, false));
    let t = event::<dex::TradeEvent>(&settled);
    assert_eq!((t.mint, t.trader, t.recipient, t.buy), (coin.mint, coin.pool, coin.pool, true));
    assert_eq!((t.sol, t.tokens, t.fee), (4 * SOL, batch.tokens_out, batch.fee));
    assert_eq!((t.real_sol, t.token_reserve, t.graduated, t.by_creator), (batch.after.real_sol, batch.after.tokens, false, false));
    assert!(events::<dex::Graduated>(&settled).is_empty());
    for (who, sol) in [(&admin, SOL), (&alice, 2 * SOL), (&bob, SOL)] {
        let k = event::<dex::SeatClaimed>(&env.claim_seat(&coin, who, true).unwrap());
        let share = (batch.tokens_out as u128 * sol as u128 / (4 * SOL) as u128) as u64;
        assert_eq!((k.mint, k.owner, k.sol, k.tokens, k.refund), (coin.mint, who.pubkey(), sol, share, false));
    }

    // a batch that graduates says so, in the trade and in its own event
    let big = launch_with_batch(&mut env, 120, 0);
    env.commit(&big, &alice, 100 * SOL).unwrap();
    env.warp(env.pool(&big).opens_at);
    let settled = env.settle(&big, &alice).unwrap();
    let batch = math::buy(opening_reserves(), 100 * SOL, FEE_BPS).unwrap();
    let g = event::<dex::Graduated>(&settled);
    assert_eq!((g.mint, g.real_sol, g.token_reserve, g.burned), (big.mint, batch.after.graduation_sol, batch.after.tokens, batch.burned));
    let t = event::<dex::TradeEvent>(&settled);
    assert_eq!((t.trader, t.real_sol, t.graduated, t.by_creator), (big.pool, batch.after.real_sol, true, false));

    // a refused batch and an empty one make no trade
    let small = launch_with_batch(&mut env, 120, 0);
    let empty = launch_with_batch(&mut env, 120, 0);
    env.commit(&small, &alice, 3 * MIN_COMMIT).unwrap();
    env.commit(&small, &bob, 2 * MIN_COMMIT).unwrap();
    env.warp(env.pool(&small).opens_at);
    let settled = env.settle(&small, &bob).unwrap();
    let s = event::<dex::Settled>(&settled);
    assert_eq!((s.mint, s.sol, s.tokens, s.seats, s.refund), (small.mint, 5 * MIN_COMMIT, 0, 2, true));
    assert!(events::<dex::TradeEvent>(&settled).is_empty(), "a refund buys nothing");
    let k = event::<dex::SeatClaimed>(&env.claim_seat(&small, &alice, false).unwrap());
    assert_eq!((k.owner, k.sol, k.tokens, k.refund), (alice.pubkey(), 3 * MIN_COMMIT, 0, true));
    let settled = env.settle(&empty, &bob).unwrap();
    let s = event::<dex::Settled>(&settled);
    assert_eq!((s.sol, s.tokens, s.seats, s.refund), (0, 0, 0, false));
    assert!(events::<dex::TradeEvent>(&settled).is_empty(), "nobody joined");

    // once the creator hands the coin over, the old creator's trades are no longer the creator's, the new one's are
    let hand_over = pool_ix(dex::accounts::SetCreator { creator, pool: coin.pool }, dex::instruction::SetCreator { new_creator: bob.pubkey() });
    let owed = env.pool(&coin).creator_fees;
    let h = event::<dex::CreatorChanged>(&env.send(&admin, vec![hand_over], &[]).unwrap());
    assert_eq!((h.mint, h.from, h.to, h.settled), (coin.mint, creator, bob.pubkey(), owed), "the old creator paid their share of the batch's fee");
    assert_eq!(traded_by_creator(&env.buy(&coin, &admin, SOL).unwrap()), Some(false));
    assert_eq!(traded_by_creator(&env.buy(&coin, &bob, SOL).unwrap()), Some(true));
    assert_eq!(traded_by_creator(&env.sell(&coin, &bob, 1_000 * TOKEN).unwrap()), Some(true));
    // and the creator's buy into another wallet's account is still the creator's, the tokens that wallet's
    let data = dex::instruction::Buy { sol_in: SOL, min_tokens_out: 0 }.data();
    let ixs = vec![
        Env::open_account_ix(&bob.pubkey(), &carol.pubkey(), &coin.mint),
        Env::swap_ix(&coin, &bob.pubkey(), ata(&carol.pubkey(), &coin.mint), data),
    ];
    let t = event::<dex::TradeEvent>(&env.send(&bob, ixs, &[]).unwrap());
    assert_eq!((t.trader, t.recipient, t.buy, t.by_creator), (bob.pubkey(), carol.pubkey(), true, true));
    assert_eq!(env.tokens(&carol.pubkey(), &coin), t.tokens);
    // and the fees earned since go to the new creator
    let owed = env.pool(&coin).creator_fees;
    let f = event::<dex::FeesClaimed>(&env.claim_creator(&coin, &bob).unwrap());
    assert_eq!((f.mint, f.to, f.amount, f.creator), (coin.mint, bob.pubkey(), owed, true));
}

/// Tries `find_program_address` makes for these seeds: one for each bump from 255 down to the one it returns.
fn tries(seeds: &[&[u8]], program: &Address) -> u64 {
    256 - Address::find_program_address(seeds, program).1 as u64
}

/// Tries for `owner`'s seat in `coin`, which every commitment makes.
fn seat_tries(owner: &Address, coin: &Coin) -> u64 {
    tries(&[SEAT_SEED, coin.pool.as_ref(), owner.as_ref()], &dex::ID)
}

/// Tries for `owner`'s token account of `coin`, which the associated token program makes when it opens it.
fn account_tries(owner: &Address, coin: &Coin) -> u64 {
    tries(&[owner.as_ref(), TOKEN_2022.as_ref(), coin.mint.as_ref()], &ATA_PROGRAM)
}

/// 2,048 wallets, the same in every run, to find the ones whose addresses take the most tries or the fewest. Each is
/// handed out once, so no two roles share a wallet.
struct Wallets {
    all: Vec<Keypair>,
    taken: Vec<Address>,
}

impl Wallets {
    fn new() -> Self {
        let all = (0..2_048u64)
            .map(|i| {
                let mut secret = [0u8; 32];
                secret[..8].copy_from_slice(&i.to_le_bytes());
                Keypair::new_from_array(secret)
            })
            .collect();
        Wallets { all, taken: vec![] }
    }

    /// The wallet not handed out yet that `score` puts highest.
    fn most<K: Ord>(&mut self, score: impl Fn(&Address) -> K) -> Keypair {
        let free = self.all.iter().filter(|w| !self.taken.contains(&w.pubkey()));
        let wallet = free.max_by_key(|w| score(&w.pubkey())).unwrap().insecure_clone();
        self.taken.push(wallet.pubkey());
        wallet
    }

    /// The wallet not handed out yet that `score` puts lowest.
    fn fewest(&mut self, score: impl Fn(&Address) -> u64) -> Keypair {
        self.most(|w| std::cmp::Reverse(score(w)))
    }
}

/// The opening batch's steps at their dearest, held under the limits the site's package asks for
/// (site/chain/src/index.mjs). A commitment looks for its seat's bump, and the associated token program for the token
/// account's when a claim opens it, at 1,500 units a try, and the tries depend on the wallet: the wallets here are the
/// ones that take the most tries, out of 2,048, for these coins. Anyone may send SOL to a seat's or an account's
/// address before it opens, which makes opening it dearer: the SOL topped up, the space allocated and the owner
/// assigned, three calls instead of one. So each opening is measured both ways, and the batches that settle with a
/// claim graduate, which is the dearest settle. Each limit must also cover 20 tries: a wallet needs more about once
/// in a million.
#[test]
fn the_opening_batch_fits_the_compute_the_site_asks_for() {
    let mut env = Env::new();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.insecure_clone());
    // one batch measured step by step, one that settles with a claim, one that buys without graduating, one refused
    let (a, b) = (launch_with_batch(&mut env, 300, 0), launch_with_batch(&mut env, 300, 0));
    let (small, refused) = (launch_with_batch(&mut env, 300, 0), launch_with_batch(&mut env, 300, 0));

    let mut wallets = Wallets::new();
    let seat_worst = wallets.most(|w| seat_tries(w, &a));
    let seat_best = wallets.fewest(|w| seat_tries(w, &a));
    let claim_worst = wallets.most(|w| account_tries(w, &a));
    let claim_best = wallets.fewest(|w| account_tries(w, &a));
    // the worst left, whose token account is sent SOL before the claim
    let funded_claim_worst = wallets.most(|w| account_tries(w, &a));
    let settle_claim_worst = wallets.most(|w| account_tries(w, &b));
    for w in [&seat_worst, &seat_best, &claim_worst, &claim_best, &funded_claim_worst, &settle_claim_worst] {
        env.svm.airdrop(&w.pubkey(), 10 * SOL).unwrap();
    }
    // the least SOL an address can be sent: the rent of an empty account
    let empty = env.svm.minimum_balance_for_rent_exemption(0);

    let new_seat_best = units(env.commit(&a, &seat_best, SOL));
    let opened = env.commit(&a, &seat_worst, SOL).unwrap();
    let same_seat = units(env.commit(&a, &seat_worst, SOL));
    let part = units(env.withdraw(&a, &seat_worst, SOL));
    let all = units(env.withdraw(&a, &seat_worst, SOL));
    // the seat closed; SOL sent to its address, then the seat opened again
    env.svm.airdrop(&Env::seat_of(&a, &seat_worst.pubkey()), empty).unwrap();
    let reopened = env.commit(&a, &seat_worst, SOL).unwrap();
    assert_eq!(system_calls(&reopened), system_calls(&opened) + 2, "the seat topped up, allocated and assigned");
    let (new_seat, funded_seat) = (opened.compute_units_consumed, reopened.compute_units_consumed);
    for w in [&claim_worst, &claim_best, &funded_claim_worst] {
        env.commit(&a, w, SOL).unwrap();
    }
    env.commit(&b, &settle_claim_worst, SOL).unwrap();
    for coin in [&a, &b] {
        env.commit(coin, &alice, 100 * SOL).unwrap();
    }
    env.commit(&small, &bob, SOL).unwrap();
    env.commit(&refused, &bob, 5 * MIN_COMMIT).unwrap();
    for (w, coin) in [(&funded_claim_worst, &a), (&settle_claim_worst, &b)] {
        env.svm.airdrop(&ata(&w.pubkey(), &coin.mint), empty).unwrap();
    }

    env.warp(env.pool(&a).opens_at);
    let settle = units(env.settle(&small, &bob));
    let settle_refund = units(env.settle(&refused, &bob));
    let settle_graduating = units(env.settle(&a, &bob));
    assert_eq!((env.pool(&small).graduated, env.pool(&a).graduated, env.pool(&refused).opening_state), (0, 1, OPENING_REFUND));
    let claimed = env.claim_seat(&a, &claim_worst, true).unwrap();
    let claim_best_units = units(env.claim_seat(&a, &claim_best, true));
    let funded = env.claim_seat(&a, &funded_claim_worst, true).unwrap();
    assert_eq!(system_calls(&funded), system_calls(&claimed) + 2, "the token account topped up, allocated and assigned");
    let (claim, funded_claim) = (claimed.compute_units_consumed, funded.compute_units_consumed);
    let claim_refund = units(env.claim_seat(&refused, &bob, false));
    let mut ixs = vec![pool_ix(Env::settle_accounts(&b), dex::instruction::Settle {})];
    ixs.extend(Env::claim_seat_ixs(&b, &settle_claim_worst.pubkey(), true));
    let settle_claim = units(env.send(&settle_claim_worst, ixs, &[]));
    assert_eq!(env.pool(&b).graduated, 1);
    for (w, coin) in [(&claim_worst, &a), (&funded_claim_worst, &a), (&settle_claim_worst, &b)] {
        assert!(env.tokens(&w.pubkey(), coin) > 0);
    }

    let (seat_most, seat_least) = (seat_tries(&seat_worst.pubkey(), &a), seat_tries(&seat_best.pubkey(), &a));
    let (account_most, account_least) = (account_tries(&claim_worst.pubkey(), &a), account_tries(&claim_best.pubkey(), &a));
    let account_funded = account_tries(&funded_claim_worst.pubkey(), &a);
    let account_most_b = account_tries(&settle_claim_worst.pubkey(), &b);
    println!(
        "compute units, opening batch at its dearest: commitment into a new seat {new_seat} ({seat_most} tries for the seat; \
         {new_seat_best} with {seat_least}), at an address sent SOL {funded_seat}, into the same seat {same_seat}; withdrawal \
         of part {part}, of all {all}; settle {settle}, refused {settle_refund}, graduating {settle_graduating}; seat claim \
         with account creation {claim} ({account_most} tries for the account; {claim_best_units} with {account_least}), at \
         an address sent SOL {funded_claim} ({account_funded} tries), refund {claim_refund}; graduating settle with a claim \
         and account creation at an address sent SOL {settle_claim} ({account_most_b} tries)"
    );
    assert!(funded_seat > new_seat, "SOL at the seat's address makes the commitment dearer");
    let commit = new_seat.max(same_seat).max(funded_seat);
    assert!(commit < 50_000);
    assert!(part.max(all) < 20_000);
    assert!(settle.max(settle_refund).max(settle_graduating) < 60_000);
    assert!(claim.max(funded_claim).max(claim_refund) < 80_000);
    assert!(settle_claim < 140_000);

    // what one more try costs, and how many tries each limit leaves room for
    assert!(seat_most > seat_least && account_most > account_least);
    let per_seat_try = (new_seat - new_seat_best) / (seat_most - seat_least);
    let per_account_try = (claim - claim_best_units) / (account_most - account_least);
    let commit_covers = seat_most + (50_000 - commit) / per_seat_try;
    let claim_covers = (account_most + (80_000 - claim) / per_account_try).min(account_funded + (80_000 - funded_claim) / per_account_try);
    let settle_claim_covers = account_most_b + (140_000 - settle_claim) / per_account_try;
    println!(
        "a try costs {per_seat_try} units for the seat, {per_account_try} for the account; the limits cover {commit_covers} \
         tries for a commitment, {claim_covers} for a claim, {settle_claim_covers} for a settle with a claim"
    );
    assert!(commit_covers.min(claim_covers).min(settle_claim_covers) >= 20);
}

/// A first buy and a launch at their dearest, held under the limits the site's package asks for
/// (site/chain/src/index.mjs): 80,000 units for a buy, which opens the buyer's token account in the same transaction.
/// The buys here open that account and graduate the coin, the dearest buy, for the wallets out of 2,048 whose account
/// takes the most tries and the fewest, and with SOL already at the account's address. Like the batch's steps, the
/// limit must also cover 20 tries.
#[test]
fn a_first_buy_fits_the_compute_the_site_asks_for() {
    let mut env = Env::new();
    // three coins, each graduated by its first buy
    let (worst, best, funded) = (env.launch(), env.launch(), env.launch());
    let mut wallets = Wallets::new();
    let buyers = [
        wallets.most(|w| account_tries(w, &worst)),
        wallets.fewest(|w| account_tries(w, &best)),
        wallets.most(|w| account_tries(w, &funded)),
    ];
    for w in &buyers {
        env.svm.airdrop(&w.pubkey(), 200 * SOL).unwrap();
    }
    // the least SOL an address can be sent: the rent of an empty account
    let empty = env.svm.minimum_balance_for_rent_exemption(0);
    env.svm.airdrop(&ata(&buyers[2].pubkey(), &funded.mint), empty).unwrap();

    let opened = env.buy(&worst, &buyers[0], 100 * SOL).unwrap();
    let buy_best = units(env.buy(&best, &buyers[1], 100 * SOL));
    let paid_in = env.buy(&funded, &buyers[2], 100 * SOL).unwrap();
    assert_eq!(system_calls(&paid_in), system_calls(&opened) + 2, "the token account topped up, allocated and assigned");
    let (buy, buy_funded) = (opened.compute_units_consumed, paid_in.compute_units_consumed);
    for coin in [&worst, &best, &funded] {
        assert_eq!(env.pool(coin).graduated, 1);
        env.check_books(coin);
    }

    let (most, least) = (account_tries(&buyers[0].pubkey(), &worst), account_tries(&buyers[1].pubkey(), &best));
    let most_funded = account_tries(&buyers[2].pubkey(), &funded);
    println!(
        "compute units, a first buy that opens the account and graduates: {buy} ({most} tries for the account; {buy_best} \
         with {least}), at an address sent SOL {buy_funded} ({most_funded} tries)"
    );
    assert!(buy.max(buy_funded) < 80_000);
    assert!(most > least);
    let per_try = (buy - buy_best) / (most - least);
    let covers = (most + (80_000 - buy) / per_try).min(most_funded + (80_000 - buy_funded) / per_try);
    println!("a try costs {per_try} units; the limit covers {covers} tries for a first buy");
    assert!(covers >= 20);
}

/// A launch at its dearest, held under the 200,000 units the site's package asks for (site/chain/src/index.mjs): the
/// longest metadata, with the creator's first buy (which opens their token account and graduates the coin) or their
/// commitment to the batch, at the salt out of 2,048 whose addresses take the most tries in all. The mint's, the
/// pool's and the vault's bumps are looked for in the launch, the vault's twice (the program finds it, then the
/// associated token program creates it), and the creator's account's or seat's after it.
#[test]
fn a_launch_fits_the_compute_the_site_asks_for() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let creator = admin.pubkey();
    let launch_tries = |salt: u64, last: &dyn Fn(&Coin) -> u64| {
        let coin = Coin::of(mint_for(&creator, salt));
        let mint_tries = tries(&[MINT_SEED, creator.as_ref(), &salt.to_le_bytes()], &dex::ID);
        mint_tries + tries(&[POOL_SEED, coin.mint.as_ref()], &dex::ID) + 2 * account_tries(&coin.pool, &coin) + last(&coin)
    };
    let buying = |c: &Coin| account_tries(&creator, c);
    let committing = |c: &Coin| seat_tries(&creator, c);
    // salts clear of fresh_salt's
    let salts = (1u64 << 40)..(1u64 << 40) + 2_048;
    let buy_salt = salts.clone().max_by_key(|&s| launch_tries(s, &buying)).unwrap();
    let commit_salt = salts.filter(|&s| s != buy_salt).max_by_key(|&s| launch_tries(s, &committing)).unwrap();
    let longest = LaunchArgs { name: "n".repeat(32), symbol: "s".repeat(10), uri: "u".repeat(200), ..env.args() };

    let coin = Coin::of(mint_for(&creator, buy_salt));
    let data = dex::instruction::Buy { sol_in: 100 * SOL, min_tokens_out: 0 }.data();
    let ixs = vec![
        env.launch_ix(&creator, &coin.mint, LaunchArgs { salt: buy_salt, ..longest.clone() }),
        Env::open_account_ix(&creator, &creator, &coin.mint),
        Env::swap_ix(&coin, &creator, ata(&creator, &coin.mint), data),
    ];
    let launch_buy = units(env.send(&admin, ixs, &[]));
    assert_eq!(env.pool(&coin).graduated, 1);
    env.check_books(&coin);
    let batch = Coin::of(mint_for(&creator, commit_salt));
    let ixs = vec![
        env.launch_ix(&creator, &batch.mint, LaunchArgs { salt: commit_salt, opening_secs: 300, ..longest }),
        Env::commit_ix(&batch, &creator, SOL),
    ];
    let launch_commit = units(env.send(&admin, ixs, &[]));
    assert_eq!(env.seat_sol(&batch, &creator), Some(SOL));
    env.check_books(&batch);

    let (buy_tries, commit_tries) = (launch_tries(buy_salt, &buying), launch_tries(commit_salt, &committing));
    // a try costs 1,500 units, in this program and in the associated token program
    let room = (200_000 - launch_buy.max(launch_commit).min(200_000)) / 1_500;
    println!(
        "compute units, a launch with the longest metadata: with a first buy that graduates {launch_buy} ({buy_tries} tries \
         in all), with a commitment {launch_commit} ({commit_tries} tries); the limit leaves room for {room} more tries"
    );
    assert!(launch_buy.max(launch_commit) < 200_000);
}

/* ---------------- upgrades ---------------- */

/// The loader's header in a program's data account: its state, the slot it was deployed in, the upgrade authority.
const PROGRAM_DATA_HEADER: usize = 45;

/// The loader refuses to change a program twice in one slot, and an upgraded program runs from the next.
fn next_slot(env: &mut Env) {
    let slot = env.svm.get_sysvar::<Clock>().slot;
    env.svm.warp_to_slot(slot + 1);
}

/// Replaces the program at its address the way a deploy does: the program's data account made bigger first when the
/// binary has grown, the binary in a buffer as the loader's writes leave it, then the loader's Upgrade, signed by the
/// upgrade authority. No account of the pool's is touched.
fn upgrade(env: &mut Env, binary: &[u8]) {
    let admin = env.admin.insecure_clone();
    next_slot(env);
    let room = env.svm.get_account(&program_data()).unwrap().data.len() - PROGRAM_DATA_HEADER;
    if binary.len() > room {
        // ExtendProgram, by 10 KiB at least as the loader asks, paid by the admin
        let more = ((binary.len() - room) as u32).max(10_240);
        let mut data = vec![6, 0, 0, 0];
        data.extend_from_slice(&more.to_le_bytes());
        let accounts = vec![
            AccountMeta::new(program_data(), false),
            AccountMeta::new(dex::ID, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            AccountMeta::new(admin.pubkey(), true),
        ];
        env.send(&admin, vec![Instruction { program_id: LOADER, accounts, data }], &[]).unwrap();
        next_slot(env);
    }
    // a buffer: its state, its authority (the admin), then the binary
    let buffer = Keypair::new().pubkey();
    let mut data = vec![1, 0, 0, 0, 1];
    data.extend_from_slice(admin.pubkey().as_ref());
    data.extend_from_slice(binary);
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm.set_account(buffer, Account { lamports, data, owner: LOADER, executable: false, rent_epoch: 0 }).unwrap();
    let accounts = vec![
        AccountMeta::new(program_data(), false),
        AccountMeta::new(dex::ID, false),
        AccountMeta::new(buffer, false),
        // the buffer's SOL, less the program's rent, goes back to the admin
        AccountMeta::new(admin.pubkey(), false),
        AccountMeta::new_readonly(RENT_SYSVAR, false),
        AccountMeta::new_readonly(CLOCK_SYSVAR, false),
        AccountMeta::new_readonly(admin.pubkey(), true),
    ];
    env.send(&admin, vec![Instruction { program_id: LOADER, accounts, data: vec![3, 0, 0, 0] }], &[]).unwrap();
    let deployed = env.svm.get_account(&program_data()).unwrap().data;
    assert!(deployed[PROGRAM_DATA_HEADER..PROGRAM_DATA_HEADER + binary.len()] == *binary, "the new binary is in place");
    next_slot(env);
}

/// `launch` as the version before the opening batch reads it: today's arguments without the last, `opening_secs`.
fn launch_ix_before_batch(env: &Env, creator: &Address, mint: &Address, args: LaunchArgs) -> Instruction {
    let mut ix = env.launch_ix(creator, mint, args);
    ix.data.truncate(ix.data.len() - 4);
    ix
}

/// A coin launched by `creator` the way the version before the batch launches.
fn launch_before_batch(env: &mut Env, creator: &Keypair) -> Coin {
    let salt = fresh_salt();
    let coin = Coin::of(mint_for(&creator.pubkey(), salt));
    let ix = launch_ix_before_batch(env, &creator.pubkey(), &coin.mint, LaunchArgs { salt, ..env.args() });
    env.send(creator, vec![ix], &[]).unwrap();
    coin
}

/// The pool's bytes from the opening batch's first field to the end of the account: the 64 that were reserved before.
fn batch_bytes(env: &Env, coin: &Coin) -> Vec<u8> {
    let data = env.svm.get_account(&coin.pool).unwrap().data;
    assert_eq!(data.len(), Pool::LEN, "the pool's size never changes");
    data[8 + std::mem::offset_of!(Pool, opens_at)..].to_vec()
}

/// Anchor's "fallback functions are not supported": an instruction the binary does not have.
const NO_SUCH_INSTRUCTION: InstructionError = InstructionError::Custom(101);
/// Anchor's "the program could not deserialize the given instruction".
const UNREADABLE_ARGS: InstructionError = InstructionError::Custom(102);

/// Coins launched by the binary from before the opening batch (b73a4b1), traded and one graduated, then the current
/// binary in its place at the same address, as a mainnet upgrade does it: there each pool holds real SOL and nothing
/// migrates it. The batch's fields, in what were reserved bytes, read zeros, so the old coins have no batch: they buy
/// at once, graduate, pay their fees, change hands and sell out, with the books straight. A coin launched after the
/// upgrade has a batch and goes through it to the end next to them. The old half is written in that version's
/// formats and expects its errors, so this test holds for that one upgrade only.
#[test]
#[ignore = "needs the binary from before the batch in POOL_SO_OLD: upgrade-test.sh builds it and runs this"]
fn upgrade_keeps_the_coins_launched_before_the_batch() {
    let binary = std::fs::read(so("POOL_SO", "pool/deploy/dex.so")).unwrap();
    let mut env = Env::new_from(&so("POOL_SO_OLD", "old/deploy/dex.so"));
    let (admin, launcher) = (env.admin.insecure_clone(), env.launcher.insecure_clone());
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.insecure_clone());

    // the old binary: two coins in its own launch format, traded, and one graduated
    let early = launch_before_batch(&mut env, &admin);
    let curve = launch_before_batch(&mut env, &launcher);
    env.buy(&early, &alice, 3 * SOL).unwrap();
    env.buy(&curve, &alice, 2 * SOL).unwrap();
    env.buy(&curve, &launcher, SOL).unwrap();
    let held = env.tokens(&alice.pubkey(), &curve);
    env.sell(&curve, &alice, held / 2).unwrap();
    env.buy(&early, &bob, 200 * SOL).unwrap();
    assert_eq!((env.pool(&early).graduated, env.pool(&curve).graduated), (1, 0));
    // A launch in today's format reaches the old binary as one without a batch: the bytes after the salt are not read.
    // So the site must not offer a batch until the program it talks to has one.
    let salt = fresh_salt();
    let quiet = Coin::of(mint_for(&admin.pubkey(), salt));
    let ix = env.launch_ix(&admin.pubkey(), &quiet.mint, LaunchArgs { salt, opening_secs: 300, ..env.args() });
    env.send(&admin, vec![ix], &[]).unwrap();
    assert_eq!(error(env.commit(&quiet, &alice, SOL)), NO_SUCH_INSTRUCTION, "the old binary has no batch");
    let coins = [early, curve, quiet];
    for coin in &coins {
        env.check_books(coin);
        assert!(batch_bytes(&env, coin).iter().all(|&b| b == 0), "the old binary left the reserved bytes at zero");
    }
    let creator_owed = env.pool(&early).creator_fees;

    // The loader's Upgrade lists none of the pools' accounts, so nothing of theirs can move: this checks the helper,
    // not the program. What counts is how the new binary reads them, below.
    let watched: Vec<Address> = coins.iter().flat_map(|c| [c.pool, c.vault, c.mint]).chain([config_address()]).collect();
    let before = env.snapshot(&watched);
    upgrade(&mut env, &binary);
    assert_eq!(env.snapshot(&watched), before, "the upgrade touched no account of the pools'");

    // the old coins have no batch: nothing waits for a settle, and the batch's instructions refuse them
    for coin in &coins {
        let quote = math::buy(reserves(&env.pool(coin)), SOL / 10, FEE_BPS).unwrap();
        env.buy(coin, &bob, SOL / 10).unwrap();
        assert_eq!(env.pool(coin).token_reserve, quote.after.tokens, "bought at once, as the math says");
        assert_eq!(env.pool(coin).opening_state, OPENING_NONE);
        assert_eq!(error(env.commit(coin, &alice, SOL)), pool_error(PoolError::NoOpening));
        assert_eq!(error(env.settle(coin, &bob)), pool_error(PoolError::NoOpening));
        assert_eq!(error(env.withdraw(coin, &alice, SOL)), NO_SEAT);
        assert_eq!(error(env.claim_seat(coin, &alice, false)), NO_SEAT);
        assert!(batch_bytes(&env, coin).iter().all(|&b| b == 0), "a trade leaves the batch's fields at zero");
        env.check_books(coin);
    }
    // and an old page's launch is refused now, not read wrong
    let salt = fresh_salt();
    let mint = mint_for(&admin.pubkey(), salt);
    let ix = launch_ix_before_batch(&env, &admin.pubkey(), &mint, LaunchArgs { salt, ..env.args() });
    assert_eq!(error(env.send(&admin, vec![ix], &[])), UNREADABLE_ARGS);

    // on the curve: trades as the math says, each event read where the site reads it, the creator's marked as theirs
    let quote = math::buy(reserves(&env.pool(&curve)), SOL, FEE_BPS).unwrap();
    let bought = env.buy(&curve, &alice, SOL).unwrap();
    assert_eq!(reserves(&env.pool(&curve)), quote.after);
    let trade = event::<dex::TradeEvent>(&bought);
    assert_eq!((trade.tokens, trade.by_creator), (quote.tokens_out, false));
    assert!(event::<dex::TradeEvent>(&env.buy(&curve, &launcher, SOL).unwrap()).by_creator);
    let held = env.tokens(&alice.pubkey(), &curve);
    let quote = math::sell(reserves(&env.pool(&curve)), held, FEE_BPS).unwrap();
    env.sell(&curve, &alice, held).unwrap();
    assert_eq!(reserves(&env.pool(&curve)), quote.after);
    env.check_books(&curve);
    // it graduates in the buy that crosses the line, and goes on as a plain pool
    let quote = math::buy(reserves(&env.pool(&curve)), 200 * SOL, FEE_BPS).unwrap();
    env.buy(&curve, &bob, 200 * SOL).unwrap();
    let p = env.pool(&curve);
    assert!(p.graduated == 1 && quote.burned > 0);
    assert_eq!((p.burned, p.graduated_at), (quote.burned, T0));
    env.check_books(&curve);
    // the coin that graduated under the old binary trades both ways
    env.sell(&early, &bob, 100_000_000 * TOKEN).unwrap();
    env.buy(&early, &alice, SOL).unwrap();
    env.check_books(&early);

    // fees owed from before the upgrade and after are paid in full, to the creator and to the recorded treasury
    let p = env.pool(&early);
    assert!(p.creator_fees > creator_owed && creator_owed > 0);
    let before = env.lamports(&admin.pubkey());
    env.claim_creator(&early, &admin).unwrap();
    assert_eq!(env.lamports(&admin.pubkey()) + 5_000, before + p.creator_fees);
    for coin in &coins {
        let owed = env.pool(coin).treasury_fees;
        let before = env.lamports(&env.treasury);
        env.claim_treasury(coin, &bob).unwrap();
        assert_eq!(env.lamports(&env.treasury), before + owed);
        env.check_books(coin);
    }
    // the creator hands the coin over: what was owed goes to them in the same call, the new creator collects after
    let owed = env.pool(&curve).creator_fees;
    let accounts = dex::accounts::SetCreator { creator: launcher.pubkey(), pool: curve.pool };
    let ix = pool_ix(accounts, dex::instruction::SetCreator { new_creator: alice.pubkey() });
    let before = env.lamports(&launcher.pubkey());
    env.send(&launcher, vec![ix], &[]).unwrap();
    assert_eq!(env.lamports(&launcher.pubkey()) + 5_000, before + owed);
    assert_eq!(env.pool(&curve).creator, alice.pubkey());
    env.buy(&curve, &bob, SOL).unwrap();
    assert_eq!(error(env.claim_creator(&curve, &launcher)), pool_error(PoolError::WrongAccount));
    env.claim_creator(&curve, &alice).unwrap();
    env.check_books(&curve);

    // everyone can still leave, each sale as the math says
    for (coin, who) in [(&early, &alice), (&early, &bob), (&curve, &bob), (&curve, &launcher), (&quiet, &bob)] {
        let held = env.tokens(&who.pubkey(), coin);
        let quote = math::sell(reserves(&env.pool(coin)), held, FEE_BPS).unwrap();
        env.sell(coin, who, held).unwrap();
        assert_eq!(reserves(&env.pool(coin)), quote.after);
        env.check_books(coin);
    }

    // a coin launched now has its batch, and goes through it to the end
    let carol = env.wallet(10 * SOL);
    let coin = launch_with_batch(&mut env, 300, SOL);
    assert_eq!(env.pool(&coin).opening_state, OPENING_OPEN);
    assert_eq!(error(env.buy(&coin, &alice, SOL)), pool_error(PoolError::NotOpenYet));
    env.commit(&coin, &alice, 2 * SOL).unwrap();
    env.commit(&coin, &carol, SOL).unwrap();
    env.withdraw(&coin, &carol, SOL / 2).unwrap();
    env.check_books(&coin);
    env.warp(env.pool(&coin).opens_at);
    env.settle(&coin, &bob).unwrap();
    let total = 3 * SOL + SOL / 2;
    let expected = math::buy(opening_reserves(), total, FEE_BPS).unwrap();
    let share = |sol: u64| (expected.tokens_out as u128 * sol as u128 / total as u128) as u64;
    assert_eq!((env.pool(&coin).opening_state, env.pool(&coin).opening_tokens), (OPENING_SETTLED, expected.tokens_out));
    for (who, sol) in [(&admin, SOL), (&alice, 2 * SOL), (&carol, SOL / 2)] {
        env.claim_seat(&coin, who, true).unwrap();
        assert_eq!(env.tokens(&who.pubkey(), &coin), share(sol));
        env.check_books(&coin);
    }
    assert_eq!(env.pool(&coin).opening_seats, 0);
    env.buy(&coin, &bob, SOL).unwrap();
    for who in [&alice, &carol, &bob, &admin] {
        let held = env.tokens(&who.pubkey(), &coin);
        env.sell(&coin, who, held).unwrap();
        env.check_books(&coin);
    }
    env.claim_creator(&coin, &admin).unwrap();
    env.claim_treasury(&coin, &bob).unwrap();
    for coin in coins.iter().chain([&coin]) {
        env.check_books(coin);
    }
}

/// An upgrade while a batch is under way: the live binary replaced by the current one while a batch is open with seats
/// in it, and again once it is settled with seats still to claim, next to a refused batch whose SOL is still owed.
/// Each batch goes on where it was: the same seats, window and books. The live binary comes in `POOL_SO_LIVE`, dumped
/// from the chain before an upgrade. Without it both sides are the current binary, and this is only a frame: it runs
/// the batch through the loader's upgrade, and would not notice a change in the pool's or the seat's layout. The steps
/// before each upgrade use today's formats; if the next version changes them, they must be written as the live one's.
#[test]
fn upgrade_in_the_middle_of_an_opening_batch() {
    let current = so("POOL_SO", "pool/deploy/dex.so");
    let live = std::env::var("POOL_SO_LIVE").unwrap_or_else(|_| current.clone());
    let binary = std::fs::read(&current).unwrap();
    let same = std::fs::read(&live).unwrap() == binary;
    println!("upgrade in a batch, from {live} to {current}{}", if same { ": the same bytes, so only a frame" } else { "" });
    let mut env = Env::new_from(&live);
    let (admin, alice, bob) = (env.admin.insecure_clone(), env.alice.insecure_clone(), env.bob.insecure_clone());
    let carol = env.wallet(10 * SOL);
    let coin = launch_with_batch(&mut env, 300, SOL);
    let small = launch_with_batch(&mut env, 120, 0);
    env.commit(&coin, &alice, 2 * SOL).unwrap();
    env.commit(&coin, &bob, SOL).unwrap();
    env.commit(&small, &carol, SOL / 200).unwrap();
    let seats = |owners: &[&Keypair]| owners.iter().map(|o| Env::seat_of(&coin, &o.pubkey())).collect::<Vec<_>>();
    let mut watched = vec![coin.pool, coin.vault, small.pool, Env::seat_of(&small, &carol.pubkey())];
    watched.extend(seats(&[&admin, &alice, &bob]));

    // open, with three seats (the snapshot checks the helper, as in the upgrade before the batch)
    let before = env.snapshot(&watched);
    upgrade(&mut env, &binary);
    assert_eq!(env.snapshot(&watched), before, "the upgrade touched no account of the pools'");
    assert_eq!(error(env.buy(&coin, &carol, SOL)), pool_error(PoolError::NotOpenYet));
    env.withdraw(&coin, &bob, SOL / 2).unwrap();
    env.commit(&coin, &carol, SOL).unwrap();
    let opens = env.pool(&coin).opens_at;
    assert_eq!(opens, T0 + 300);
    env.warp(opens - OPENING_LOCK_SECS);
    assert_eq!(error(env.commit(&coin, &alice, SOL)), pool_error(PoolError::OpeningLocked));
    env.check_books(&coin);
    env.warp(opens);
    env.settle(&coin, &bob).unwrap();
    env.settle(&small, &bob).unwrap();
    assert_eq!(env.pool(&small).opening_state, OPENING_REFUND);
    let total = 4 * SOL + SOL / 2;
    let expected = math::buy(opening_reserves(), total, FEE_BPS).unwrap();
    let share = |sol: u64| (expected.tokens_out as u128 * sol as u128 / total as u128) as u64;
    env.claim_seat(&coin, &admin, true).unwrap();
    assert_eq!(env.tokens(&admin.pubkey(), &coin), share(SOL));

    // settled, with three seats to claim, and the refused batch's SOL still owed
    watched.extend(seats(&[&carol]));
    let before = env.snapshot(&watched);
    upgrade(&mut env, &binary);
    assert_eq!(env.snapshot(&watched), before, "the upgrade touched no account of the pools'");
    for (who, sol) in [(&alice, 2 * SOL), (&bob, SOL / 2), (&carol, SOL)] {
        env.claim_seat(&coin, who, true).unwrap();
        assert_eq!(env.tokens(&who.pubkey(), &coin), share(sol));
        env.check_books(&coin);
    }
    let p = env.pool(&coin);
    assert_eq!(p.opening_seats, 0);
    assert!(p.opening_tokens_left < 4, "only the rounding dust stays in the vault");
    let before = env.lamports(&carol.pubkey());
    env.claim_seat(&small, &carol, false).unwrap();
    assert_eq!(env.lamports(&carol.pubkey()), before + SOL / 200 + env.seat_rent() - 5_000);
    env.check_books(&small);
    // and both coins trade
    env.buy(&coin, &bob, SOL).unwrap();
    env.sell(&coin, &alice, 1_000 * TOKEN).unwrap();
    env.buy(&small, &bob, SOL).unwrap();
    env.check_books(&coin);
    env.check_books(&small);
}

