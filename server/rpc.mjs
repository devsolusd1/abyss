// The site's door to Solana: /api/rpc?cluster=devnet|mainnet. Pages send their JSON-RPC calls here and this forwards
// them to the cluster's node (server/config.mjs), so a paid node's key never reaches a browser. What passes:
//   - only the calls the site itself makes (CALLS), with the settings it sends (CONFIG), one call at a time (the site
//     sends no batches); getProgramAccounts only as the site asks for the coin list (poolListing), so every page asks
//     the same and is answered from what is shared;
//   - transactions (sent or simulated) only when one instruction goes to the pool program and every other to the
//     compute budget, the associated token account program or a program a wallet adds as it signs (WALLET_ADDS), so
//     the door is not a free relay for anything else (every transaction the site makes calls the pool program);
//   - per caller, a share of calls per window, and fewer of the heavy ones (best effort: each instance counts its own).
//     The share of sends counts transactions, not calls: a page sends one again while it waits for it to land, and
//     those resends (the same bytes, with no preflight, as the page sends them) take no more of it, a few times;
//   - answers up to MAX_ANSWER bytes, and only JSON: anything else the node's side sends (an error page, which can
//     name its host) becomes this server's own error, its detail in the log.
// The program's account list, the mints it names (the coin board, the landing) and the recent priority fees for a set
// of accounts (asked before each send) are shared between callers for a few seconds, and a transaction once read is
// kept for a while: the node is asked once for what many pages want, and a call the node is answering already is not
// sent again (the same call from another page waits for that answer). What is kept is bounded in bytes, and only small
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
  getProgramAccounts: ["commitment", "encoding", "filters"],   // and only as poolListing has it
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
const flying = new Map();                                // key -> the shareable result of the same call, on its way from the node

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: typeof id === "number" || typeof id === "string" ? id : null, error: { code, message } });
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/*
 * getProgramAccounts as the site sends it (site/chain poolsFromNode, through web3.js): the program's Pool accounts,
 * whole, in base64, by a Pool's size and Anchor's mark of one. Anything else (a slice, other filters, a context) would
 * be its own key in what is shared, each one a full read of the program on the node.
 */
const POOL_LEN = 8 + 336;
const POOL_MARK = base58(createHash("sha256").update("account:Pool").digest().subarray(0, 8));
const COMMITMENTS = ["processed", "confirmed", "finalized"];
const only = (o, keys) => isObject(o) && Object.keys(o).every((k) => keys.includes(k));
function poolListing(p) {
  const c = p[1];
  if (p.length !== 2 || !only(c, ["encoding", "commitment", "filters"]) || c.encoding !== "base64") return false;
  if (c.commitment !== undefined && !COMMITMENTS.includes(c.commitment)) return false;
  if (!Array.isArray(c.filters) || c.filters.length !== 2) return false;
  const [size, mark] = c.filters, m = mark?.memcmp;
  return only(size, ["dataSize"]) && size.dataSize === POOL_LEN && only(mark, ["memcmp"]) && only(m, ["offset", "bytes", "encoding"])
    && m.offset === 0 && m.bytes === POOL_MARK && (m.encoding === undefined || m.encoding === "base58");
}

const ALLOWED = (cluster) => [cluster.program, COMPUTE_BUDGET, ATA_PROGRAM].map(addressBytes).filter(Boolean);
/*
 * The programs a wallet may add to the site's transaction as it signs (the page sends what the wallet gave back).
 * Each one only checks or records: none moves anyone's SOL or tokens of its own accord.
 *   - Lighthouse, L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95: Phantom appends its "guard" assertions, which fail the
 *     transaction when an account ends up other than the wallet showed before signing.
 *   - Memo, MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: a line of text in the transaction, which some wallets add.
 * They pass only in a transaction that also calls the pool program, so the door is no free relay for them either.
 * The compute budget, which wallets also add (a priority fee), is one of the site's own programs already.
 */
const WALLET_ADDS = ["L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"].map(addressBytes);
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
/**
 * True when an instruction of the transaction goes to the pool program and every other one to one of the site's
 * programs or to one a wallet adds (WALLET_ADDS). A compute budget or an account opening alone is not the site's:
 * every transaction it makes calls the pool program.
 */
