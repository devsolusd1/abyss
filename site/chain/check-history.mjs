// Checks Chain.readHistory against a fake node on this machine that limits getTransaction the way devnet's public node
// does (a call past LIMIT in any window is refused with 429, and refused calls count too), on a timescale ten times
// shorter: the reader is set to 8 calls per 1.05 s, the node allows 10 per 1 s. Nothing touches a real cluster.
//
//   node check-history.mjs

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

// a browser's localStorage, kept in a Map, so the bundle's kept transactions can be read by a second copy of it
const disk = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => { disk.set(k, String(v)); },
    removeItem: (k) => { disk.delete(k); },
  },
};
const require = createRequire(import.meta.url);
const BUNDLE = require.resolve("../vendor/chain.js");
const fresh = () => { delete require.cache[BUNDLE]; return require(BUNDLE); };   // a page loaded anew
let Chain = fresh();

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };

/* ---------- the fake node ---------- */

const WIN = 1000;
const node = { limit: 10, calls: [], refused: 0, served: 0, unserved: new Map(), broken: false, always429: false, refuseNext: 0, slow: 0 };
const hist = { mode: "full", asked: 0, lists: 0 };   // the fake history server, and how often the list is read directly
const pools = new Map();                     // pool address -> [{ signature, blockTime, err, data: [base64] }], newest first
const tag = (name) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const key32 = (n) => Buffer.alloc(32, n);
// events name their coin (the reader drops another coin's): key32(1) when none is given
const mintBytes = (m) => (m ? Buffer.from(new Chain.PublicKey(m).toBytes()) : key32(1));
function trade(i, buy, m) {
  return Buffer.concat([tag("TradeEvent"), mintBytes(m), key32(2), key32(2), Buffer.from([buy ? 1 : 0]), u64(1000 + i), u64(10 + i),
    u64(1), u64(5000 + i), u64(1e15 - i), Buffer.from([0])]).toString("base64");
}
const launched = (m) => Buffer.concat([tag("Launched"), mintBytes(m), key32(2), key32(0), u64(30e9), u64(42e9), Buffer.from([100, 0])]).toString("base64");

/** A pool with n transactions: the first is the launch with a first buy (two events in one), each later one a trade. */
function makePool(mint, n, { failedAt = -1 } = {}) {
  const pool = Chain.poolAddress(mint).toBase58(), list = [];
  for (let i = 0; i < n; i++) {
    const signature = `${mint.slice(0, 6)}sig${String(i).padStart(4, "0")}`.padEnd(88, "x");
    list.unshift({ signature, blockTime: 1_800_000_000 + i * 60, err: i === failedAt ? { InstructionError: [0, "Custom"] } : null,
      data: i === 0 ? [launched(mint), trade(0, true, mint)] : [trade(i, i % 3 !== 0, mint)] });
  }
  pools.set(pool, list);
  return list;
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    // the site's history server (server/history.mjs), as a page sees it: GET /history?cluster=…&pool=…&limit=…
    if (req.method === "GET" && req.url.startsWith("/history")) {
      hist.asked++;
      if (hist.mode === "broken") return send(500, { error: "broken" });
      const q = new URL(req.url, "http://x").searchParams, list = (pools.get(q.get("pool")) ?? []).slice(0, Number(q.get("limit") ?? 100));
      const ok = list.filter((s) => !s.err), keep = hist.mode === "partial" ? ok.slice(0, Math.ceil(ok.length / 2)) : ok;
      const txs = Object.fromEntries(keep.map((s) => [s.signature, { t: s.blockTime, d: s.data }]));
      return send(200, { total: ok.length, have: keep.length, complete: keep.length === ok.length, signatures: list.map((s) => ({ signature: s.signature, blockTime: s.blockTime, err: s.err ? true : null })), txs });
    }
    const call = JSON.parse(body);
    if (call.method === "getSignaturesForAddress") hist.lists++;
    if (Array.isArray(call)) return send(400, { error: "no batches here" });
    const { id, method, params } = call;
    if (method === "getSignaturesForAddress") {
      const list = (pools.get(params[0]) ?? []).slice(0, params[1]?.limit ?? 1000);
      return send(200, { jsonrpc: "2.0", id, result: list.map((s, i) => ({ signature: s.signature, slot: 1000 - i, err: s.err, memo: null, blockTime: s.blockTime, confirmationStatus: "finalized" })) });
    }
    if (method !== "getTransaction") return send(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "not here" } });
    const now = Date.now();
    node.calls = node.calls.filter((t) => t > now - WIN);
    node.calls.push(now);                                       // refused calls count too, as on devnet
    if (node.refuseNext > 0) { node.refuseNext--; node.refused++; return send(429, { jsonrpc: "2.0", id, error: { code: 429, message: "Too many requests" } }); }
    if (node.always429 || node.calls.length > node.limit) { node.refused++; return send(429, { jsonrpc: "2.0", id, error: { code: 429, message: "Too many requests for a specific RPC call" } }); }
    if (node.broken) return send(500, { jsonrpc: "2.0", id, error: { code: -32603, message: "broken" } });
    if (node.slow) await new Promise((ok) => setTimeout(ok, node.slow));
    const sig = params[0];
    let tx = null;
    for (const list of pools.values()) for (const s of list) if (s.signature === sig) tx = s;
    const left = node.unserved.get(sig) ?? 0;
    if (left > 0) { node.unserved.set(sig, left - 1); return send(200, { jsonrpc: "2.0", id, result: null }); }
    node.served++;
    // logged as the chain does: inside the pool program's invoke; then another program logs a forged trade
    const P = "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK", E = "Evi1111111111111111111111111111111111111111";
    send(200, { jsonrpc: "2.0", id, result: tx && { blockTime: tx.blockTime, slot: 1, meta: { err: tx.err, logMessages: [
      `Program ${P} invoke [1]`, "Program log: Instruction: Buy", ...tx.data.map((d) => `Program data: ${d}`), `Program ${P} success`,
      `Program ${E} invoke [1]`, `Program data: ${trade(999, true)}`, `Program ${E} success`,
    ] } } });
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const NETCFG = { cluster: "fake", rpcUrl: `http://127.0.0.1:${server.address().port}`, program: "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK", historyPace: 8, historyWindowMs: 1050 };
Chain.setNet(NETCFG);

