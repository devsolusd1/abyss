// Puts the pool program in the hands of a Squads v4 multisig, then runs upgrades and config changes through it. The
// program's upgrade authority and its config's admin both go to the multisig's vault (vault 0): after that, nothing
// changes without THRESHOLD of the members' votes, and then the TIMELOCK's wait. Run it from WSL or Linux. Without
// SEND=1 nothing is sent: each command shows its plan, its cost, the public keys and its simulation.
//
//   node multisig.mjs create             MEMBERS=a,b,c THRESHOLD=2 TIMELOCK=<seconds>       (or REHEARSAL=1, on devnet)
//   node multisig.mjs propose-keycheck   MULTISIG=<address>      a harmless proposal; each member signs one once
//   node multisig.mjs handoff            MULTISIG=<address> MEMBERS=a,b,c THRESHOLD=2 TIMELOCK=<seconds> [VAULT=<address>]
//                                        (REHEARSAL=1: no MEMBERS; THRESHOLD and TIMELOCK are then optional)
//   node multisig.mjs write-buffer       MULTISIG=<address> BUILD=<.so or build.json> [BUFFER_KEYPAIR=<path>] [USE_RPC=0|1]
//   node multisig.mjs propose-upgrade    MULTISIG=<address> BUFFER=<address> BUILD=<.so or build.json>
//   node multisig.mjs propose-config     MULTISIG=<address> and any of LAUNCHES_OPEN, LAUNCHER, TREASURY, LAUNCH_FEE
//                                        (lamports), MIN_FEE_BPS, TREASURY_SHARE_BPS, ADMIN (or ADMIN_MULTISIG)
//   node multisig.mjs propose-authority  MULTISIG=<address> NEW_AUTHORITY=<wallet> (or NEW_AUTHORITY_MULTISIG)
//   node multisig.mjs close-buffer       BUFFER=<address> [MULTISIG=<address>, when the vault holds the buffer]
//   node multisig.mjs approve            MULTISIG=<address> INDEX=<n> [BUILD=..., for an upgrade; needed on mainnet]
//   node multisig.mjs execute            MULTISIG=<address> INDEX=<n> [BUILD=..., for an upgrade; needed on mainnet]
//   node multisig.mjs cleanup            MULTISIG=<address>      closes finished proposals, their rent to the vault
//   node multisig.mjs status             [MULTISIG=<address>]
//
// Every command reads CLUSTER=devnet|mainnet (devnet), RPC_URL (needed on mainnet, never printed), KEYPAIR (pays every
// fee and rent; for the handoff, the program's upgrade authority and the config's admin), PROGRAM (the pool program's
// id) and SEND=1. On mainnet a priority price is paid (PRIORITY_FEE=<micro-lamports> sets it, or PRICE, as the other
// scripts call it), and a multisig with a timelock under MIN_TIMELOCK (3600 s) is refused. A proposal, an approval
// and an execution are signed by a member: MEMBER_KEYPAIR=<path>, or MEMBER=1..3 with REHEARSAL=1; with neither, the
// KEYPAIR itself, which must then be a member. Members need no SOL: the KEYPAIR pays. No key file may sit inside a git
// repository. approve and execute refuse what can't be undone or read (a program's close, say) unless DANGER=1.
//
// The order: create, then the key check (every member signs a harmless proposal, so a mistyped member shows before
// anything depends on it), then the handoff. An upgrade: write-buffer (the KEYPAIR's buffer, checked against BUILD),
// propose-upgrade (which hands the buffer to the vault and proposes, in one transaction), approve, execute.
//
// REHEARSAL=1 (devnet only): the members are three test wallets made from the KEYPAIR's key, the same on every run, as
// site/chain/seats-check.mjs makes its wallets. The multisig's create key is made from the KEYPAIR's key and PROGRAM,
// so running create again finds the same multisig instead of making a second one.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SendTransactionError, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY,
  SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import * as squads from "@sqds/multisig";

export const SQUADS = squads.PROGRAM_ID;
export const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const DEVNET_RPC = "https://api.devnet.solana.com";
const GENESIS = { devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" };
/** Never sent for: the devnet program the site runs on today. The rehearsal deploys a program of its own. */
export const PROTECTED = new Set(["CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK"]);
/** Squads refuses a longer one (TimeLockExceedsMaxAllowed). */
export const MAX_TIMELOCK = 90 * 24 * 3600;
/** Short, so a rehearsal can wait it out. */
const REHEARSAL_TIMELOCK = 60;
/** The program's own bounds on ConfigArgs (state.rs, math.rs): refused here rather than in a failed vote. */
export const MAX_LAUNCH_FEE = 1_000_000_000n;
export const MAX_FEE_BPS = 300;
export const BPS = 10_000;
/**
 * Micro-lamports per compute unit on mainnet. The node's recent fees are each slot's lowest, which are mostly 0, so
 * the floor is what usually applies; a transaction that expires is sent again at twice the price, up to the cap. At
 * 150,000 units, the cap costs 0.0015 SOL. The floor is check-deploy.mjs's.
 */
export const PRIORITY_FLOOR = 500_000n;
export const PRIORITY_CAP = 10_000_000n;
const SEND_TRIES = 4;
/** What the CLI's write-buffer gets: as deploy.sh gives its deploy. */
const SIGN_ATTEMPTS = 30;
const MAX_UNITS = 1_400_000;
const [INITIATE, VOTE, EXECUTE] = [1, 2, 4];
const PROGRAMDATA_HEADER = 45;
const BUFFER_HEADER = 37;
/** ConfigArgs: three keys, launch_fee u64, min_fee_bps u16, treasury_share_bps u16, launches_open bool. */
export const CONFIG_ARGS_LEN = 3 * 32 + 8 + 2 + 2 + 1;
/** The key check's memo. A proposal holding only this does nothing when run; its signers are what counts. */
export const KEYCHECK = "nox multisig key check: each member signs one of these once, before the handoff";
const LOADER_KINDS = ["InitializeBuffer", "Write", "DeployWithMaxDataLen", "Upgrade", "SetAuthority", "Close", "ExtendProgram", "SetAuthorityChecked", "Migrate", "ExtendProgramChecked"];

export class Refusal extends Error {}
const refuse = (text) => { throw new Refusal(text); };

/* ---------------- Encoding ---------------- */

export const sha256 = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest(); };
export const disc = (name) => sha256(`global:${name}`).subarray(0, 8);
const accountDisc = (name) => sha256(`account:${name}`).subarray(0, 8);
const u8 = (n) => Buffer.from([n]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const meta = (pubkey, { signer = false, writable = false } = {}) => ({ pubkey, isSigner: signer, isWritable: writable });
export const isWallet = (k) => PublicKey.isOnCurve(k.toBytes());

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58, for a transaction's signature, known before it is sent: printed even if the node never answers. */
export function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`), out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b) break; out = `1${out}`; }
  return out;
}

/* ---------------- The pool program ---------------- */

export const configAddress = (program) => PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
export const programDataAddress = (program) => PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];

/** ConfigArgs in lib.rs order, as programs/examples/devnet.mjs writes them. */
export function encodeConfigArgs(a) {
  return Buffer.concat([
    a.admin.toBuffer(), a.launcher.toBuffer(), a.treasury.toBuffer(),
    u64(a.launchFee), u16(a.minFeeBps), u16(a.treasuryShareBps), u8(a.launchesOpen ? 1 : 0),
  ]);
}

export function decodeConfigArgs(data, at = 0) {
  const key = (i) => new PublicKey(data.subarray(at + i, at + i + 32));
  return {
    admin: key(0), launcher: key(32), treasury: key(64), launchFee: data.readBigUInt64LE(at + 96),
    minFeeBps: data.readUInt16LE(at + 104), treasuryShareBps: data.readUInt16LE(at + 106), launchesOpen: data[at + 108] === 1,
  };
}

/** The Config account: Anchor's 8 bytes of discriminator, the ConfigArgs fields, then the bump. */
export function decodeConfig(data) {
  if (data.length < 8 + CONFIG_ARGS_LEN + 1 || !data.subarray(0, 8).equals(accountDisc("Config"))) return null;
  return decodeConfigArgs(data, 8);
}

/** update_config's accounts, in UpdateConfig's order: the admin signs, the config and the treasury it names are written. */
export function updateConfigIx(program, admin, args) {
  return new TransactionInstruction({
    programId: program,
    keys: [meta(admin, { signer: true }), meta(configAddress(program), { writable: true }), meta(args.treasury, { writable: true })],
    data: Buffer.concat([disc("update_config"), encodeConfigArgs(args)]),
  });
}

export const sameConfig = (a, b) => a.admin.equals(b.admin) && a.launcher.equals(b.launcher) && a.treasury.equals(b.treasury)
  && a.launchFee === b.launchFee && a.minFeeBps === b.minFeeBps && a.treasuryShareBps === b.treasuryShareBps
  && a.launchesOpen === b.launchesOpen;

/* ---------------- The upgradeable loader ---------------- */

/**
 * SetAuthority (4), not SetAuthorityChecked (7): the checked one needs the new authority's signature, and the vault is
 * an address of the Squads program, which signs only inside its own instructions.
 */
export function setUpgradeAuthorityIx(program, current, next) {
  return new TransactionInstruction({
    programId: LOADER,
    keys: [meta(programDataAddress(program), { writable: true }), meta(current, { signer: true }), meta(next)],
    data: u32(4),
  });
}

/** The same SetAuthority, on a buffer: whoever holds a buffer can rewrite it, so the vault must hold it before a vote. */
export function setBufferAuthorityIx(buffer, current, next) {
  return new TransactionInstruction({
    programId: LOADER, keys: [meta(buffer, { writable: true }), meta(current, { signer: true }), meta(next)], data: u32(4),
  });
}

/** Close (5) of a buffer: its SOL to the recipient. Only its authority can do it, so a buffer given away needs a vote. */
export function closeBufferIx(buffer, recipient, authority) {
  return new TransactionInstruction({
    programId: LOADER,
    keys: [meta(buffer, { writable: true }), meta(recipient, { writable: true }), meta(authority, { signer: true })],
    data: u32(5),
  });
}

/**
 * Upgrade (3), in the loader's account order. The spill account gets the buffer's lamports back. Four bytes, with no
 * trailing close_buffer byte (SIMD-0430): every runtime, before that change and after, reads it as the upgrade that
 * closes the buffer.
 */
export function upgradeIx({ program, buffer, spill, authority }) {
  return new TransactionInstruction({
    programId: LOADER,
    keys: [
      meta(programDataAddress(program), { writable: true }), meta(program, { writable: true }), meta(buffer, { writable: true }),
      meta(spill, { writable: true }), meta(SYSVAR_RENT_PUBKEY), meta(SYSVAR_CLOCK_PUBKEY), meta(authority, { signer: true }),
    ],
    data: u32(3),
  });
}

/** The loader's states: Buffer (1) with its authority, Program (2) pointing at its data, ProgramData (3) with its own. */
export function decodeBuffer(data) {
  if (data.length < BUFFER_HEADER || data.readUInt32LE(0) !== 1) return null;
  return { authority: data[4] ? new PublicKey(data.subarray(5, 37)) : null, bytes: data.subarray(BUFFER_HEADER) };
}
export function decodeProgramAccount(data) {
  if (data.length < 36 || data.readUInt32LE(0) !== 2) return null;
  return { programData: new PublicKey(data.subarray(4, 36)) };
}
export function decodeProgramData(data) {
  if (data.length < PROGRAMDATA_HEADER || data.readUInt32LE(0) !== 3) return null;
  return {
    slot: data.readBigUInt64LE(4), authority: data[12] ? new PublicKey(data.subarray(13, 45)) : null,
    room: data.length - PROGRAMDATA_HEADER, bytes: data.subarray(PROGRAMDATA_HEADER),
  };
}
/** A buffer or a program's data holds a binary: its bytes, then only zeros. */
export const holds = (bytes, so) => bytes.length >= so.length && bytes.subarray(0, so.length).equals(so) && bytes.subarray(so.length).every((b) => b === 0);

export const expand = (path) => resolve(String(path).replace(/^~(?=$|\/)/, homedir()));

/**
 * BUILD: the .so, or the build.json build.sh writes next to it. The binary must be built for PROGRAM: declare_id!
 * writes the id into it, so a build for another id (which the program would refuse to run as) is caught here.
 */
export function loadBuild(path, { program, cluster }) {
  const file = expand(path);
  if (!existsSync(file)) refuse(`BUILD: there is no file at ${file}`);
  let so = file, info = null;
  if (file.endsWith(".json")) {
    try { info = JSON.parse(readFileSync(file, "utf8")); } catch { refuse(`BUILD: ${file} is not a build.json`); }
    so = join(dirname(file), info.file ?? "dex.so");
    if (!existsSync(so)) refuse(`BUILD: ${file} names ${so}, which is not there`);
  }
  const bytes = readFileSync(so);
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) refuse(`BUILD: ${so} is not a program binary (.so)`);
  const sha = sha256(bytes).toString("hex");
  if (info?.sha256 && info.sha256 !== sha) refuse(`BUILD: ${so} is not the binary ${file} describes (sha256 ${sha}, not ${info.sha256})`);
  if (info?.program && info.program !== program.toBase58()) refuse(`BUILD: ${file} is a build for ${info.program}, not for PROGRAM ${program.toBase58()}`);
  if (cluster === "mainnet" && info?.dirty === true) refuse(`BUILD: ${file} is a dirty build: mainnet takes only a clean build of a commit`);
  if (!bytes.includes(program.toBuffer())) refuse(`BUILD: ${so} was not built for PROGRAM ${program.toBase58()} (the id is not in the binary): build.sh <PROGRAM> makes one`);
  return { file: so, bytes, sha, commit: info?.commit ?? null };
}

/* ---------------- Squads ---------------- */

export const multisigAddress = (createKey) => squads.getMultisigPda({ createKey })[0];
export const vaultAddress = (address) => squads.getVaultPda({ multisigPda: address, index: 0 })[0];
export const transactionAddress = (address, index) => squads.getTransactionPda({ multisigPda: address, index: BigInt(index) })[0];
export const proposalAddress = (address, index) => squads.getProposalPda({ multisigPda: address, transactionIndex: BigInt(index) })[0];
export const programConfigAddress = () => squads.getProgramConfigPda({})[0];

/** The rehearsal's members: seeds from the KEYPAIR's key and the member's number, the same on every run. */
export const rehearsalMember = (secret, n) => Keypair.fromSeed(sha256(secret, `nox rehearsal member ${n}`));
/** The multisig's create key, from the KEYPAIR's key and the program: one multisig per payer and program. */
export const createKeyFor = (secret, program) => Keypair.fromSeed(sha256(secret, `nox multisig create key ${program.toBase58()}`));

export function createMultisigIx({ treasury, payer, createKey, members, threshold, timelock }) {
  const address = multisigAddress(createKey);
  return squads.instructions.multisigCreateV2({
    treasury, creator: payer, createKey, multisigPda: address,
    // No config authority: the members, threshold and timelock change only by the members' own vote, after the timelock.
    // The vault collects the rent of finished proposals (cleanup): with none, Squads would keep it for good. Collecting
    // is all it does; it gives no say over the multisig.
    configAuthority: null, rentCollector: vaultAddress(address),
    threshold, timeLock: timelock, members: members.map((key) => ({ key, permissions: squads.types.Permissions.all() })),
  });
}

/** The vault transaction holding `inner` and its proposal, in one go: a member proposes, the payer pays the rent. */
export function proposeIxs({ address, index, proposer, payer, inner }) {
  const message = new TransactionMessage({ payerKey: vaultAddress(address), recentBlockhash: PublicKey.default.toBase58(), instructions: inner });
  return [
    squads.instructions.vaultTransactionCreate({
      multisigPda: address, transactionIndex: BigInt(index), creator: proposer, rentPayer: payer,
      vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message,
    }),
    squads.instructions.proposalCreate({ multisigPda: address, transactionIndex: BigInt(index), creator: proposer, rentPayer: payer }),
  ];
}

export const keycheckIx = () => new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(KEYCHECK) });

export function decodeMultisig(info) {
  if (!info) return { error: "does not exist" };
  if (!info.owner.equals(SQUADS)) return { error: `is not a Squads v4 account (its owner is ${info.owner.toBase58()})` };
  if (!Buffer.from(squads.accounts.multisigDiscriminator).equals(info.data.subarray(0, 8))) return { error: "is a Squads account, but not a multisig" };
  const [ms] = squads.accounts.Multisig.fromAccountInfo(info);
  return {
    ms: {
      createKey: ms.createKey, configAuthority: ms.configAuthority, threshold: ms.threshold, timeLock: ms.timeLock,
      transactionIndex: BigInt(ms.transactionIndex.toString()), staleIndex: BigInt(ms.staleTransactionIndex.toString()),
      rentCollector: ms.rentCollector ?? null,
      members: ms.members.map((m) => ({ key: m.key, mask: m.permissions.mask })),
    },
  };
}

export function decodeProposal(info) {
  if (!info || !info.owner.equals(SQUADS) || !Buffer.from(squads.accounts.proposalDiscriminator).equals(info.data.subarray(0, 8))) return null;
  const [p] = squads.accounts.Proposal.fromAccountInfo(info);
  return {
    status: p.status.__kind, at: p.status.timestamp === undefined ? null : Number(p.status.timestamp.toString()),
    approved: p.approved, rejected: p.rejected, cancelled: p.cancelled,
  };
}

export function decodeVaultTransaction(info) {
  if (!info || !info.owner.equals(SQUADS) || !Buffer.from(squads.accounts.vaultTransactionDiscriminator).equals(info.data.subarray(0, 8))) return null;
  const [t] = squads.accounts.VaultTransaction.fromAccountInfo(info);
  const keys = t.message.accountKeys;
  return {
    creator: t.creator, vaultIndex: t.vaultIndex,
    instructions: t.message.instructions.map((ix) => ({
      programId: keys[ix.programIdIndex], accounts: Array.from(ix.accountIndexes, (i) => keys[i]), data: Buffer.from(ix.data),
    })),
  };
}

/* ---------------- Checks, with no network: what each command refuses ---------------- */

export const sameKeys = (a, b) => a.length === b.length && new Set(a.map(String)).size === a.length
  && a.every((k) => b.some((j) => j.equals(k)));

export function parseKeys(text, name) {
  return text.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    try { return new PublicKey(s); } catch { return refuse(`${name}: "${s}" is not a public key`); }
  });
}
const key = (text, name) => parseKeys(text ?? "", name)[0] ?? refuse(`${name}=<address> is needed`);

function whole(text, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(String(text)) || Number(text) < min || Number(text) > max) refuse(`${name} must be a whole number from ${min} to ${max}, not "${text}"`);
  return Number(text);
}
function flag(text, name) {
  if (text === undefined || text === "" || text === "0") return false;
  if (text === "1") return true;
  return refuse(`${name} is 1 or 0, not "${text}"`);
}
/** USE_RPC, as deploy.sh reads it: 1 on mainnet and 0 on devnet unless given. */
export const useRpcFor = (cluster, env) => (env.USE_RPC === undefined || env.USE_RPC === "" ? cluster === "mainnet" : flag(env.USE_RPC, "USE_RPC"));

/**
 * The shortest timelock a mainnet multisig gets, unless MIN_TIMELOCK says otherwise: check-deploy.mjs's own, so a
 * multisig this script makes or hands the program to never fails that check after the handoff, which can't be undone.
 */
export const MIN_MAINNET_TIMELOCK = 3600;

/** On mainnet these stop a create and a handoff alike; check-deploy.mjs fails the same multisig afterwards. */
function weakness({ threshold, timelock, configAuthority = null, payerIsMember, minTimelock = MIN_MAINNET_TIMELOCK }) {
  const out = [];
  if (threshold < 2) out.push("its threshold is 1: any one member's key alone could upgrade the program");
  if (timelock === 0) out.push("its timelock is 0: an approved upgrade could run at once, with no time for anyone to see it coming");
  else if (timelock < minTimelock) {
    out.push(`its timelock is ${timelock} s, under ${minTimelock} (MIN_TIMELOCK changes it): little time to see an upgrade coming, and check-deploy.mjs fails it`);
  }
  if (configAuthority && !configAuthority.equals(PublicKey.default)) out.push(`it has a config authority, ${configAuthority.toBase58()}, which can change the members and threshold alone, with no vote and no timelock`);
  if (payerIsMember) out.push("the KEYPAIR is one of its members: the deploy wallet would still hold a say after the handoff; pick another key");
  return out;
}

/** What `create` refuses and warns about. */
export function checkShape({ cluster, members, threshold, timelock, payer = null, minTimelock = MIN_MAINNET_TIMELOCK }) {
  const refusals = [], warnings = [];
  const seen = new Set(), twice = new Set();
  for (const m of members) (seen.has(m.toBase58()) ? twice : seen).add(m.toBase58());
  if (!members.length) refusals.push("no members");
  if (twice.size) refusals.push(`listed twice in MEMBERS: ${[...twice].join(", ")}`);
  const offCurve = members.filter((m) => !isWallet(m));
  if (offCurve.length) refusals.push(`not a wallet's key, so it could never sign: ${offCurve.map(String).join(", ")}`);
  if (!Number.isInteger(threshold) || threshold < 1) refusals.push("THRESHOLD must be 1 or more");
  else if (threshold > members.length) refusals.push(`THRESHOLD ${threshold} is more than the ${members.length} members`);
  if (!Number.isInteger(timelock) || timelock < 0 || timelock > MAX_TIMELOCK) refusals.push(`TIMELOCK must be 0 to ${MAX_TIMELOCK} seconds (90 days, Squads' most)`);
  if (refusals.length) return { refusals, warnings };
  const weak = weakness({ threshold, timelock, minTimelock, payerIsMember: Boolean(payer && members.some((m) => m.equals(payer))) });
  if (cluster === "mainnet") {
    refusals.push(...weak.map((w) => `on mainnet the multisig can't be this: ${w}`));
    if (threshold === members.length && members.length > 1) warnings.push("every member must vote: one lost key freezes the program for good");
  } else if (payer && members.some((m) => m.equals(payer))) warnings.push("the KEYPAIR is one of the members (fine for a test; mainnet refuses it)");
  return { refusals, warnings };
}

