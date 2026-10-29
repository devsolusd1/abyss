// A coin's birth, for its page: /api/birth?cluster=…&pool=<pool address>. From the pool's first transactions it
// gives the launch (when, by whom, the creator's buy in it), the first FIRST buyers (with an opening batch, the first
// wallets to take a seat in it count, `batch: true`, with the SOL they first put in, and their seats are followed
// until the batch settles), and for each one where the SOL that wallet started with came from: the sender of the
// wallet's oldest SOL before its first buy, one hop, with the transaction. Facts only, each with its signature: the
// page says "funded by", never "linked to". Only this pool's events count: a transaction can name the pool and carry
// another pool's events (the program ignores accounts it does not use), so each event's mint must be the pool's own.
//
// It reads the pool's first OLDEST transactions with an event of this pool, fetching FETCH at most (a transaction that
// only names the pool counts there). While one of the first buyers has a seat in an opening batch and the batch's
// settle has not been read, the OLDEST window does not stop the reading: only FETCH does, and a birth stopped there
// keeps seat.settled false (each seat as the last transaction read left it). A birth that has its FIRST buyers or its
// window read (and their seats settled), or FETCH fetched, with transactions after it, is final: it does not change,
// so it is kept in this instance's memory, cached at the edge for an hour and never read again. Any other birth keeps
// what it read, and a minute after its last listing (not while an ask is still reading it) only the signatures after
// the newest seen are listed and read on. With a paid node one answer does it all, unless the node refuses part of a
// batch (its plan's rate): what it served is read, and the next ask goes on. A node that takes no batches (RPC_BATCH=0,
// or it refused one in the last ten minutes: history.mjs callMany) gets the same transactions as single calls, a few at a time.
// On the public node every call keeps its pace (one every 1.3 s, on the mark the history shares) and an answer gives
// what it has (complete: false), the next one goes on. A transaction the node does not serve (null, or an error) is not
// read: the answer stays complete: false and the next ask tries it again.
//
// Answer: { complete, tooOld, read, more, launch, buyers }
//   complete: nothing more to read until the pool has new transactions. tooOld: 5,000 or more transactions, its start
//   further back than this pages. read: the pool's transactions with an event of this pool read from its start; more:
//   there are transactions after them not looked at (so the buyers may not be every buyer so far).
//   launch: { signature, slot, time, creator, firstBuy: { sol, tokens } | { sol, batch: true } (the creator's seat) | null }
//   buyers: [{ wallet, signature, slot, time, sol, creator, funding, batch?, seat? }], in chain order
//     seat (batch): { sol (in it at the end of what was read), settled (the batch's settle was read: sol is final),
//                     out (a withdrawal emptied it before the settle, and no commit took a seat again after it) }
//     funding: { by, signature, time, sol } | { older: true } (1,000 or more transactions before the buy)
//              | { none: true } (its oldest transactions before the buy that did not fail, up to TRIES, were all read
//              and none gave it SOL) | null (not read yet: complete is false)

import { createHash } from "node:crypto";
import { clusterOf, addressBytes, callerOf, foreign, Limiter, json, base58, OutOfTime, publicTurn, backOff } from "./config.mjs";
import { call, callMany, NodeError, poolMint, ownLines } from "./history.mjs";

const FIRST = 10;
const PAGES = 5;                                         // 5,000 transactions back at most
const OLDEST = 60;                                       // the first transactions read for buyers (with an event of the pool)
const FETCH = 200;                                       // transactions fetched at most (ones that only name the pool too)
const TRIES = 3;                                         // a buyer's oldest transactions read for its funding
const BUDGET_MS = 8000;
const YOUNG_MS = 60_000;                                 // a birth that is not final lists new transactions this often
const MAX_JOBS = 2000;
const asks = new Limiter(30, 10_000);
const jobs = new Map();                                  // cluster|pool -> { state, view (once final), running }
const tag = (name) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const TRADE = tag("TradeEvent"), LAUNCHED = tag("Launched"), COMMITTED = tag("Committed"), WITHDRAWN = tag("Withdrawn"), SETTLED = tag("Settled");
const OTHERS = ["SeatClaimed", "Graduated", "FeesClaimed", "CreatorChanged"].map(tag);   // the pool's too: they count as read

/**
 * A call that keeps the public node's pace (the turn the history takes too), and gives up when the answer's time is
 * spent or the node refuses all of it (429). A batch it refuses only in part (a paid plan's rate) comes back as it is:
 * the caller reads what was served, up to the first one that was not. `send` is call, or callMany for several calls
 * (one batch, or single calls to a node that takes no batches).
 */