// a fresh mint per case, so nothing is kept from another case
let mints = 0;
const mint = () => { const k = Chain.Keypair.generate().publicKey.toBase58(); mints++; return k; };
const reset = () => { node.calls = []; node.refused = 0; node.served = 0; };
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
const busiest = () => { // the most calls the node saw in any window
  let most = 0; const c = [...log]; for (let i = 0; i < c.length; i++) { let n = 0; for (let j = i; j < c.length && c[j] < c[i] + WIN; j++) n++; most = Math.max(most, n); } return most;
};
const log = [], asked = [];                    // when each getTransaction went out, and for which transaction
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (init?.body?.includes("getTransaction")) { log.push(Date.now()); asked.push(JSON.parse(init.body).params[0]); }
  return realFetch(url, init);
};
const newTx = (list, m, i) => { const s = { signature: `${m.slice(0, 6)}new${String(i).padStart(4, "0")}`.padEnd(88, "x"), blockTime: 1_900_000_000 + i * 60, err: null, data: [trade(200 + i, true, m)] }; list.unshift(s); return s; };

/* ---------- 1. a cold read: whole, in order, at the pace, newest first ---------- */
{
  reset(); log.length = 0;
  const m = mint(), list = makePool(m, 30, { failedAt: 7 });
  const seen = [];
  const t0 = Date.now();
  const r = await Chain.readHistory(m, { onProgress: (x) => seen.push(x) });
  const secs = (Date.now() - t0) / 1000;
  const okSigs = list.filter((s) => !s.err).map((s) => s.signature);
  line(r.complete && r.whole && r.have === 29 && r.total === 29 && !r.error, `30 transactions, one failed: read ${r.have} of ${r.total}, whole, in ${secs.toFixed(1)} s`);
  line(node.refused === 0 && busiest() <= 8, `no 429 (refused ${node.refused}), at most ${busiest()} calls in any window of the node's`);
  line(node.served === 29, `each transaction fetched once (${node.served} calls), the failed one never`);
  const times = r.events.map((e) => e.time);
  line(times.every((t, i) => i === 0 || t >= times[i - 1]), "events oldest first");
  line(r.events[0].kind === "launch" && r.events[1].kind === "trade" && r.events[1].signature === r.events[0].signature, "the launch comes before the first buy in its own transaction");
  line(r.events.length === 30 && r.events.every((e) => e.kind !== "trade" || typeof e.sol === "bigint"), `${r.events.length} events decoded`);
  const runs = seen.every((x) => x.events.length > 0 && x.events[x.events.length - 1].signature === okSigs[0]
    && new Set(x.events.map((e) => e.signature)).size === x.have
    && okSigs.slice(0, x.have).every((s) => x.events.some((e) => e.signature === s)));
  line(seen.length >= 20 && runs && seen.every((x, i) => i === 0 || x.have > seen[i - 1].have), `progress came ${seen.length} times, each the unbroken run back from the newest`);
  line(seen[0].have >= 1 && seen[0].events.at(-1).signature === okSigs[0], "the newest transaction came first");

  /* 2. read again: nothing fetched */
  reset();
  const again = await Chain.readHistory(m);
  line(again.complete && node.served === 0 && node.calls.length === 0, `read again: ${node.calls.length} calls, ${again.have} of ${again.total}`);

  /* 3. a new page: the kept transactions come from localStorage */
  Chain = fresh(); Chain.setNet(NETCFG); reset();
  const page = await Chain.readHistory(m);
  line(page.complete && node.calls.length === 0 && page.events.length === 30, `a page loaded anew reads them from storage: ${node.calls.length} calls`);

  /* 4. a new transaction on the pool: only it is fetched */
  const sig = `${m.slice(0, 6)}sig9999`.padEnd(88, "x");
  list.unshift({ signature: sig, blockTime: 1_900_000_000, err: null, data: [trade(99, false, m)] });
  reset();
  const more = await Chain.readHistory(m);
  line(more.complete && node.served === 1 && more.events.at(-1).signature === sig, `a new trade: ${node.served} call, and it is the newest event`);

  /* 4b. three new ones over the kept run: read from the kept ones up, so what comes back never shrinks */
  await pause(1200); reset(); asked.length = 0;
  const added = [1, 2, 3].map((i) => newTx(list, m, i));      // added[2] is the newest
  const steps = [];
  const grown = await Chain.readHistory(m, { onProgress: (x) => steps.push(x) });
  line(asked.join() === [added[0], added[1], added[2]].map((s) => s.signature).join(), "three new ones are fetched oldest first, from the kept ones up");
  line(steps.length === 4 && steps.every((x, i) => x.have === 30 + i && x.pending === 3 - i), `the 30 kept at once, then each step one longer (${steps.map((x) => `${x.have}/${x.pending} pending`).join(", ")})`);
  line(grown.complete && grown.events.at(-1).signature === added[2].signature && grown.pending === 0, "and then the newest is on top");

  /* 4c. more new ones than GAP: newest first, as a cold read */
  await pause(1200); reset(); asked.length = 0;
  const many = Array.from({ length: 12 }, (_, i) => newTx(list, m, 10 + i));
  const first = [];
  const cold = await Chain.readHistory(m, { onProgress: (x) => { if (first.length < 2) first.push(x); } });
  line(asked[0] === many[11].signature && first[0].have === 1 && first[0].pending === 0, "twelve new ones: the newest is fetched first and shows alone");
  line(cold.complete && cold.have === 45, `and they join the kept ones: ${cold.have} of ${cold.total}`);

  /* 4d. the middle one of three new ones not served once: the stretch never shrinks, in this read or the next */
  await pause(1200); reset();
  const three = [31, 32, 33].map((i) => newTx(list, m, i));     // three[2] is the newest
  node.unserved.set(three[1].signature, 1);
  const s1 = [], s2 = [];
  const r1 = await Chain.readHistory(m, { onProgress: (x) => s1.push(x.have) });
  const r2 = await Chain.readHistory(m, { onProgress: (x) => s2.push(x.have) });
  line(s1.every((h, i) => i === 0 || h >= s1[i - 1]) && !r1.complete && r1.have === 46, `the middle one missing: ${s1.join(" → ")}, never shorter, ${r1.have} of ${r1.total}`);
  line(s2[0] >= r1.have && r2.complete && r2.have === 48, `the next read starts from the long stretch (${s2.join(" → ")}) and completes`);
}