/** A multisig whose vault can act: enough voters for its threshold, someone to propose, someone to execute. */
export function checkCanAct(ms) {
  const can = (bit) => ms.members.filter((m) => m.mask & bit).length;
  const out = [];
  if (ms.threshold < 1) out.push("its threshold is 0");
  if (can(VOTE) < ms.threshold) out.push(`only ${can(VOTE)} of its members can vote, under its threshold of ${ms.threshold}: it could never pass anything`);
  if (!can(INITIATE)) out.push("none of its members can propose");
  if (!can(EXECUTE)) out.push("none of its members can execute");
  return out;
}

/** A key check: a vault transaction holding only the key check's memo. */
export const isKeycheck = (vtx) => vtx.instructions.length === 1 && vtx.instructions[0].programId.equals(MEMO)
  && vtx.instructions[0].data.equals(Buffer.from(KEYCHECK));

/**
 * The members who have signed a key check: its proposer, and whoever approved, rejected or cancelled it. Squads takes
 * each of those signatures from members only, so each one shows that member holds the key the multisig lists.
 */
export function provenMembers(entries) {
  const seen = new Map();
  for (const { vtx, proposal } of entries) {
    if (!vtx || !isKeycheck(vtx)) continue;
    for (const k of [vtx.creator, ...(proposal ? [...proposal.approved, ...proposal.rejected, ...proposal.cancelled] : [])]) seen.set(k.toBase58(), k);
  }
  return [...seen.values()];
}

/**
 * What `handoff` refuses: a vault that is not vault 0 of an existing multisig able to act; members, threshold or
 * timelock other than the ones expected; a member who has not shown their key (the key check); on mainnet, a weak
 * multisig; a config authority anywhere; or a program whose authority or config admin is someone other than the KEYPAIR
 * (or already the vault). `parts` says which of the two moves are still to do.
 */
export function checkHandoff({ cluster, address, found, vault, expectedVault = null, expectedMembers = null, expectedThreshold = null, expectedTimelock = null, proven = null, payer, authority, config, minTimelock = MIN_MAINNET_TIMELOCK }) {
  const refusals = [], warnings = [], parts = { authority: false, config: false };
  // Once the vault holds both, the key check has done its work: its proposal may be executed and cleaned up since,
  // which takes its signers off the chain, and a run to see where things stand must not read as a refusal.
  const handedOver = Boolean(authority?.equals(vault) && config?.admin.equals(vault));
  if (expectedVault && !expectedVault.equals(vault)) refusals.push(`VAULT ${expectedVault.toBase58()} is not vault 0 of MULTISIG ${address.toBase58()}, which is ${vault.toBase58()}`);
  if (found.error) {
    refusals.push(`MULTISIG ${address.toBase58()} ${found.error}: pass the multisig's own address (not its vault's), after create`);
  } else {
    const { ms } = found;
    refusals.push(...checkCanAct(ms).map((r) => `the multisig is unusable: ${r}`));
    if (expectedMembers && !sameKeys(ms.members.map((m) => m.key), expectedMembers)) {
      refusals.push(`the multisig's members (${ms.members.map((m) => m.key.toBase58()).join(", ")}) are not the ones expected`);
    }
    if (expectedThreshold !== null && ms.threshold !== expectedThreshold) refusals.push(`the multisig takes ${ms.threshold} votes, not THRESHOLD ${expectedThreshold}`);
    if (expectedTimelock !== null && ms.timeLock !== expectedTimelock) refusals.push(`the multisig's timelock is ${ms.timeLock} s, not TIMELOCK ${expectedTimelock}`);
    const payerIsMember = ms.members.some((m) => m.key.equals(payer));
    // A config authority can swap the members alone: on any cluster, the program does not go to such a multisig.
    if (!ms.configAuthority.equals(PublicKey.default)) refusals.push(`the multisig has a config authority, ${ms.configAuthority.toBase58()}, which can change the members and threshold alone, with no vote and no timelock`);
    if (cluster === "mainnet") {
      refusals.push(...weakness({ threshold: ms.threshold, timelock: ms.timeLock, minTimelock, payerIsMember }).map((w) => `on mainnet the program can't go to this multisig: ${w}`));
    } else if (payerIsMember) warnings.push("the KEYPAIR is one of the members (fine for a test; mainnet refuses it)");
    if (!ms.rentCollector) warnings.push("the multisig has no rent collector: the rent of each of its proposals stays locked for good");
    const missing = proven ? ms.members.filter((m) => !proven.some((k) => k.equals(m.key))) : ms.members;
    if (missing.length && !handedOver) {
      refusals.push(`not every member has shown they hold their key: ${missing.map((m) => m.key.toBase58()).join(", ")} `
        + "signed no key check. A mistyped member would only show once the program is theirs: each signs one first "
        + "(propose-keycheck, then approve; the one who proposes counts too)");
    }
  }
  if (!config) refusals.push("the program has no config yet: run init-config first (with the upgrade authority handed over first, init_config would need a vote)");
  else if (config.admin.equals(vault)) { /* done already */ } else if (config.admin.equals(payer)) parts.config = true;
  else refusals.push(`the config's admin is ${config.admin.toBase58()}, not the KEYPAIR ${payer.toBase58()}`);
  if (!authority) refusals.push("the program has no upgrade authority: it is immutable, and there is nothing to hand over");
  else if (authority.equals(vault)) { /* done already */ } else if (authority.equals(payer)) parts.authority = true;
  else refusals.push(`the upgrade authority is ${authority.toBase58()}, not the KEYPAIR ${payer.toBase58()}`);
  return { refusals, warnings, parts };
}

