// The site's chain layer: everything that touches Solana. Pages call these and never build a
// transaction or read an account themselves.
//
// It reads the pool program's accounts directly (no indexer), quotes with the same integer
// math as the program (programs/pool/src/math.rs), and builds transactions for the visitor's
// wallet to sign. The cluster and program come from window.NET (net.js), or from setNet() in Node.

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";

/* ---------------- Network ---------------- */

let NET = typeof window !== "undefined" ? window.NET : null;
let connection = null;

/** For Node scripts and tests: { rpcUrl, program, cluster }. */
export function setNet(net) {
  NET = net;
  connection = null;
}

export function net() {
  return NET;
}

function conn() {
  if (!NET || !NET.rpcUrl) throw new Error("No cluster configured");
  if (!connection) connection = new Connection(NET.rpcUrl, "confirmed");
  return connection;
}

const program = () => new PublicKey(NET.program);

/* ---------------- Constants ---------------- */

export const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const LAMPORTS = 1_000_000_000n;
const DECIMALS = 6;
export const SUPPLY = 1_000_000_000n * 1_000_000n;
/** The launch numbers the program is used with today: open at 30 SOL, graduate at 420. */
export const LAUNCH = { virtualSol: 30n * LAMPORTS, graduationMcap: 420n * LAMPORTS, feeBps: 100 };
/**
 * What the program lets a launch choose (programs/pool/src/state.rs): 1 to 1,000 virtual SOL, a
 * graduation market cap from 2x to 100x the virtual SOL, a fee up to 3%. The lowest fee is the
 * config's (minFeeBps).
 */
export const BOUNDS = { minVirtualSol: LAMPORTS, maxVirtualSol: 1_000n * LAMPORTS, minMultiple: 2n, maxMultiple: 100n, maxFeeBps: 300 };
const POOL_LEN = 8 + 336;
const CONFIG_LEN = 8 + 110;

/* ---------------- Encoding ---------------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

const discCache = new Map();
/** Anchor's 8-byte tag: sha256("global:<name>") for instructions, "account:", "event:". */
async function disc(kind, name) {
  const key = `${kind}:${name}`;
  if (!discCache.has(key)) discCache.set(key, (await sha256(enc.encode(key))).slice(0, 8));
  return discCache.get(key);
}

function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function u64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; }
function str(s) { const bytes = enc.encode(s); return concat(u32(bytes.length), bytes); }
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

class Reader {
  constructor(bytes, at = 0) { this.b = bytes; this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.at = at; }
  key() { const k = new PublicKey(this.b.slice(this.at, this.at + 32)); this.at += 32; return k; }
  u8() { return this.b[this.at++]; }
  bool() { return this.u8() === 1; }
  u16() { const n = this.v.getUint16(this.at, true); this.at += 2; return n; }
  u32() { const n = this.v.getUint32(this.at, true); this.at += 4; return n; }
  u64() { const n = this.v.getBigUint64(this.at, true); this.at += 8; return n; }
  i64() { const n = this.v.getBigInt64(this.at, true); this.at += 8; return n; }
  str() { const len = this.u32(); const s = dec.decode(this.b.slice(this.at, this.at + len)); this.at += len; return s; }
  skip(n) { this.at += n; return this; }
}

const meta = (pubkey, { signer = false, writable = false } = {}) => ({ pubkey, isSigner: signer, isWritable: writable });

/* ---------------- Addresses ---------------- */

const pda = (seeds, owner) => PublicKey.findProgramAddressSync(seeds, owner)[0];
export const configAddress = () => pda([enc.encode("config")], program());
export const poolAddress = (mint) => pda([enc.encode("pool"), new PublicKey(mint).toBytes()], program());
export const ata = (owner, mint) =>
  pda([new PublicKey(owner).toBytes(), TOKEN_2022.toBytes(), new PublicKey(mint).toBytes()], ATA_PROGRAM);

/* ---------------- The program's math (same integers as math.rs) ---------------- */

const ceilDiv = (a, b) => (a + b - 1n) / b;
export const feeOf = (amount, bps) => ceilDiv(amount * BigInt(bps), 10_000n);