function onlyOurs(b64, cluster) {
  const programs = programsOf(b64);
  if (!programs || !programs.length) return false;
  const allowed = ALLOWED(cluster), pool = addressBytes(cluster.program);
  let pooled = false;
  for (const p of programs) {
    const k = addressBytes(p);
    if (!k) return false;
    if (pool && same(pool, k)) pooled = true;
    else if (!allowed.some((a) => same(a, k)) && !WALLET_ADDS.some((a) => same(a, k))) return false;
  }
  return pooled;
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
    case "getProgramAccounts":
      if (p[0] !== cluster.program) return "Only the pool program's accounts";
      if (!poolListing(p)) return "Only the pool list, as this site asks for it";
      break;
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
const lost = (id, err) => json(rpcError(id, -32603, err?.large ? "The node's answer was too large" : "The node did not answer"), 502);
/**
 * The node's answer for the page, as it came when it is JSON. Anything else (an error page of the node's provider or
 * its CDN, which can name the node's host) becomes this server's own error: a 429 stays one, the rest is a 502. Only
 * the status goes to the log, never the text or the URL.
 */
function passOn(up, id) {
  let ok = false;
  try { const r = JSON.parse(up.text); ok = r !== null && typeof r === "object"; } catch { /* not JSON */ }
  if (ok) return new Response(up.text, { status: up.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  console.error(`rpc: the node answered HTTP ${up.status} with something that is not JSON`);
  if (up.status === 429) return json(rpcError(id, 429, "The node is busy; slow down"), 429, { "retry-after": "5" });
  return lost(id);
}
/** An answer's result when other pages may have it too (a 200 with a result; a transaction only once it is there). */
function shareable(up, store) {
  if (up.status !== 200) return undefined;
  try {
    const r = JSON.parse(up.text);
    if (r && "result" in r && !r.error && (store === shared || r.result)) return r.result;
  } catch { /* not JSON: not shared */ }
  return undefined;
}

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
    // the share is taken before anything is looked at, so refused calls cost their sender too
    const batch = Array.isArray(body);
    if (!calls.take(who, batch ? Math.max(1, body.length) : 1)) return json(rpcError(batch ? null : body?.id, 429, "Too many calls from here; slow down"), 429, { "retry-after": "5" });
    // one call at a time: the site's pages send no batches, and a batch would pass by what is shared
    if (batch) return json(rpcError(null, -32600, "One call at a time"), 400);
    const why = refuse(body, cluster);
    if (why) return json(rpcError(body?.id, -32601, why), 403);
    if (body.method === "getProgramAccounts" && !heavy.take(who)) return json(rpcError(body.id, 429, "Too many account lists from here"), 429, { "retry-after": "5" });
    if (body.method === "sendTransaction" && !takeSend(who, body.params[0], body.params[body.params.length - 1])) return json(rpcError(body.id, 429, "Too many transactions from here"), 429, { "retry-after": "30" });
    if (body.method === "simulateTransaction" && !sims.take(who)) return json(rpcError(body.id, 429, "Too many simulations from here"), 429, { "retry-after": "15" });

    // a call that another page asked for a moment ago is answered from memory, and one on its way already waits for it
    const key = keyOf(cluster, body), store = body.method === "getTransaction" ? txs : shared;
    const hit = key ? store.get(key) : null;
    if (hit) return json({ jsonrpc: "2.0", id: body.id ?? null, result: hit.result });
    const under = key ? flying.get(key) : null;
    if (under) {
      const result = await under;                        // never fails: undefined when its answer is not one to share
      if (result !== undefined) return json({ jsonrpc: "2.0", id: body.id ?? null, result });
    }
    const job = upstream(cluster, body);
    if (key && !under) {
      const share = job.then((up) => { const result = shareable(up, store); if (result !== undefined) store.put(key, up.text, result); return result; }, () => undefined)
        .finally(() => { if (flying.get(key) === share) flying.delete(key); });
      flying.set(key, share);
    }
    let up;
    try { up = await job; } catch (err) { return lost(body.id, err); }
    return passOn(up, body.id);
  } catch {
    return json(rpcError(null, -32603, "Something went wrong here"), 500);
  }
}
