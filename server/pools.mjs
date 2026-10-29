// Every pool of the program for every visitor at once: /api/pools?cluster=…[&limit=1..100][&board=1][&after=…|&sort=volume].
// The coin board and the landing read this instead of the program's account list: this instance reads that list from
// the node at most every LIST_MS, whoever asks (an answer that comes while a read is under way waits for that one), and
// the edge keeps the answer a few seconds more, so what the node is asked does not grow with the visitors. Only Pool
// accounts of the pool program (its owner, a Pool's size and Anchor's mark of one), newest first (then by mint); with
// sort=volume, the most traded first (the pool's volume: every lamport its trades moved since launch, fees included),
// then newest first as before. /coin without a coin asks for that one: limit=1&sort=volume. The order by volume has no
// next page (after= with it is refused): what it leaves out past MAX_ANSWER is the least traded.
//
// A coin's name, symbol and link are its mint's metadata, which the launch seals (programs/pool/src/token.rs takes the
// update authority away in the same instruction): they never change, so each mint's are read once and kept here. An
// answer spends BUDGET_MS at most (SLICE_MS for a slice: the page waits 12 s and 5 s), its wait for the list included,
// and in that time reads the metadata it still needs, in the answer's order (newest first, or the most traded first):
// a paid node is sent ROUND calls of 100 mints in one batch (or as single calls, a few at a time, when it takes no
// batches: history.mjs callMany), the public node one call at its turn (the pace the history and the birth keep:
// config.mjs). A pool whose metadata are not in by then comes with null for them, the edge keeps that answer only a
// second, and the page reads those itself.
//
// When the node fails, refuses (429) or is slow, or the public node's turn comes after the answer's time, the list read
// last is given while it is under STALE_MS old; without one, the answer is a 503 with a retry-after, and the read goes
// on for the next answers. After a read that failed or was refused, the next waits RETRY_MS. An answer stays under
// MAX_ANSWER bytes: past that it leaves the oldest pools out (cut), and after=<openedAt>.<mint> of its last pool asks
// for the ones after it (older, or as old with a later mint), so pages read in a row miss none and repeat none.
//
// Answer: { at, total, cut, pools }
//   at: when the list was read (ms). total: the program's pools. cut: pools leaves some out to stay under MAX_ANSWER.
//   pools, newest first (with sort=volume, the most traded first), each a list:
//     [address, data, name, symbol, uri]   the pool account's address and its whole data, in base64
//     [data, name, symbol]                 with board=1: the mint and the numbers only (the data without its mark and
//                                          without the creator, treasury, vault and hook program), for the coin board
//   name, symbol and uri are null while the coin's metadata are not read.

import { createHash } from "node:crypto";
import { clusterOf, callerOf, foreign, Limiter, base58, json, OutOfTime, publicTurn, backOff } from "./config.mjs";
import { call, callMany, NodeError } from "./history.mjs";

const LIST_MS = 4000;                                    // how often this instance reads the program's account list
const WAIT_MS = 2000;                                    // how long an answer waits for a new read when it has a list
const STALE_MS = 60_000;                                 // how old a list may be and still be given when the node fails
const RETRY_MS = 3000;                                   // after a read that failed or was refused, no new one before this
const BUDGET_MS = 5000;                                  // how long an answer may spend, its waits for the node included
const SLICE_MS = 3000;                                   // the same for a slice (limit): the landing's page waits 5 s for it
const ROUND = 10;                                        // calls of 100 mints in one round, to a paid node
const MAX_READ = 64 * 1024 * 1024;                       // the node's account list, read here (about 690 bytes a pool)
const MAX_ANSWER = 4 * 1024 * 1024;                      // Vercel answers up to about 4.5 MB
const MAX_METAS = 100_000;
const POOL_LEN = 8 + 336;
const KEYS_END = 8 + 32 * 5;                             // the mint, then the creator, treasury, vault and hook program
const VOLUME = KEYS_END + 8 * 10;                        // the last of the eleven u64 amounts
const OPENED_AT = KEYS_END + 8 * 11;                     // the i64 after the eleven u64 amounts
const POOL_TAG = createHash("sha256").update("account:Pool").digest().subarray(0, 8);   // Anchor's mark of a Pool account
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AFTER = /^(-?\d{1,16})\.([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const asks = new Limiter(60, 10_000);
const lists = new Map();                                 // cluster -> { at, pools: [{ address, data, mint, openedAt, volume }] }
const reading = new Map();                               // cluster -> the read of its list under way
const cooling = new Map();                               // cluster -> { until, failure } after a read that failed or was refused
const metas = new Map();                                 // cluster|mint -> [name, symbol, uri]
const filling = new Map();                               // cluster -> the round of metadata under way

function keep(map, key, value, max) { map.delete(key); map.set(key, value); if (map.size > max) map.delete(map.keys().next().value); }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, Math.max(0, ms)));
const metaKey = (cluster, mint) => `${cluster.name}|${mint}`;

