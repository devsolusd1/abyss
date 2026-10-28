//! Calls into Token-2022 and the associated token program.
//!
//! Coins carry no transfer hook in this version. The code that builds a mint and moves
//! tokens already takes an optional hook, so a later version can add one without rewriting
//! the trading path.

use {
    crate::{state::DECIMALS, PoolError},
    anchor_lang::{
        prelude::*,
        solana_program::{
            instruction::Instruction,
            program::{invoke, invoke_signed},
            system_instruction,
        },
    },
    spl_token_2022_interface::{
        extension::{
            metadata_pointer::{self, MetadataPointer},
            transfer_hook::{self, TransferHook},
            BaseStateWithExtensions, ExtensionType, StateWithExtensions,
        },
        instruction::{self as token_ix, AuthorityType},
        state::{Account as TokenAccount, AccountState, Mint},
    },
    spl_token_metadata_interface::{instruction as metadata_ix, state::TokenMetadata},
};

pub const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// The associated token account of `owner` for a Token-2022 `mint`.
pub fn associated_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

/// What a coin's metadata says. Kept to the usual limits, which `launch` checks.
pub struct Metadata<'a> {
    pub name: &'a str,
    pub symbol: &'a str,
    pub uri: &'a str,
}

/// Creates the mint account with room for its fixed extensions and lamports for the metadata
/// that `TokenMetadata` will append. Someone who sees the address first can send it SOL, which
/// would make a plain `create_account` fail, so an address with lamports and nothing else is
/// taken over instead. Anything with data, or owned by a program, is refused.
pub fn create_mint_account<'info>(
    payer: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    hook: bool,
    metadata: &Metadata,
    pool: &Pubkey,
    mint_seeds: &[&[u8]],
) -> Result<()> {
    let extensions: &[ExtensionType] =
        if hook { &[ExtensionType::TransferHook, ExtensionType::MetadataPointer] } else { &[ExtensionType::MetadataPointer] };
    let space = ExtensionType::try_calculate_account_len::<Mint>(extensions)?;
    let token_metadata = TokenMetadata {
        update_authority: (*pool).into(),
        mint: *mint.key,
        name: metadata.name.to_string(),
        symbol: metadata.symbol.to_string(),
        uri: metadata.uri.to_string(),
        additional_metadata: vec![],
    };
    // Token-2022 grows the account for the metadata itself but adds no lamports.
    let full = space + token_metadata.tlv_size_of()?;
    let lamports = Rent::get()?.minimum_balance(full);

    let accounts = [payer.clone(), mint.clone(), system_program.clone()];
    let held = mint.lamports();
    // the mint is the program's address (MINT_SEED): the program signs for it
    if held == 0 {
        invoke_signed(&system_instruction::create_account(payer.key, mint.key, lamports, space as u64, &TOKEN_2022), &accounts, &[mint_seeds])?;
        return Ok(());
    }
    // someone sent SOL to the address first (it can't stop the launch): top it up, then take it as it is
    require!(*mint.owner == System::id() && mint.data_is_empty(), PoolError::MintTaken);
    if held < lamports {
        invoke(&system_instruction::transfer(payer.key, mint.key, lamports - held), &accounts)?;
    }
    invoke_signed(&system_instruction::allocate(mint.key, space as u64), &accounts, &[mint_seeds])?;
    invoke_signed(&system_instruction::assign(mint.key, &TOKEN_2022), &accounts, &[mint_seeds])?;
    Ok(())
}