/**
 * What the handoff checks the multisig against: the rehearsal's members or MEMBERS, and THRESHOLD and TIMELOCK when
 * given. Sending needs the members on every cluster, and on mainnet the threshold and timelock too: a mistyped
 * MULTISIG would hand the program to strangers, and a rehearsal's short timelock would slip through.
 */
export function expectedFor(env, { rehearsal, send, cluster = "devnet", rehearsalWallets = [] }) {
  if (rehearsal && env.MEMBERS) refuse("REHEARSAL=1 expects its own three members: leave MEMBERS out");
  const members = rehearsal ? rehearsalWallets.map((w) => w.publicKey) : env.MEMBERS ? parseKeys(env.MEMBERS, "MEMBERS") : null;
  if (send && !members) refuse("the handoff needs MEMBERS=a,b,c (or REHEARSAL=1): the members the multisig must have");
  const threshold = env.THRESHOLD ? whole(env.THRESHOLD, "THRESHOLD", 1) : null;
  const timelock = env.TIMELOCK ? whole(env.TIMELOCK, "TIMELOCK", 0, MAX_TIMELOCK) : null;
  if (send && cluster === "mainnet" && (threshold === null || timelock === null)) {
    refuse("on mainnet the handoff needs THRESHOLD=n and TIMELOCK=<seconds> too: what the multisig must have, checked against the chain");
  }
  return { members, threshold, timelock };
}
/** The members alone, as earlier versions of this script took them. */
export const expectedMembersFor = (env, o) => expectedFor(env, o).members;

/** What `create` refuses about PROGRAM: the multisig is tied to it for good (the create key is made from it). */
export function checkCreateProgram({ cluster, program, state, payer, vault }) {
  const refusals = [], warnings = [];
  const id = program.toBase58();
  if (!state) {
    const text = `PROGRAM ${id} does not exist on ${cluster} yet, and the multisig is tied to this id for good`;
    if (cluster === "mainnet") refusals.push(`${text}: deploy it first (MAINNET.md), or check the id`);
    else warnings.push(`${text}: check the id before SEND=1`);
  } else if (!state.upgradeable) refusals.push(`PROGRAM ${id} is not a program of the upgradeable loader`);
  else if (!state.authority) refusals.push(`PROGRAM ${id} is immutable: there would be nothing to hand over`);
  else if (!state.authority.equals(payer) && !state.authority.equals(vault)) {
    refusals.push(`PROGRAM ${id}'s upgrade authority is ${state.authority.toBase58()}, not the KEYPAIR: this KEYPAIR could never hand it over`);
  }
  return { refusals, warnings };
}

/** The config fields propose-config changes; the rest stays as it is on chain. ADMIN_MULTISIG: that multisig's vault. */
export function configOverrides(env) {
  const given = (name) => env[name] !== undefined && env[name] !== "";
  const o = {};
  if (given("LAUNCHES_OPEN")) {
    const v = String(env.LAUNCHES_OPEN).toLowerCase();
    if (!["1", "0", "true", "false"].includes(v)) refuse(`LAUNCHES_OPEN is 1 or 0, not "${env.LAUNCHES_OPEN}"`);
    o.launchesOpen = v === "1" || v === "true";
  }
  if (given("ADMIN")) o.admin = key(env.ADMIN, "ADMIN");
  if (given("ADMIN_MULTISIG")) {
    const vault = vaultAddress(key(env.ADMIN_MULTISIG, "ADMIN_MULTISIG"));
    if (o.admin && !o.admin.equals(vault)) refuse(`ADMIN ${o.admin.toBase58()} is not vault 0 of ADMIN_MULTISIG, which is ${vault.toBase58()}: give one or the other`);
    o.admin = vault;
  }
  if (given("LAUNCHER")) o.launcher = key(env.LAUNCHER, "LAUNCHER");
  if (given("TREASURY")) o.treasury = key(env.TREASURY, "TREASURY");
  if (given("LAUNCH_FEE")) o.launchFee = BigInt(whole(env.LAUNCH_FEE, "LAUNCH_FEE (in lamports)", 0, Number(MAX_LAUNCH_FEE)));
  if (given("MIN_FEE_BPS")) o.minFeeBps = whole(env.MIN_FEE_BPS, "MIN_FEE_BPS", 0, MAX_FEE_BPS);
  if (given("TREASURY_SHARE_BPS")) o.treasuryShareBps = whole(env.TREASURY_SHARE_BPS, "TREASURY_SHARE_BPS", 0, BPS);
  if (o.admin?.equals(PublicKey.default)) refuse("ADMIN 11111111111111111111111111111111 would lock the config for good");
  return o;
}

/**
 * Who may sign as the config's admin and launcher: a wallet, or a vault (this multisig's, or `otherVault`, one checked
 * on chain). Any other address of a program has no key, so the config, or every launch, would be locked.
 */
export function checkConfigTargets(next, { vault, otherVault = null }) {
  const out = [];
  const vaultOk = (k) => k.equals(vault) || Boolean(otherVault && k.equals(otherVault));
  if (!isWallet(next.admin) && !vaultOk(next.admin)) {
    out.push(`the admin ${next.admin.toBase58()} is not a wallet's key nor this multisig's vault: no one could sign as the admin (for another multisig's vault, ADMIN_MULTISIG=<that multisig>)`);
  }
  if (!isWallet(next.launcher) && !vaultOk(next.launcher)) out.push(`the launcher ${next.launcher.toBase58()} is not a wallet's key nor this multisig's vault: no one could sign a launch`);
  return out;
}

/** What an upgrade from this buffer needs, at the vote and at the run: the vault holds it, and its bytes are the build's. */
export function checkBuffer({ cluster, buffer, vault, so = null, needBuild = false }) {
  if (!buffer) return ["the buffer is gone (closed, or never made): this upgrade can't run; make a new buffer and a new proposal"];
  const out = [];
  if (!buffer.authority?.equals(vault)) out.push(`the buffer is held by ${buffer.authority?.toBase58() ?? "no one"}, not the vault: whoever holds it can still rewrite its bytes after the vote`);
  if (so) {
    if (!holds(buffer.bytes, so)) out.push(`the buffer's bytes (${buffer.bytes.length}, sha256 ${sha256(buffer.bytes).toString("hex")}) are not BUILD's (${so.length}, sha256 ${sha256(so).toString("hex")})`);
  } else if (needBuild && cluster === "mainnet") out.push("on mainnet an upgrade's buffer is checked against a build: BUILD=<.so or build.json> is needed");
  return out;
}

const CONFIG_FIELDS = [
  ["admin", "admin"], ["launcher", "launcher"], ["treasury", "treasury"], ["launchFee", "launch_fee"],
  ["minFeeBps", "min_fee_bps"], ["treasuryShareBps", "treasury_share_bps"], ["launchesOpen", "launches_open"],
];
const fieldText = (v) => (v instanceof PublicKey ? v.toBase58() : String(v));
export function configDiff(from, to) {
  return CONFIG_FIELDS.filter(([f]) => fieldText(from[f]) !== fieldText(to[f])).map(([f, name]) => `${name} ${fieldText(from[f])} -> ${fieldText(to[f])}`);
}

/**
 * One line for one instruction of a vault transaction, and why it is dangerous, if it is: what can't be undone (a
 * program's close, an authority taken away) or what this script can't read. approve and execute stop on a danger.
 */
export function explainInstruction({ programId, accounts, data }, { program, vault, config = null, name = (k) => (k ? k.toBase58() : "none") }) {
  const say = (text, danger = null, more = {}) => ({ text, danger, ...more });
  const n = data.length >= 4 ? data.readUInt32LE(0) : -1;
  const programData = programDataAddress(program);
  if (programId.equals(LOADER)) {
    const kind = LOADER_KINDS[n] ?? `instruction ${n}`;
    if (n === 3 && accounts.length >= 7 && (data.length === 4 || (data.length === 5 && data[4] <= 1))) {
      const closes = data.length === 4 || data[4] === 1;
      return say(`upgrade ${name(accounts[1])} from buffer ${accounts[2].toBase58()} (${closes ? `then the buffer closes, its SOL to ${name(accounts[3])}` : "the buffer is kept"})`,
        accounts[1].equals(program) ? null : `it upgrades ${accounts[1].toBase58()}, not PROGRAM`, { upgrade: { program: accounts[1], buffer: accounts[2], closes } });
    }
    if ((n === 4 || n === 7) && data.length === 4 && accounts.length >= 2) {
      const what = accounts[0].equals(programData) ? `the upgrade authority of ${program.toBase58()}` : `the authority of ${accounts[0].toBase58()}`;
      if (accounts.length < 3) return say(`take away ${what}, for good`, "it takes an authority away for good: a program could never be upgraded again, a buffer never closed");
      const next = accounts[2];
      return say(`give ${what} to ${name(next)}${n === 7 ? " (SetAuthorityChecked: the new one signs)" : ""}`,
        next.equals(vault) || isWallet(next) ? null : `the new authority ${next.toBase58()} is neither a wallet's key nor this vault: unless it is another multisig's vault, no one could ever use it`);
    }
    if (n === 5 && (data.length === 4 || data.length === 5) && accounts.length >= 2) {
      const ofProgram = accounts.length >= 4 || accounts[0].equals(programData);
      return say(`close ${ofProgram ? `the program ${(accounts[3] ?? program).toBase58()}` : accounts[0].toBase58()}, its SOL to ${name(accounts[1])}`,
        ofProgram ? "it closes a PROGRAM: its address dies for good, and every pool with it" : null);
    }
    if ((n === 6 || n === 9) && data.length >= 8 && accounts.length >= 2) return say(`extend ${accounts[1].toBase58()}'s room by ${data.readUInt32LE(4)} bytes`);
    return say(`the loader's ${kind}, with ${accounts.length} accounts`, `the loader's ${kind} is nothing this kit proposes: read it in the Squads app or the explorer first`);
  }
  if (programId.equals(program) && data.length === 8 + CONFIG_ARGS_LEN && data.subarray(0, 8).equals(disc("update_config"))) {
    const args = decodeConfigArgs(data, 8);
    const changed = config ? configDiff(config, args) : [];
    const leaves = config?.admin.equals(vault) && !args.admin.equals(vault) ? " (the config leaves this multisig)" : "";
    const targets = checkConfigTargets(args, { vault });
    return say(`update_config: ${changed.length ? changed.join(", ") : config ? "the config as it is now" : "(the config can't be read)"}${leaves}`,
      targets.length ? targets.join("; ") : null, { update: args });
  }
  if (programId.equals(MEMO)) return say(`memo "${data.toString("utf8")}"${data.equals(Buffer.from(KEYCHECK)) ? ": the key check, which does nothing when run" : ""}`);
  if (programId.equals(SystemProgram.programId) && n === 2 && data.length === 12 && accounts.length >= 2) {
    return say(`send ${sol(data.readBigUInt64LE(4))} from ${name(accounts[0])} to ${name(accounts[1])}`);
  }
  return say(`${programId.toBase58()}: ${data.length} bytes of data, ${accounts.length} accounts`,
    `an instruction this script can't read (program ${programId.toBase58()}): read it in the Squads app or the explorer first`);
}

/** The same instructions, in the same order: a proposal that already holds this change. */
export function sameInstructions(held, inner) {
  return held.length === inner.length && held.every((h, i) => h.programId.equals(inner[i].programId) && h.data.equals(inner[i].data)
    && h.accounts.length === inner[i].keys.length && h.accounts.every((a, j) => a.equals(inner[i].keys[j].pubkey)));
}

/**
 * A proposal still open that holds the same change: a second one would only lock more rent (a send whose confirmation
 * was lost may have made the first). A key check that has passed can't take more signers, so another may be made.
 */
export function findTwin(entries, inner, { staleIndex = 0n, keycheck = false } = {}) {
  return entries.find((e) => {
    if (!e.vtx || !sameInstructions(e.vtx.instructions, inner)) return false;
    const status = e.proposal?.status ?? "Draft";
    if (status === "Approved") return !keycheck;
    return (status === "Draft" || status === "Active") && e.index > staleIndex;
  }) ?? null;
}

/** Which proposals Squads lets anyone close (vault_transaction_accounts_close): finished, or stale and never approved. */
export function closable(entry, staleIndex) {
  if (!entry.vtx) return false;
  const status = entry.proposal?.status ?? null;
  if (["Executed", "Rejected", "Cancelled"].includes(status)) return true;
  return entry.index <= staleIndex && (status === null || status === "Draft" || status === "Active");
}

const COMMANDS = ["create", "propose-keycheck", "handoff", "write-buffer", "propose-upgrade", "propose-config", "propose-authority", "close-buffer", "approve", "execute", "cleanup", "status"];

