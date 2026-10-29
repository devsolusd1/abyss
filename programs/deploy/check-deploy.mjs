// Checks a deployed pool program against what it should be, and only reads: the program and its upgrade authority, the
// binary on chain byte for byte against a build, the config, and with a multisig, that its vault holds both the program
// and the config. It needs no key and sends nothing. It exits with 1 when any check fails.
//
//   CLUSTER=devnet PROGRAM=<id> BUILD=~/nox-release/<id>/build.json node check-deploy.mjs
//   CLUSTER=mainnet PROGRAM=<id> BUILD=… MULTISIG=<multisig> EXPECT_MEMBERS=a,b,c … node check-deploy.mjs
//   CLUSTER=mainnet PROGRAM=<id> BUILD=<new build.json> MULTISIG=… BUFFER=<buffer> node check-deploy.mjs
// (on mainnet with RPC_URL exported first, read with read -rsp as MAINNET.md shows: never on the command line)
//
// CLUSTER           devnet (the default) or mainnet. The node must be of it: its genesis hash is checked first.
// RPC_URL           the node; the cluster's public one unless given. Never printed: a paid node's URL carries its key.
// PROGRAM           the program id.
// BUILD             what the chain should hold: build.sh's build.json (with its dex.so next to it), or a .so.
// EXPECT_AUTHORITY  the upgrade authority the program should have.
// MULTISIG          a Squads v4 multisig: the upgrade authority and the config's admin must both be its vault 0.
// EXPECT_MEMBERS (a,b,c), EXPECT_THRESHOLD, EXPECT_TIMELOCK (seconds)
//                   the multisig's, each checked when given. MIN_TIMELOCK is the shortest time lock that passes: 3600
//                   on mainnet, 0 on devnet, unless given.
// On mainnet BUILD is required, and EXPECT_AUTHORITY or MULTISIG; with MULTISIG, EXPECT_MEMBERS too.
// BUFFER            an upgrade on its way: the build is compared with that buffer instead of the program (BUILD must
//                   then be a build.json, which names the program it is for). The buffer must fit in the program's
//                   room, and be held by BUFFER_AUTHORITY (the wallet that wrote it) or already by the vault. When every
//                   check passes and the vault does not hold it yet, it prints the next step: multisig.mjs
//                   propose-upgrade, which hands the buffer to the vault the program's own authority is, in the same
//                   transaction as the proposal. Never by hand: a buffer handed to any other key is lost with its SOL.
// EXPECT_ADMIN, EXPECT_LAUNCHER, EXPECT_TREASURY, EXPECT_LAUNCH_FEE (lamports), EXPECT_MIN_FEE_BPS,
// EXPECT_TREASURY_SHARE_BPS, EXPECT_LAUNCHES_OPEN (0 or 1)
//                   the config's values, each checked when given.
// CONFIG=0          leaves the config out: right after the deploy, before init-config.mjs.
// SITE=0            leaves out, on mainnet, that site/net.js and server/config.mjs name this program (they do only after
//                   set-program.mjs). ROOT is the repository they are read from; this one unless given.
//
// init-config.mjs and deploy.sh use the helpers this file exports.

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "node:util";

