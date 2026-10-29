// The site's door to Solana: /api/rpc?cluster=devnet|mainnet. Pages send their JSON-RPC calls here and this forwards
// them to the cluster's node (server/config.mjs), so a paid node's key never reaches a browser. What passes:
//   - only the calls the site itself makes (CALLS), with the settings it sends (CONFIG); getProgramAccounts only on
//     the pool program;
//   - transactions (sent or simulated) only when every instruction goes to the pool program, the compute budget or
//     the associated token account program, so the door is not a free relay for anything else;
//   - per caller, a share of calls per window, and fewer of the heavy ones (best effort: each instance counts its own).
//     The share of sends counts transactions, not calls: a page sends one again while it waits for it to land, and
//     those resends (the same bytes, with no preflight, as the page sends them) take no more of it, a few times;
//   - answers up to MAX_ANSWER bytes.
// The program's account list, the mints it names (the coin board, the landing) and the recent priority fees for a set
// of accounts (asked before each send) are shared between callers for a few seconds, and a transaction once read is
// kept for a while: the node is asked once for what many pages want. What is kept is bounded in bytes, and only small
// answers are kept.

import { createHash } from "node:crypto";
import { clusterOf, addressBytes, base58, callerOf, foreign, Limiter, json, COMPUTE_BUDGET, ATA_PROGRAM } from "./config.mjs";

const CALLS = new Set([
  "getAccountInfo", "getMultipleAccounts", "getBalance", "getProgramAccounts", "getSignaturesForAddress", "getTransaction",
  "getLatestBlockhash", "getBlockHeight", "getSignatureStatuses", "simulateTransaction", "sendTransaction",
  "getMinimumBalanceForRentExemption", "getSlot", "getHealth", "getRecentPrioritizationFees",
]);
// the settings each call may carry (what web3.js and the pages send); anything else is refused
const CONFIG = {
  getAccountInfo: ["commitment", "encoding", "dataSlice", "minContextSlot"],
  getMultipleAccounts: ["commitment", "encoding", "dataSlice", "minContextSlot"],
  getBalance: ["commitment", "minContextSlot"],
  getProgramAccounts: ["commitment", "encoding", "dataSlice", "filters", "withContext", "minContextSlot"],
  getSignaturesForAddress: ["commitment", "limit", "before", "until", "minContextSlot"],
  getTransaction: ["commitment", "encoding", "maxSupportedTransactionVersion"],
  getLatestBlockhash: ["commitment", "minContextSlot"],
  getBlockHeight: ["commitment", "minContextSlot"],
  getSignatureStatuses: ["searchTransactionHistory"],
  simulateTransaction: ["commitment", "encoding", "sigVerify", "replaceRecentBlockhash", "accounts", "minContextSlot", "innerInstructions"],
  sendTransaction: ["encoding", "skipPreflight", "preflightCommitment", "maxRetries", "minContextSlot"],
  getMinimumBalanceForRentExemption: ["commitment"],
  getSlot: ["commitment", "minContextSlot"],
  getHealth: [],
  getRecentPrioritizationFees: [],                       // only a list of accounts, no settings
};
const MAX_BODY = 32 * 1024;
const MAX_BATCH = 10;
const MAX_TX = 1700;                                     // base64 of the largest transaction (1232 bytes) is 1644
const MAX_ANSWER = 4 * 1024 * 1024;                      // Vercel answers up to about 4.5 MB
const KEEP_ANSWER = 256 * 1024;                          // only answers this small are kept
const SHARED_MS = 3000;                                  // how long the program's account list is shared
const TX_MS = 10 * 60 * 1000;                            // how long a read transaction is kept
const SENT_MS = 2 * 60 * 1000;                           // how long a sent transaction is known (its blockhash lasts about 60 to 90 s)
const MAX_SENT = 20_000;
const FREE_RESENDS = 4;                                  // resends of a transaction that take no share (the page's are 3 at most)
const calls = new Limiter(120, 10_000), heavy = new Limiter(20, 10_000), sends = new Limiter(12, 60_000), sims = new Limiter(40, 60_000);