/** The node's answer to one call, read up to MAX_READ bytes; a 429 comes back as { error: { code: 429 } }. */
async function callLarge(cluster, body) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(cluster.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    if (res.status === 429) return { id: body.id, error: { code: 429 } };
    if (!res.ok) throw new NodeError(`The node answered HTTP ${res.status}`, res.status);
    const parts = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_READ) { ctl.abort(); throw new Error("The node's account list is too large"); }
        parts.push(value);
      }
    }
    try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new NodeError(`The node's answer was not JSON (HTTP ${res.status})`, res.status); }
  } finally { clearTimeout(timer); }
}

/**
 * The program's Pool accounts, newest first: owned by the program, a Pool's size, with a Pool's mark (the node is asked
 * for only those, and what it sends is checked again). On the public node at its turn; null when that comes after
 * `until`, or the node answers 429.
 */
async function readList(cluster, until) {
  if (!(await publicTurn(cluster, until))) return null;
  const r = await callLarge(cluster, { jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [cluster.program, {
    encoding: "base64", commitment: "confirmed", filters: [{ dataSize: POOL_LEN }, { memcmp: { offset: 0, bytes: base58(POOL_TAG) } }],
  }] });
  if (r?.error?.code === 429) { backOff(cluster); return null; }
  if (!Array.isArray(r?.result)) throw new Error("node");
  const pools = [];
  for (const a of r.result) {
    const d = a?.account?.data;
    if (a?.account?.owner !== cluster.program || typeof a.pubkey !== "string" || !ADDRESS.test(a.pubkey) || !Array.isArray(d) || typeof d[0] !== "string") continue;
    const data = Buffer.from(d[0], "base64");
    if (data.length !== POOL_LEN || !data.subarray(0, 8).equals(POOL_TAG)) continue;
    pools.push({ address: a.pubkey, data, mint: base58(data.subarray(8, 40)), openedAt: Number(data.readBigInt64LE(OPENED_AT)), volume: data.readBigUInt64LE(VOLUME) });
  }
  pools.sort((a, b) => b.openedAt - a.openedAt || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
  return { at: Date.now(), pools };
}

/**
 * The list as of LIST_MS ago at most: one read for every answer that wants it meanwhile. While a kept list is under
 * STALE_MS old, it is given when that read is slow (after WAIT_MS), fails, or waits for a late turn of the public node.
 * Otherwise the read's error, or OutOfTime when the read is not in by `until` (it goes on for the next answers) or the
 * node refused it. A read that failed or was refused is not tried again for RETRY_MS: meanwhile its answer stands.
 */
async function listOf(cluster, until) {
  const name = cluster.name, kept = lists.get(name);
  if (kept && Date.now() - kept.at < LIST_MS) return kept;
  const usable = kept && Date.now() - kept.at < STALE_MS, cool = cooling.get(name);
  let job = reading.get(name);
  if (!job && cool && Date.now() < cool.until) {
    if (usable) return kept;
    throw cool.failure ?? new OutOfTime();
  }
  if (!job) {
    const failed = (failure) => cooling.set(name, { until: Date.now() + RETRY_MS, failure });
    job = readList(cluster, until).then((got) => { if (got) lists.set(name, got); else failed(null); return got; }, (err) => { failed(err); throw err; })
      .finally(() => reading.delete(name));
    job.catch(() => {});                                 // an answer that stopped waiting for it is not there to hear it
    reading.set(name, job);
  }
  let got = null, failure = null;
  try { got = await Promise.race([job, sleep(usable ? Math.min(WAIT_MS, until - Date.now()) : until - Date.now()).then(() => null)]); } catch (err) { failure = err; }
  if (got) return got;
  if (usable) return kept;
  throw failure ?? new OutOfTime();
}

/** Name, symbol and link from a Token-2022 mint's metadata extension (type 19), or empty ones when it has none. */
export function mintMetadata(data) {
  let at = 166;
  try {
    while (at + 4 <= data.length) {
      const type = data.readUInt16LE(at), len = data.readUInt16LE(at + 2);
      if (type === 19) {
        let p = at + 4 + 64;                             // after the update authority and the mint
        const str = (max) => { const n = data.readUInt32LE(p), s = data.subarray(p + 4, p + 4 + n).toString("utf8"); p += 4 + n; return s.slice(0, max); };
        return [str(64), str(32), str(256)];
      }
      if (type === 0) break;
      at += 4 + len;
    }
  } catch { /* cut short: as if it had none */ }
  return ["", "", ""];
}

/**
 * Reads the metadata of up to ROUND × 100 mints (100 on the public node, at its turn) and keeps those the node served.
 * False when the public node's turn came after `until` or the node answered 429.
 */
async function readRound(cluster, mints, until) {
  const list = [];
  for (let i = 0; i < mints.length; i += 100) list.push({ jsonrpc: "2.0", id: list.length, method: "getMultipleAccounts", params: [mints.slice(i, i + 100), { encoding: "base64", commitment: "confirmed" }] });
  let replies;
  if (cluster.paid) replies = await callMany(cluster, list);
  else {
    if (!(await publicTurn(cluster, until))) return false;
    replies = [await call(cluster, list[0])];
  }
  const byId = new Map((Array.isArray(replies) ? replies : []).map((r) => [r?.id, r]));
  let refused = false;
  for (const c of list) {
    const r = byId.get(c.id), values = r?.result?.value;
    if (r?.error?.code === 429) refused = true;
    if (!Array.isArray(values)) continue;
    c.params[0].forEach((mint, j) => {
      const v = values[j];
      // only a Token-2022 mint's own metadata: what the launch sealed
      if (v?.owner === TOKEN_2022 && Array.isArray(v.data) && typeof v.data[0] === "string") keep(metas, metaKey(cluster, mint), mintMetadata(Buffer.from(v.data[0], "base64")), MAX_METAS);
    });
  }
  if (refused) { backOff(cluster); return false; }
  return true;
}

/**
 * Reads the metadata missing for `mints` (in the answer's order: newest first, or the most traded first), a round at a
 * time, until they are all in or `until`: one answer reads a round and the others wait for it, then look again. A mint
 * the node did not serve is not asked for again by the same answer.
 */
async function fill(cluster, mints, until) {
  const tried = new Set();
  for (;;) {
    const want = mints.filter((m) => !metas.has(metaKey(cluster, m)) && !tried.has(m));
    const left = until - Date.now();
    if (!want.length || left <= 0) return;
    const busy = filling.get(cluster.name);
    if (busy) { await Promise.race([busy, sleep(left)]); continue; }
    const part = want.slice(0, cluster.paid ? ROUND * 100 : 100);
    part.forEach((m) => tried.add(m));
    const round = readRound(cluster, part, until).catch((err) => { console.error("pools: metadata:", err); return false; })
      .finally(() => filling.delete(cluster.name));
    filling.set(cluster.name, round);
    if ((await Promise.race([round, sleep(left).then(() => true)])) === false) return;   // a failure or a late turn: the next answer goes on
  }
}

/** A pool for the coin board: its mint and everything after the four keys, so the page reads it as a whole pool. */
const boardOf = (data) => Buffer.concat([data.subarray(8, 40), data.subarray(KEYS_END)]).toString("base64");

/** The most traded first; the sort keeps the list's own order (newest first, then by mint) between equal volumes. */
const byVolume = (a, b) => (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0);

/**
 * The answer for the first `limit` pools of a list, newest first or (`sort` "volume") the most traded first, and those
 * after `after` when it names one (newest first only), once their metadata are in or `until`: { text, complete }
 * (complete: every pool in it named). A complete one is kept with its list, for the answers that ask the same of it (a
 * few: each can be MBs); the list sorted by volume is kept with it too, so the order is worked out once a read.
 */
async function answerOf(cluster, snap, limit, board, sort, after, until) {
  const key = `${board}|${limit}|${sort}|${after ? `${after.openedAt}.${after.mint}` : ""}`, kept = snap.answers?.get(key);
  if (kept) return kept;
  const order = sort === "volume" ? (snap.byVolume ??= [...snap.pools].sort(byVolume)) : snap.pools;
  let from = 0;
  if (after) {
    from = order.findIndex((p) => p.openedAt < after.openedAt || (p.openedAt === after.openedAt && p.mint > after.mint));
    if (from < 0) from = order.length;
  }
  const pools = order.slice(from, from + limit);
  await fill(cluster, pools.map((p) => p.mint), until);
  const rows = [];
  let size = 100, named = 0;
  for (const p of pools) {
    const m = metas.get(metaKey(cluster, p.mint)), [name, symbol, uri] = m ?? [null, null, null];
    const row = JSON.stringify(board ? [p.board ??= boardOf(p.data), name, symbol] : [p.address, p.b64 ??= p.data.toString("base64"), name, symbol, uri]);
    size += Buffer.byteLength(row) + 1;
    if (size > MAX_ANSWER) break;
    rows.push(row);
    if (m) named++;
  }
  const out = { text: `{"at":${snap.at},"total":${snap.pools.length},"cut":${rows.length < pools.length},"pools":[${rows.join(",")}]}`, complete: named === rows.length };
  if (out.complete) keep(snap.answers ??= new Map(), key, out, 8);
  return out;
}

export async function handlePools(request, env = {}) {
  try {
    if (request.method !== "GET") return json({ error: "GET only" }, 405, { allow: "GET" });
    if (foreign(request)) return json({ error: "This server is for this site's own pages" }, 403);
    const q = new URL(request.url).searchParams;
    const cluster = clusterOf(q.get("cluster") ?? "", env);
    if (!cluster) return json({ error: "Unknown cluster" }, 400);
    if (!cluster.url || !cluster.program) return json({ error: `Nox is not on ${cluster.name} yet` }, 503);
    const limit = q.has("limit") ? Math.min(100, Math.max(1, Math.floor(Number(q.get("limit"))) || 100)) : Infinity;
    const board = q.get("board") === "1";
    const a = q.has("after") ? AFTER.exec(q.get("after")) : null;
    if (q.has("after") && !a) return json({ error: "after: a pool's openedAt and mint, as <openedAt>.<mint>" }, 400);
    const sort = q.has("sort") ? q.get("sort") : "";
    if (q.has("sort") && sort !== "volume") return json({ error: "sort: volume, or none for the newest first" }, 400);
    if (sort && a) return json({ error: "after: only for the newest first, not with sort" }, 400);
    if (!asks.take(callerOf(request))) return json({ error: "Too many asks from here; slow down" }, 429, { "retry-after": "5" });

    const until = Date.now() + (Number.isFinite(limit) ? SLICE_MS : BUDGET_MS);
    let snap;
    try { snap = await listOf(cluster, until); } catch (err) {
      // the list is not in by the answer's time (a slow node, a 429, a late turn of the public node), and nothing kept answers
      if (!(err instanceof OutOfTime)) throw err;
      return json({ error: "The node is busy; ask again shortly" }, 503, { "retry-after": "3" });
    }
    const { text, complete } = await answerOf(cluster, snap, limit, board, sort, a && { openedAt: Number(a[1]), mint: a[2] }, until);
    return new Response(text, { status: 200, headers: {
      "content-type": "application/json",
      "cache-control": complete ? "public, max-age=0, s-maxage=4, stale-while-revalidate=10" : "public, max-age=0, s-maxage=1",
    } });
  } catch (err) {
    console.error("pools:", err);                       // the details stay in the server's log: they can name the node
    return json({ error: "The node did not answer" }, 502);
  }
}
