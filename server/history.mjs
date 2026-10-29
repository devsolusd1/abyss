// One read of a pool's recent history for every visitor: /api/history?cluster=…&pool=<pool address>[&limit=1..100][&at=…].
// It answers the pool's latest transactions with each one's event lines, so a coin page needs one call instead of one
// per transaction (site/chain/src readHistory decodes them). Only pools of the pool program (its Pool accounts, not
// its seats or config), and only the lines the pool program itself logged: another program can name the pool in its
// own transaction and log whatever it likes.
//
// Transactions never change once they are in, so each is fetched once and kept in this instance's memory; the list of
// signatures is read again at most every LIST_MS, or at once when `at` (the page's mark of the pool's state, which
// changes with every trade or claim) is new. The answer is cached at the edge for a moment, per `at`. With a paid node
// it fetches BATCH at a time, in one batch (or as single calls, a few at a time, when the node takes no batches:
// RPC_BATCH=0, or it refused one in the last BATCH_OFF_MS); on the public node each of its calls keeps to that node's
// pace (about one call every 1.3 s, on the mark it shares with the birth: config.mjs), so a long history comes in over
// a few answers (complete: false until it is all in). One answer waits for the node's turns BUDGET_MS at most, the
// pool check and the listing included; a 429 counts as a turn that comes too late. Then it gives what it has. With no
// list kept for the pool yet it has nothing to give (an empty one would read as a pool without trades), so its pool
// check and listing may wait until FIRST_MS: the page waits 15 s for an answer, and without a 200 it reads the node
// itself (for the few seconds a 503's retry-after asks, or for a minute after any other answer or none in 15 s). When
// the listing's turn comes after that too, or the node answers 429, it says so: 503, with no wait for a turn it knows
// is too late.
//
// Answer: { total, have, complete, signatures: [{ signature, blockTime, err }], txs: { signature: { t, d: [base64] } } }

import { createHash } from "node:crypto";
import { clusterOf, addressBytes, callerOf, foreign, Limiter, json, base58, OutOfTime, publicTurn, backOff, PUBLIC_GAP } from "./config.mjs";

const LIST_MS = 2000;
const BUDGET_MS = 7000;                                  // how long one answer may spend, its waits for the node included
const FIRST_MS = 12_000;                                 // how long it may wait for a pool's first list (the page waits 15 s)
const BATCH = 10;
const BATCH_OFF_MS = 10 * 60 * 1000;                     // how long a node that refused a batch is sent single calls
const SINGLES = 4;                                       // single calls at once, to a node that takes no batches
const POOL_MS = 10 * 60 * 1000;                          // how long "this is one of the program's pools" is believed
const MAX_ANSWER = 4 * 1024 * 1024;
const PREFIX = "Program data: ";
const POOL_TAG = createHash("sha256").update("account:Pool").digest().subarray(0, 8);   // Anchor's mark of a Pool account
const asks = new Limiter(60, 10_000);
const lists = new Map();                                 // cluster|pool|limit -> { at, mark, list }
const pools = new Map();                                 // cluster|address -> { at, mint }
const kept = new Map();                                  // signature -> { t, d }
const fetching = new Map();                              // signature -> promise

function keep(map, key, value, max) { map.delete(key); map.set(key, value); if (map.size > max) map.delete(map.keys().next().value); }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, Math.max(0, ms)));

/**
 * The "Program data:" lines that `program` itself logged, read off the call stack the logs describe ("Program X
 * invoke [n]" in, "Program X success" or "failed" out). A line logged by any other program (one that called the pool
 * program, or one the pool program called) is not the pool's.
 */
export function ownLines(logs, program) {
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

/**
 * The node refused a call: an HTTP error, or an answer that is not JSON. It names the status, never the URL (a paid
 * node's carries its key).
 */
export class NodeError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** One call (or a batch) to the cluster's node; a 429 comes back as { error: { code: 429 } }, with the call's id. */
export async function call(cluster, body) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(cluster.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    if (res.status === 429) return Array.isArray(body) ? body.map((c) => ({ id: c?.id, error: { code: 429 } })) : { id: body?.id, error: { code: 429 } };
    if (!res.ok) throw new NodeError(`The node answered HTTP ${res.status}`, res.status);
    const text = await res.text();
    if (text.length > MAX_ANSWER) throw new Error("too large");
    try { return JSON.parse(text); } catch { throw new NodeError(`The node's answer was not JSON (HTTP ${res.status})`, res.status); }
  } finally { clearTimeout(timer); }
}
const one = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/** Cluster name -> until when its node is sent no batch: it refused one (a plan that takes none, or fewer). */
export const noBatches = {};

/** The node takes batches: a paid one, unless RPC_BATCH=0 or it refused a batch in the last BATCH_OFF_MS. */
const batches = (cluster) => cluster.batch && !((noBatches[cluster.name] ?? 0) > Date.now());