/** A map of answers kept for `ms`, at most `bytes` of them in all, oldest out first. */
class Kept {
  constructor(ms, bytes) { this.ms = ms; this.bytes = bytes; this.size = 0; this.map = new Map(); }
  get(key, now = Date.now()) { const v = this.map.get(key); return v && now - v.at < this.ms ? v : null; }
  put(key, text, result, now = Date.now()) {
    if (text.length > KEEP_ANSWER) return;
    const old = this.map.get(key), n = text.length + key.length;   // a key can be long too: up to 128 accounts
    if (old) { this.size -= old.n; this.map.delete(key); }
    this.map.set(key, { at: now, result, n });
    this.size += n;
    for (const [k, v] of this.map) {                     // oldest first: the expired ones, then while over the budget
      if (now - v.at < this.ms && this.size <= this.bytes) break;
      this.map.delete(k); this.size -= v.n;
    }
  }
}
const shared = new Kept(SHARED_MS, 16 * 1024 * 1024), txs = new Kept(TX_MS, 24 * 1024 * 1024);

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: typeof id === "number" || typeof id === "string" ? id : null, error: { code, message } });
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

const ALLOWED = (cluster) => [cluster.program, COMPUTE_BUDGET, ATA_PROGRAM].map(addressBytes).filter(Boolean);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The programs a serialized transaction's instructions go to (legacy or v0), as base58, or null when it does not parse. */
export function programsOf(b64) {
  try {
    const b = Buffer.from(b64, "base64");
    let at = 0;
    const byte = () => { if (at >= b.length) throw new Error("short"); return b[at++]; };
    const shortVec = () => { let n = 0; for (let shift = 0; shift < 21; shift += 7) { const x = byte(); n |= (x & 0x7f) << shift; if (!(x & 0x80)) return n; } throw new Error("long"); };
    const skip = (n) => { at += n; if (at > b.length) throw new Error("short"); };
    skip(64 * shortVec());                               // signatures
    if (b[at] & 0x80) { if ((b[at] & 0x7f) !== 0) return null; at++; }   // a versioned message: only v0
    skip(3);                                             // header
    const keys = [];
    for (let i = shortVec(); i > 0; i--) { if (keys.length >= 64) return null; keys.push(b.subarray(at, at + 32)); skip(32); }
    skip(32);                                            // recent blockhash
    const used = [];
    for (let i = shortVec(); i > 0; i--) {
      if (used.length >= 64) return null;
      const p = byte();
      if (p >= keys.length) return null;                 // a program id must be one of the message's own keys
      used.push(p);
      skip(shortVec());                                  // account indexes
      skip(shortVec());                                  // data
    }
    return used.map((p) => base58(keys[p]));
  } catch { return null; }
}
/** True when every instruction of the transaction goes to one of the site's programs. */
function onlyOurs(b64, cluster) {
  const programs = programsOf(b64);
  if (!programs || !programs.length) return false;
  const allowed = ALLOWED(cluster);
  return programs.every((p) => { const k = addressBytes(p); return k && allowed.some((a) => same(a, k)); });
}

/** A serialized transaction's first signature (the one the cluster knows it by), as base58, or null when it has none. */
export function signatureOf(b64) {
  const b = Buffer.from(b64, "base64");
  return b.length >= 65 && b[0] > 0 && b[0] < 0x80 ? base58(b.subarray(1, 65)) : null;   // a count under 128 is one byte
}

/*
 * The transactions each caller sent in the last SENT_MS, by first signature, each with a digest of its bytes: a resend
 * is the same signature on the same bytes. The signature alone is not enough, as it is only what the sender put there
 * (an unsigned transaction's is all zeros): other bytes under it are another transaction, and count. A resend is free
 * only with no preflight (one with it is a simulation too) and FREE_RESENDS times; past that, each one counts.
 */
