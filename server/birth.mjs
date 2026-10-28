// A coin's birth, for its page: /api/birth?cluster=…&pool=<pool address>. From the pool's first transactions it
// gives the launch (when, by whom, the creator's buy in it), the first FIRST buyers, and for each one where the SOL
// that wallet started with came from: the sender of the wallet's oldest SOL before its first buy, one hop, with the
// transaction. Facts only, each with its signature: the page says "funded by", never "linked to".
//
// A birth does not change, so once it has its FIRST buyers it is kept here and cached at the edge for an hour; a coin
// with fewer buyers yet is read again after a minute. With a paid node one answer does it all; on the public node the
// calls keep its pace (one every 1.3 s) and an answer gives what it has (complete: false), the next one goes on.
//
// Answer: { complete, tooOld, launch: { signature, slot, time, creator, firstBuy: { sol, tokens } | null },
//           buyers: [{ wallet, signature, slot, time, sol, creator, funding }] }
//   funding: { by, signature, time, sol } | { older: true } (a wallet with over 1,000 transactions before) | { none: true }

import { createHash } from "node:crypto";
import { clusterOf, addressBytes, callerOf, foreign, Limiter, json, base58 } from "./config.mjs";
import { call, isPool, ownLines } from "./history.mjs";

const FIRST = 10;
const PAGES = 5;                                         // 5,000 transactions back at most
const OLDEST = 60;                                       // the first transactions read for buyers
const BUDGET_MS = 8000;
const PUBLIC_GAP = 1312;
const KEEP_MS = 60 * 60 * 1000, YOUNG_MS = 60_000;
const asks = new Limiter(30, 10_000);
const jobs = new Map();                                  // cluster|pool -> { at, state, result, running }
const nextAt = {};
const tag = (name) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const TRADE = tag("TradeEvent"), LAUNCHED = tag("Launched");

class OutOfTime extends Error {}

/** A call that keeps the public node's pace, and gives up when the answer's time is spent. */
async function paced(cluster, body, until) {
  if (!cluster.paid) {
    const wait = (nextAt[cluster.name] ?? 0) - Date.now();
    if (Date.now() + Math.max(0, wait) > until) throw new OutOfTime();
    if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
    nextAt[cluster.name] = Date.now() + PUBLIC_GAP;
  } else if (Date.now() > until) throw new OutOfTime();
  const r = await call(cluster, body);
  const errs = Array.isArray(r) ? r.filter((x) => x?.error) : r?.error ? [r] : [];
  if (errs.some((x) => x.error.code === 429)) { nextAt[cluster.name] = Date.now() + 12_000; throw new OutOfTime(); }
  return r;
}
const one = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });
const txParams = (sig) => [sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }];