/** A batch's answers serve some of its calls: one of them has its own answer there (a result, or the node's rate: 429). */
function serves(answers, list) {
  const ids = new Set(list.map((c) => c.id));
  return answers.some((x) => isObject(x) && ids.has(x.id) && ("result" in x || x.error?.code === 429));
}

/**
 * Several calls, their answers in a list, each with its call's id (a call with no answer is left out). In one batch
 * when the node takes batches. A batch it refuses (an answer that is not a list, a list that serves none of the
 * calls, or an HTTP error other than 429) marks its cluster as one whose node takes none for BATCH_OFF_MS, and the
 * same calls go again as single calls: SINGLES at a time, and none after a 429 (the node's rate; the next round asks
 * for the rest). Throws when no call got an answer.
 */
export async function callMany(cluster, list) {
  if (batches(cluster)) {
    let r;
    // no answer at all (a timeout, a lost connection) says nothing of batches: it goes to the caller as it is
    try { r = await call(cluster, list); } catch (err) { if (!(err instanceof NodeError)) throw err; r = err; }
    if (Array.isArray(r) && serves(r, list)) return r;
    noBatches[cluster.name] = Date.now() + BATCH_OFF_MS;
    const why = r instanceof NodeError ? (r.status === 200 ? "an answer that is not JSON" : `HTTP ${r.status}`)
      : Array.isArray(r) ? "a list that serves none of the calls" : "one answer, not a list";
    console.warn(`The ${cluster.name} node refused a batch (${why}): single calls to it for ${BATCH_OFF_MS / 60_000} minutes`);
  }
  const out = [];
  let first = null;
  for (let i = 0; i < list.length; i += SINGLES) {
    const got = await Promise.all(list.slice(i, i + SINGLES).map((c) => call(cluster, c)
      .then((r) => (isObject(r) ? { ...r, id: c.id } : null), (err) => { first ??= err; return null; })));
    for (const r of got) if (r) out.push(r);
    if (got.some((r) => r?.error?.code === 429)) break;
  }
  if (!out.length && first) throw first;
  return out;
}

/**
 * The mint of a pool of the program, or null for any other address: the account is the program's and starts with the
 * Pool account's mark (a seat or the config is the program's too, and is not a pool). Only its first 40 bytes are read.
 * On the public node it waits for its turn; OutOfTime when that comes after `until`, or when the node answers 429.
 */
export async function poolMint(cluster, address, until = Infinity) {
  const key = `${cluster.name}|${address}`, hit = pools.get(key), now = Date.now();
  if (hit && now - hit.at < (hit.mint ? POOL_MS : 60_000)) return hit.mint;
  // a pool is never closed: when the node's turn comes too late or it answers 429, an account read as one stays one
  const late = () => { if (hit?.mint) return hit.mint; throw new OutOfTime(); };
  if (!(await publicTurn(cluster, until))) return late();
  const r = await call(cluster, one("getAccountInfo", [address, { encoding: "base64", dataSlice: { offset: 0, length: 40 }, commitment: "confirmed" }]));
  if (r?.error?.code === 429) { backOff(cluster); return late(); }
  if (r?.error) throw new Error("node");
  const v = r?.result?.value, data = Array.isArray(v?.data) ? Buffer.from(String(v.data[0] ?? ""), "base64") : null;
  const mint = v?.owner === cluster.program && data?.length >= 40 && data.subarray(0, 8).equals(POOL_TAG) ? base58(data.subarray(8, 40)) : null;
  keep(pools, key, { at: now, mint }, 2000);
  return mint;
}
export const isPool = async (cluster, address, until) => (await poolMint(cluster, address, until)) !== null;

/**
 * The pool's latest signatures; on the public node at its turn. When that comes after `until`, or the node answers
 * 429, the list last read, or OutOfTime when there is none.
 */
const listKey = (cluster, pool, limit) => `${cluster.name}|${pool}|${limit}`;
async function signatures(cluster, pool, limit, mark, until) {
  const key = listKey(cluster, pool, limit), hit = lists.get(key);
  if (hit && Date.now() - hit.at < LIST_MS && hit.mark === mark) return hit.list;
  const late = () => { if (hit) return hit.list; throw new OutOfTime(); };
  if (!(await publicTurn(cluster, until))) return late();
  const r = await call(cluster, one("getSignaturesForAddress", [pool, { limit, commitment: "confirmed" }]));
  if (r?.error?.code === 429) { backOff(cluster); return late(); }
  if (!Array.isArray(r?.result)) throw new Error("node");
  const list = r.result.filter((s) => s && typeof s.signature === "string" && s.signature.length <= 90)
    .map((s) => ({ signature: s.signature, blockTime: typeof s.blockTime === "number" ? s.blockTime : null, err: s.err ? true : null }));
  keep(lists, key, { at: Date.now(), mark, list }, 2000);
  return list;
}