const sent = new Map();                                  // caller|signature -> { at, digest, free }
/**
 * Takes a share of sends for a transaction, unless it is a resend of one this caller sent a moment ago, with no
 * preflight, and it still has free resends; false when no share is left.
 */
function takeSend(who, b64, cfg, now = Date.now()) {
  const sig = signatureOf(b64), key = sig && `${who}|${sig}`, digest = createHash("sha256").update(b64).digest("base64");
  const seen = key && sent.get(key), again = seen && now - seen.at < SENT_MS && seen.digest === digest;
  if (again && cfg?.skipPreflight === true && seen.free < FREE_RESENDS) { seen.free++; return true; }
  if (!sends.take(who, 1, now)) return false;
  if (key && !again) { sent.delete(key); sent.set(key, { at: now, digest, free: 0 }); }   // a resend keeps its count
  for (const [k, v] of sent) {                           // oldest first: the expired ones, then while there are too many
    if (now - v.at < SENT_MS && sent.size <= MAX_SENT) break;
    sent.delete(k);
  }
  return true;
}

/** Why a call may not pass, or null. */
function refuse(call, cluster) {
  if (!isObject(call) || call.jsonrpc !== "2.0" || typeof call.method !== "string") return "Not a JSON-RPC call";
  if (!CALLS.has(call.method)) return `${call.method.slice(0, 40)} is not a call this site makes`;
  if (call.params !== undefined && !Array.isArray(call.params)) return "params must be a list";
  const p = call.params ?? [];
  // the last item may be a settings object; it may only carry what the site sends
  const cfg = p.length && isObject(p[p.length - 1]) ? p[p.length - 1] : null;
  if (cfg && !Object.keys(cfg).every((k) => CONFIG[call.method].includes(k))) return `Settings this site does not send in ${call.method}`;
  switch (call.method) {
    case "getProgramAccounts": if (p[0] !== cluster.program) return "Only the pool program's accounts"; break;
    case "getMultipleAccounts": if (!Array.isArray(p[0]) || p[0].length > 100 || !p[0].every((k) => typeof k === "string")) return "Up to 100 accounts"; break;
    case "getSignatureStatuses": if (!Array.isArray(p[0]) || p[0].length > 20 || !p[0].every((k) => typeof k === "string")) return "Up to 20 signatures"; break;
    case "getSignaturesForAddress": if (Number(cfg?.limit ?? 1000) > 100) return "Up to 100 signatures"; break;
    case "getRecentPrioritizationFees":                  // [] or [[address, …]], as web3.js sends it
      if (p.length > 1 || (p.length && (!Array.isArray(p[0]) || p[0].length > 128 || !p[0].every((k) => addressBytes(k))))) return "Up to 128 accounts";
      break;
    case "sendTransaction": case "simulateTransaction":
      if (typeof p[0] !== "string" || p[0].length > MAX_TX || cfg?.encoding !== "base64") return "Transactions in base64 only";
      if (!onlyOurs(p[0], cluster)) return "Only transactions for the pool program";
      break;
    default: break;
  }
  for (const x of p) if (typeof x !== "string" && typeof x !== "number" && typeof x !== "boolean" && !isObject(x) && !Array.isArray(x)) return "Odd params";
  return null;
}

/**
 * The key under which an answer may be shared, or null: only the listing calls, the priority fees and transaction
 * reads, as the site sends them. The fees are the same for a set of accounts in any order.
 */