export function isqrtCeil(n) {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x * x === n ? x : x + 1n;
}

export const graduationSol = (virtualSol, mcap) => isqrtCeil(virtualSol * mcap) - virtualSol;

function leg(sol, tokens, solIn) {
  const left = ceilDiv(sol * tokens, sol + solIn);
  return [tokens - left, left];
}

/** Reserves as the math reads them: { virtualSol, realSol, tokens, graduationSol, graduated }. */
export function quoteBuy(r, solIn, feeBps) {
  solIn = BigInt(solIn);
  const fee = feeOf(solIn, feeBps);
  let rest = solIn - fee;
  const after = { ...r };
  let out = 0n;
  let burned = 0n;
  if (!after.graduated) {
    const room = after.graduationSol - after.realSol;
    const onCurve = rest < room ? rest : room;
    if (onCurve > 0n) {
      const [o, left] = leg(after.virtualSol + after.realSol, after.tokens, onCurve);
      out += o; after.tokens = left; after.realSol += onCurve; rest -= onCurve;
    }
    if (after.realSol === after.graduationSol) {
      burned = after.tokens * after.virtualSol / (after.virtualSol + after.realSol);
      after.tokens -= burned;
      after.graduated = true;
    }
  }
  if (after.graduated && rest > 0n) {
    const [o, left] = leg(after.realSol, after.tokens, rest);
    out += o; after.tokens = left; after.realSol += rest;
  }
  return { fee, tokensOut: out, burned, graduates: burned > 0n, after };
}

export function quoteSell(r, tokensIn, feeBps) {
  tokensIn = BigInt(tokensIn);
  const offset = r.graduated ? 0n : r.virtualSol;
  const x = offset + r.realSol;
  const newX = ceilDiv(x * r.tokens, r.tokens + tokensIn);
  const gross = x - newX;
  const fee = feeOf(gross, feeBps);
  return { fee, solOut: gross - fee, after: { ...r, realSol: newX - offset, tokens: r.tokens + tokensIn } };
}

/** Price in SOL per whole token, and market cap in SOL on the supply still in existence. */
export function priceOf(r, burned = 0n) {
  const sol = r.graduated ? r.realSol : r.virtualSol + r.realSol;
  const price = (Number(sol) / 1e9) / (Number(r.tokens) / 1e6);
  return { price, marketCap: price * (Number(SUPPLY - burned) / 1e6) };
}

/* ---------------- Reading ---------------- */

function parsePool(address, data) {
  const r = new Reader(data, 8);
  const p = {
    address, mint: r.key(), creator: r.key(), treasury: r.key(), vault: r.key(), hookProgram: r.key(),
    virtualSol: r.u64(), realSol: r.u64(), tokens: r.u64(), graduationSol: r.u64(), graduationMcap: r.u64(),
    burned: r.u64(), creatorFees: r.u64(), treasuryFees: r.u64(), creatorFeesPaid: r.u64(), treasuryFeesPaid: r.u64(),
    volume: r.u64(), openedAt: Number(r.i64()), graduatedAt: Number(r.i64()), feeBps: r.u16(), treasuryShareBps: r.u16(),
  };
  p.graduated = r.u8() === 1;
  const { price, marketCap } = priceOf(p, p.burned);
  p.price = price;
  p.marketCap = marketCap;
  // Share of the way to graduation, by real SOL in.
  p.progress = p.graduated ? 1 : Number(p.realSol) / Number(p.graduationSol);
  return p;
}

/** Name, symbol and link from the mint's own metadata extension (type 19). */
function parseMintMetadata(data) {
  let at = 166;
  while (at + 4 <= data.length) {
    const view = new DataView(data.buffer, data.byteOffset + at, 4);
    const type = view.getUint16(0, true);
    const len = view.getUint16(2, true);
    if (type === 19) {
      const r = new Reader(data, at + 4).skip(64);
      return { name: r.str(), symbol: r.str(), uri: r.str() };
    }
    if (type === 0) break;
    at += 4 + len;
  }
  return { name: "", symbol: "", uri: "" };
}