/* ---------- 5. a time budget: the latest stretch, then the rest next time ---------- */
{
  await pause(1200); reset(); log.length = 0;
  const m = mint(), list = makePool(m, 25);
  const r = await Chain.readHistory(m, { budgetMs: 800 });
  line(!r.complete && r.have > 0 && r.have < 25 && !r.error, `with 0.8 s: ${r.have} of ${r.total}, not complete, no error`);
  line(r.events.every((e) => list.slice(0, r.have).some((s) => s.signature === e.signature)), "and they are the newest ones");
  const rest = await Chain.readHistory(m);
  line(rest.complete && node.served === 25, `the next read finishes: ${rest.have} of ${rest.total}, ${node.served} calls in all`);
}

/* ---------- 6. abort ---------- */
{
  await pause(1200); reset();
  const m = mint(); makePool(m, 20);
  const ctl = new AbortController();
  const t0 = Date.now();
  const r = await Chain.readHistory(m, { signal: ctl.signal, onProgress: (x) => { if (x.have === 3) ctl.abort(); } });
  line(r.have === 3 && !r.complete && !r.error && Date.now() - t0 < 1500, `aborted at 3: returned ${r.have} of ${r.total} at once`);
}

/* ---------- 7. two reads of one pool at once: no transaction fetched twice ---------- */
{
  await pause(1200); reset();
  const m = mint(); makePool(m, 12);
  const [a, b] = await Promise.all([Chain.readHistory(m), Chain.readHistory(m)]);
  line(a.complete && b.complete && node.served === 12, `two reads at once: both complete, ${node.served} calls for 12 transactions`);
}