function keyOf(cluster, call) {
  try {
    if (call.method === "getProgramAccounts" || call.method === "getMultipleAccounts") return `${cluster.name}|${call.method}|${JSON.stringify(call.params)}`;
    if (call.method === "getRecentPrioritizationFees") return `${cluster.name}|fees|${[...new Set(call.params?.[0] ?? [])].sort().join()}`;
    if (call.method === "getTransaction" && typeof call.params?.[0] === "string") {
      const c = call.params[1] ?? {};
      return `${cluster.name}|tx|${call.params[0]}|${c.commitment ?? ""}|${c.encoding ?? ""}|${c.maxSupportedTransactionVersion ?? ""}`;
    }
  } catch { /* too odd to share */ }
  return null;
}

/** The node's answer, at most MAX_ANSWER bytes. */
async function upstream(cluster, body) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(cluster.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    const parts = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_ANSWER) { ctl.abort(); throw Object.assign(new Error("too large"), { large: true }); }
        parts.push(value);
      }
    }
    return { status: res.status, text: Buffer.concat(parts).toString("utf8") };
  } finally { clearTimeout(timer); }
}
const passOn = (up) => new Response(up.text, { status: up.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const lost = (id, err) => json(rpcError(id, -32603, err?.large ? "The node's answer was too large" : "The node did not answer"), 502);

export async function handleRpc(request, env = {}) {
  try {
    if (request.method !== "POST") return json(rpcError(null, -32600, "POST JSON-RPC calls here"), 405, { allow: "POST" });
    if (foreign(request)) return json(rpcError(null, -32600, "This server is for this site's own pages"), 403);
    const cluster = clusterOf(new URL(request.url).searchParams.get("cluster") ?? "", env);
    if (!cluster) return json(rpcError(null, -32600, "Unknown cluster"), 400);
    if (!cluster.url) return json(rpcError(null, -32603, `No node for ${cluster.name} yet`), 503);

    const who = callerOf(request);
    const text = await request.text();
    if (text.length > MAX_BODY) return json(rpcError(null, -32600, "Too large"), 413);
    let body;
    try { body = JSON.parse(text); } catch { return json(rpcError(null, -32700, "Not JSON"), 400); }
    const batch = Array.isArray(body), list = batch ? body : [body];
    if (!list.length || list.length > MAX_BATCH) return json(rpcError(null, -32600, `1 to ${MAX_BATCH} calls at once`), 400);
    // the share is taken before anything is looked at, so refused calls cost their sender too
    if (!calls.take(who, list.length)) return json(rpcError(list[0]?.id, 429, "Too many calls from here; slow down"), 429, { "retry-after": "5" });
    for (const call of list) {
      const why = refuse(call, cluster);
      if (why) return json(rpcError(call?.id, -32601, why), 403);
    }
    for (const call of list) {
      if (call.method === "getProgramAccounts" && !heavy.take(who)) return json(rpcError(call.id, 429, "Too many account lists from here"), 429, { "retry-after": "5" });
      if (call.method === "sendTransaction" && !takeSend(who, call.params[0], call.params[call.params.length - 1])) return json(rpcError(call.id, 429, "Too many transactions from here"), 429, { "retry-after": "30" });
      if (call.method === "simulateTransaction" && !sims.take(who)) return json(rpcError(call.id, 429, "Too many simulations from here"), 429, { "retry-after": "15" });
    }

    if (batch) {
      try { return passOn(await upstream(cluster, body)); } catch (err) { return lost(null, err); }
    }
    // one call that another page asked for a moment ago is answered from memory
    const key = keyOf(cluster, body), store = body.method === "getTransaction" ? txs : shared;
    const hit = key ? store.get(key) : null;
    if (hit) return json({ jsonrpc: "2.0", id: body.id ?? null, result: hit.result });
    let up;
    try { up = await upstream(cluster, body); } catch (err) { return lost(body.id, err); }
    if (key && up.status === 200) {
      try {
        const r = JSON.parse(up.text);
        if (r && "result" in r && !r.error && (store === shared || r.result)) store.put(key, up.text, r.result);
      } catch { /* passed on as it came */ }
    }
    return passOn(up);
  } catch {
    return json(rpcError(null, -32603, "Something went wrong here"), 500);
  }
}