async function paced(cluster, body, until, send = call) {
  if (!(await publicTurn(cluster, until)) || (cluster.paid && Date.now() > until)) throw new OutOfTime();
  const r = await send(cluster, body);
  const all = Array.isArray(r) ? r : [r], refused = all.filter((x) => x?.error?.code === 429).length;
  if (refused) backOff(cluster);
  if (refused && refused === all.length) throw new OutOfTime();
  return r;
}
const one = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });
const txParams = (sig) => [sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }];

/** The pool's events in one transaction, from its own log lines. */
export function events(lines) {
  const out = [];
  for (const b64 of lines) {
    const b = Buffer.from(b64, "base64"), head = b.subarray(0, 8);
    if (b.length >= 8 + 32 * 3 + 1 + 8 * 5 + 1 && head.equals(TRADE)) {
      let at = 8;
      const key = () => { const k = base58(b.subarray(at, at + 32)); at += 32; return k; };
      const u64 = () => { const v = b.readBigUInt64LE(at); at += 8; return v; };
      const mint = key(), trader = key(); key();
      const buy = b[at++] === 1, sol = u64(), tokens = u64();
      out.push({ kind: "trade", mint, trader, buy, sol, tokens });
    } else if (b.length >= 8 + 32 * 2 + 8 * 3 && (head.equals(COMMITTED) || head.equals(WITHDRAWN))) {
      out.push({ kind: head.equals(COMMITTED) ? "commit" : "withdraw", mint: base58(b.subarray(8, 40)), owner: base58(b.subarray(40, 72)),
        sol: b.readBigUInt64LE(72), seatSol: b.readBigUInt64LE(80), total: b.readBigUInt64LE(88) });
    } else if (b.length >= 8 + 32 + 8 * 2 + 4 + 1 && head.equals(SETTLED)) {
      out.push({ kind: "settled", mint: base58(b.subarray(8, 40)), sol: b.readBigUInt64LE(40), tokens: b.readBigUInt64LE(48), seats: b.readUInt32LE(56), refund: b[60] === 1 });
    } else if (b.length >= 8 + 32 * 3 && head.equals(LAUNCHED)) {
      out.push({ kind: "launch", mint: base58(b.subarray(8, 40)), creator: base58(b.subarray(40, 72)) });
    } else if (b.length >= 8 + 32 && OTHERS.some((t) => head.equals(t))) {
      out.push({ kind: "other", mint: base58(b.subarray(8, 40)) });
    }
  }
  return out;
}

/** Who sent `wallet` the SOL it gained in transaction `tx`: the account whose balance fell most. */
export function funder(tx, wallet) {
  const msg = tx?.transaction?.message, meta = tx?.meta;
  if (!msg || !meta) return null;
  const keys = [...(msg.accountKeys ?? []), ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])].map(String);
  const i = keys.indexOf(wallet);
  if (i < 0) return null;
  const delta = (j) => (meta.postBalances?.[j] ?? 0) - (meta.preBalances?.[j] ?? 0);
  if (!(delta(i) > 0)) return null;
  let by = -1;
  for (let j = 0; j < keys.length; j++) if (j !== i && delta(j) < 0 && (by < 0 || delta(j) < delta(by))) by = j;
  return by < 0 ? null : { by: keys[by], sol: delta(i) / 1e9 };
}

/*
 * A birth's state, between asks: the signatures listed and not read yet (the oldest that may still be fetched, in
 * chain order), the newest signature seen (the next listing stops there) and when that listing ended, and what was read.
 */
const listing = (until) => ({ until, before: null, top: null, got: [], cut: false, pages: 0 });
const fresh = (mint) => ({
  mint, list: listing(null), newest: null, listedAt: 0, queue: [], beyond: false, fetched: 0, read: 0,
  launch: null, buyers: [], settled: false, tooOld: false, done: false,
});
/** One of the first buyers has a seat in the batch and the settle was not read yet: the seats are followed on. */
const seated = (st) => !st.settled && st.buyers.some((b) => b.batch);
/** Nothing more is read for buyers: FETCH fetched, or the window read or the FIRST buyers in, with no seat to follow. */
const stopped = (st) => st.fetched >= FETCH || (!st.queue.length && st.beyond)
  || (!seated(st) && (st.read >= OLDEST || st.buyers.length >= FIRST));
/** There are transactions after the ones read that were not looked at. */
const more = (st) => st.tooOld || st.queue.length > 0 || st.beyond || !!(st.list && (st.list.got.length || st.list.cut));
/** It will not change: nothing more is read, and what comes after it is known to be there. */
const final = (st) => st.tooOld || (st.done && stopped(st) && more(st));