/** Every variable every command shares, checked before anything is read. */
export function settings(command, env) {
  if (!COMMANDS.includes(command)) refuse(`usage: node multisig.mjs <${COMMANDS.join("|")}> (the top of multisig.mjs says how)`);
  const cluster = env.CLUSTER || "devnet";
  if (cluster !== "devnet" && cluster !== "mainnet") refuse(`CLUSTER is devnet or mainnet, not "${cluster}"`);
  if (cluster === "mainnet" && !env.RPC_URL) refuse("CLUSTER=mainnet needs RPC_URL, a paid node (it is never printed)");
  const rehearsal = flag(env.REHEARSAL, "REHEARSAL");
  if (rehearsal && cluster !== "devnet") refuse("REHEARSAL=1 is for devnet only: its members are test wallets made from the KEYPAIR's key");
  if (!env.PROGRAM) refuse("PROGRAM=<the pool program's id> is needed");
  const program = key(env.PROGRAM, "PROGRAM");
  if (cluster === "mainnet" && !env.KEYPAIR) refuse("CLUSTER=mainnet needs KEYPAIR=<path>: the wallet that pays, and the program's authority for the handoff");
  if (env.MEMBER && env.MEMBER_KEYPAIR) refuse("set MEMBER or MEMBER_KEYPAIR, not both");
  if (env.MEMBER && !rehearsal) refuse("MEMBER=n picks one of the rehearsal's test wallets, so it needs REHEARSAL=1; otherwise set MEMBER_KEYPAIR=<path>");
  const member = env.MEMBER ? whole(env.MEMBER, "MEMBER", 1, 3) : null;
  const send = flag(env.SEND, "SEND");
  if (send && PROTECTED.has(program.toBase58())) {
    refuse(`PROGRAM ${program.toBase58()} is the devnet program the site runs on today: this script sends nothing for it. The rehearsal deploys a program of its own (MAINNET.md)`);
  }
  const danger = flag(env.DANGER, "DANGER");
  // PRICE is what deploy.sh, init-config.mjs and check-deploy.mjs call it: either name sets it here.
  if (env.PRIORITY_FEE && env.PRICE && env.PRIORITY_FEE !== env.PRICE) refuse("PRIORITY_FEE and PRICE say two prices: set one");
  const fee = env.PRIORITY_FEE || env.PRICE;
  const priority = cluster === "mainnet" && fee ? BigInt(whole(fee, env.PRIORITY_FEE ? "PRIORITY_FEE" : "PRICE", 0, Number(PRIORITY_CAP))) : null;
  const minTimelock = env.MIN_TIMELOCK ? whole(env.MIN_TIMELOCK, "MIN_TIMELOCK", 0, MAX_TIMELOCK) : MIN_MAINNET_TIMELOCK;
  return {
    command, cluster, rehearsal, program, member, send, danger, priority, minTimelock, env,
    rpc: env.RPC_URL || DEVNET_RPC, keypairPath: env.KEYPAIR || "~/.config/solana/devnet.json", memberKeypairPath: env.MEMBER_KEYPAIR || null,
    release: expand(env.NOX_RELEASE || "~/nox-release"),
  };
}

/** The git repository a file sits in, if any. */
export function gitRepoAbove(file) {
  let dir = dirname(resolve(file));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
/** A key in a repository is one `git add -A` and one push from public (this one is): no key file is taken from one. */
export function outsideRepo(file, name) {
  const repo = gitRepoAbove(file);
  if (repo) refuse(`${name}: ${file} is inside the git repository ${repo}, where one "git add -A" and a push would publish it. Keep keys outside any repository (in ~/nox-keys, say)`);
}

/** Reads a keypair file. Nothing of its content is ever printed, not even in an error. */
export function loadKeypair(path, name) {
  const file = expand(path);
  if (!existsSync(file)) refuse(`${name}: there is no file at ${file}`);
  outsideRepo(file, name);
  let bytes;
  try { bytes = JSON.parse(readFileSync(file, "utf8")); } catch { refuse(`${name}: ${file} is not a keypair file`); }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) refuse(`${name}: ${file} is not a keypair file`);
  const secret = Uint8Array.from(bytes);
  try { return { keypair: Keypair.fromSecretKey(secret), secret }; } catch { return refuse(`${name}: ${file} is not a keypair file`); }
}

/* ---------------- Printing ---------------- */

export const sol = (lamports) => `${(Number(lamports) / 1e9).toFixed(9).replace(/\.?0+$/, "")} SOL`;
export function duration(seconds) {
  let s = Math.max(0, Math.round(seconds));
  const out = [];
  for (const [n, unit] of [[86_400, "d"], [3_600, "h"], [60, "min"], [1, "s"]]) {
    if (s >= n || (n === 1 && !out.length)) { out.push(`${Math.floor(s / n)} ${unit}`); s %= n; }
  }
  return out.join(" ");
}
const permissions = (mask) => [["Initiate", INITIATE], ["Vote", VOTE], ["Execute", EXECUTE]].filter(([, b]) => mask & b).map(([n]) => n).join(", ") || "none";
const explorer = (ctx, what, id) => `https://explorer.solana.com/${what}/${id}${ctx.cluster === "devnet" ? "?cluster=devnet" : ""}`;
const who = (ctx, k) => { const name = k && ctx.labels.get(k.toBase58()); return k ? `${k.toBase58()}${name ? ` (${name})` : ""}` : "none"; };
const row = (name, text) => console.log(`  ${name.padEnd(18)}${text}`);

/** What hides the RPC URL in a text: the URL, its host, its path and its query (where a paid node's key goes). */
export function makeScrub(url) {
  let parts = [url];
  try {
    const u = new URL(url);
    parts.push(u.host, u.hostname, u.search, u.pathname, u.username, u.password, ...u.searchParams.values());
  } catch { /* not a URL: the whole text is hidden */ }
  parts = [...new Set(parts.filter((p) => p && p.length >= 6))].sort((a, b) => b.length - a.length);
  return (text) => parts.reduce((t, p) => t.split(p).join("<RPC_URL>"), String(text));
}

/** Hides the RPC URL from everything this process prints, errors and the solana CLI's output included. */
function hideRpcUrl(url) {
  const scrub = makeScrub(url);
  for (const name of ["log", "error", "warn", "info"]) {
    const original = console[name].bind(console);
    console[name] = (...args) => original(...args.map((a) => scrub(typeof a === "string" ? a : inspect(a))));
  }
}

/** A failed check or a refusal found while planning: printed now; it stops SEND=1 and makes the exit code 1. */
function problem(ctx, text) { ctx.problems.push(text); console.log(`  refused: ${text}`); }
function check(ctx, ok, text) { if (!ok) ctx.problems.push(text); console.log(`  ${ok ? "ok  " : "FAIL"} ${text}`); }

/* ---------------- The network ---------------- */

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function connect(ctx) {
  ctx.conn = new Connection(ctx.rpc, "confirmed");
  let genesis;
  try { genesis = await ctx.conn.getGenesisHash(); } catch (err) { refuse(`the RPC node did not answer (${err?.message ?? err})`); }
  if (genesis !== GENESIS[ctx.cluster]) refuse(`the RPC node is not a ${ctx.cluster} node (its genesis hash is ${genesis})`);
  const program = await ctx.conn.getAccountInfo(SQUADS);
  if (!program?.executable) refuse(`the Squads v4 program ${SQUADS.toBase58()} is not executable on ${ctx.cluster}`);
  const balance = BigInt(await ctx.conn.getBalance(ctx.payer.publicKey));
  console.log(`${ctx.command} on ${ctx.cluster}${ctx.command === "status" ? " (it only reads)" : ctx.send ? ", SENDING" : ", dry run: nothing is sent (SEND=1 sends)"}`);
  row("payer", `${who(ctx, ctx.payer.publicKey)}, ${sol(balance)}`);
  row("program", ctx.program.toBase58());
}

export async function simulate(conn, tx, watch = []) {
  const { value } = await conn.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
    ...(watch.length ? { accounts: { encoding: "base64", addresses: watch.map((k) => k.toBase58()) } } : {}),
  });
  return value;
}

/**
 * The priority price from the node's recent fees for these accounts, between the floor and the cap. Those fees are
 * each slot's lowest, so they are mostly 0: then the floor, and the output says so.
 */
export function pickPrice(fees) {
  const paid = fees.map((f) => BigInt(f)).filter((f) => f > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!paid.length) return { price: PRIORITY_FLOOR, why: "the floor: the node's recent fees for these accounts were all 0, as they mostly are (PRIORITY_FEE=<micro-lamports> sets another)" };
  const p75 = paid[Math.floor((paid.length - 1) * 0.75)];
  const price = p75 < PRIORITY_FLOOR ? PRIORITY_FLOOR : p75 > PRIORITY_CAP ? PRIORITY_CAP : p75;
  return { price, why: `the 75th percentile of ${paid.length} recent fees paid (${p75}), kept between ${PRIORITY_FLOOR} and ${PRIORITY_CAP}` };
}
/** A transaction that expired goes again at twice the price, up to the cap. */
export const bumpPrice = (price) => (price * 2n > PRIORITY_CAP ? PRIORITY_CAP : price * 2n);

async function priorityPrice(ctx, writable) {
  if (ctx.priority !== null) return { price: ctx.priority, why: "PRIORITY_FEE, as given" };
  let fees = [];
  try { fees = (await ctx.conn.getRecentPrioritizationFees({ lockedWritableAccounts: writable.slice(0, 128) })).map((r) => r.prioritizationFee); } catch { /* the floor */ }
  return pickPrice(fees);
}

/**
 * Waits for a sent transaction, by polling, so no websocket carries the RPC URL. A node that stumbles (a 429, a 503, a
 * timeout) says nothing about the transaction, so an error is asked again; only many in a row give up, as "unknown".
 * "expired": the blockhash ran out and the transaction is nowhere, so it can never land.
 */
export async function confirm(conn, signature, lastValidBlockHeight, raw, { pause = 2_000, patience = 30 } = {}) {
  const done = (s) => s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized";
  let misses = 0;
  for (;;) {
    await sleep(pause);
    try {
      const status = (await conn.getSignatureStatuses([signature])).value[0];
      if (status?.err) return { state: "failed", err: status.err };
      if (done(status)) return { state: "confirmed" };
      if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
        const late = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
        if (!late) return { state: "expired" };
        if (late.err) return { state: "failed", err: late.err };
        if (done(late)) return { state: "confirmed" };
      } else if (!status) await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      misses = 0;
    } catch (err) {
      if (++misses >= patience) return { state: "unknown", error: err };
    }
  }
}

/**
 * Simulates, then with SEND=1 signs, sends and waits for the confirmation. The compute limit comes from the simulation.
 * `watch` are the accounts the transaction creates, whose rent the payer pays; `extra` is any other SOL the payer gives
 * (Squads' creation fee). A payer short of it all is refused. One that expires is sent again, up to SEND_TRIES times
 * (on mainnet at twice the price each time); one whose fate is unknown is not, and its signature is printed.
 */
async function run(ctx, label, ixs, signers = [], { watch = [], extra = 0n } = {}) {
  const { conn, payer } = ctx;
  const writable = [...new Map(ixs.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => [k.pubkey.toBase58(), k.pubkey]))).values()];
  let price = 0n;
  if (ctx.cluster === "mainnet") {
    const pick = await priorityPrice(ctx, [payer.publicKey, ...writable]);
    price = pick.price;
    row("priority", `${price} micro-lamports per compute unit: ${pick.why}`);
  }
  for (let attempt = 1; ; attempt++) {
    const build = (limit, blockhash) => new VersionedTransaction(new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
        ...(price > 0n ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price })] : []), ...ixs,
      ],
    }).compileToV0Message());
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const before = watch.length ? await conn.getMultipleAccountsInfo(watch) : [];
    const sim = await simulate(conn, build(MAX_UNITS, blockhash), watch);
    const units = sim.unitsConsumed ?? 0;
    const limit = Math.min(MAX_UNITS, Math.ceil(units * 1.2) + 5_000);
    const tx = build(limit, blockhash);
    const fee = 5_000n * BigInt(tx.message.header.numRequiredSignatures) + (price * BigInt(limit) + 999_999n) / 1_000_000n;
    const rent = sim.err ? 0n : (sim.accounts ?? []).reduce((sum, a, i) => sum + BigInt(a?.lamports ?? 0) - BigInt(before[i]?.lamports ?? 0), 0n);
    console.log(`  ${label}: simulated, ${sim.err ? `FAILED ${JSON.stringify(sim.err)}` : "ok"}, ${units} compute units, ${tx.serialize().length} bytes`);
    console.log(`  cost: ${sol(fee)} in fees${price ? ` (${price} micro-lamports per unit of priority)` : ""}`
      + `${rent > 0n ? ` + ${sol(rent)} of rent` : ""}${extra ? ` + ${sol(extra)} to Squads` : ""}`);
    const balance = BigInt(await conn.getBalance(payer.publicKey));
    // A simulation that failed created nothing, so the rent of what it would create is unknown.
    const rentUnknown = watch.length > 0 && Boolean(sim.err);
    if (balance < fee + rent + extra || (rentUnknown && balance === 0n)) {
      problem(ctx, `the KEYPAIR holds ${sol(balance)}, and this needs ${sol(fee + rent + extra)}${rentUnknown ? " plus the rent of the accounts it creates" : ""}`);
    }
    if (sim.err) {
      console.log((sim.logs ?? []).slice(-12).map((l) => `      ${l}`).join("\n"));
      problem(ctx, `${label}: the simulation failed`);
    }
    if (!ctx.send || ctx.problems.length) {
      if (ctx.send) refuse(`not sent: ${ctx.problems.join("; ")}`);
      return { ok: !sim.err, units };
    }
    const unique = [...new Map([payer, ...signers].map((k) => [k.publicKey.toBase58(), k])).values()];
    tx.sign(unique);
    const raw = tx.serialize();
    const signature = base58(tx.signatures[0]);
    console.log(`  ${label}: sending ${explorer(ctx, "tx", signature)}`);
    try {
      await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
    } catch (err) {
      // An answer with an error (its preflight, a bad blockhash) means the node never forwarded it. Anything else, a
      // timeout or a 503, may have reached the network: it is watched like a sent one.
      if (err instanceof SendTransactionError) refuse(`${label}: the node refused it (${err.message.split("\n").slice(0, 2).join(" ")})`);
      console.log(`  ${label}: the node did not answer the send cleanly (${err?.message ?? err}); watching whether it landed`);
    }
    const end = await confirm(conn, signature, lastValidBlockHeight, raw);
    if (end.state === "confirmed") { console.log(`  ${label}: confirmed`); return { ok: true, signature }; }
    if (end.state === "failed") refuse(`${label} failed on chain: ${JSON.stringify(end.err)}`);
    if (end.state === "unknown") {
      refuse(`${label}: the node stopped answering after the send, so whether it landed is unknown (${signature}). `
        + `Look it up (the link above) or run status before running this again: ${String(end.error?.message ?? end.error).slice(0, 120)}`);
    }
    if (attempt >= SEND_TRIES) refuse(`${label} expired ${attempt} times without landing, so nothing changed: run it again later${ctx.cluster === "mainnet" ? ", or with a higher PRIORITY_FEE" : ""}`);
    if (ctx.cluster === "mainnet" && ctx.priority === null) price = bumpPrice(price);
    console.log(`  ${label}: expired without landing, so nothing changed; sending it again${price ? ` at ${price} micro-lamports per unit` : ""}`);
  }
}