/** The pool's events in one transaction, from its own log lines. */
export function events(lines) {
  const out = [];
  for (const b64 of lines) {
    const b = Buffer.from(b64, "base64");
    if (b.length >= 8 + 32 * 3 + 1 + 8 * 5 + 1 && b.subarray(0, 8).equals(TRADE)) {
      let at = 8;
      const key = () => { const k = base58(b.subarray(at, at + 32)); at += 32; return k; };
      const u64 = () => { const v = b.readBigUInt64LE(at); at += 8; return v; };
      const mint = key(), trader = key(); key();
      const buy = b[at++] === 1, sol = u64(), tokens = u64();
      out.push({ kind: "trade", mint, trader, buy, sol, tokens });
    } else if (b.length >= 8 + 32 * 3 && b.subarray(0, 8).equals(LAUNCHED)) {
      out.push({ kind: "launch", mint: base58(b.subarray(8, 40)), creator: base58(b.subarray(40, 72)) });
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

/** Moves a birth on as far as the time allows; the state stays for the next ask. */
async function advance(cluster, pool, st, until) {
  // 1. the pool's oldest transactions: page back until a page is short (the start) or PAGES pages
  while (!st.listed) {
    const r = await paced(cluster, one("getSignaturesForAddress", [pool, { limit: 1000, commitment: "confirmed", ...(st.before ? { before: st.before } : {}) }]), until);
    if (!Array.isArray(r?.result)) throw new Error("node");
    st.sigs.push(...r.result);
    st.pages++;
    if (r.result.length < 1000) st.listed = true;
    else if (st.pages >= PAGES) { st.listed = true; st.tooOld = true; }
    else st.before = r.result[r.result.length - 1].signature;
  }
  if (st.tooOld) return;
  if (!st.oldest) st.oldest = st.sigs.filter((s) => !s.err).slice(-OLDEST).reverse();
  // 2. the first buyers, in chain order, and the launch
  while (st.read < st.oldest.length && st.buyers.length < FIRST) {
    const part = st.oldest.slice(st.read, st.read + (cluster.paid ? 10 : 1));
    const r = await paced(cluster, part.map((s, id) => ({ jsonrpc: "2.0", id, method: "getTransaction", params: txParams(s.signature) })), until);
    const byId = new Map((Array.isArray(r) ? r : [r]).map((x) => [x?.id, x]));
    for (let k = 0; k < part.length; k++) {
      const s = part[k], tx = byId.get(k)?.result;
      if (!tx) return;                                   // not served (yet): the next ask reads on from here
      for (const e of events(ownLines(tx.meta?.logMessages, cluster.program))) {
        if (e.kind === "launch" && !st.launch) st.launch = { signature: s.signature, slot: s.slot ?? tx.slot ?? null, time: tx.blockTime ?? s.blockTime ?? null, creator: e.creator, firstBuy: null };
        if (e.kind === "trade" && e.buy) {
          if (st.launch && s.signature === st.launch.signature && e.trader === st.launch.creator && !st.launch.firstBuy) {
            st.launch.firstBuy = { sol: Number(e.sol) / 1e9, tokens: Number(e.tokens) / 1e6 };
          }
          if (st.buyers.length < FIRST && !st.buyers.some((b) => b.wallet === e.trader)) {
            st.buyers.push({ wallet: e.trader, signature: s.signature, slot: s.slot ?? tx.slot ?? null, time: tx.blockTime ?? s.blockTime ?? null, sol: Number(e.sol) / 1e9, creator: false, funding: null });
          }
        }
      }
      st.read++;
    }
  }
  for (const b of st.buyers) b.creator = !!st.launch && b.wallet === st.launch.creator;
  // 3. where each first buyer's SOL came from: the oldest transaction before its first buy, one hop
  for (const b of st.buyers) {
    if (b.funding) continue;
    if (!b.before) {
      const r = await paced(cluster, one("getSignaturesForAddress", [b.wallet, { limit: 1000, before: b.signature, commitment: "confirmed" }]), until);
      if (!Array.isArray(r?.result)) throw new Error("node");
      if (!r.result.length) { b.funding = { none: true }; continue; }
      if (r.result.length >= 1000) { b.funding = { older: true }; continue; }
      b.before = r.result[r.result.length - 1];
    }
    const r = await paced(cluster, one("getTransaction", txParams(b.before.signature)), until);
    const f = funder(r?.result, b.wallet);
    b.funding = f ? { ...f, signature: b.before.signature, time: r.result.blockTime ?? b.before.blockTime ?? null } : { none: true };
    delete b.before;
  }
  st.done = true;
}

const view = (st) => ({
  complete: !!st.done || !!st.tooOld, tooOld: !!st.tooOld, launch: st.launch ?? null,
  buyers: (st.buyers ?? []).map(({ before, ...b }) => b),
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

    const key = `${cluster.name}|${pool}`, now = Date.now();
    let job = jobs.get(key);
    if (job?.state.done && now - job.at > (job.state.buyers.length >= FIRST ? KEEP_MS : YOUNG_MS)) job = null;   // a young coin is read again
    if (!job) {
      if (!(await isPool(cluster, pool))) return json({ error: "Not a pool of this program" }, 404, { "cache-control": "public, s-maxage=60" });
      job = { at: now, running: null, state: { sigs: [], pages: 0, before: null, listed: false, tooOld: false, oldest: null, read: 0, launch: null, buyers: [], done: false } };
      jobs.set(key, job);
      if (jobs.size > 2000) jobs.delete(jobs.keys().next().value);
    }
    if (!job.state.done && !job.state.tooOld) {
      job.running ??= advance(cluster, pool, job.state, Date.now() + BUDGET_MS)
        .catch((err) => { if (!(err instanceof OutOfTime)) console.error("birth:", err); })
        .finally(() => { job.running = null; });
      await job.running;
    }
    const v = view(job.state);
    const final = v.complete && (v.tooOld || v.buyers.length >= FIRST);
    return json(v, 200, { "cache-control": final ? "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" : v.complete ? "public, max-age=0, s-maxage=60" : "public, max-age=0, s-maxage=1" });
  } catch (err) {
    console.error("birth:", err);
    return json({ error: "The node did not answer" }, 502);
  }
}