/// Turns the bare account into the coin: extensions, mint, metadata. The pool's PDA is the
/// mint and metadata authority until `seal` takes both away.
pub fn initialize_mint<'info>(
    mint: &AccountInfo<'info>,
    pool: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    hook: Option<&Pubkey>,
    metadata: &Metadata,
    pool_seeds: &[&[u8]],
) -> Result<()> {
    if let Some(hook) = hook {
        // No authority: nobody can point the coin at another hook later.
        invoke(&transfer_hook::instruction::initialize(&TOKEN_2022, mint.key, None, Some(*hook))?, &[mint.clone()])?;
    }
    invoke(
        &metadata_pointer::instruction::initialize(&TOKEN_2022, mint.key, None, Some(*mint.key))?,
        &[mint.clone()],
    )?;
    invoke(&token_ix::initialize_mint2(&TOKEN_2022, mint.key, pool.key, None, DECIMALS)?, &[mint.clone()])?;
    let ix = metadata_ix::initialize(
        &TOKEN_2022,
        mint.key,
        pool.key,
        mint.key,
        pool.key,
        metadata.name.to_string(),
        metadata.symbol.to_string(),
        metadata.uri.to_string(),
    );
    invoke_signed(&ix, &[mint.clone(), pool.clone(), token_program.clone()], &[pool_seeds])?;
    Ok(())
}

/// Creates the pool's vault: the associated token account the pool owns for this mint.
pub fn create_vault<'info>(
    payer: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    pool: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    let ix = Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer.key, true),
            AccountMeta::new(*vault.key, false),
            AccountMeta::new_readonly(*pool.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
        ],
        // CreateIdempotent.
        data: vec![1],
    };
    invoke(
        &ix,
        &[payer.clone(), vault.clone(), pool.clone(), mint.clone(), system_program.clone(), token_program.clone()],
    )?;
    Ok(())
}

/// Mints the whole supply into the vault, then removes the mint authority and the metadata's
/// update authority for good.
pub fn seal<'info>(
    mint: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    pool: &AccountInfo<'info>,
    supply: u64,
    pool_seeds: &[&[u8]],
) -> Result<()> {
    let signer = &[pool_seeds];
    invoke_signed(
        &token_ix::mint_to(&TOKEN_2022, mint.key, vault.key, pool.key, &[], supply)?,
        &[mint.clone(), vault.clone(), pool.clone()],
        signer,
    )?;
    invoke_signed(
        &token_ix::set_authority(&TOKEN_2022, mint.key, None, AuthorityType::MintTokens, pool.key, &[])?,
        &[mint.clone(), pool.clone()],
        signer,
    )?;
    invoke_signed(
        // The default is the null address: no authority.
        &metadata_ix::update_authority(&TOKEN_2022, mint.key, pool.key, Default::default()),
        &[mint.clone(), pool.clone()],
        signer,
    )?;
    Ok(())
}

/// Reads the finished mint back and refuses anything but what `launch` meant to build: the
/// full supply, no authority of any kind, and exactly the expected extensions.
pub fn check_mint(mint: &AccountInfo, hook: Option<&Pubkey>, metadata: &Metadata, supply: u64) -> Result<()> {
    require_keys_eq!(*mint.owner, TOKEN_2022, PoolError::MintMismatch);
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Mint>::unpack(&data)?;
    let base = state.base;
    let bad = base.mint_authority.is_some()
        || base.freeze_authority.is_some()
        || base.supply != supply
        || base.decimals != DECIMALS
        || !base.is_initialized;
    require!(!bad, PoolError::MintMismatch);

    let mut expected = vec![ExtensionType::MetadataPointer, ExtensionType::TokenMetadata];
    if let Some(hook) = hook {
        expected.push(ExtensionType::TransferHook);
        let ext = state.get_extension::<TransferHook>()?;
        require!(
            Option::<Pubkey>::from(ext.authority).is_none() && Option::<Pubkey>::from(ext.program_id) == Some(*hook),
            PoolError::MintMismatch
        );
    }
    let mut found = state.get_extension_types()?;
    found.sort_by_key(|t| *t as u16);
    expected.sort_by_key(|t| *t as u16);
    require!(found == expected, PoolError::MintMismatch);

    let pointer = state.get_extension::<MetadataPointer>()?;
    require!(
        Option::<Pubkey>::from(pointer.authority).is_none()
            && Option::<Pubkey>::from(pointer.metadata_address) == Some(*mint.key),
        PoolError::MintMismatch
    );
    let stored = state.get_variable_len_extension::<TokenMetadata>()?;
    require!(
        Option::<Pubkey>::from(stored.update_authority).is_none()
            && stored.mint == *mint.key
            && stored.name == metadata.name
            && stored.symbol == metadata.symbol
            && stored.uri == metadata.uri
            && stored.additional_metadata.is_empty(),
        PoolError::MintMismatch
    );
    Ok(())
}