/** What one transaction tells of the birth, from this pool's events in it. */
function take(st, pool, signature, tx, program) {
  const evs = events(ownLines(tx.meta?.logMessages, program)).filter((e) => e.mint === st.mint);   // not another pool's
  if (!evs.length) return;
  st.read++;
  const at = { signature, slot: tx.slot ?? null, time: tx.blockTime ?? null }, sol = (lamports) => Number(lamports) / 1e9;
  const inLaunch = () => st.launch && signature === st.launch.signature && !st.launch.firstBuy;
  for (const e of evs) {
    if (e.kind === "launch" && !st.launch) st.launch = { ...at, creator: e.creator, firstBuy: null };
    if (e.kind === "settled") st.settled = true;
    if (e.kind === "commit" || e.kind === "withdraw") {
      let b = st.buyers.find((x) => x.wallet === e.owner);
      if (e.kind === "commit") {
        if (inLaunch() && e.owner === st.launch.creator) st.launch.firstBuy = { sol: sol(e.sol), batch: true };
        if (!b && st.buyers.length < FIRST) st.buyers.push(b = { wallet: e.owner, ...at, sol: sol(e.sol), creator: false, funding: null, batch: true, seat: { sol: 0, out: false } });
      }
      // withdrawing all of it closes the seat (out); a commit after it takes a seat again (the program makes it anew)
      if (b?.seat && !st.settled) { b.seat.sol = sol(e.seatSol); b.seat.out = e.kind === "commit" ? false : b.seat.out || e.seatSol === 0n; }
    }
    if (e.kind === "trade" && e.buy && e.trader !== pool) {          // the batch's own buy (by the pool) is its seats'
      if (inLaunch() && e.trader === st.launch.creator) st.launch.firstBuy = { sol: sol(e.sol), tokens: Number(e.tokens) / 1e6 };
      if (st.buyers.length < FIRST && !st.buyers.some((b) => b.wallet === e.trader)) st.buyers.push({ wallet: e.trader, ...at, sol: sol(e.sol), creator: false, funding: null });
    }
  }
}

/** Moves a birth on as far as the time allows; the state stays for the next ask. */
async function advance(cluster, pool, st, until) {
  // 1. the pool's signatures, newest first: back to its start the first time (PAGES pages at most, then one more to see
  // whether the start was in them), afterwards only those after the newest seen
  while (st.list) {
    const L = st.list, probe = L.pages >= PAGES;
    const r = await paced(cluster, one("getSignaturesForAddress", [pool, { limit: probe ? 1 : 1000, commitment: "confirmed", ...(L.before ? { before: L.before } : {}), ...(L.until ? { until: L.until } : {}) }]), until);
    if (!Array.isArray(r?.result)) throw new Error("node");
    let end = probe;
    if (probe && r.result.length) {
      if (!L.until) { st.tooOld = true; st.list = null; st.done = true; return; }
      L.got = []; L.cut = true;                          // more new ones than are paged: they cannot be read in order
    } else if (!probe) {
      if (!L.pages && r.result.length) L.top = r.result[0].signature;
      L.pages++;
      for (const s of r.result) if (s && !s.err && typeof s.signature === "string" && s.signature.length <= 90) L.got.push(s.signature);
      const room = Math.max(0, FETCH - st.fetched - st.queue.length);
      if (L.got.length > room) { L.got = L.got.slice(L.got.length - room); L.cut = true; }   // the oldest are the ones kept
      if (r.result.length < 1000) end = true; else L.before = r.result[r.result.length - 1].signature;
    }
    if (end) { st.queue.push(...L.got.reverse()); st.beyond ||= L.cut; if (L.top) st.newest = L.top; st.list = null; st.listedAt = Date.now(); }
  }
  // 2. the transactions, oldest first: the launch, the first buyers, and their seats until the batch settles
  while (st.queue.length && !stopped(st)) {
    const part = st.queue.slice(0, Math.min(cluster.paid ? 10 : 1, FETCH - st.fetched));
    const r = await paced(cluster, part.map((sig, id) => ({ jsonrpc: "2.0", id, method: "getTransaction", params: txParams(sig) })), until, callMany);
    const byId = new Map(r.map((x) => [x?.id, x]));
    for (let k = 0; k < part.length && !stopped(st); k++) {
      const tx = byId.get(k)?.result;
      if (!tx) return;                                   // not served (yet): the next ask reads on from here
      st.queue.shift();
      st.fetched++;
      take(st, pool, part[k], tx, cluster.program);
    }
  }
  // 3. where each first buyer's SOL came from: its oldest transactions before its first buy that did not fail, one hop.
  // One the node does not serve (null, or an error) is not read: that buyer waits for the next ask, the others go on
  let unread = false;
  for (const b of st.buyers) {
    if (b.funding) continue;
    if (!b.look) {
      const r = await paced(cluster, one("getSignaturesForAddress", [b.wallet, { limit: 1000, before: b.signature, commitment: "confirmed" }]), until);
      if (!Array.isArray(r?.result)) throw new Error("node");
      if (r.result.length >= 1000) { b.funding = { older: true }; continue; }
      b.look = r.result.filter((s) => s && !s.err && typeof s.signature === "string").slice(-TRIES).reverse().map((s) => s.signature);
    }
    while (b.look.length && !b.funding) {
      // an HTTP error on it is the node not serving it, like an error in its answer
      const tx = (await paced(cluster, one("getTransaction", txParams(b.look[0])), until).catch((err) => { if (err instanceof NodeError) return null; throw err; }))?.result;
      if (!tx?.meta) break;
      const f = funder(tx, b.wallet);
      if (f) b.funding = { ...f, signature: b.look[0], time: tx.blockTime ?? null };
      else b.look.shift();
    }
    if (!b.funding && b.look.length) { unread = true; continue; }   // no "none" and no later sender for what was not read
    b.funding ??= { none: true };
    delete b.look;
  }
  if (!unread && !st.list) st.done = true;              // a listing opened meanwhile is read first
}