function take(cluster, sig, reply, blockTime) {
  const tx = reply?.result;
  if (!tx || !tx.meta) return false;                     // not served (yet)
  keep(kept, sig, { t: typeof tx.blockTime === "number" ? tx.blockTime : blockTime, d: ownLines(tx.meta.logMessages, cluster.program) }, 20_000);
  return true;
}
const params = (sig) => [sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }];

/** Fetches what is missing, newest first, until it is all in or the budget is spent. */
async function fill(cluster, list, until) {
  const missing = () => list.filter((s) => !s.err && !kept.has(s.signature) && !fetching.has(s.signature));
  for (let tries = 0; Date.now() < until && tries < 40; tries++) {
    const want = missing();
    if (!want.length) {
      const others = list.map((s) => fetching.get(s.signature)).filter(Boolean);   // another answer is fetching them
      if (!others.length) return;
      await Promise.race([Promise.allSettled(others), sleep(until - Date.now())]);
      continue;
    }
    if (cluster.paid) {
      const part = want.slice(0, BATCH);
      const job = callMany(cluster, part.map((s, i) => ({ jsonrpc: "2.0", id: i, method: "getTransaction", params: params(s.signature) })));
      part.forEach((s) => fetching.set(s.signature, job));
      let replies;
      try { replies = await job; } catch { replies = []; } finally { part.forEach((s) => fetching.get(s.signature) === job && fetching.delete(s.signature)); }
      const byId = Array.isArray(replies) ? new Map(replies.map((r) => [r?.id, r])) : new Map();
      let got = 0;
      part.forEach((s, i) => { if (take(cluster, s.signature, byId.get(i), s.blockTime)) got++; });
      if (!got) return;                                  // the node refused or served none: the next answer tries again
    } else {
      if (!(await publicTurn(cluster, until))) return;
      const s = missing()[0];
      if (!s) continue;                                  // another answer fetched them while this one waited
      const job = call(cluster, one("getTransaction", params(s.signature)));
      fetching.set(s.signature, job);
      let reply;
      try { reply = await job; } catch { reply = null; } finally { if (fetching.get(s.signature) === job) fetching.delete(s.signature); }
      if (reply?.error?.code === 429) { backOff(cluster); return; }
      if (!take(cluster, s.signature, reply, s.blockTime)) return;
    }
  }
}

export async function handleHistory(request, env = {}) {
  try {
    if (request.method !== "GET") return json({ error: "GET only" }, 405, { allow: "GET" });
    if (foreign(request)) return json({ error: "This server is for this site's own pages" }, 403);
    const q = new URL(request.url).searchParams;
    const cluster = clusterOf(q.get("cluster") ?? "", env);
    if (!cluster) return json({ error: "Unknown cluster" }, 400);
    if (!cluster.url || !cluster.program) return json({ error: `Nox is not on ${cluster.name} yet` }, 503);
    const pool = q.get("pool") ?? "";
    if (!addressBytes(pool)) return json({ error: "Not an address" }, 400);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(q.get("limit") ?? 100)) || 100));
    const mark = String(q.get("at") ?? "").slice(0, 120);
    if (!asks.take(callerOf(request))) return json({ error: "Too many asks from here; slow down" }, 429, { "retry-after": "5" });

    const now = Date.now(), until = now + BUDGET_MS, known = lists.has(listKey(cluster, pool, limit));
    // with no list kept, the listing's turn may come until FIRST_MS, and the pool check leaves a turn before it
    const last = known ? until : now + FIRST_MS;
    let list;
    try {
      if (!(await isPool(cluster, pool, known ? until : last - PUBLIC_GAP))) return json({ error: "Not a pool of this program" }, 404, { "cache-control": "public, s-maxage=60" });
      list = await signatures(cluster, pool, limit, mark, last);
    } catch (err) {
      if (!(err instanceof OutOfTime)) throw err;        // the node's turn comes later (or a 429), and nothing kept answers
      return json({ error: "The node is busy; ask again shortly" }, 503, { "retry-after": "3" });
    }
    await fill(cluster, list, until);
    const txs = {};
    let have = 0, total = 0;
    for (const s of list) {
      if (s.err) continue;
      total++;
      const k = kept.get(s.signature);
      if (k) { txs[s.signature] = k; have++; }
    }
    const complete = have === total;
    return json({ total, have, complete, signatures: list, txs }, 200,
      { "cache-control": complete ? "public, max-age=0, s-maxage=2, stale-while-revalidate=10" : "public, max-age=0, s-maxage=1" });
  } catch (err) {
    console.error("history:", err);                     // the details stay in the server's log: they can name the node
    return json({ error: "The node did not answer" }, 502);
  }
}