async function withMetadata(pools) {
  const infos = await conn().getMultipleAccountsInfo(pools.map((p) => p.mint));
  pools.forEach((p, i) => Object.assign(p, infos[i] ? parseMintMetadata(infos[i].data) : { name: "", symbol: "", uri: "" }));
  return pools;
}

/** Every pool the program holds, newest first, with each coin's name and symbol. */
export async function listPools() {
  const tag = await disc("account", "Pool");
  const accounts = await conn().getProgramAccounts(program(), {
    filters: [{ dataSize: POOL_LEN }, { memcmp: { offset: 0, bytes: base58(tag) } }],
  });
  const pools = accounts.map((a) => parsePool(a.pubkey, a.account.data));
  pools.sort((a, b) => b.openedAt - a.openedAt);
  return withMetadata(pools);
}

export async function readPool(mint) {
  const address = poolAddress(mint);
  const info = await conn().getAccountInfo(address);
  if (!info) return null;
  const [pool] = await withMetadata([parsePool(address, info.data)]);
  return pool;
}

export async function readConfig() {
  const info = await conn().getAccountInfo(configAddress());
  if (!info || info.data.length < CONFIG_LEN) return null;
  const r = new Reader(info.data, 8);
  return {
    admin: r.key(), launcher: r.key(), treasury: r.key(), launchFee: r.u64(),
    minFeeBps: r.u16(), treasuryShareBps: r.u16(), launchesOpen: r.bool(),
  };
}

/** What a wallet holds: SOL and, when a mint is given, that coin. */
export async function readWallet(owner, mint) {
  const c = conn();
  const sol = await c.getBalance(new PublicKey(owner));
  let tokens = 0n;
  if (mint) {
    const info = await c.getAccountInfo(ata(owner, mint));
    if (info) tokens = new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(64, true);
  }
  return { sol: BigInt(sol), tokens };
}

/* ---------------- Events: the trades behind a chart ---------------- */

const EVENTS = ["TradeEvent", "Launched", "Graduated", "FeesClaimed", "CreatorChanged"];

async function decodeEvent(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  for (const name of EVENTS) {
    const tag = await disc("event", name);
    if (tag.every((x, i) => bytes[i] === x)) {
      const r = new Reader(bytes, 8);
      if (name === "TradeEvent") {
        return {
          kind: "trade", mint: r.key(), trader: r.key(), recipient: r.key(), buy: r.bool(), sol: r.u64(),
          tokens: r.u64(), fee: r.u64(), realSol: r.u64(), tokenReserve: r.u64(), graduated: r.bool(),
        };
      }
      if (name === "Launched") {
        return { kind: "launch", mint: r.key(), creator: r.key(), hookProgram: r.key(), virtualSol: r.u64(), graduationSol: r.u64(), feeBps: r.u16() };
      }
      if (name === "Graduated") return { kind: "graduation", mint: r.key(), realSol: r.u64(), tokenReserve: r.u64(), burned: r.u64() };
      if (name === "FeesClaimed") return { kind: "claim", mint: r.key(), to: r.key(), amount: r.u64(), creator: r.bool() };
      return { kind: "creator", mint: r.key(), from: r.key(), to: r.key(), settled: r.u64() };
    }
  }
  return null;
}

/**
 * The pool's recent history, oldest first: each event with its time and signature. Read from
 * the program's own logs, so it needs nothing but an RPC.
 */
export async function history(mint, { limit = 100 } = {}) {
  const c = conn();
  const sigs = await c.getSignaturesForAddress(poolAddress(mint), { limit });
  const ok = sigs.filter((s) => !s.err);
  const txs = [];
  for (let i = 0; i < ok.length; i += 25) {
    const batch = await c.getTransactions(ok.slice(i, i + 25).map((s) => s.signature), { maxSupportedTransactionVersion: 0 });
    txs.push(...batch);
  }
  const prefix = `Program data: `;
  const events = [];
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    if (!tx || !tx.meta) continue;
    for (const line of tx.meta.logMessages ?? []) {
      if (!line.startsWith(prefix)) continue;
      const event = await decodeEvent(line.slice(prefix.length));
      if (event) events.push({ ...event, time: tx.blockTime, signature: ok[i].signature });
    }
  }
  return events.reverse();
}

