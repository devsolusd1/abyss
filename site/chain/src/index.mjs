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

/** For Node scripts and tests: { rpcUrl, program, cluster, historyPace?, historyWindowMs? } (see the history pace below). */
export function setNet(net) {
  NET = net;
  connection = null;
  pace = null; nextAt = 0; coolUntil = 0;    // another node, its own limit
}

export function net() {
  return NET;
}

function conn() {
  if (!NET || !NET.rpcUrl) throw new Error("No cluster configured");
  if (!connection) connection = new Connection(NET.rpcUrl, { commitment: "confirmed", fetch: netFetch });
  return connection;
}

// A page calls the site's own server (NET.rpcUrl, /api/rpc), which holds the node's address and key. When that server
// is missing or failing (404, 5xx, no answer) and the cluster has a public node (NET.fallbackRpc: devnet), the call
// goes there instead, and so do the calls of the next minute. A 403 or 429 from the site's server is its answer.
let rpcDownUntil = 0;
async function netFetch(url, init) {
  const fallback = NET?.fallbackRpc;
  if (!fallback || String(url) !== NET.rpcUrl) return fetch(url, init);
  if (Date.now() < rpcDownUntil) return fetch(fallback, init);
  try {
    const res = await fetch(url, init);
    if (![404, 500, 502, 503, 504].includes(res.status)) return res;
  } catch (err) {
    if (init?.signal?.aborted) throw err;
  }
  rpcDownUntil = Date.now() + 60_000;
  return fetch(fallback, init);
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
  const infos = [];
  for (let i = 0; i < pools.length; i += 100) infos.push(...await conn().getMultipleAccountsInfo(pools.slice(i, i + 100).map((p) => p.mint)));
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

/* ---------------- History, at the public node's pace ---------------- */

// The public devnet node lets one address make about ten getTransaction calls in any ten seconds (each call in a
// JSON-RPC batch counts), and once past that answers 429 for several seconds more. Measured on 2026-10-27: one call
// every 1.2 s passed 50 of 50; one a second, or a burst of 8, ran into the pause. So transactions are fetched one call at
// a time, newest first, `pace` calls per window (NET.historyPace, else 8, per NET.historyWindowMs, else 10.5 s: one
// every 1.3 s), and a 429 pauses every read for 8/7 of a window (12 s) and lowers the pace for a while. A transaction
// never changes once it is in, so each is fetched once: its event lines are kept in memory and, in a browser, in
// localStorage for its pool, so a page read again needs only the new ones. Times are on a clock that only goes forward.
const PREFIX = "Program data: ";
let pace = null;                       // calls per window, lowered by 429s and raised back after calm stretches
let calm = 0;                          // calls answered since the last 429
let nextAt = 0;                        // the next call goes out no sooner than this
let coolUntil = 0;                     // after a 429, no call before this
const GAP = 8;                         // new transactions above kept ones, up to this many, are read from the kept ones up
const txCache = new Map();             // signature -> { time, data: [event lines, base64] }
const txFetching = new Map();          // signature -> the call fetching it
const decoded = new Map();             // signature -> its events, decoded once

const clock = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
const paceSet = () => Math.max(1, Number(NET?.historyPace) || 8);
const paceNow = () => pace ?? (pace = paceSet());
const windowMs = () => Math.max(1, Number(NET?.historyWindowMs) || 10_500);
function sleep(ms, signal) {
  return new Promise((ok) => {
    const done = () => { clearTimeout(t); signal?.removeEventListener("abort", done); ok(); };
    const t = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Waits for this page's next call and takes it. False if that would be after `until`, or `signal` aborted. */
async function turn(until, signal) {
  for (;;) {
    if (signal?.aborted) return false;
    const now = clock(), at = Math.max(nextAt, coolUntil, now);
    if (at > until) return false;                        // no call starts after the budget, however slow the replies were
    if (at <= now) { nextAt = now + windowMs() / paceNow(); return true; }
    await sleep(at - now, signal);
  }
}

/** One JSON-RPC call, straight to the node (no retries: the pace is ours). Resolves to its reply, { result } or { error }. */
async function rpc(method, params, signal) {
  const ctl = new AbortController(), stop = () => ctl.abort();
  const timer = setTimeout(stop, 15_000);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const res = await netFetch(NET.rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (res.status === 429) return { error: { code: 429 } };
    if (!body || typeof body !== "object" || !("result" in body || "error" in body)) throw new Error(`The node answered ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/**
 * Fetches the first transaction in `want` (in the order to read them) that no one has or is fetching, when the pace allows it by
 * `until`. Returns false when it sent nothing (out of time, aborted), "limited" when the node answered 429, else true.
 * A transaction the node did not serve goes into `missed`; a 429 pauses all reads and lowers the pace.
 */
async function fetchOne(want, until, signal, missed) {
  if (!(await turn(until, signal))) return false;
  // another read may have taken some of them while this one waited
  const s = want.find((x) => !txCache.has(x.signature) && !txFetching.has(x.signature));
  if (!s) return true;
  const job = rpc("getTransaction", [s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }], signal);
  txFetching.set(s.signature, job);
  let reply;
  try { reply = await job; }
  catch (err) { if (signal?.aborted) return false; throw err; }
  finally { if (txFetching.get(s.signature) === job) txFetching.delete(s.signature); }
  if (reply.error?.code === 429) {
    coolUntil = clock() + windowMs() * 8 / 7;
    pace = Math.max(Math.min(3, paceNow()), paceNow() - 2);   // down by two, to three at the least, never up
    calm = 0;
    return "limited";
  }
  // two windows' worth of calls without a 429: one more call per window, back up to the set pace
  if (paceNow() < paceSet() && ++calm >= 2 * paceNow()) { pace++; calm = 0; }
  if (reply.error) throw new Error(String(reply.error.message ?? `The node refused (${reply.error.code})`));
  const tx = reply.result;
  if (!tx || !tx.meta) { missed.add(s.signature); return true; }   // not served (yet): the next read asks again
  const data = ownLines(tx.meta.logMessages, NET.program);
  txCache.set(s.signature, { time: tx.blockTime ?? s.blockTime ?? null, data });
  return true;
}

/**
 * The "Program data:" lines that `program` itself logged, read off the call stack the logs describe ("Program X
 * invoke [n]" in, "Program X success" or "failed" out). Another program can name a pool in its own transaction and log
 * lines that look like the pool's events; those are not kept. (server/history.mjs does the same.)
 */
function ownLines(logs, program) {
  const ID = "[1-9A-HJ-NP-Za-km-z]{32,44}", inv = new RegExp(`^Program (${ID}) invoke \\[\\d+\\]$`), out = new RegExp(`^Program (${ID}) (success|failed)`);
  const stack = [], lines = [];
  for (const l of Array.isArray(logs) ? logs : []) {
    if (typeof l !== "string") continue;
    if (l.startsWith("Log truncated")) break;
    let m = inv.exec(l);
    if (m) { stack.push(m[1]); continue; }
    m = out.exec(l);
    if (m) { if (stack[stack.length - 1] === m[1]) stack.pop(); continue; }
    if (l.startsWith(PREFIX) && stack[stack.length - 1] === program) lines.push(l.slice(PREFIX.length));
  }
  return lines;
}

/* the kept transactions, per pool in localStorage: { signature: { t, d } }, for the 30 pools read last (version 2:
   only the pool program's own lines; version 1 kept every program's) */
const STORE = "nox.tx.2";
const storeKey = (pool) => `${STORE}.${NET.cluster ?? ""}.${NET.program}.${pool}`;
const loaded = new Set();
function storage() { try { return typeof window !== "undefined" && window.localStorage ? window.localStorage : null; } catch { return null; } }
let swept = false;
function loadStore(pool) {
  if (loaded.has(pool)) return;
  loaded.add(pool);
  if (!swept) {                                          // what version 1 kept is not trusted any more: it goes, once
    swept = true;
    try { const ls = storage(); if (ls) for (const k of Object.keys(ls)) if (k.startsWith("nox.tx.1.")) ls.removeItem(k); } catch { /* blocked */ }
  }
  try {
    const raw = storage()?.getItem(storeKey(pool));
    if (!raw) return;
    for (const [sig, v] of Object.entries(JSON.parse(raw))) {
      if (!txCache.has(sig) && v && Array.isArray(v.d) && v.d.every((x) => typeof x === "string")) {
        txCache.set(sig, { time: typeof v.t === "number" ? v.t : null, data: v.d });
      }
    }
  } catch { /* a broken entry is read again from the chain */ }
}
function saveStore(pool, ok) {
  const ls = storage();
  if (!ls) return;
  try {
    const out = {};
    for (const s of ok) { const v = txCache.get(s.signature); if (v) out[s.signature] = { t: v.time, d: v.data }; }
    const key = storeKey(pool), list = `${STORE}.pools`;
    let pools = [];
    try { pools = JSON.parse(ls.getItem(list) || "[]").filter((k) => typeof k === "string" && k !== key); } catch { /* start again */ }
    pools.push(key);
    while (pools.length > 30) ls.removeItem(pools.shift());
    ls.setItem(key, JSON.stringify(out));
    ls.setItem(list, JSON.stringify(pools));
  } catch { /* full or blocked: memory still has them */ }
}

/** A kept transaction's events, in the order its logs have them. */
async function eventsOf(sig) {
  if (!decoded.has(sig)) {
    const list = [];
    for (const b64 of txCache.get(sig).data) {
      try { const e = await decodeEvent(b64); if (e) list.push(e); } catch { /* not one of ours */ }
    }
    decoded.set(sig, list);
  }
  return decoded.get(sig);
}

/** Settles with `p`, or rejects after `ms` or when `signal` aborts. */
function bounded(p, ms, signal) {
  return new Promise((ok, no) => {
    const stop = (why) => { clearTimeout(t); signal?.removeEventListener("abort", aborted); no(new Error(why)); };
    const aborted = () => stop("Stopped");
    const t = setTimeout(() => stop("The node did not answer in time"), ms);
    p.catch(() => {});                                   // a late failure after the timeout or abort is nobody's
    if (signal?.aborted) return aborted();
    signal?.addEventListener("abort", aborted, { once: true });
    p.then((v) => { clearTimeout(t); signal?.removeEventListener("abort", aborted); ok(v); }, (e) => { clearTimeout(t); signal?.removeEventListener("abort", aborted); no(e); });
  });
}

/* the site's history server (/api/history): the pool's latest transactions with their event lines, in one call */
let historyDownUntil = 0;
async function fromServer(pool, limit, signal, at) {
  const mark = at ? `&at=${encodeURIComponent(String(at).slice(0, 120))}` : "";
  const res = await bounded(fetch(`${NET.historyUrl}&pool=${encodeURIComponent(pool)}&limit=${limit}${mark}`, { signal, cache: "no-store" }), 15_000, signal);
  if (!res.ok) throw new Error(`The history server answered ${res.status}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.signatures) || !body.txs || typeof body.txs !== "object") throw new Error("Not a history");
  const signatures = body.signatures
    .filter((s) => s && typeof s.signature === "string")
    .map((s) => ({ signature: s.signature, blockTime: typeof s.blockTime === "number" ? s.blockTime : null, err: s.err ? true : null }));
  let added = 0;
  for (const s of signatures) {
    const v = body.txs[s.signature];
    if (!txCache.has(s.signature) && v && Array.isArray(v.d) && v.d.every((x) => typeof x === "string")) {
      txCache.set(s.signature, { time: typeof v.t === "number" ? v.t : s.blockTime, data: v.d });
      added++;
    }
  }
  return { signatures, added };
}

/**
 * The pool's recent history, read from the program's own logs (it needs nothing but an RPC), at the pace above.
 * With the site's server (NET.historyUrl) it is one call that brings the signatures and every transaction the server
 * has; without it, or when it fails (then for a minute), the signatures and transactions are read here. `at` marks the
 * pool's state as the page last read it (its volume and paid fees, say): the server reads the list again for a new mark.
 * Looks back over the last `limit` transactions on the pool and fetches the ones not kept yet, until all are in,
 * `budgetMs` has passed, or `signal` aborts; `onProgress(result)` hears whenever what it would return changes.
 * The order: a few new transactions above kept ones (up to GAP) from the kept ones up, so the run grows without a
 * break; otherwise newest first, so a page read cold shows the latest trades first.
 *
 * Returns { events, have, total, pending, added, whole, complete, error }:
 *   events    oldest first, each with its time, signature and place in its transaction (n): the unbroken run of
 *             kept transactions from the newest one, or, under a few new ones not read yet, from the first kept one
 *             below them (so a partial read is one stretch, never one with holes)
 *   have      transactions in that run, of `total` that did not fail
 *   pending   new transactions above the run not read yet
 *   added     transactions this read put in (by any reader), a measure of its progress
 *   whole     the look back reached the pool's first transaction (fewer than `limit` on it)
 *   complete  have === total
 *   error     why it stopped early, when the node failed (it is then partial)
 *   waiting   the site's server (NET.historyUrl) gave what it has and is still fetching the rest: ask again shortly
 * Throws when the list of transactions itself cannot be read (in 20 s), or `signal` aborts before it is.
 */
export async function readHistory(mint, { limit = 100, budgetMs = Infinity, signal, onProgress, at } = {}) {
  if (signal?.aborted) throw new Error("Stopped");
  const mintKey = new PublicKey(mint).toBase58(), pool = poolAddress(mint).toBase58();
  loadStore(pool);
  let sigs = null, served = null;
  if (NET.historyUrl && Date.now() >= historyDownUntil) {
    try { served = await fromServer(pool, limit, signal, at); sigs = served.signatures; }
    catch (err) { if (signal?.aborted) throw err; historyDownUntil = Date.now() + 60_000; }
  }
  if (!sigs) sigs = await bounded(conn().getSignaturesForAddress(new PublicKey(pool), { limit }), 20_000, signal);
  const ok = sigs.filter((s) => !s.err);
  const whole = sigs.length < limit;
  const until = clock() + budgetMs;
  const missed = new Set();
  const kept = () => ok.reduce((n, s) => n + (txCache.has(s.signature) ? 1 : 0), 0), keptBefore = kept();
  let error = null, shown = null, refused = 0, fetched = 0, from = -1;

  // where the run starts: the newest transaction, or, under up to GAP new ones, the kept stretch starting near the top
  // that reaches furthest back. Once this read has a run, its start only moves up, one kept transaction at a time, so
  // what it hands over never shrinks
  function pick() {
    let best = -1, end = -1;
    for (let i = 0; i <= Math.min(GAP, ok.length - 1); i++) {
      if (!txCache.has(ok[i].signature) || (i > 0 && txCache.has(ok[i - 1].signature))) continue;
      let j = i;
      while (j + 1 < ok.length && txCache.has(ok[j + 1].signature)) j++;
      if (j > end) { best = i; end = j; }
    }
    return best;                                         // -1: nothing kept near the top, so newest first
  }
  function start() {
    if (from < 0 || !txCache.has(ok[from].signature)) {
      from = pick();
      if (from < 0) return 0;
    }
    while (from > 0 && txCache.has(ok[from - 1].signature)) from--;
    return from;
  }
  // new ones above the run from the run up, then the rest newest first
  function order() {
    const at = start();
    const list = at > 0 ? [...ok.slice(0, at).reverse(), ...ok.slice(at)] : ok;
    return list.filter((s) => !txCache.has(s.signature) && !missed.has(s.signature));
  }
  async function result() {
    const at = start(), txs = [];
    for (let i = at; i < ok.length && txCache.has(ok[i].signature); i++) txs.push({ s: ok[i], list: await eventsOf(ok[i].signature) });
    const events = [];
    for (let i = txs.length - 1; i >= 0; i--) {
      const { s, list } = txs[i], time = s.blockTime ?? txCache.get(s.signature).time;
      list.forEach((e, n) => { if (String(e.mint) === mintKey) events.push({ ...e, time, signature: s.signature, n }); });
    }
    const complete = txs.length === ok.length;
    return { events, have: txs.length, total: ok.length, pending: at, added: (served ? served.added : 0) + kept() - keptBefore, whole, complete, error,
      waiting: Boolean(served) && !complete };       // the site's server is still fetching the rest
  }

  if (onProgress) {
    // what is kept already shows at once, before the first call
    const r = await result();
    if (r.have) { shown = `${r.pending}:${r.have}`; try { onProgress(r); } catch { /* the page's own problem */ } }
  }
  for (;;) {
    if (served || signal?.aborted) break;              // the site's server fetches them: they are asked of it again later
    const want = order();
    if (!want.length) break;
    const free = want.filter((s) => !txFetching.has(s.signature));
    if (!free.length) {
      // all of them are being fetched by another read: wait for one of those calls
      await Promise.race(want.map((s) => txFetching.get(s.signature)).filter(Boolean).map((p) => p.catch(() => null)));
      continue;
    }
    let went;
    try { went = await fetchOne(free, until, signal, missed); }
    catch (err) { error = String(err?.message ?? err); break; }
    if (!went) break;
    // a node that keeps refusing after the pauses is out of reach for now
    if (went === "limited") { if (++refused >= 5) { error = "The node kept answering 429 (too many requests)"; break; } continue; }
    refused = 0;
    if (++fetched % 6 === 0) saveStore(pool, ok);   // a page closed partway keeps what it read
    if (onProgress) {
      const r = await result(), key = `${r.pending}:${r.have}`;
      if (key !== shown) { shown = key; try { onProgress(r); } catch { /* the page's own problem */ } }
    }
  }
  saveStore(pool, ok);
  return result();
}

/**
 * The whole recent history at once (see readHistory), oldest first. A transaction the node did not serve yet is asked
 * for again, up to three reads; throws if the node failed or the history is still not all in.
 */
export async function history(mint, { limit = 100 } = {}) {
  let r = null;
  for (let i = 0; i < 10 && !(r && r.complete); i++) {
    if (r && r.waiting) await sleep(2000);             // the site's server is still fetching
    else if (i >= 3) break;
    r = await readHistory(mint, { limit });
    if (r.error) throw new Error(r.error);
  }
  if (!r.complete) throw new Error(`The node served ${r.have} of the ${r.total} transactions`);
  return r.events;
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

/**
 * A claim of the fees a pool owes. As the creator (`creator: true`, the default): `owner` must be the pool's creator,
 * signs, and is paid. As the platform: the SOL goes to the treasury written into the pool, whoever sends it
 * (`owner` only pays the network fee). Returns the transaction and the lamports it would pay.
 */
export async function buildClaim({ pool, owner, creator = true }) {
  owner = new PublicKey(owner);
  const keys = creator
    ? [meta(owner, { signer: true, writable: true }), meta(pool.address, { writable: true })]
    : [meta(pool.address, { writable: true }), meta(new PublicKey(pool.treasury), { writable: true })];
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
    await ix(creator ? "claim_creator_fees" : "claim_treasury_fees", keys),
  );
  return { tx, signers: [], amount: creator ? pool.creatorFees : pool.treasuryFees };
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
  const raw = signed.serialize();
  const signature = base58(signed.signature);
  try {
    await conn().sendRawTransaction(raw, { skipPreflight: false });
  } catch (err) {
    const m = String(err?.message ?? err);
    // it was there already (a resend through the public node, say), or the answer was lost on the way and it may well
    // have gone through: either way, wait for it. Anything else is a refusal before it was sent: a failed simulation
    // (the page explains the program's error), a 4xx from the site's server
    if (!/already been processed/i.test(m) && !/^5\d\d\b|fetch|network|timed? ?out|ECONN|socket|aborted/i.test(m)) throw err;
  }
  await confirm(signature, height, raw);
  return signature;
}

/**
 * Waits for a sent transaction by asking for its status once a second (no websocket: the site's server is plain HTTP).
 * It is sent again, up to three times, while it has not landed, and given up once its blockhash has expired.
 */
async function confirm(signature, lastValidBlockHeight, raw) {
  const failed = () => Object.assign(new Error("The transaction failed on chain"), { signature });
  const landed = (st) => st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
  let resent = 0;
  for (let i = 1; ; i++) {
    await sleep(1000);
    let st = null;
    try { st = (await conn().getSignatureStatuses([signature])).value[0]; } catch { /* asked again in a second */ }
    if (st?.err) throw failed();
    if (landed(st)) return;
    if (i % 4 !== 0) continue;
    let height = 0;
    try { height = await conn().getBlockHeight("confirmed"); } catch { /* asked again later */ }
    if (height > lastValidBlockHeight) {
      // one last look, in the node's history too, before calling it lost
      try { st = (await conn().getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]; } catch { st = null; }
      if (st?.err) throw failed();
      if (landed(st)) return;
      throw Object.assign(new Error("The transaction expired before it landed"), { signature });
    }
    if (resent < 3) { resent++; try { await conn().sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); } catch { /* it may have landed */ } }
  }
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
  // a fee payer with no lamports has no account at all
  if (text.includes("AccountNotFound")) return "This wallet has no SOL yet, and it needs a little for the network fee";
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