/** What the vault would do, simulated as if it had signed: a proposal that can't run is refused before the vote. */
async function preview(ctx, label, inner) {
  const { blockhash } = await ctx.conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: ctx.payer.publicKey, recentBlockhash: blockhash, instructions: inner }).compileToV0Message());
  const sim = await simulate(ctx.conn, tx);
  console.log(`  ${label}, simulated as if the vault signed: ${sim.err ? `FAILED ${JSON.stringify(sim.err)}` : "ok"}, ${sim.unitsConsumed} compute units`);
  if (sim.err) {
    console.log((sim.logs ?? []).slice(-10).map((l) => `      ${l}`).join("\n"));
    problem(ctx, `${label} would fail when the vault runs it`);
  }
}

async function programConfig(ctx) {
  const info = await ctx.conn.getAccountInfo(programConfigAddress());
  if (!info) refuse(`Squads' program config ${programConfigAddress().toBase58()} is missing on ${ctx.cluster}`);
  const [pc] = squads.accounts.ProgramConfig.fromAccountInfo(info);
  return { fee: BigInt(pc.multisigCreationFee.toString()), treasury: pc.treasury };
}

/** The pool program's state, or null when nothing is at its address: its upgrade authority, its data and its config. */
async function readProgramState(ctx) {
  const programData = programDataAddress(ctx.program), config = configAddress(ctx.program);
  const [p, pd, c] = await ctx.conn.getMultipleAccountsInfo([ctx.program, programData, config], "confirmed");
  if (!p) return null;
  const linked = p.owner.equals(LOADER) && p.executable && Boolean(decodeProgramAccount(p.data)?.programData.equals(programData));
  const data = linked && pd ? decodeProgramData(pd.data) : null;
  return { upgradeable: Boolean(data), programData, data, authority: data?.authority ?? null, config: c && c.owner.equals(ctx.program) ? decodeConfig(c.data) : null };
}
async function readProgram(ctx) {
  const state = await readProgramState(ctx);
  if (!state) refuse(`PROGRAM ${ctx.program.toBase58()} does not exist on ${ctx.cluster}`);
  if (!state.upgradeable) refuse(`PROGRAM ${ctx.program.toBase58()} is not a program of the upgradeable loader`);
  return state;
}

async function readMultisig(ctx, address) {
  const found = decodeMultisig(await ctx.conn.getAccountInfo(address, "confirmed"));
  if (found.error) refuse(`MULTISIG ${address.toBase58()} ${found.error}`);
  return found.ms;
}
/** A multisig that exists and can act: the only kind a buffer or a proposal is made for. */
async function readUsableMultisig(ctx, address) {
  const ms = await readMultisig(ctx, address);
  showMultisig(ctx, address, ms);
  const broken = checkCanAct(ms);
  if (broken.length) refuse(`the multisig is unusable: ${broken.join("; ")}`);
  return ms;
}

/** Every proposal of the multisig (the last 500 at most), with its vault transaction and the rent they hold. */
async function readProposals(ctx, address, ms, { last = 500n } = {}) {
  const first = ms.transactionIndex > last ? ms.transactionIndex - last + 1n : 1n;
  const indexes = [];
  for (let i = first; i <= ms.transactionIndex; i++) indexes.push(i);
  const out = [];
  for (let at = 0; at < indexes.length; at += 50) {
    const chunk = indexes.slice(at, at + 50);
    const infos = await ctx.conn.getMultipleAccountsInfo(chunk.flatMap((i) => [proposalAddress(address, i), transactionAddress(address, i)]), "confirmed");
    chunk.forEach((index, n) => out.push({
      index, proposal: decodeProposal(infos[2 * n]), vtx: decodeVaultTransaction(infos[2 * n + 1]),
      rent: BigInt((infos[2 * n]?.lamports ?? 0) + (infos[2 * n + 1]?.lamports ?? 0)),
    }));
  }
  return out;
}

function showMultisig(ctx, address, ms) {
  row("multisig", `${address.toBase58()}: ${ms.threshold} of ${ms.members.length}, timelock ${duration(ms.timeLock)}`);
  row("vault 0", who(ctx, vaultAddress(address)));
  ms.members.forEach((m, i) => row(i ? "" : "members", `${who(ctx, m.key)}: ${permissions(m.mask)}`));
  row("config authority", ms.configAuthority.equals(PublicKey.default) ? "none: the members change the multisig only by their own vote" : `${ms.configAuthority.toBase58()} (it can change the multisig alone)`);
  row("rent collector", ms.rentCollector ? who(ctx, ms.rentCollector) : "none: the rent of its proposals stays locked for good");
}
function showKeycheck(ctx, ms, proven) {
  ms.members.forEach((m, i) => row(i ? "" : "key check", `${who(ctx, m.key)}: ${proven.some((k) => k.equals(m.key)) ? "signed one" : "not yet"}`));
}

/** The signer of a proposal, an approval or an execution: MEMBER_KEYPAIR, MEMBER=n in a rehearsal, or the KEYPAIR. */
function memberSigner(ctx) {
  if (ctx.memberKeypairPath) return loadKeypair(ctx.memberKeypairPath, "MEMBER_KEYPAIR").keypair;
  if (ctx.member) return ctx.rehearsalWallets[ctx.member - 1];
  return ctx.payer;
}
function requireMember(ctx, ms, signer, bit, what) {
  const m = ms.members.find((x) => x.key.equals(signer.publicKey));
  if (!m) refuse(`${who(ctx, signer.publicKey)} is not a member of the multisig: set MEMBER_KEYPAIR=<a member's keypair>${ctx.rehearsal ? " or MEMBER=1..3" : ""}`);
  if (!(m.mask & bit)) refuse(`${who(ctx, signer.publicKey)} is a member, but may not ${what}`);
  row("member", who(ctx, signer.publicKey));
}

function showConfig(ctx, config) {
  row("config admin", who(ctx, config.admin));
  row("launcher", who(ctx, config.launcher));
  row("treasury", who(ctx, config.treasury));
  row("launch fee", `${config.launchFee} lamports, min fee ${config.minFeeBps} bps, treasury share ${config.treasuryShareBps} bps, launches_open ${config.launchesOpen}`);
}

/**
 * Prints what a vault transaction does, one line per instruction, and for an upgrade what the buffer holds: its size,
 * its sha256 and who holds it. With `vote` (approve, execute), the buffer must be the vault's, and match BUILD, or it
 * is a problem. Returns the dangers and the upgrades found, each with the buffer's bytes as they are now.
 */
async function showProposal(ctx, vtx, { label, vault, config, build = null, vote = false }) {
  const dangers = [], upgrades = [];
  for (const ix of vtx.instructions) {
    const e = explainInstruction(ix, { program: ctx.program, vault, config, name: (k) => who(ctx, k) });
    row(label, e.text);
    label = "";
    if (e.danger) dangers.push(e.danger);
    if (!e.upgrade) continue;
    const info = await ctx.conn.getAccountInfo(e.upgrade.buffer, "confirmed");
    const buf = info && info.owner.equals(LOADER) ? decodeBuffer(info.data) : null;
    row("", buf ? `the buffer: ${buf.bytes.length} bytes, sha256 ${sha256(buf.bytes).toString("hex")}, held by ${who(ctx, buf.authority)}` : "the buffer: gone (closed, or never made)");
    if (vote) for (const r of checkBuffer({ cluster: ctx.cluster, buffer: buf, vault, so: build?.bytes ?? null, needBuild: true })) problem(ctx, r);
    else if (buf && !buf.authority?.equals(vault)) row("", "warning: the buffer is not the vault's: whoever holds it can still rewrite it");
    if (vote && build && buf && holds(buf.bytes, build.bytes)) console.log(`  ok   the buffer holds BUILD ${build.file} (sha256 ${build.sha})`);
    if (vote && !build && ctx.cluster !== "mainnet") console.log("  note: BUILD=<.so or build.json> would check the buffer's bytes against a build (needed on mainnet)");
    upgrades.push({ ...e.upgrade, bytes: buf?.bytes ?? null });
  }
  return { dangers, upgrades };
}
/** approve and execute stop on a danger unless DANGER=1, said after reading it elsewhere. */
function weighDangers(ctx, dangers) {
  for (const d of dangers) {
    if (ctx.danger) console.log(`  warning: ${d} (DANGER=1)`);
    else problem(ctx, `${d}. Only with DANGER=1, once you are sure it is meant`);
  }
}

async function chainNow(ctx) {
  const clock = await ctx.conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  return Number(clock.data.readBigInt64LE(32));
}

/**
 * The CLI's write-buffer, as it is run and as it is printed: the printed one never shows the RPC URL. The writes go
 * through the node (--use-rpc) when useRpc, else straight to the validators: deploy.sh's USE_RPC, 1 on mainnet (the
 * paid node) and 0 on devnet, whose public node turns most of 500 writes away (429).
 */
export function writeBufferArgs({ so, bufferPath, url, hideUrl, keypairPath, price, useRpc = true }) {
  const args = ["program", "write-buffer", so, "--buffer", bufferPath, "--url", url, "--keypair", keypairPath,
    "--commitment", "confirmed", "--max-sign-attempts", String(SIGN_ATTEMPTS)];
  if (useRpc) args.push("--use-rpc");
  if (price > 0n) args.push("--with-compute-unit-price", String(price));
  const shown = args.map((a) => (a === url && hideUrl ? "<RPC_URL>" : a));
  return { args, shown };
}

const SOLANA_BIN = join(homedir(), ".local/share/solana/install/active_release/bin");
const cliEnv = () => ({ ...process.env, PATH: `${SOLANA_BIN}:${process.env.PATH ?? ""}` });