export const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const SYSTEM = new PublicKey("11111111111111111111111111111111");
export const SQUADS = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
/** The program on devnet today: the site's, and where init-config.mjs takes its numbers from. */
export const DEVNET_PROGRAM = "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK";
export const PUBLIC_RPC = { devnet: "https://api.devnet.solana.com", mainnet: "https://api.mainnet-beta.solana.com" };
/** Each cluster's genesis hash, as multisig.mjs and sol.sh have them: a node of another cluster answers another one. */
export const GENESIS = { devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" };
/** The shortest time lock a mainnet multisig passes with, unless MIN_TIMELOCK says otherwise. */
export const MIN_MAINNET_TIMELOCK = 3600;
/**
 * The priority fee when none is given on mainnet, in micro-lamports per compute unit: a percentile of the node's recent
 * fees, between these. A program write costs about 3,000 units, so even the cap is a few thousand lamports a write.
 */
export const PRICE_FLOOR = 500_000;
export const PRICE_CAP = 10_000_000;
/** The limits written into the program (state.rs), which init_config refuses to pass. */
export const MAX_LAUNCH_FEE = 1_000_000_000n;
export const MAX_FEE_BPS = 300;
export const BPS = 10_000;
/** Config: Anchor's 8-byte mark, then admin, launcher, treasury, launch_fee u64, min_fee_bps u16, treasury_share_bps u16,
 * launches_open bool, bump u8 (state.rs). */
export const CONFIG_SIZE = 8 + 32 * 3 + 8 + 2 + 2 + 1 + 1;

const HERE = dirname(fileURLToPath(import.meta.url));
export const home = (p) => String(p).replace(/^~(?=\/|$)/, homedir());
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sol = (lamports) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(9).replace(/\.?0+$/, "");
/** Anchor's mark of an account kind, and of an instruction. */
export const accountMark = (name) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
export const instructionMark = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/* ---------- the node's URL never shows ---------- */

const secrets = [];
/**
 * Remembers a node URL so no output shows it: as given, as parsed (the host in lower case, a slash added), its host,
 * and each part of its path, query and user info six characters long or more, where the key goes. sol.sh does the same
 * for the CLI.
 */
export function secret(url) {
  if (!url) return;
  const add = (...parts) => secrets.push(...parts.filter((p) => p && p.length >= 6));
  add(url);
  try {
    const u = new URL(url);
    add(u.href, u.host, u.hostname, u.host + u.pathname + u.search, ...`${u.pathname}${u.search}:${u.username}:${u.password}`.split(/[/?&=#:;]+/));
  } catch { /* not a URL: the whole string is hidden already */ }
  secrets.sort((a, b) => b.length - a.length);
}
const pattern = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
export const hide = (text) => secrets.reduce((t, s) => t.replace(pattern(s), "<hidden>"), String(text));
/** Every line this process prints passes through hide(), errors and the library's own retries included. */
export function guardOutput() {
  for (const k of ["log", "error", "warn", "info"]) {
    const write = console[k].bind(console);
    console[k] = (...args) => write(hide(format(...args)));
  }
  const fail = (err) => { console.error(`error: ${err?.message ?? err}`); process.exit(1); };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
}

/* ---------- settings ---------- */

export function clusterOf(value = "devnet") {
  const v = String(value).trim().toLowerCase();
  if (v === "devnet") return "devnet";
  if (v === "mainnet" || v === "mainnet-beta") return "mainnet";
  throw new Error(`CLUSTER must be devnet or mainnet, not "${value}"`);
}

/**
 * The node for a cluster: RPC_URL when given, the public node otherwise. `paid`: mainnet needs RPC_URL, and not the
 * public node (it is not for apps, and it throttles a deploy's hundreds of writes).
 */
export function nodeFor(cluster, env = process.env, { paid = false } = {}) {
  const given = String(env.RPC_URL ?? "").trim();
  if (!given) {
    if (paid && cluster === "mainnet") throw new Error("CLUSTER=mainnet needs RPC_URL: a paid node (its URL is never printed)");
    return { url: PUBLIC_RPC[cluster], label: PUBLIC_RPC[cluster], own: false };
  }
  secret(given);
  let u;
  try { u = new URL(given); } catch { throw new Error("RPC_URL is not a URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("RPC_URL must be an http(s) URL");
  if (paid && cluster === "mainnet" && u.hostname === "api.mainnet-beta.solana.com") {
    throw new Error("RPC_URL is the public mainnet node, which is not for this: use a paid one");
  }
  return { url: given, label: "RPC_URL (not shown)", own: true };
}

/**
 * Null when the node is of the cluster, otherwise why not. An RPC_URL left in the shell from another step would apply
 * one cluster's rules (no priority fee, a dirty build, a short time lock) to the other's chain.
 */
export async function clusterError(conn, cluster) {
  let genesis;
  try { genesis = await conn.getGenesisHash(); } catch (err) { return `the node did not answer (${err?.message ?? err})`; }
  if (genesis === GENESIS[cluster]) return null;
  const other = Object.keys(GENESIS).find((k) => GENESIS[k] === genesis);
  return `the node is not a ${cluster} node: its genesis hash is ${genesis}${other ? `, ${other}'s` : ""}`;
}

/** An address from a setting, or a stop that names the setting. */
export function addressOf(value, name) {
  try {
    const key = new PublicKey(String(value ?? "").trim());
    if (key.toBase58() === String(value).trim()) return key;
  } catch { /* said below */ }
  throw new Error(`${name} must be a base58 address${value ? `, not "${value}"` : ""}`);
}

/* ---------- the program's accounts ---------- */

export const programdataAddress = (program) => PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];
export const configAddress = (program) => PublicKey.findProgramAddressSync([Buffer.from("config")], program);
/**
 * A Squads v4 multisig's vault: ["multisig", multisig, "vault", index as one byte] under the Squads program, as the
 * program (state/multisig.rs) and its SDK (getVaultPda in sdk/multisig/src/pda.ts) derive it.
 */
export const vaultAddress = (multisig, index = 0) =>
  PublicKey.findProgramAddressSync([Buffer.from("multisig"), multisig.toBuffer(), Buffer.from("vault"), Buffer.from([index])], SQUADS)[0];

/** The upgradeable loader's two accounts: Program (tag 2, its program data) and ProgramData (tag 3, slot, authority). */
export function parseProgram(data) {
  if (data.length < 36 || data.readUInt32LE(0) !== 2) return null;
  return { programdata: new PublicKey(data.subarray(4, 36)) };
}
export function parseProgramdata(data) {
  if (data.length < 45 || data.readUInt32LE(0) !== 3) return null;
  return {
    slot: data.readBigUInt64LE(4),
    authority: data[12] === 1 ? new PublicKey(data.subarray(13, 45)) : null,
    elf: data.subarray(45),
  };
}
/** A Buffer (tag 1): its authority, then the bytes written so far. */
export function parseBuffer(data) {
  if (data.length < 37 || data.readUInt32LE(0) !== 1) return null;
  return { authority: data[4] === 1 ? new PublicKey(data.subarray(5, 37)) : null, bytes: data.subarray(37) };
}

export function parseConfig(data) {
  if (data.length !== CONFIG_SIZE || !data.subarray(0, 8).equals(accountMark("Config"))) return null;
  const key = (at) => new PublicKey(data.subarray(at, at + 32));
  return {
    admin: key(8), launcher: key(40), treasury: key(72),
    launchFee: data.readBigUInt64LE(104), minFeeBps: data.readUInt16LE(112), treasuryShareBps: data.readUInt16LE(114),
    launchesOpen: data[116] === 1, bump: data[117],
  };
}

/** The program's config: null when there is none yet, `{ bad }` when the account there is not a Config of the program. */
export async function readConfig(conn, program) {
  const [address, bump] = configAddress(program);
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info) return null;
  const config = info.owner.equals(program) ? parseConfig(info.data) : null;
  if (!config) return { address, bad: `${address.toBase58()} holds ${info.data.length} bytes of ${info.owner.toBase58()}, not a Config` };
  return { address, ...config, bumpOk: config.bump === bump };
}

/**
 * Squads v4's Multisig (state/multisig.rs): create_key, config_authority, threshold u16, time_lock u32,
 * transaction_index u64, stale_transaction_index u64, rent_collector Option<Pubkey>, bump, members Vec<{ key, mask }>.
 */
export function parseMultisig(data) {
  if (data.length < 8 + 32 * 2 + 2 + 4 + 16 + 1 || !data.subarray(0, 8).equals(accountMark("Multisig"))) return null;
  let at = 8 + 32;
  const configAuthority = new PublicKey(data.subarray(at, at + 32)); at += 32;
  const threshold = data.readUInt16LE(at); at += 2;
  const timeLock = data.readUInt32LE(at); at += 4;
  const transactionIndex = data.readBigUInt64LE(at); at += 16;
  at += data[at] === 1 ? 33 : 1;
  at += 1;
  const count = data.readUInt32LE(at); at += 4;
  const members = [];
  for (let i = 0; i < count && at + 33 <= data.length; i++, at += 33) members.push({ key: new PublicKey(data.subarray(at, at + 32)), mask: data[at + 32] });
  return members.length === count ? { configAuthority, threshold, timeLock, transactionIndex, members } : null;
}

/**
 * A priority fee from the node's recent ones, clamped. The node gives, for each recent slot, the lowest fee that landed
 * in it, which is 0 in nearly every slot (some transaction always pays nothing): the percentile is taken over the slots
 * where it was above 0, so it says what paying transactions paid at the least. On the public mainnet node on
 * 2026-10-29 all 150 slots showed 0, with a busy account named too: in practice it is the floor. A paid node's own
 * estimate (Helius's getPriorityFeeEstimate, for one) follows congestion, and PRICE= takes it.
 */
export const priceNote = (r) => (r.paying
  ? `the 75th percentile of the ${r.paying} of the last ${r.slots} slots where it was above 0 (p50 ${r.p50}, p75 ${r.p75}, max ${r.max}), kept between ${r.floor} and ${r.cap}; PRICE= sets another`
  : `the floor: each of the node's last ${r.slots} slots shows 0; PRICE= sets another, such as the node's own estimate`);
export async function recentPrice(conn, accounts = [], { pct = 75, floor = PRICE_FLOOR, cap = PRICE_CAP } = {}) {
  const all = (await conn.getRecentPrioritizationFees({ lockedWritableAccounts: accounts })).map((f) => f.prioritizationFee);
  const fees = all.filter((fee) => fee > 0).sort((a, b) => a - b);
  const at = (p) => (fees.length ? fees[Math.min(fees.length - 1, Math.floor((fees.length * p) / 100))] : 0);
  return { price: Math.min(cap, Math.max(floor, at(pct))), p50: at(50), p75: at(75), max: fees.at(-1) ?? 0, slots: all.length, paying: fees.length, floor, cap };
}

/* ---------- the checks ---------- */

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); return ok; };
const note = (text) => console.log(`       ${text}`);
const short = (key) => (key ? `${key.toBase58().slice(0, 4)}…${key.toBase58().slice(-4)}` : "none");

/** build.json and the .so next to it, or a .so alone. */
function loadBuild(path) {
  const p = resolve(home(path));
  if (!p.endsWith(".json")) return { meta: null, so: readFileSync(p), file: p };
  const meta = JSON.parse(readFileSync(p, "utf8"));
  const file = join(dirname(p), meta.file ?? "dex.so");
  return { meta, so: readFileSync(file), file };
}

/** The binary in `bytes` is the build's, then zeros to the end (a program's or a buffer's room past the binary). */
const holds = (bytes, so) => bytes.length >= so.length && bytes.subarray(0, so.length).equals(so) && bytes.subarray(so.length).every((b) => b === 0);

async function main() {
  guardOutput();
  const env = process.env;
  const cluster = clusterOf(env.CLUSTER ?? "devnet");
  const rpc = nodeFor(cluster, env);
  const conn = new Connection(rpc.url, "confirmed");
  const program = addressOf(env.PROGRAM, "PROGRAM");
  const ms = env.MULTISIG ? addressOf(env.MULTISIG, "MULTISIG") : null;
  const bufferKey = env.BUFFER ? addressOf(env.BUFFER, "BUFFER") : null;
  console.log(`check-deploy: ${program.toBase58()} on ${cluster}, through ${rpc.label}`);

  // 0. The node, and on mainnet the proofs that matter: a check without them would pass on anything.
  const wrongNode = await clusterError(conn, cluster);
  if (!line(!wrongNode, wrongNode ?? `the node is a ${cluster} node (genesis ${GENESIS[cluster].slice(0, 8)}…)`)) return finish();
  if (cluster === "mainnet") {
    line(Boolean(env.BUILD), "BUILD is given: on mainnet the bytes are always compared with a build");
    line(Boolean(env.EXPECT_AUTHORITY || ms), "EXPECT_AUTHORITY or MULTISIG is given: on mainnet the upgrade authority is always checked");
    if (ms) line(Boolean(env.EXPECT_MEMBERS), "EXPECT_MEMBERS is given: on mainnet the multisig's members are always checked");
    if (bufferKey) line(Boolean(ms), "MULTISIG is given: on mainnet a buffer goes to the vault only");
  }

  // 1. The program, and the account that holds its binary.
  const info = await conn.getAccountInfo(program, "confirmed");
  if (!line(Boolean(info), "the program account exists")) return finish();
  line(info.owner.equals(LOADER) && info.executable, `it is executable and belongs to the upgradeable loader (${info.owner.toBase58()})`);
  const pdAddress = programdataAddress(program);
  const head = parseProgram(info.data);
  if (!line(Boolean(head?.programdata.equals(pdAddress)), `its program data is at ${pdAddress.toBase58()}`)) return finish();
  const pdInfo = await conn.getAccountInfo(pdAddress, "confirmed");
  const pd = pdInfo && pdInfo.owner.equals(LOADER) ? parseProgramdata(pdInfo.data) : null;
  if (!line(Boolean(pd), "the program data is the loader's")) return finish();
  note(`deployed last in slot ${pd.slot}; ${pd.elf.length} bytes of room, ${sol(pdInfo.lamports)} SOL of rent in it`);
  note(`upgrade authority: ${pd.authority ? pd.authority.toBase58() : "none: the program is final, nobody can upgrade it"}`);
  if (env.EXPECT_AUTHORITY) {
    const want = addressOf(env.EXPECT_AUTHORITY, "EXPECT_AUTHORITY");
    line(Boolean(pd.authority?.equals(want)), `the upgrade authority is ${want.toBase58()}`);
  }

  // 2. The bytes: the build, then zeros to the end of the room (an upgrade with a smaller binary leaves zeros). With
  // BUFFER the build is the one on its way, so it is compared with the buffer, and the program's bytes are only shown.
  const build = env.BUILD ? loadBuild(env.BUILD) : null;
  const want = build ? sha256(build.so) : null;
  if (build) {
    if (build.meta) {
      line(build.meta.program === program.toBase58(), `the build is for this program (build.json: ${build.meta.program})`);
      line(build.meta.sha256 === want && build.meta.size === build.so.length, `${build.file} is the binary build.json describes`);
      const clean = build.meta.dirty === false;
      if (cluster === "mainnet") line(clean, `the build is of commit ${String(build.meta.commit).slice(0, 7)} from a clean tree`);
      else note(`the build is of commit ${String(build.meta.commit).slice(0, 7)}${clean ? "" : ", from a tree with changes not committed (dirty)"}`);
    } else if (bufferKey) line(false, "BUILD is a build.json, which names the program the binary is for: a bare .so says nothing of it");
    line(build.so.includes(program.toBuffer()), "the build carries this program's id (its declare_id!)");
  }
  if (build && !bufferKey) {
    if (line(pd.elf.length >= build.so.length, `the program data has room for the build (${pd.elf.length} bytes for ${build.so.length})`)) {
      const live = sha256(pd.elf.subarray(0, build.so.length));
      const zeros = pd.elf.subarray(build.so.length).every((b) => b === 0);
      line(live === want, `the bytes on chain are the build's: sha256 ${want}`);
      if (live !== want) note(`on chain, the first ${build.so.length} bytes: sha256 ${live}`);
      line(zeros, `the ${pd.elf.length - build.so.length} bytes after it are zeros`);
    }
  } else {
    let end = pd.elf.length;
    while (end > 0 && pd.elf[end - 1] === 0) end--;
    note(`${build ? "" : "no BUILD to compare with; "}on chain, ${end} bytes before the zeros: sha256 ${sha256(pd.elf.subarray(0, end))}`);
  }

  // 2b. The buffer of an upgrade: the build's bytes, room for them in the program, and who holds it.
  let buffer = null;
  if (bufferKey) {
    const bInfo = await conn.getAccountInfo(bufferKey, "confirmed");
    buffer = bInfo?.owner.equals(LOADER) ? parseBuffer(bInfo.data) : null;
    if (line(Boolean(buffer), `${bufferKey.toBase58()} is a buffer of the upgradeable loader`)) {
      note(`buffer: ${buffer.bytes.length} bytes, ${sol(bInfo.lamports)} SOL of rent, authority ${buffer.authority ? buffer.authority.toBase58() : "none"}`);
      line(Boolean(buffer.authority), "the buffer has an authority (one without can never be used nor closed)");
      if (build) {
        line(holds(buffer.bytes, build.so), `the buffer holds the build: sha256 ${want}${buffer.bytes.length > build.so.length ? ", then zeros" : ""}`);
        if (!holds(buffer.bytes, build.so)) note(`in the buffer, its first ${Math.min(buffer.bytes.length, build.so.length)} bytes: sha256 ${sha256(buffer.bytes.subarray(0, build.so.length))}`);
      }
      line(buffer.bytes.length <= pd.elf.length, `it fits in the program's room (${buffer.bytes.length} of ${pd.elf.length} bytes; a larger one needs the program extended first)`);
      if (env.BUFFER_AUTHORITY) {
        const writer = addressOf(env.BUFFER_AUTHORITY, "BUFFER_AUTHORITY");
        const vault = ms ? vaultAddress(ms, 0) : null;
        line(Boolean(buffer.authority?.equals(writer) || (vault && buffer.authority?.equals(vault))),
          `the buffer is held by BUFFER_AUTHORITY ${short(writer)}${vault ? " or by the vault" : ""}`);
      }
    }
  }

  // 3. The config, which only the upgrade authority can create.
  let config = null;
  if (env.CONFIG === "0") note("config: left out (CONFIG=0)");
  else {
    config = await readConfig(conn, program);
    if (line(Boolean(config) && !config.bad, `the config exists at ${configAddress(program)[0].toBase58()}${config?.bad ? `: ${config.bad}` : ""}`) && config.bumpOk !== undefined) {
      line(config.bumpOk, "its bump is the address's");
      note(`admin     ${config.admin.toBase58()}`);
      note(`launcher  ${config.launcher.toBase58()}`);
      note(`treasury  ${config.treasury.toBase58()}`);
      note(`launch_fee ${config.launchFee} lamports (${sol(config.launchFee)} SOL), min_fee_bps ${config.minFeeBps}, treasury_share_bps ${config.treasuryShareBps}, launches_open ${config.launchesOpen}`);
      const expected = [
        ["admin", "EXPECT_ADMIN", (v) => addressOf(v, "EXPECT_ADMIN").toBase58(), config.admin.toBase58()],
        ["launcher", "EXPECT_LAUNCHER", (v) => addressOf(v, "EXPECT_LAUNCHER").toBase58(), config.launcher.toBase58()],
        ["treasury", "EXPECT_TREASURY", (v) => addressOf(v, "EXPECT_TREASURY").toBase58(), config.treasury.toBase58()],
        ["launch_fee", "EXPECT_LAUNCH_FEE", (v) => String(BigInt(v)), String(config.launchFee)],
        ["min_fee_bps", "EXPECT_MIN_FEE_BPS", (v) => String(Number(v)), String(config.minFeeBps)],
        ["treasury_share_bps", "EXPECT_TREASURY_SHARE_BPS", (v) => String(Number(v)), String(config.treasuryShareBps)],
        ["launches_open", "EXPECT_LAUNCHES_OPEN", (v) => String(v === "1" || v === "true"), String(config.launchesOpen)],
      ];
      for (const [field, name, read, have] of expected) {
        if (env[name] === undefined || env[name] === "") continue;
        const want = read(env[name]);
        line(want === have, `${field} is ${want}${want === have ? "" : ` (it is ${have})`}`);
      }
      const treasury = await conn.getAccountInfo(config.treasury, "confirmed");
      const rent0 = await conn.getMinimumBalanceForRentExemption(0);
      line(Boolean(treasury?.owner.equals(SYSTEM)) && treasury.lamports >= rent0,
        `the treasury is a plain wallet that holds its rent (${treasury ? sol(treasury.lamports) : 0} SOL)`);
    }
  }

  // 4. The multisig: who is in it, what it takes, and its vault 0 holding the upgrade authority and the config's admin.
  let vaultOk = false;
  if (ms) {
    const msInfo = await conn.getAccountInfo(ms, "confirmed");
    const m = msInfo?.owner.equals(SQUADS) ? parseMultisig(msInfo.data) : null;
    if (line(Boolean(m), `${ms.toBase58()} is a Squads v4 multisig`)) {
      const vault = vaultAddress(ms, 0);
      note(`vault 0: ${vault.toBase58()}`);
      for (const member of m.members) {
        const can = [[1, "propose"], [2, "vote"], [4, "execute"]].filter(([bit]) => member.mask & bit).map(([, w]) => w);
        note(`member ${member.key.toBase58()} (${can.join(", ") || "nothing"})`);
      }
      const voters = m.members.filter((x) => x.mask & 2).length;
      line(m.configAuthority.equals(PublicKey.default), `it is autonomous: only its members' votes change it${m.configAuthority.equals(PublicKey.default) ? "" : ` (config authority ${m.configAuthority.toBase58()})`}`);
      line(m.threshold >= 1 && m.threshold <= voters, `it takes ${m.threshold} of its ${voters} voting members`);
      if (env.EXPECT_MEMBERS) {
        const wanted = env.EXPECT_MEMBERS.split(",").map((s, i) => addressOf(s.trim(), `EXPECT_MEMBERS (number ${i + 1})`).toBase58()).sort();
        const have = m.members.map((x) => x.key.toBase58()).sort();
        const same = wanted.length === have.length && wanted.every((k, i) => k === have[i]);
        line(same, `its members are the ${wanted.length} of EXPECT_MEMBERS${same ? "" : `: it has ${have.length}, and ${wanted.filter((k) => !have.includes(k)).map((k) => short(new PublicKey(k))).join(", ") || "none"} of those missing`}`);
        line(m.members.every((x) => (x.mask & 7) === 7), "every member may propose, vote and execute");
      }
      if (env.EXPECT_THRESHOLD) line(m.threshold === Number(env.EXPECT_THRESHOLD), `the threshold is ${env.EXPECT_THRESHOLD}${m.threshold === Number(env.EXPECT_THRESHOLD) ? "" : ` (it is ${m.threshold})`}`);
      if (env.EXPECT_TIMELOCK) line(m.timeLock === Number(env.EXPECT_TIMELOCK), `the time lock is ${env.EXPECT_TIMELOCK} s${m.timeLock === Number(env.EXPECT_TIMELOCK) ? "" : ` (it is ${m.timeLock} s)`}`);
      const minLock = Number(env.MIN_TIMELOCK ?? (cluster === "mainnet" ? MIN_MAINNET_TIMELOCK : 0));
      if (cluster === "mainnet") line(m.threshold >= 2, "a change takes at least two members");
      line(m.timeLock >= minLock, `a change waits ${m.timeLock} s after its approval (the time lock; at least ${minLock} s passes)`);
      vaultOk = line(Boolean(pd.authority?.equals(vault)), `the upgrade authority is the vault (${short(pd.authority)})`);
      if (config && !config.bad) {
        line(config.admin.equals(vault), `the config's admin is the vault (${short(config.admin)})`);
        note(config.treasury.equals(vault) ? "the treasury is the vault too" : `the treasury is ${short(config.treasury)}, not the vault`);
      }
      if (buffer?.authority?.equals(vault)) line(true, "the buffer is the vault's: multisig.mjs propose-upgrade can use it");
    }
  }

  // 5. The site: on mainnet, both files name this program once set-program.mjs has run.
  const root = resolve(home(env.ROOT ?? join(HERE, "..", "..")));
  const netJs = readFileSync(join(root, "site", "net.js"), "utf8");
  const site = /mainnet:[\s\S]*?program: "([^"]*)"/.exec(netJs)?.[1];
  const { CLUSTERS } = await import(pathToFileURL(join(root, "server", "config.mjs")).href);
  if (cluster === "mainnet" && env.SITE !== "0") {
    line(site === program.toBase58(), `site/net.js names it for mainnet (${site || "empty"})`);
    line(CLUSTERS.mainnet.program === program.toBase58(), `server/config.mjs names it for mainnet (${CLUSTERS.mainnet.program || "empty"})`);
  } else if (cluster === "mainnet") note("site: left out (SITE=0)");
  else note(`the site's devnet program is ${CLUSTERS.devnet.program}${CLUSTERS.devnet.program === program.toBase58() ? " (this one)" : ", not this one"}`);

  // 6. The next step for a buffer, printed only when every check passed and the vault this multisig has is the
  // program's authority now, read from the chain. Never a hand-over alone: multisig.mjs propose-upgrade hands the buffer
  // to that vault in the same transaction as the proposal, so there is never a buffer handed over and not proposed,
  // which only a vote could close. Its KEYPAIR signs the hand-over, so it must be the buffer's holder.
  if (buffer?.authority && ms && !failed) {
    const vault = vaultAddress(ms, 0);
    if (!buffer.authority.equals(vault) && vaultOk) {
      console.log("\nnext: the proposal, which checks the buffer's bytes again and hands it to the vault in the same transaction:");
      console.log(`  CLUSTER=${cluster} PROGRAM=${program.toBase58()} MULTISIG=${ms.toBase58()} BUFFER=${bufferKey.toBase58()} BUILD=${env.BUILD} \\`);
      console.log(`    KEYPAIR=<the keypair of ${buffer.authority.toBase58()}> MEMBER_KEYPAIR=<a member> node programs/deploy/multisig.mjs propose-upgrade`);
    }
  }
  return finish();
}

function finish() {
  console.log(failed ? `\n${failed} check(s) failed` : "\nevery check passed");
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