/// A Token-2022 `transfer_checked` that carries the coin's hook accounts along. `extra` holds
/// what the client passed after the instruction's own accounts: the hook program, its account
/// list and the list's entries. Token-2022 finds them by address, so their order is free and a
/// caller can't swap in a different list or rules account.
#[allow(clippy::too_many_arguments)]
pub fn transfer<'info>(
    source: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    hook: Option<&Pubkey>,
    extra: &[AccountInfo<'info>],
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut ix =
        token_ix::transfer_checked(&TOKEN_2022, source.key, mint.key, destination.key, authority.key, &[], amount, DECIMALS)?;
    let mut infos = vec![source.clone(), mint.clone(), destination.clone(), authority.clone()];
    if let Some(hook) = hook {
        spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi(
            &mut ix,
            &mut infos,
            hook,
            source.clone(),
            mint.clone(),
            destination.clone(),
            authority.clone(),
            amount,
            extra,
        )?;
    }
    invoke_signed(&ix, &infos, signer_seeds)?;
    Ok(())
}

/// Burns from the vault. Burning never calls the hook.
pub fn burn<'info>(
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    pool: &AccountInfo<'info>,
    amount: u64,
    pool_seeds: &[&[u8]],
) -> Result<()> {
    invoke_signed(
        &token_ix::burn(&TOKEN_2022, vault.key, mint.key, pool.key, &[], amount)?,
        &[vault.clone(), mint.clone(), pool.clone()],
        &[pool_seeds],
    )?;
    Ok(())
}

/// Extensions a holder's account may carry for a coin of this program: the ones the associated
/// token program adds, and the two a wallet can switch on itself.
const HOLDER_EXTENSIONS: [ExtensionType; 4] = [
    ExtensionType::ImmutableOwner,
    ExtensionType::TransferHookAccount,
    ExtensionType::MemoTransfer,
    ExtensionType::CpiGuard,
];

/// Checks the account a buy pays tokens into, and returns its owner.
///
/// Whoever holds a mint's key can create a mint at that address with other extensions, open
/// accounts for other people's wallets, close the mint and launch the real coin there. Those
/// accounts outlive the first mint and keep what it gave them: one marked non-transferable
/// takes tokens in and never lets them out. Any extension outside `HOLDER_EXTENSIONS`, or a
/// frozen account, can only come from such an earlier mint, so a buy into it is refused.
pub fn check_buyer_account(account: &AccountInfo, mint: &Pubkey, pool: &Pubkey) -> Result<Pubkey> {
    require_keys_eq!(*account.owner, TOKEN_2022, PoolError::WrongAccount);
    let data = account.try_borrow_data()?;
    let state = StateWithExtensions::<TokenAccount>::unpack(&data)?;
    require_keys_eq!(state.base.mint, *mint, PoolError::WrongAccount);
    // The hook would count tokens arriving at the pool's own account as a sell, and the pool
    // would never count them: the buyer would pay for nothing.
    require!(state.base.owner != *pool, PoolError::PoolAsBuyer);
    let clean = state.base.state == AccountState::Initialized
        && state.get_extension_types()?.iter().all(|t| HOLDER_EXTENSIONS.contains(t));
    require!(clean, PoolError::UnsafeBuyerAccount);
    Ok(state.base.owner)
}

/// Adds lamports until `account` is rent-exempt at its current size. Token-2022 grows a mint
/// for its metadata without adding any, and rounds some lengths up past what was funded.
pub fn top_up_rent<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
) -> Result<()> {
    let needed = Rent::get()?.minimum_balance(account.data_len());
    let held = account.lamports();
    if held < needed {
        invoke(
            &system_instruction::transfer(payer.key, account.key, needed - held),
            &[payer.clone(), account.clone(), system_program.clone()],
        )?;
    }
    Ok(())
}
