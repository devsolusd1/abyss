// One read of a pool's recent history for every visitor: /api/history?cluster=…&pool=<pool address>[&limit=1..100][&at=…].
// It answers the pool's latest transactions with each one's event lines, so a coin page needs one call instead of one
// per transaction (site/chain/src readHistory decodes them). Only pools of the pool program, and only the lines the
// pool program itself logged: another program can name the pool in its own transaction and log whatever it likes.
//
// Transactions never change once they are in, so each is fetched once and kept in this instance's memory; the list of
// signatures is read again at most every LIST_MS, or at once when `at` (the page's mark of the pool's state, which
// changes with every trade or claim) is new. The answer is cached at the edge for a moment, per `at`. With a paid node
// it fetches BATCH at a time; on the public node it keeps to that node's pace (about one call every 1.3 s), so a long
// history comes in over a few answers (complete: false until it is all in).
//
// Answer: { total, have, complete, signatures: [{ signature, blockTime, err }], txs: { signature: { t, d: [base64] } } }

import { clusterOf, addressBytes, callerOf, foreign, Limiter, json } from "./config.mjs";

const LIST_MS = 2000;
const BUDGET_MS = 7000;                                  // how long one answer may spend fetching
const BATCH = 10;
const PUBLIC_GAP = 1312;                                 // ms between calls on the public node (8 per 10.5 s)
const POOL_MS = 10 * 60 * 1000;                          // how long "this is one of the program's pools" is believed
const MAX_ANSWER = 4 * 1024 * 1024;
const PREFIX = "Program data: ";
const asks = new Limiter(60, 10_000);
const lists = new Map();                                 // cluster|pool|limit -> { at, mark, list }
const pools = new Map();                                 // cluster|pool -> { at, ok }
const kept = new Map();                                  // signature -> { t, d }
const fetching = new Map();                              // signature -> promise
const nextAt = {};                                       // cluster -> when the public node may be called next

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

/** One call (or a batch) to the cluster's node; a 429 comes back as { error: { code: 429 } }. */
export async function call(cluster, body) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(cluster.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    if (res.status === 429) return Array.isArray(body) ? body.map(() => ({ error: { code: 429 } })) : { error: { code: 429 } };
    const text = await res.text();
    if (text.length > MAX_ANSWER) throw new Error("too large");
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}
const one = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });

export async function isPool(cluster, pool) {
  const key = `${cluster.name}|${pool}`, hit = pools.get(key), now = Date.now();
  if (hit && now - hit.at < (hit.ok ? POOL_MS : 60_000)) return hit.ok;
  const r = await call(cluster, one("getAccountInfo", [pool, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }]));
  if (r?.error) throw new Error("node");
  const ok = r?.result?.value?.owner === cluster.program;
  keep(pools, key, { at: now, ok }, 2000);
  return ok;
}

async function signatures(cluster, pool, limit, mark) {
  const key = `${cluster.name}|${pool}|${limit}`, hit = lists.get(key), now = Date.now();
  if (hit && now - hit.at < LIST_MS && hit.mark === mark) return hit.list;
  const r = await call(cluster, one("getSignaturesForAddress", [pool, { limit, commitment: "confirmed" }]));
  if (!Array.isArray(r?.result)) throw new Error("node");
  const list = r.result.filter((s) => s && typeof s.signature === "string" && s.signature.length <= 90)
    .map((s) => ({ signature: s.signature, blockTime: typeof s.blockTime === "number" ? s.blockTime : null, err: s.err ? true : null }));
  keep(lists, key, { at: now, mark, list }, 2000);
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
      const job = call(cluster, part.map((s, i) => ({ jsonrpc: "2.0", id: i, method: "getTransaction", params: params(s.signature) })));
      part.forEach((s) => fetching.set(s.signature, job));
      let replies;
      try { replies = await job; } catch { replies = []; } finally { part.forEach((s) => fetching.get(s.signature) === job && fetching.delete(s.signature)); }
      const byId = Array.isArray(replies) ? new Map(replies.map((r) => [r?.id, r])) : new Map();
      let got = 0;
      part.forEach((s, i) => { if (take(cluster, s.signature, byId.get(i), s.blockTime)) got++; });
      if (!got) return;                                  // the node refused or served none: the next answer tries again
    } else {
      const wait = (nextAt[cluster.name] ?? 0) - Date.now();
      if (Date.now() + Math.max(0, wait) > until) return;
      if (wait > 0) { await sleep(wait); continue; }
      nextAt[cluster.name] = Date.now() + PUBLIC_GAP;
      const s = want[0];
      const job = call(cluster, one("getTransaction", params(s.signature)));
      fetching.set(s.signature, job);
      let reply;
      try { reply = await job; } catch { reply = null; } finally { if (fetching.get(s.signature) === job) fetching.delete(s.signature); }
      if (reply?.error?.code === 429) { nextAt[cluster.name] = Date.now() + 12_000; return; }
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

    if (!(await isPool(cluster, pool))) return json({ error: "Not a pool of this program" }, 404, { "cache-control": "public, s-maxage=60" });
    const list = await signatures(cluster, pool, limit, mark);
    await fill(cluster, list, Date.now() + BUDGET_MS);
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