/* ---------- 8. a transaction the node does not serve yet ---------- */
{
  await pause(1200); reset();
  const m = mint(), list = makePool(m, 6);
  node.unserved.set(list[2].signature, 1);                     // the third newest comes back null once
  const r = await Chain.readHistory(m);
  line(!r.complete && r.have === 2 && !r.error, `one not served: the run stops before it (${r.have} of ${r.total}), no error`);
  const r2 = await Chain.readHistory(m);
  line(r2.complete && r2.events.length === 7, `read again, it is served: ${r2.have} of ${r2.total}`);
}

/* ---------- 9. a node stricter than the pace: 429, a pause, a slower pace, then all of it ---------- */
{
  await pause(1500); reset(); log.length = 0;
  node.limit = 5;
  const m = mint(); makePool(m, 16);
  const t0 = Date.now();
  const r = await Chain.readHistory(m);
  const gaps = []; for (let i = 1; i < log.length; i++) gaps.push(log[i] - log[i - 1]);
  line(r.complete && !r.error && node.refused >= 1, `node allows 5: complete after ${node.refused} refusal(s), in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  line(gaps.some((g) => g >= 1150), `a pause of ${Math.max(...gaps)} ms after the 429 (8/7 of the window is 1200)`);
  node.limit = 10;
}

/* ---------- 10. a node that keeps refusing, and one that fails ---------- */
{
  Chain = fresh(); Chain.setNet(NETCFG); await pause(1500); reset();
  node.always429 = true;
  const m = mint(); makePool(m, 4);
  const t0 = Date.now();
  const r = await Chain.readHistory(m);
  line(!r.complete && /429/.test(r.error ?? "") && node.refused === 5, `always 429: gives up after ${node.refused} with "${r.error}" in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  node.always429 = false;
  Chain = fresh(); Chain.setNet(NETCFG); await pause(1500); reset();
  node.broken = true;
  const m2 = mint(); makePool(m2, 4);
  const r2 = await Chain.readHistory(m2);
  line(!r2.complete && r2.have === 0 && /broken|500/.test(r2.error ?? ""), `a node error stops the read: "${r2.error}"`);
  let threw = null;
  try { await Chain.history(m2); } catch (err) { threw = err.message; }
  line(!!threw, `history() throws on it: "${threw}"`);
  node.broken = false;
}

/* ---------- 12. slow replies do not stretch the budget ---------- */
{
  Chain = fresh(); Chain.setNet(NETCFG); await pause(1500); reset();
  node.slow = 300;
  const m = mint(); makePool(m, 25);
  log.length = 0;
  const t0 = Date.now();
  const r = await Chain.readHistory(m, { budgetMs: 800 });
  const took = Date.now() - t0;
  console.log(`         calls went out at ${log.map((t) => t - t0).join(", ")} ms`);
  line(!r.complete && took < 2500, `300 ms replies, 0.8 s budget: stopped at ${r.have} of ${r.total} after ${took} ms`);
  node.slow = 0;
}

/* ---------- 13. a 429 never raises the pace, and calm brings it back ---------- */
{
  Chain = fresh(); Chain.setNet({ ...NETCFG, historyPace: 2 }); await pause(1500); reset(); log.length = 0;
  node.refuseNext = 1;
  const m = mint(); makePool(m, 6);
  await Chain.readHistory(m);
  const gaps = []; for (let i = 1; i < log.length; i++) gaps.push(log[i] - log[i - 1]);
  line(gaps.every((g) => g >= 500), `set to 2 a window, a 429 keeps it there: gaps ${gaps.join(", ")} ms (525 at 2)`);

  Chain = fresh(); Chain.setNet(NETCFG); await pause(1500); reset(); log.length = 0;
  node.limit = 1000; node.refuseNext = 1;
  const m2 = mint(); makePool(m2, 60);
  await Chain.readHistory(m2);
  const g2 = []; for (let i = 1; i < log.length; i++) g2.push(log[i] - log[i - 1]);
  const after = g2.slice(2, 6), late = g2.slice(-5);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  line(avg(late) < avg(after) - 15, `after a 429 the pace comes back: ${avg(after).toFixed(0)} ms apart right after, ${avg(late).toFixed(0)} ms at the end (131 at the set pace)`);
  node.limit = 10;
}

/* ---------- 14. the site's history server: one call brings it all; the reader falls back when it breaks ---------- */
{
  const H = { ...NETCFG, historyUrl: `${NETCFG.rpcUrl}/history?cluster=fake` };
  Chain = fresh(); Chain.setNet(H); await pause(1200); reset(); hist.asked = 0; hist.lists = 0;
  hist.mode = "full";
  const m = mint(); makePool(m, 15);
  let r = await Chain.readHistory(m);
  line(r.complete && !r.waiting && r.events.length === 16 && node.served === 0 && hist.lists === 0 && hist.asked === 1,
    `from the server: ${r.have} of ${r.total} in one call, no transaction or list asked of the node`);
  hist.mode = "partial";
  const m2 = mint(); makePool(m2, 10);
  r = await Chain.readHistory(m2);
  line(!r.complete && r.waiting && r.have === 5 && node.served === 0, `a server still fetching: ${r.have} of ${r.total}, waiting, and the reader does not fetch them itself`);
  hist.mode = "full";
  r = await Chain.readHistory(m2);
  line(r.complete && !r.waiting && r.added === 5, `asked again once it has them all: complete, ${r.added} added`);
  hist.mode = "broken"; hist.asked = 0; hist.lists = 0; reset();
  const m3 = mint(); makePool(m3, 4);
  r = await Chain.readHistory(m3);
  line(r.complete && hist.asked === 1 && node.served === 4 && hist.lists === 1, `a broken server: read directly instead (${node.served} calls)`);
  const m4 = mint(); makePool(m4, 2);
  r = await Chain.readHistory(m4);
  line(r.complete && hist.asked === 1, `and for a minute the server is not asked again (${hist.asked} ask in all)`);
  hist.mode = "full";
}

/* ---------- 11. storage keeps the 30 pools read last ---------- */
{
  const before = [...disk.keys()].filter((k) => k.startsWith("nox.tx.2.fake.")).length;
  Chain = fresh(); Chain.setNet({ ...NETCFG, historyWindowMs: 200 }); await pause(1200); reset();
  node.limit = 1000;                                            // this case is about storage, not the pace
  for (let i = 0; i < 32; i++) { const m = mint(); makePool(m, 1); await Chain.readHistory(m); }
  node.limit = 10;
  const kept = [...disk.keys()].filter((k) => k.startsWith("nox.tx.2.fake."));
  const list = JSON.parse(disk.get("nox.tx.2.pools"));
  line(kept.length === 30 && list.length === 30, `after ${before} + 32 pools, ${kept.length} kept, ${list.length} listed`);
}

server.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall history checks passed");
process.exit(failed ? 1 : 0);