/** Runs the solana CLI with every line it prints going through console.log, so the RPC URL is hidden from it too. */
function runCli(args) {
  return new Promise((done) => {
    const child = spawn("solana", args, { env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let rest = "";
    const take = (chunk) => {
      rest += chunk;
      const lines = rest.split(/\r\n|\n|\r/);
      rest = lines.pop();
      for (const l of lines) if (l.trim()) console.log(`    ${l}`);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => done({ code: -1, error: err.code }));
    child.on("close", (code) => { if (rest.trim()) console.log(`    ${rest}`); done({ code }); });
  });
}

/* ---------------- The commands ---------------- */

async function create(ctx) {
  const { env } = ctx;
  let members;
  if (ctx.rehearsal) {
    if (env.MEMBERS) refuse("REHEARSAL=1 makes its own three members: leave MEMBERS out");
    members = ctx.rehearsalWallets.map((w) => w.publicKey);
  } else {
    if (!env.MEMBERS) refuse("create needs MEMBERS=a,b,c (the members' public keys), or REHEARSAL=1 on devnet");
    members = parseKeys(env.MEMBERS, "MEMBERS");
  }
  const threshold = whole(env.THRESHOLD || "2", "THRESHOLD");
  if (!env.TIMELOCK && !ctx.rehearsal) refuse("create needs TIMELOCK=<seconds>: how long an approved proposal waits before it can run");
  const timelock = whole(env.TIMELOCK || String(REHEARSAL_TIMELOCK), "TIMELOCK");
  const shape = checkShape({ cluster: ctx.cluster, members, threshold, timelock, payer: ctx.payer.publicKey, minTimelock: ctx.minTimelock });
  if (shape.refusals.length) refuse(shape.refusals.join("; "));
  const createKey = createKeyFor(ctx.secret, ctx.program);
  const address = multisigAddress(createKey.publicKey), vault = vaultAddress(address);
  ctx.labels.set(vault.toBase58(), "the vault");
  await connect(ctx);

  // The program the create key is made from: a wrong id would make a multisig the right one can never find.
  const state = await readProgramState(ctx);
  const tie = checkCreateProgram({ cluster: ctx.cluster, program: ctx.program, state, payer: ctx.payer.publicKey, vault });
  if (state?.upgradeable) row("upgrade authority", who(ctx, state.authority));
  row("multisig", address.toBase58());
  row("vault 0", `${vault.toBase58()}: the handoff gives it the upgrade authority and the config's admin`);
  row("create key", `${createKey.publicKey.toBase58()}, made from the KEYPAIR's key and PROGRAM: another run finds this same multisig`);
  members.forEach((m, i) => row(i ? "" : "members", `${who(ctx, m)}: Initiate, Vote, Execute`));
  row("threshold", `${threshold} of ${members.length} votes`);
  row("timelock", `${duration(timelock)} between a proposal's approval and its execution`);
  row("config authority", "none. Members, threshold and timelock change only by a config proposal the members vote on, "
    + "which waits out the timelock too. Keep it so: a config authority could swap the members alone, with no vote and no wait.");
  row("rent collector", "the vault: the rent of finished proposals goes back to it (cleanup)");
  if (ctx.cluster === "mainnet") console.log("  check every member's address against that member's own wallet before SEND=1");
  for (const w of [...shape.warnings, ...tie.warnings]) console.log(`  warning: ${w}`);
  for (const r of tie.refusals) problem(ctx, r);

  const found = decodeMultisig(await ctx.conn.getAccountInfo(address, "confirmed"));
  if (!found.error) {
    const same = sameKeys(found.ms.members.map((m) => m.key), members) && found.ms.threshold === threshold && found.ms.timeLock === timelock;
    console.log("  the multisig exists already: nothing to create");
    showMultisig(ctx, address, found.ms);
    if (!same) problem(ctx, "it is not the multisig asked for (members, threshold or timelock differ): change it by a config proposal in the Squads app, or use another KEYPAIR");
    if (!found.ms.rentCollector?.equals(vault)) console.log("  warning: its rent collector is not the vault, so cleanup can't take its proposals' rent back there");
  } else {
    if (found.error !== "does not exist") refuse(`the multisig's address ${address.toBase58()} holds an account that ${found.error}`);
    const { fee, treasury } = await programConfig(ctx);
    row("Squads fee", `${sol(fee)}, to its treasury ${treasury.toBase58()}`);
    const ix = createMultisigIx({ treasury, payer: ctx.payer.publicKey, createKey: createKey.publicKey, members, threshold, timelock });
    const result = await run(ctx, "create the multisig", [ix], [createKey], { watch: [address], extra: fee });
    if (ctx.send && result.ok) {
      const made = decodeMultisig(await ctx.conn.getAccountInfo(address, "confirmed"));
      check(ctx, !made.error && sameKeys(made.ms.members.map((m) => m.key), members) && made.ms.members.every((m) => m.mask === 7)
        && made.ms.threshold === threshold && made.ms.timeLock === timelock && made.ms.configAuthority.equals(PublicKey.default)
        && Boolean(made.ms.rentCollector?.equals(vault)),
      "read back: the members with every permission, the threshold, the timelock, no config authority, the vault collecting rent");
      console.log(`  ${explorer(ctx, "address", address.toBase58())}`);
    }
  }
  const m = ctx.rehearsal ? ["MEMBER=1", "MEMBER=2", "MEMBER=3"] : ["MEMBER_KEYPAIR=<member a>", "MEMBER_KEYPAIR=<member b>", "MEMBER_KEYPAIR=<member c>"];
  console.log(`  next, the key check: each member signs once, so a mistyped member shows before the handoff`);
  console.log(`    MULTISIG=${address.toBase58()} ${m[0]} ... node multisig.mjs propose-keycheck     (it prints the INDEX)`);
  console.log(`    MULTISIG=${address.toBase58()} INDEX=<n> ${m[1]} ... node multisig.mjs approve       (and the same with ${m[2]})`);
  console.log(`  then: MULTISIG=${address.toBase58()} ${ctx.rehearsal ? "" : `MEMBERS=... THRESHOLD=${threshold} TIMELOCK=${timelock} `}... node multisig.mjs handoff`);
}

async function proposeKeycheck(ctx) {
  const address = key(ctx.env.MULTISIG, "MULTISIG"), vault = vaultAddress(address);
  const proposer = memberSigner(ctx);
  ctx.labels.set(vault.toBase58(), "the vault");
  await connect(ctx);
  const ms = await readUsableMultisig(ctx, address);
  const entries = await readProposals(ctx, address, ms);
  const proven = provenMembers(entries);
  showKeycheck(ctx, ms, proven);
  requireMember(ctx, ms, proposer, INITIATE, "propose");
  if (proven.some((k) => k.equals(proposer.publicKey))) console.log("  warning: this member has signed a key check already: one made by a member who has not counts for more");
  await propose(ctx, address, ms, proposer, [keycheckIx()], "the key check", { entries, keycheck: true });
  console.log("  each member who has not signed one yet approves it (the proposer counts already). Once it has its votes, no one");
  console.log("  else can approve it: whoever is left makes another (propose-keycheck). After the handoff (not before: the handoff reads its signers off it), execute it, as it only writes a memo, then cleanup");
}

async function handoff(ctx) {
  const { env } = ctx;
  const address = key(env.MULTISIG, "MULTISIG"), vault = vaultAddress(address);
  const expectedVault = env.VAULT ? key(env.VAULT, "VAULT") : null;
  if (expectedVault && !expectedVault.equals(vault)) refuse(`VAULT ${expectedVault.toBase58()} is not vault 0 of MULTISIG ${address.toBase58()}, which is ${vault.toBase58()}`);
  const expected = expectedFor(env, ctx);
  ctx.labels.set(vault.toBase58(), "the vault");
  await connect(ctx);

  const found = decodeMultisig(await ctx.conn.getAccountInfo(address, "confirmed"));
  const state = await readProgram(ctx);
  let proven = null;
  if (found.ms) {
    showMultisig(ctx, address, found.ms);
    proven = provenMembers(await readProposals(ctx, address, found.ms));
    showKeycheck(ctx, found.ms, proven);
  } else { row("multisig", address.toBase58()); row("vault 0", who(ctx, vault)); }
  const verdict = checkHandoff({
    cluster: ctx.cluster, address, found, vault, expectedVault, expectedMembers: expected.members,
    expectedThreshold: expected.threshold, expectedTimelock: expected.timelock, proven,
    payer: ctx.payer.publicKey, authority: state.data.authority, config: state.config, minTimelock: ctx.minTimelock,
  });
  row("upgrade authority", `${who(ctx, state.data.authority)}${verdict.parts.authority ? " -> the vault" : ""}`);
  if (state.config) row("config admin", `${who(ctx, state.config.admin)}${verdict.parts.config ? " -> the vault (launcher, treasury, fees and launches_open stay as they are)" : ""}`);
  for (const w of verdict.warnings) console.log(`  warning: ${w}`);
  if (!expected.members) console.log("  warning: no MEMBERS given, so the members above are not checked; SEND=1 needs MEMBERS=a,b,c (or REHEARSAL=1)");
  for (const r of verdict.refusals) problem(ctx, r);
  const ixs = [];
  if (verdict.parts.config) ixs.push(updateConfigIx(ctx.program, ctx.payer.publicKey, { ...state.config, admin: vault }));
  if (verdict.parts.authority) ixs.push(setUpgradeAuthorityIx(ctx.program, ctx.payer.publicKey, vault));
  if (!ixs.length) {
    if (!ctx.problems.length) console.log("  nothing to do: the vault holds both already");
    return;
  }
  if (found.ms) {
    console.log(`  after this the KEYPAIR can no longer upgrade the program or change its config: ${found.ms.threshold} of the `
      + `${found.ms.members.length} members must approve, and each change waits ${duration(found.ms.timeLock)} after its approval`);
  }
  const result = await run(ctx, "hand over", ixs);
  if (!ctx.send || !result.ok) return;
  const after = await readProgram(ctx);
  check(ctx, Boolean(after.data.authority?.equals(vault)), "read back: the upgrade authority is the vault");
  check(ctx, Boolean(after.config && sameConfig(after.config, { ...state.config, admin: vault })), "read back: the config's admin is the vault, and the rest is as it was");
}

/**
 * A proposal: the vault transaction and its proposal at the multisig's next index, after the vault's own preview.
 * `before` runs first in the same transaction, signed by the KEYPAIR (the buffer's hand-over, for an upgrade).
 */
async function propose(ctx, address, ms, proposer, inner, what, { before = [], entries = null, keycheck = false } = {}) {
  const twin = findTwin(entries ?? await readProposals(ctx, address, ms), inner, { staleIndex: ms.staleIndex, keycheck });
  if (twin) refuse(`proposal ${twin.index} holds this same change already (${twin.proposal?.status ?? "no proposal yet"}): vote on it, INDEX=${twin.index}, instead of making another`);
  const index = ms.transactionIndex + 1n;
  await preview(ctx, what, [...before, ...inner]);
  const ixs = [...before, ...proposeIxs({ address, index, proposer: proposer.publicKey, payer: ctx.payer.publicKey, inner })];
  const result = await run(ctx, `propose (INDEX ${index})`, ixs, [proposer], { watch: [transactionAddress(address, index), proposalAddress(address, index)] });
  if (ctx.send && result.ok) {
    const p = decodeProposal(await ctx.conn.getAccountInfo(proposalAddress(address, index), "confirmed"));
    check(ctx, p?.status === "Active", `read back: proposal ${index} is open for votes`);
  }
  console.log(`  INDEX=${index}${ctx.send ? "" : " (the index this proposal would get)"}`);
  console.log(`  next: ${ms.threshold} of the members approve: MULTISIG=${address.toBase58()} INDEX=${index} `
    + `${ctx.rehearsal ? "MEMBER=1..3" : "MEMBER_KEYPAIR=<path>"} ... node multisig.mjs approve`);
  console.log(`        then, ${duration(ms.timeLock)} after the approval: ... node multisig.mjs execute`);
  return index;
}

/** Checks done before any buffer is written or proposed: a usable multisig whose vault holds the program. */
async function upgradeGround(ctx, address, vault) {
  const ms = await readUsableMultisig(ctx, address);
  const state = await readProgram(ctx);
  row("upgrade authority", `${who(ctx, state.data.authority)}, room for ${state.data.room} bytes`);
  if (!state.data.authority?.equals(vault)) problem(ctx, `the upgrade authority is ${who(ctx, state.data.authority)}, not the vault: run the handoff first (the vault could never use a buffer before that)`);
  return { ms, state };
}

async function writeBuffer(ctx) {
  const { env } = ctx;
  const address = key(env.MULTISIG, "MULTISIG"), vault = vaultAddress(address);
  if (!env.BUILD) refuse("write-buffer needs BUILD=<.so or build.json>: the binary to write");
  const build = loadBuild(env.BUILD, ctx);
  // As deploy.sh does: the default place is made once and kept, a path given that leads nowhere is a stop.
  const bufferPath = expand(env.BUFFER_KEYPAIR || join(ctx.release, ctx.cluster, "upgrade-buffer.json"));
  outsideRepo(bufferPath, "BUFFER_KEYPAIR");
  if (env.BUFFER_KEYPAIR && !existsSync(bufferPath)) refuse(`BUFFER_KEYPAIR: there is no file at ${bufferPath}`);
  const bufferKey = existsSync(bufferPath) ? loadKeypair(bufferPath, "BUFFER_KEYPAIR").keypair.publicKey : null;
  if (bufferKey?.equals(ctx.payer.publicKey)) refuse("BUFFER_KEYPAIR is the KEYPAIR: the buffer needs a key of its own");
  ctx.labels.set(vault.toBase58(), "the vault");
  await connect(ctx);
  const { state } = await upgradeGround(ctx, address, vault);
  row("build", `${build.file}: ${build.bytes.length} bytes, sha256 ${build.sha}${build.commit ? `, commit ${build.commit.slice(0, 7)}` : ""}`);
  if (build.bytes.length > state.data.room) problem(ctx, `the build (${build.bytes.length} bytes) is bigger than the program's room (${state.data.room}): the program must be extended first, which this script does not do`);
  row("buffer", bufferKey ? `${bufferKey.toBase58()} (${bufferPath})` : `a new key, made at ${bufferPath} with SEND=1`);

  let left = build.bytes.length, fresh = true;
  if (bufferKey) {
    const info = await ctx.conn.getAccountInfo(bufferKey, "confirmed");
    const buf = info && info.owner.equals(LOADER) ? decodeBuffer(info.data) : null;
    if (info && !buf) problem(ctx, `the buffer's address holds an account that is not a loader buffer: point BUFFER_KEYPAIR at a new file`);
    else if (buf && !buf.authority?.equals(ctx.payer.publicKey)) {
      problem(ctx, `the buffer is held by ${who(ctx, buf.authority)}, not the KEYPAIR${buf.authority?.equals(vault) ? `: take its SOL back with close-buffer BUFFER=${bufferKey.toBase58()} (a vote),` : ""} or point BUFFER_KEYPAIR at a new file`);
    } else if (buf && buf.bytes.length !== build.bytes.length) {
      problem(ctx, `the buffer was made for ${buf.bytes.length} bytes, and the build has ${build.bytes.length}: close it (close-buffer BUFFER=${bufferKey.toBase58()}) or point BUFFER_KEYPAIR at a new file`);
    } else if (buf) {
      fresh = false;
      left = 0;
      for (let at = 0; at < build.bytes.length; at += 1024) if (!buf.bytes.subarray(at, at + 1024).equals(build.bytes.subarray(at, at + 1024))) left += Math.min(1024, build.bytes.length - at);
      row("", left ? `there, the KEYPAIR's: the CLI writes only what differs (about ${left} bytes)` : "there, the KEYPAIR's, and it holds this build already");
    }
  }
  const rent = BigInt(await ctx.conn.getMinimumBalanceForRentExemption(BUFFER_HEADER + build.bytes.length));
  let price = 0n;
  if (ctx.cluster === "mainnet") {
    const pick = await priorityPrice(ctx, [ctx.payer.publicKey, ...(bufferKey ? [bufferKey] : [])]);
    price = pick.price;
    row("priority", `${price} micro-lamports per compute unit: ${pick.why}`);
  }
  // About 960 bytes a write, about 3,000 compute units each (deploy.sh's figures).
  const writes = Math.ceil(left / 960);
  const fees = BigInt(writes) * (5_000n + (price * 3_000n) / 1_000_000n) + 10_000n;
  row("cost", `${fresh ? `${sol(rent)} of rent (back to the KEYPAIR at the upgrade, or at close-buffer) + ` : ""}about ${sol(fees)} in fees, ${writes} writes`);
  const balance = BigInt(await ctx.conn.getBalance(ctx.payer.publicKey));
  if (balance < (fresh ? rent : 0n) + fees) problem(ctx, `the KEYPAIR holds ${sol(balance)}, and this needs about ${sol((fresh ? rent : 0n) + fees)}`);
  const cli = spawnSync("solana", ["--version"], { env: cliEnv(), encoding: "utf8" });
  if (cli.status !== 0) problem(ctx, "the solana CLI is not on PATH (~/.local/share/solana/install/active_release/bin)");
  const { args, shown } = writeBufferArgs({ so: build.file, bufferPath, url: ctx.rpc, hideUrl: Boolean(env.RPC_URL), keypairPath: expand(ctx.keypairPath), price, useRpc: useRpcFor(ctx.cluster, env) });
  const next = () => console.log(`  next: MULTISIG=${address.toBase58()} BUFFER=${bufferKey?.toBase58() ?? "<the buffer>"} BUILD=${env.BUILD} `
    + `${ctx.rehearsal ? "MEMBER=1" : "MEMBER_KEYPAIR=<a member>"} ... node multisig.mjs propose-upgrade`
    + "\n        It checks the buffer against BUILD, then hands it to the vault and proposes the upgrade, in one transaction.");
  if (bufferKey && left === 0 && !ctx.problems.length) { console.log("  nothing to write"); next(); return; }
  console.log(`  command: solana ${shown.join(" ")}`);
  if (!ctx.send || ctx.problems.length) {
    if (ctx.send) refuse(`not sent: ${ctx.problems.join("; ")}`);
    console.log("  SEND=1 runs it (the RPC URL hidden from what it prints), then reads the buffer back");
    next();
    return;
  }
  if (!bufferKey) {
    mkdirSync(dirname(bufferPath), { recursive: true });
    const made = Keypair.generate();
    writeFileSync(bufferPath, JSON.stringify(Array.from(made.secretKey)), { mode: 0o600, flag: "wx" });
    console.log(`  made ${bufferPath}: the buffer ${made.publicKey.toBase58()}`);
  }
  const buffer = loadKeypair(bufferPath, "BUFFER_KEYPAIR").keypair.publicKey;
  const r = await runCli(args);
  if (r.code !== 0) refuse(`the write stopped (${r.error ?? `exit ${r.code}`}): run the same command again, and it goes on from the buffer ${buffer.toBase58()}`);
  const info = await ctx.conn.getAccountInfo(buffer, "confirmed");
  const buf = info && info.owner.equals(LOADER) ? decodeBuffer(info.data) : null;
  check(ctx, Boolean(buf?.authority?.equals(ctx.payer.publicKey) && holds(buf.bytes, build.bytes)), `read back: the buffer ${buffer.toBase58()} is the KEYPAIR's and holds BUILD (sha256 ${build.sha})`);
  console.log(`  next: MULTISIG=${address.toBase58()} BUFFER=${buffer.toBase58()} BUILD=${env.BUILD} ${ctx.rehearsal ? "MEMBER=1" : "MEMBER_KEYPAIR=<a member>"} ... node multisig.mjs propose-upgrade`);
}

async function proposeUpgrade(ctx) {
  const { env } = ctx;
  const address = key(env.MULTISIG, "MULTISIG"), vault = vaultAddress(address);
  const build = env.BUILD ? loadBuild(env.BUILD, ctx) : null;
  if (!build && ctx.cluster === "mainnet" && env.BUFFER) refuse("on mainnet propose-upgrade needs BUILD=<.so or build.json>: the buffer is checked against it before anyone votes");
  const proposer = env.BUFFER ? memberSigner(ctx) : null;
  ctx.labels.set(vault.toBase58(), "the vault");
  await connect(ctx);
  const { ms, state } = await upgradeGround(ctx, address, vault);
  if (!env.BUFFER) {
    if (ctx.problems.length) return;
    console.log("  BUFFER=<address> is needed. The KEYPAIR writes it, it is checked, and only then does it go to the vault:");
    console.log(`    1. MULTISIG=${address.toBase58()} BUILD=<.so or build.json> ... node multisig.mjs write-buffer     (the cost; SEND=1 writes)`);
    console.log(`    2. MULTISIG=${address.toBase58()} BUFFER=<the buffer> BUILD=<the same> ${ctx.rehearsal ? "MEMBER=1" : "MEMBER_KEYPAIR=<a member>"} ... node multisig.mjs propose-upgrade`);
    console.log("       It checks the bytes, then hands the buffer to the vault and proposes, in one transaction.");
    return;
  }
  const buffer = key(env.BUFFER, "BUFFER");
  const info = await ctx.conn.getAccountInfo(buffer, "confirmed");
  const buf = info && info.owner.equals(LOADER) ? decodeBuffer(info.data) : null;
  if (!buf) refuse(`BUFFER ${buffer.toBase58()} is not a buffer of the upgradeable loader`);
  row("buffer", `${buffer.toBase58()}: ${buf.bytes.length} bytes, sha256 ${sha256(buf.bytes).toString("hex")}`);
  row("buffer authority", who(ctx, buf.authority));
  // The KEYPAIR's buffer goes to the vault in the proposal's own transaction, and only once its bytes are BUILD's:
  // given away first, a wrong one could be closed only by a vote.
  const handOver = Boolean(buf.authority?.equals(ctx.payer.publicKey));
  if (!handOver && !buf.authority?.equals(vault)) problem(ctx, `the buffer is held by ${who(ctx, buf.authority)}, neither the vault nor the KEYPAIR`);
  if (build) check(ctx, holds(buf.bytes, build.bytes), `the buffer holds BUILD ${build.file} (${build.bytes.length} bytes, sha256 ${build.sha})`);
  else if (handOver) problem(ctx, "the buffer is still the KEYPAIR's: BUILD=<.so or build.json> is needed to check its bytes before it goes to the vault");
  else console.log("  warning: no BUILD, so the buffer's bytes are not checked against a build");
  if (buf.bytes.length > state.data.room) {
    problem(ctx, `the new program (${buf.bytes.length} bytes) is bigger than the room in the program's data account (${state.data.room}): it must be extended first, which this script does not do`);
  }
  requireMember(ctx, ms, proposer, INITIATE, "propose");
  if (handOver) row("hand-over", "the buffer goes to the vault in the same transaction as the proposal");
  const inner = [upgradeIx({ program: ctx.program, buffer, spill: ctx.payer.publicKey, authority: vault })];
  await propose(ctx, address, ms, proposer, inner, "the upgrade", { before: handOver ? [setBufferAuthorityIx(buffer, ctx.payer.publicKey, vault)] : [] });
  console.log(`  each approval and the execution check the buffer again: BUILD=${env.BUILD ?? "<.so or build.json>"} with them${ctx.cluster === "mainnet" ? " (needed on mainnet)" : ""}`);
}

async function proposeConfig(ctx) {
  const address = key(ctx.env.MULTISIG, "MULTISIG"), vault = vaultAddress(address);
  const changes = configOverrides(ctx.env);
  if (!Object.keys(changes).length) refuse("propose-config changes nothing: set at least one of LAUNCHES_OPEN, LAUNCHER, TREASURY, LAUNCH_FEE, MIN_FEE_BPS, TREASURY_SHARE_BPS, ADMIN, ADMIN_MULTISIG");
  const proposer = memberSigner(ctx);
  ctx.labels.set(vault.toBase58(), "the vault");
  await connect(ctx);
  const ms = await readUsableMultisig(ctx, address);
  requireMember(ctx, ms, proposer, INITIATE, "propose");
  const { config } = await readProgram(ctx);
  if (!config) refuse("the program has no config yet: run init-config first");
  showConfig(ctx, config);
  if (!config.admin.equals(vault)) problem(ctx, `the config's admin is ${who(ctx, config.admin)}, not the vault: run the handoff first`);
  const next = { ...config, ...changes };
  const diff = configDiff(config, next);
  if (!diff.length) refuse("every value given is what the config holds already: nothing to propose");
  for (const d of diff) row("change", d);
  // Another multisig's vault as the admin: that multisig must exist and be able to act, or the config is locked.
  let otherVault = null;
  if (ctx.env.ADMIN_MULTISIG) {
    const other = key(ctx.env.ADMIN_MULTISIG, "ADMIN_MULTISIG");
    const found = decodeMultisig(await ctx.conn.getAccountInfo(other, "confirmed"));
    if (found.error) refuse(`ADMIN_MULTISIG ${other.toBase58()} ${found.error}`);
    const broken = [...checkCanAct(found.ms), ...(found.ms.configAuthority.equals(PublicKey.default) ? [] : ["it has a config authority"])];
    if (broken.length) refuse(`ADMIN_MULTISIG ${other.toBase58()} can't hold the config: ${broken.join("; ")}`);
    otherVault = vaultAddress(other);
    row("new admin", `vault 0 of the multisig ${other.toBase58()}: ${found.ms.threshold} of ${found.ms.members.length}, timelock ${duration(found.ms.timeLock)}`);
  }
  for (const r of checkConfigTargets(next, { vault, otherVault })) problem(ctx, r);
  if (!next.admin.equals(vault)) console.log(`  warning: the config leaves this multisig's vault: once this runs, only ${next.admin.toBase58()} can change it`);
  // The program takes only a treasury that can receive SOL: a plain wallet holding its rent.
  const treasury = await ctx.conn.getAccountInfo(next.treasury, "confirmed");
  const floor = await ctx.conn.getMinimumBalanceForRentExemption(0);
  if (!treasury || !treasury.owner.equals(SystemProgram.programId) || treasury.lamports < floor) {
    problem(ctx, `the treasury ${next.treasury.toBase58()} must be a plain wallet holding at least ${sol(floor)}: the program refuses any other`);
  }
  await propose(ctx, address, ms, proposer, [updateConfigIx(ctx.program, vault, next)], "the config change");
}

/** The upgrade authority out of the vault: to a wallet, or to another multisig's vault. A rehearsal's way back. */
async function proposeAuthority(ctx) {
  const { env } = ctx;
  const address = key(env.MULTISIG, "MULTISIG"), vault = vaultAddress(address);
  if (env.NEW_AUTHORITY && env.NEW_AUTHORITY_MULTISIG) refuse("set NEW_AUTHORITY or NEW_AUTHORITY_MULTISIG, not both");
  const other = env.NEW_AUTHORITY_MULTISIG ? key(env.NEW_AUTHORITY_MULTISIG, "NEW_AUTHORITY_MULTISIG") : null;
  if (!other && !env.NEW_AUTHORITY) refuse("propose-authority needs NEW_AUTHORITY=<a wallet> or NEW_AUTHORITY_MULTISIG=<a multisig>");
  const next = other ? vaultAddress(other) : key(env.NEW_AUTHORITY, "NEW_AUTHORITY");
  if (!other && !isWallet(next)) refuse(`NEW_AUTHORITY ${next.toBase58()} is not a wallet's key, so no one could sign an upgrade: for another multisig's vault, NEW_AUTHORITY_MULTISIG=<that multisig>`);
  if (next.equals(vault)) refuse("that is this multisig's vault, which holds the authority already");
  const proposer = memberSigner(ctx);
  ctx.labels.set(vault.toBase58(), "the vault");
  await connect(ctx);
  const ms = await readUsableMultisig(ctx, address);
  if (other) {
    const found = decodeMultisig(await ctx.conn.getAccountInfo(other, "confirmed"));
    if (found.error) refuse(`NEW_AUTHORITY_MULTISIG ${other.toBase58()} ${found.error}`);
    const broken = [...checkCanAct(found.ms), ...(found.ms.configAuthority.equals(PublicKey.default) ? [] : ["it has a config authority"])];
    if (broken.length) refuse(`NEW_AUTHORITY_MULTISIG ${other.toBase58()} can't hold the program: ${broken.join("; ")}`);
    row("new authority", `vault 0 of the multisig ${other.toBase58()}, ${next.toBase58()}`);
  } else {
    row("new authority", `${who(ctx, next)}, a wallet`);
    console.log(`  warning: the program leaves the multisig: once this runs, the one key ${next.toBase58()} can upgrade it alone, with no vote and no wait`);
  }
  const state = await readProgram(ctx);
  row("upgrade authority", who(ctx, state.data.authority));
  if (!state.data.authority?.equals(vault)) problem(ctx, `the upgrade authority is ${who(ctx, state.data.authority)}, not the vault: there is nothing for the multisig to give`);
  console.log("  the config's admin is apart: propose-config ADMIN=... moves it");
  requireMember(ctx, ms, proposer, INITIATE, "propose");
  await propose(ctx, address, ms, proposer, [setUpgradeAuthorityIx(ctx.program, vault, next)], "the authority change");
}

/** A buffer's SOL back to the KEYPAIR: at once when the KEYPAIR holds it, by a vote when the vault does. */
async function closeBuffer(ctx) {
  const { env } = ctx;
  const buffer = key(env.BUFFER, "BUFFER");
  const address = env.MULTISIG ? key(env.MULTISIG, "MULTISIG") : null, vault = address && vaultAddress(address);
  if (vault) ctx.labels.set(vault.toBase58(), "the vault");
  await connect(ctx);
  const info = await ctx.conn.getAccountInfo(buffer, "confirmed");
  const buf = info && info.owner.equals(LOADER) ? decodeBuffer(info.data) : null;
  if (!buf) refuse(`BUFFER ${buffer.toBase58()} is not a buffer of the upgradeable loader${info ? "" : " (nothing is there: closed already?)"}`);
  row("buffer", `${buffer.toBase58()}: ${buf.bytes.length} bytes, ${sol(info.lamports)}, held by ${who(ctx, buf.authority)}`);
  if (buf.authority?.equals(ctx.payer.publicKey)) {
    const result = await run(ctx, "close the buffer", [closeBufferIx(buffer, ctx.payer.publicKey, ctx.payer.publicKey)]);
    if (ctx.send && result.ok) check(ctx, !(await ctx.conn.getAccountInfo(buffer, "confirmed")), `read back: the buffer is closed, its ${sol(info.lamports)} back to the KEYPAIR`);
    return;
  }
  if (!address) refuse(`the buffer is held by ${who(ctx, buf.authority)}, not the KEYPAIR: if that is a multisig's vault, MULTISIG=<that multisig> proposes its close`);
  if (!buf.authority?.equals(vault)) refuse(`the buffer is held by ${who(ctx, buf.authority)}, neither the KEYPAIR nor vault 0 of MULTISIG`);
  const proposer = memberSigner(ctx);
  const ms = await readUsableMultisig(ctx, address);
  requireMember(ctx, ms, proposer, INITIATE, "propose");
  await propose(ctx, address, ms, proposer, [closeBufferIx(buffer, ctx.payer.publicKey, vault)], "the buffer's close");
}

/** A proposal and its vault transaction, or a refusal saying why there is none. */
async function readProposal(ctx, address, index) {
  const [p, t] = await ctx.conn.getMultipleAccountsInfo([proposalAddress(address, index), transactionAddress(address, index)], "confirmed");
  const proposal = decodeProposal(p), vtx = decodeVaultTransaction(t);
  if (!vtx) refuse(`there is no vault transaction at INDEX ${index}`);
  if (!proposal) refuse(`there is no proposal at INDEX ${index}`);
  return { proposal, vtx };
}

async function approve(ctx) {
  const address = key(ctx.env.MULTISIG, "MULTISIG"), vault = vaultAddress(address);
  if (!ctx.env.INDEX) refuse("approve needs INDEX=<n>: the proposal's number");
  const index = BigInt(whole(ctx.env.INDEX, "INDEX", 1));
  const build = ctx.env.BUILD ? loadBuild(ctx.env.BUILD, ctx) : null;
  const member = memberSigner(ctx);
  ctx.labels.set(vault.toBase58(), "the vault");
  await connect(ctx);
  const ms = await readMultisig(ctx, address);
  showMultisig(ctx, address, ms);
  requireMember(ctx, ms, member, VOTE, "vote");
  const { proposal, vtx } = await readProposal(ctx, address, index);
  const state = await readProgramState(ctx);
  row("proposed by", who(ctx, vtx.creator));
  const seen = await showProposal(ctx, vtx, { label: `proposal ${index}`, vault, config: state?.config ?? null, build, vote: true });
  weighDangers(ctx, seen.dangers);
  row("votes", `${proposal.approved.length} of ${ms.threshold}, ${proposal.status}`);
  if (index <= ms.staleIndex) refuse(`proposal ${index} is stale: a change to the multisig itself came after it`);
  if (proposal.status === "Approved") refuse(`proposal ${index} has its votes already: execute it after the timelock`);
  if (proposal.status !== "Active") refuse(`proposal ${index} is ${proposal.status}: it takes no votes`);
  if (proposal.approved.some((k) => k.equals(member.publicKey))) refuse(`${who(ctx, member.publicKey)} has approved proposal ${index} already`);
  const ix = squads.instructions.proposalApprove({ multisigPda: address, transactionIndex: index, member: member.publicKey });
  const result = await run(ctx, `approve proposal ${index}`, [ix], [member]);
  if (!ctx.send || !result.ok) return;
  const after = decodeProposal(await ctx.conn.getAccountInfo(proposalAddress(address, index), "confirmed"));
  check(ctx, Boolean(after?.approved.some((k) => k.equals(member.publicKey))), `read back: ${after?.approved.length} of ${ms.threshold} votes, ${after?.status}`);
  if (after?.status === "Approved") console.log(`  it can run from ${new Date((after.at + ms.timeLock) * 1000).toISOString()} (timelock ${duration(ms.timeLock)})`);
}

async function execute(ctx) {
  const address = key(ctx.env.MULTISIG, "MULTISIG"), vault = vaultAddress(address);
  if (!ctx.env.INDEX) refuse("execute needs INDEX=<n>: the proposal's number");
  const index = BigInt(whole(ctx.env.INDEX, "INDEX", 1));
  const build = ctx.env.BUILD ? loadBuild(ctx.env.BUILD, ctx) : null;
  const member = memberSigner(ctx);
  ctx.labels.set(vault.toBase58(), "the vault");
  await connect(ctx);
  const ms = await readMultisig(ctx, address);
  showMultisig(ctx, address, ms);
  requireMember(ctx, ms, member, EXECUTE, "execute");
  const { proposal, vtx } = await readProposal(ctx, address, index);
  const before = await readProgramState(ctx);
  const seen = await showProposal(ctx, vtx, { label: `proposal ${index}`, vault, config: before?.config ?? null, build, vote: true });
  weighDangers(ctx, seen.dangers);
  row("votes", `${proposal.approved.length} of ${ms.threshold}, ${proposal.status}`);
  if (proposal.status !== "Approved") refuse(`proposal ${index} is ${proposal.status}, not Approved`);
  const left = proposal.at + ms.timeLock - (await chainNow(ctx));
  if (left > 0) refuse(`the timelock has ${duration(left)} left: proposal ${index} can run from ${new Date((proposal.at + ms.timeLock) * 1000).toISOString()}`);

  // What to check once it has run: the program's new bytes (BUILD's, or the buffer's as they are now) or the config.
  const upgrade = seen.upgrades.find((u) => u.program.equals(ctx.program)) ?? null;
  const update = vtx.instructions.find((i) => i.programId.equals(ctx.program) && i.data.length === 8 + CONFIG_ARGS_LEN && i.data.subarray(0, 8).equals(disc("update_config")));
  if (upgrade && !upgrade.bytes) refuse(`the buffer ${upgrade.buffer.toBase58()} is gone: make a new one and a new proposal`);
  if (upgrade && !before?.upgradeable) refuse(`PROGRAM ${ctx.program.toBase58()} is not a program of the upgradeable loader on ${ctx.cluster}`);
  const { instruction } = await squads.instructions.vaultTransactionExecute({ connection: ctx.conn, multisigPda: address, transactionIndex: index, member: member.publicKey });
  const result = await run(ctx, `execute proposal ${index}`, [instruction], [member]);
  if (!ctx.send || !result.ok) return;
  const after = decodeProposal(await ctx.conn.getAccountInfo(proposalAddress(address, index), "confirmed"));
  check(ctx, after?.status === "Executed", `read back: proposal ${index} is ${after?.status}`);
  if (upgrade) {
    const state = await readProgram(ctx);
    const want = build?.bytes ?? upgrade.bytes;
    check(ctx, holds(state.data.bytes, want) && state.data.slot > before.data.slot,
      `read back: the program holds ${build ? `BUILD's ${want.length} bytes (sha256 ${build.sha})` : `the buffer's ${want.length} bytes`}, deployed in slot ${state.data.slot}`);
    if (upgrade.closes) check(ctx, !(await ctx.conn.getAccountInfo(upgrade.buffer, "confirmed")), "read back: the buffer is closed, its SOL back to the spill account");
  }
  if (update) {
    const state = await readProgramState(ctx);
    check(ctx, Boolean(state?.config && sameConfig(state.config, decodeConfigArgs(update.data, 8))), "read back: the config is what the proposal said");
  }
}

/** Closes the multisig's finished proposals (anyone may): their rent goes to the rent collector, the vault. */
async function cleanup(ctx) {
  const address = key(ctx.env.MULTISIG, "MULTISIG"), vault = vaultAddress(address);
  ctx.labels.set(vault.toBase58(), "the vault");
  await connect(ctx);
  const ms = await readMultisig(ctx, address);
  showMultisig(ctx, address, ms);
  if (!ms.rentCollector) refuse("this multisig has no rent collector, so Squads lets no one close its proposals: their rent stays where it is");
  let done = (await readProposals(ctx, address, ms)).filter((e) => closable(e, ms.staleIndex));
  // The handoff reads who signed the key checks off their accounts: closing one before it would take that proof away.
  const state = await readProgramState(ctx);
  if (!state?.authority?.equals(vault)) {
    const kept = done.filter((e) => isKeycheck(e.vtx));
    if (kept.length) console.log(`  kept until the handoff: the key check${kept.length > 1 ? "s" : ""} ${kept.map((e) => e.index).join(", ")} (the handoff reads its signers)`);
    done = done.filter((e) => !isKeycheck(e.vtx));
  }
  if (!done.length) { console.log("  nothing to close: no proposal is executed, rejected, cancelled, or stale and unapproved"); return; }
  const batch = done.slice(0, 8);
  for (const e of batch) row(`  ${e.index}`, `${e.proposal?.status ?? "no proposal"}${e.index <= ms.staleIndex ? ", stale" : ""}: ${sol(e.rent)}`);
  if (done.length > batch.length) console.log(`  ${done.length - batch.length} more after these: run cleanup again`);
  const ixs = batch.map((e) => squads.instructions.vaultTransactionAccountsClose({ multisigPda: address, rentCollector: ms.rentCollector, transactionIndex: e.index }));
  const result = await run(ctx, `close ${batch.length} proposal(s), ${sol(batch.reduce((s, e) => s + e.rent, 0n))} to ${who(ctx, ms.rentCollector)}`, ixs);
  if (!ctx.send || !result.ok) return;
  const infos = await ctx.conn.getMultipleAccountsInfo(batch.map((e) => transactionAddress(address, e.index)), "confirmed");
  check(ctx, infos.every((i) => !i), "read back: those vault transactions are closed");
}

async function status(ctx) {
  const derived = !ctx.env.MULTISIG;
  const address = derived ? multisigAddress(createKeyFor(ctx.secret, ctx.program).publicKey) : key(ctx.env.MULTISIG, "MULTISIG");
  const vault = vaultAddress(address);
  ctx.labels.set(vault.toBase58(), "the vault");
  await connect(ctx);
  const { fee } = await programConfig(ctx);
  row("Squads v4", `${SQUADS.toBase58()}, executable; creation fee ${sol(fee)}`);
  const found = decodeMultisig(await ctx.conn.getAccountInfo(address, "confirmed"));
  const state = await readProgram(ctx);
  if (found.error) {
    row("multisig", `${address.toBase58()}${derived ? " (the one create makes for this KEYPAIR and PROGRAM)" : ""} ${found.error}`);
  } else {
    const ms = found.ms;
    showMultisig(ctx, address, ms);
    const entries = await readProposals(ctx, address, ms);
    showKeycheck(ctx, ms, provenMembers(entries));
    row("proposals", `${ms.transactionIndex} made${ms.staleIndex ? `, those up to ${ms.staleIndex} stale` : ""}${entries.length > 20 ? ", the last 20 shown" : ""}`);
    const now = entries.length ? await chainNow(ctx) : 0;
    for (const { index: i, proposal: p, vtx: t } of entries.slice(-20)) {
      const pending = p && ["Draft", "Active", "Approved"].includes(p.status);
      let when = "";
      if (p?.status === "Approved") { const left = p.at + ms.timeLock - now; when = left > 0 ? `, runs in ${duration(left)}` : ", can run now"; }
      row(`  ${i}`, `${p ? `${p.status}${pending ? " (pending)" : ""}, ${p.approved.length} of ${ms.threshold} votes${when}` : "no proposal"}${i <= ms.staleIndex ? ", stale" : ""}`);
      if (!t) { row("", "(not a vault transaction, or closed)"); continue; }
      const seen = await showProposal(ctx, t, { label: "", vault, config: state.config });
      for (const d of seen.dangers) row("", `warning: ${d}`);
    }
  }
  row("upgrade authority", `${who(ctx, state.data.authority)}, last deployed in slot ${state.data.slot}, room for ${state.data.room} bytes`);
  if (state.config) showConfig(ctx, state.config);
  else row("config", "none yet");
}

/* ---------------- Running it ---------------- */

async function main() {
  const command = process.argv[2];
  if (process.env.RPC_URL) hideRpcUrl(process.env.RPC_URL);
  const ctx = settings(command, process.env);
  const { keypair, secret } = loadKeypair(ctx.keypairPath, "KEYPAIR");
  Object.assign(ctx, { payer: keypair, secret, problems: [], labels: new Map([[keypair.publicKey.toBase58(), "the KEYPAIR"]]) });
  ctx.rehearsalWallets = ctx.rehearsal ? [1, 2, 3].map((n) => rehearsalMember(secret, n)) : [];
  ctx.rehearsalWallets.forEach((w, i) => ctx.labels.set(w.publicKey.toBase58(), `rehearsal member ${i + 1}`));
  const commands = {
    create, "propose-keycheck": proposeKeycheck, handoff, "write-buffer": writeBuffer, "propose-upgrade": proposeUpgrade,
    "propose-config": proposeConfig, "propose-authority": proposeAuthority, "close-buffer": closeBuffer, approve, execute, cleanup, status,
  };
  await commands[command](ctx);
  if (ctx.problems.length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.log(err instanceof Refusal ? `refused: ${err.message}` : `FAIL ${err?.stack ?? err}`);
    process.exit(1);
  });
}