/** Price points for a chart, from the trades: { time, price } with price in SOL per token. */
export function pricePoints(events, pool) {
  return events.filter((e) => e.kind === "trade").map((e) => {
    const r = { virtualSol: pool.virtualSol, realSol: e.realSol, tokens: e.tokenReserve, graduated: e.graduated };
    return { time: e.time, price: priceOf(r).price, buy: e.buy, sol: e.sol, tokens: e.tokens, trader: e.trader, signature: e.signature };
  });
}

/* ---------------- Building transactions ---------------- */

async function ix(name, keys, ...data) {
  return new TransactionInstruction({ programId: program(), keys, data: Buffer.from(concat(await disc("global", name), ...data)) });
}

function openAccount(payer, owner, mint) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      meta(payer, { signer: true, writable: true }), meta(ata(owner, mint), { writable: true }), meta(owner), meta(mint),
      meta(SystemProgram.programId), meta(TOKEN_2022),
    ],
    data: Buffer.from([1]),
  });
}

function swapKeys(pool, trader) {
  return [
    meta(trader, { signer: true, writable: true }), meta(pool.address, { writable: true }),
    meta(pool.mint, { writable: true }), meta(pool.vault, { writable: true }),
    meta(ata(trader, pool.mint), { writable: true }), meta(TOKEN_2022), meta(SystemProgram.programId),
  ];
}

const minus = (amount, bps) => amount * (10_000n - BigInt(bps)) / 10_000n;
const toLamports = (sol) => BigInt(Math.round(Number(sol) * 1e9));
const toUnits = (tokens) => BigInt(Math.round(Number(tokens) * 1e6));

/** A buy of `sol` SOL (fee included) for `owner`. Returns the transaction and its quote. */
export async function buildBuy({ pool, owner, sol, slippageBps = 100 }) {
  owner = new PublicKey(owner);
  const lamports = toLamports(sol);
  const quote = quoteBuy(pool, lamports, pool.feeBps);
  const minOut = minus(quote.tokensOut, slippageBps);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
    openAccount(owner, owner, pool.mint),
    await ix("buy", swapKeys(pool, owner), u64(lamports), u64(minOut)),
  );
  return { tx, signers: [], quote: { ...quote, minOut } };
}

export async function buildSell({ pool, owner, tokens, slippageBps = 100 }) {
  owner = new PublicKey(owner);
  const units = typeof tokens === "bigint" ? tokens : toUnits(tokens);
  const quote = quoteSell(pool, units, pool.feeBps);
  const minOut = minus(quote.solOut, slippageBps);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
    await ix("sell", swapKeys(pool, owner), u64(units), u64(minOut)),
  );
  return { tx, signers: [], quote: { ...quote, minOut } };
}