const view = (st) => ({
  complete: st.done, tooOld: st.tooOld, read: st.read, more: more(st), launch: st.launch,
  buyers: st.buyers.map(({ look, seat, ...b }) => ({
    ...b, creator: !!st.launch && b.wallet === st.launch.creator, ...(seat ? { seat: { sol: seat.sol, settled: st.settled, out: seat.out } } : {}),
  })),
});

export async function handleBirth(request, env = {}) {
  try {
    if (request.method !== "GET") return json({ error: "GET only" }, 405, { allow: "GET" });
    if (foreign(request)) return json({ error: "This server is for this site's own pages" }, 403);
    const q = new URL(request.url).searchParams;
    const cluster = clusterOf(q.get("cluster") ?? "", env);
    if (!cluster) return json({ error: "Unknown cluster" }, 400);
    if (!cluster.url || !cluster.program) return json({ error: `Nox is not on ${cluster.name} yet` }, 503);
    const pool = q.get("pool") ?? "";
    if (!addressBytes(pool)) return json({ error: "Not an address" }, 400);
    if (!asks.take(callerOf(request))) return json({ error: "Too many asks from here; slow down" }, 429, { "retry-after": "5" });

    const key = `${cluster.name}|${pool}`, until = Date.now() + BUDGET_MS;
    let job = jobs.get(key);
    if (job) { jobs.delete(key); jobs.set(key, job); }  // the least asked for goes first when there are too many
    else {
      let mint;
      try { mint = await poolMint(cluster, pool, until); } catch (err) {
        if (!(err instanceof OutOfTime)) throw err;      // the node's turn comes later (or a 429): nothing read yet, ask again
        return json(view(fresh(null)), 200, { "cache-control": "public, max-age=0, s-maxage=1" });
      }
      if (!mint) return json({ error: "Not a pool of this program" }, 404, { "cache-control": "public, s-maxage=60" });
      job = { state: fresh(mint), view: null, running: null };
      jobs.set(key, job);
      if (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
    }
    if (!job.view) {
      const st = job.state;
      // anything new? Not under a run still going: it is past its listing, and would end done with this one unread
      if (!job.running && !st.list && Date.now() - st.listedAt >= YOUNG_MS) { st.done = false; st.list = listing(st.newest); }
      if (!st.done) {
        job.running ??= advance(cluster, pool, st, until)
          .catch((err) => { if (!(err instanceof OutOfTime)) console.error("birth:", err); })
          .finally(() => { job.running = null; if (final(st)) { job.view = view(st); job.state = null; } });   // only the answer is kept
        await job.running;
      }
    }
    const v = job.view ?? view(job.state);
    return json(v, 200, { "cache-control": job.view ? "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" : v.complete ? "public, max-age=0, s-maxage=60" : "public, max-age=0, s-maxage=1" });
  } catch (err) {
    console.error("birth:", err);
    return json({ error: "The node did not answer" }, 502);
  }
}