/** Lamports as SOL in words: whole SOL with thousands commas, up to 9 decimals, no trailing zeros. */
function solWords(lamports) {
  const whole = (lamports / LAMPORTS).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (lamports % LAMPORTS).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
const pct = (bps) => String(bps / 100);

/**
 * Why the program would refuse these launch settings: one plain sentence per broken bound, as
 * { field, message } (field: virtualSol, graduationMcap or feeBps); empty when they are fine.
 * Lamports as BigInt (a safe whole Number works too), the fee in basis points, and the config's
 * lowest fee (Config.minFeeBps; 0 checks the program's own bounds alone). The graduation market
 * cap is checked against the virtual SOL once that is within its bounds, as the program does.
 */
export function launchProblems({ virtualSol = LAUNCH.virtualSol, graduationMcap = LAUNCH.graduationMcap, feeBps = LAUNCH.feeBps } = {}, minFeeBps = 0) {
  const lam = (x) => (typeof x === "bigint" ? x : Number.isSafeInteger(x) ? BigInt(x) : null);
  const v = lam(virtualSol), m = lam(graduationMcap), fee = feeBps, out = [];
  const add = (field, message) => out.push({ field, message });
  let vOk = false;
  if (v === null) add("virtualSol", "The virtual SOL must be a whole number of lamports");
  else if (v < BOUNDS.minVirtualSol) add("virtualSol", `The virtual SOL must be at least ${solWords(BOUNDS.minVirtualSol)} SOL`);
  else if (v > BOUNDS.maxVirtualSol) add("virtualSol", `The virtual SOL can be at most ${solWords(BOUNDS.maxVirtualSol)} SOL`);
  else vOk = true;
  if (m === null) add("graduationMcap", "The graduation market cap must be a whole number of lamports");
  else if (vOk && m < v * BOUNDS.minMultiple) {
    add("graduationMcap", `The graduation market cap must be at least ${BOUNDS.minMultiple}× the virtual SOL (${solWords(v * BOUNDS.minMultiple)} SOL)`);
  } else if (vOk && m > v * BOUNDS.maxMultiple) {
    add("graduationMcap", `The graduation market cap can be at most ${BOUNDS.maxMultiple}× the virtual SOL (${solWords(v * BOUNDS.maxMultiple)} SOL)`);
  }
  if (!Number.isInteger(fee) || fee < 0) add("feeBps", "The fee must be a whole number of basis points");
  else if (fee < minFeeBps) add("feeBps", `The fee must be at least ${pct(minFeeBps)}%, the lowest the config allows`);
  else if (fee > BOUNDS.maxFeeBps) add("feeBps", `The fee can be at most ${pct(BOUNDS.maxFeeBps)}%`);
  return out;
}

function settingsError(problems) {
  return Object.assign(new Error(problems.map((p) => p.message).join(". ")), { problems });
}

/**
 * A launch, and optionally the creator's first buy in the same transaction. The settings are
 * optional: virtualSol and graduationMcap in lamports (BigInt), feeBps in basis points, each
 * LAUNCH's when left out. Settings outside the program's bounds (launchProblems) throw before
 * anything is built, with one sentence per broken bound in the message and the list in
 * error.problems. The new mint's key is generated here and signs too.
 */
export async function buildLaunch({
  creator, name, symbol, uri = "", firstBuySol = 0, maxLaunchFee, mint = Keypair.generate(),
  virtualSol = LAUNCH.virtualSol, graduationMcap = LAUNCH.graduationMcap, feeBps = LAUNCH.feeBps,
}) {
  creator = new PublicKey(creator);
  const settings = { virtualSol, graduationMcap, feeBps };
  let problems = launchProblems(settings);
  if (problems.length) throw settingsError(problems);
  const config = await readConfig();
  if (!config) throw new Error("The program has no config yet");
  problems = launchProblems(settings, config.minFeeBps);
  if (problems.length) throw settingsError(problems);
  virtualSol = BigInt(virtualSol);
  graduationMcap = BigInt(graduationMcap);
  const pool = poolAddress(mint.publicKey);
  const vault = ata(pool, mint.publicKey);
  const gradSol = graduationSol(virtualSol, graduationMcap);
  const args = concat(
    str(name), str(symbol), str(uri), u64(virtualSol), u64(graduationMcap), u16(feeBps),
    u64(maxLaunchFee ?? config.launchFee),
  );
  const launch = await ix("launch", [
    meta(creator, { signer: true, writable: true }), meta(mint.publicKey, { signer: true, writable: true }),
    meta(configAddress()), meta(pool, { writable: true }), meta(vault, { writable: true }),
    meta(config.treasury, { writable: true }), meta(TOKEN_2022), meta(ATA_PROGRAM), meta(SystemProgram.programId),
  ], args);
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), launch);
  let quote = null;
  if (Number(firstBuySol) > 0) {
    const opening = {
      address: pool, mint: mint.publicKey, vault, feeBps, virtualSol, realSol: 0n,
      tokens: SUPPLY, graduationSol: gradSol, graduated: false,
    };
    const buy = await buildBuy({ pool: opening, owner: creator, sol: firstBuySol });
    tx.add(...buy.tx.instructions.slice(1));
    quote = buy.quote;
  }
  return {
    tx, signers: [mint], mint: mint.publicKey, pool, quote,
    settings: { virtualSol, graduationMcap, feeBps, graduationSol: gradSol },
    canLaunch: config.launchesOpen || config.admin.equals(creator) || config.launcher.equals(creator),
  };
}

/* ---------------- Simulating and sending ---------------- */

async function prepare(built, feePayer) {
  const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash();
  built.tx.feePayer = new PublicKey(feePayer);
  built.tx.recentBlockhash = blockhash;
  if (built.signers.length) built.tx.partialSign(...built.signers);
  return lastValidBlockHeight;
}

/** Runs a built transaction without signing for the wallet: { ok, logs, units, error }. */
export async function simulate(built, feePayer) {
  await prepare(built, feePayer);
  // Signatures are not checked in a simulation, so the wallet's missing one does not matter.
  const sim = await conn().simulateTransaction(built.tx);
  return { ok: !sim.value.err, logs: sim.value.logs ?? [], units: sim.value.unitsConsumed, error: sim.value.err && explain(sim.value) };
}

/** Has the wallet sign, sends, and waits for confirmation. Returns the signature. */
export async function send(built, wallet) {
  const height = await prepare(built, wallet.publicKey);
  const signed = await wallet.signTransaction(built.tx);
  const signature = await conn().sendRawTransaction(signed.serialize(), { skipPreflight: false });
  const result = await conn().confirmTransaction({ signature, blockhash: built.tx.recentBlockhash, lastValidBlockHeight: height }, "confirmed");
  if (result.value.err) throw Object.assign(new Error("The transaction failed on chain"), { signature });
  return signature;
}

/* ---------------- Errors in plain words ---------------- */

const POOL_ERRORS = [
  "Only the program's upgrade authority can create the config",
  "Launches are open to the team only for now",
  "A number is outside what the program allows",
  "The launch fee changed; try again",
  "Name, symbol or link is too long",
  "That coin address is taken; try again",
  "The new coin did not come out as expected",
  "An account is not the one this pool expects",
  "The price moved past your limit",
  "Too small to trade",
  "Arithmetic overflow",
  "Tokens can't be bought into the pool's own account",
  "Nothing to claim",
  "The pool would hold less SOL than it owes",
  "That token account can't receive this coin; use a fresh wallet account",
  "The treasury must be a funded wallet",
];

export function explain(errorOrSim) {
  const text = JSON.stringify(errorOrSim?.err ?? errorOrSim ?? "");
  const custom = text.match(/"Custom":(\d+)/);
  if (custom) {
    const code = Number(custom[1]);
    if (code >= 7000 && code < 7000 + POOL_ERRORS.length) return POOL_ERRORS[code - 7000];
    return `Program error ${code}`;
  }
  if (text.includes("InsufficientFunds") || text.includes("insufficient lamports")) return "Not enough SOL";
  return "The transaction would fail";
}

/* ---------------- Wallets ---------------- */

/** Injected wallets the page can talk to, by name. */
export function wallets() {
  const w = typeof window !== "undefined" ? window : {};
  const found = [];
  if (w.phantom?.solana?.isPhantom) found.push({ name: "Phantom", provider: w.phantom.solana });
  if (w.solflare?.isSolflare) found.push({ name: "Solflare", provider: w.solflare });
  if (w.backpack?.solana) found.push({ name: "Backpack", provider: w.backpack.solana });
  if (!found.length && w.solana) found.push({ name: "Wallet", provider: w.solana });
  return found;
}

/** Connects to the first wallet found, or the named one. Returns { name, publicKey, signTransaction, disconnect }. */
export async function connect(name) {
  const list = wallets();
  const pick = (name && list.find((w) => w.name === name)) || list[0];
  if (!pick) throw new Error("No Solana wallet found in this browser");
  const res = await pick.provider.connect();
  const publicKey = new PublicKey((res?.publicKey ?? pick.provider.publicKey).toString());
  return {
    name: pick.name,
    publicKey,
    signTransaction: (tx) => pick.provider.signTransaction(tx),
    disconnect: () => pick.provider.disconnect?.(),
  };
}

/* ---------------- Small helpers for pages ---------------- */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

export const short = (key) => { const s = key.toString(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
export const sol = (lamports) => Number(lamports) / 1e9;
export const tokens = (units) => Number(units) / 1e6;
export { PublicKey, Keypair };
