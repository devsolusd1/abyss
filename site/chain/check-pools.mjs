// Checks Chain.listPools through the built bundle (../vendor/chain.js, the file the site ships), against a fake node on
// this machine, read directly and through the site's own pool list (server/pools.mjs, run here on the same fake node):
//   1. read directly: a slice reads only its own coins' metadata, each mint's are read once (in lots side by side), and
//      the pools come as they always have
//   2. through the site's server: no call from the page to the node, and the same pools as a direct read (the board's
//      lighter form too); coins whose metadata the server has not read yet are read by the page
//   3. the site's server failing (HTTP 500, 404, an answer that is not a list, no answer in time): the node is read
//      directly, and the server is left alone for a minute
//   4. the landing, the coin board and a coin's page ask for what they show: the newest 12, the board's form of every
//      pool, and (with no coin named) the one most traded
//   5. the site's server slow or busy: a slice whose metadata are slow comes in time, and a busy server (503 with a
//      retry-after, 429) is asked again after the time it says, never replaced by the node read from the page
//   6. a list in several answers, read in a row after the last pool of each, and how old a list is
//   7. the busiest coin: the list by volume (the most traded first, the newer between equals, past 2^53 too) from the
//      site's server in one ask and with no next page, and from the node, sorted before it is cut, when the server fails
// Nothing touches a real cluster.
//
//   node check-pools.mjs

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { handlePools } from "../../server/pools.mjs";
import { base58 } from "../../server/config.mjs";

const require = createRequire(import.meta.url);
const Chain = require("../vendor/chain.js");
const { PublicKey } = Chain;

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const head = (text) => console.log(`\n${text}`);

/* ---------- the fake chain: pools and their mints ---------- */

const P = "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK", TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const POOL_TAG = createHash("sha256").update("account:Pool").digest().subarray(0, 8);
const key = (kind, i) => { const b = Buffer.alloc(32, kind); b.writeUInt32LE(i + 1, 0); return b; };
const u64 = (b, at, v) => b.writeBigUInt64LE(BigInt(v), at);
/** Pool i: launched at second i (so the newest is the last made), each amount its own, a batch on every fifth. */
function poolData(i) {
  const b = Buffer.alloc(8 + 336);
  POOL_TAG.copy(b, 0);
  key(1, i).copy(b, 8); key(2, i).copy(b, 40); key(3, 0).copy(b, 72); key(4, i).copy(b, 104); key(5, i % 2).copy(b, 136);
  [30e9, 1e6 * i, 1e15 - i, 42e9, 420e9, 0, 1000 + i, 1000 + i, 7, 7, 5e8 + i].forEach((v, k) => u64(b, 168 + 8 * k, v));
  b.writeBigInt64LE(BigInt(1_800_000_000 + i), 256); b.writeBigInt64LE(0n, 264);
  b.writeUInt16LE(100, 272); b.writeUInt16LE(5000, 274); b[276] = i % 7 === 0 ? 1 : 0; b[277] = 254;
  if (i % 5 === 0) { b.writeBigInt64LE(BigInt(1_800_000_600 + i), 280); u64(b, 288, 3e8); u64(b, 296, 0); u64(b, 304, 0); u64(b, 312, 0); b.writeUInt32LE(3, 320); b[324] = 1; }
  return b;
}
/** A Token-2022 mint with its metadata pointer and metadata, as the launch leaves it. */
function mintData(mint, name, symbol, uri) {
  const str = (s) => { const v = Buffer.from(s, "utf8"), n = Buffer.alloc(4); n.writeUInt32LE(v.length); return Buffer.concat([n, v]); };
  const meta = Buffer.concat([Buffer.alloc(32), mint, str(name), str(symbol), str(uri), Buffer.alloc(4)]);
  const tlv = (type, body) => { const h = Buffer.alloc(4); h.writeUInt16LE(type, 0); h.writeUInt16LE(body.length, 2); return Buffer.concat([h, body]); };
  const base = Buffer.alloc(166); base[45] = 1; base[165] = 1;
  return Buffer.concat([base, tlv(18, Buffer.concat([Buffer.alloc(32), mint])), tlv(19, meta)]);
}
const b58 = (bytes) => new PublicKey(bytes).toBase58();
const chain = { pools: [], accounts: new Map(), mints: new Map(), calls: [], delay: 0, inflight: 0, most: 0 };
const names = new Map();                                 // mint -> { name, symbol, uri }
/** n more pools (each with its mint), the newest last. */
function grow(n) {
  for (let k = 0; k < n; k++) {
    const i = chain.pools.length, data = poolData(i), mint = data.subarray(8, 40), m = b58(mint);
    const want = { name: `Coin ${i}`, symbol: `C${i}`, uri: `https://nox.example/c/${i}.json` };
    chain.pools.push({ pubkey: b58(key(9, i)), data, mint: m, i });
    chain.mints.set(m, mintData(mint, want.name, want.symbol, want.uri).toString("base64"));
    names.set(m, want);
  }
}

/* ---------- the fake node, and the site's server in front of it ---------- */

// the page calls the node at /page, the site's server at /server: so each call says who made it
//   busy: that many answers of 503 (busyAs: 429) with a retry-after of 1 s, then the server's own
//   page: at most that many pools an answer (cut: true when more remain), so a list comes in pages
//   failAfter: a page after the first answers 500. old: the list read 50 s before the answer, kept 10 s at the edge
//   onAfter: run before a page after the first is answered. noAfter: a server that ignores after= (an old one)
const site = { mode: "ok", asked: 0, busy: 0, busyAs: 503, page: 0, failAfter: false, onAfter: null, noAfter: false, urls: [] };
const account = (data, owner) => ({ data: [data, "base64"], executable: false, lamports: 3_285_120, owner, rentEpoch: 0, space: Buffer.from(data, "base64").length });
function answer(c, who) {
  chain.calls.push({ who, method: c.method, mints: c.method === "getMultipleAccounts" ? c.params[0] : null });
  const ok = (result) => ({ jsonrpc: "2.0", id: c.id, result });
  if (c.method === "getProgramAccounts") {
    const f = c.params[1]?.filters ?? [], size = f.find((x) => x.dataSize)?.dataSize, tag = f.find((x) => x.memcmp)?.memcmp?.bytes;
    return ok(chain.pools.filter((p) => (!size || p.data.length === size) && (!tag || tag === base58(p.data.subarray(0, 8))))
      .map((p) => ({ pubkey: p.pubkey, account: account(p.data.toString("base64"), P) })));
  }
  if (c.method === "getMultipleAccounts") return ok({ context: { slot: 1 }, value: c.params[0].map((m) => (chain.mints.has(m) ? account(chain.mints.get(m), TOKEN_2022) : null)) });
  if (c.method === "getAccountInfo") { const a = chain.accounts.get(c.params[0]); return ok({ context: { slot: 1 }, value: a ? account(a.toString("base64"), P) : null }); }
  return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "not here" } };
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const node = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", async () => {
    if (req.method === "GET" && req.url.startsWith("/api/pools")) return pools(req, res);
    const who = req.url.startsWith("/server") ? "server" : "page", parsed = JSON.parse(body), list = Array.isArray(parsed) ? parsed : [parsed];
    const slow = list.some((c) => c.method === "getMultipleAccounts") && (chain.delay || (who === "server" && chain.serverDelay));
    if (slow) { chain.inflight++; chain.most = Math.max(chain.most, chain.inflight); await sleep(chain.delay || chain.serverDelay); chain.inflight--; }
    const out = list.map((c) => answer(c, who));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
  });
});
let ip = 0;
const realClock = Date.now;                              // the sections below that move the clock leave this one
/** /api/pools as the site serves it (server/pools.mjs on the same node), or a server that fails as `site.mode` says. */
async function pools(req, res) {
  site.asked++; site.urls.push(req.url);
  if (site.busy > 0) { site.busy--; return res.writeHead(site.busyAs, { "content-type": "application/json", "retry-after": "1" }).end('{"error":"busy"}'); }
  const later = req.url.includes("&after=");
  if (later && site.failAfter) return res.writeHead(500, { "content-type": "application/json" }).end('{"error":"broken"}');
  if (later && site.onAfter) site.onAfter();
  if (site.mode === "broken") return res.writeHead(500, { "content-type": "application/json" }).end('{"error":"broken"}');
  if (site.mode === "missing") return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  if (site.mode === "garbage") return res.writeHead(200, { "content-type": "application/json" }).end("<html>not a list</html>");
  if (site.mode === "slow") await sleep(6500);
  const url = site.noAfter ? req.url.replace(/&after=[^&]*/, "") : req.url;
  const r = await handlePools(new Request(`http://127.0.0.1:${PORT}${url}`, { headers: { "x-forwarded-for": `10.7.0.${++ip % 250}` } }), { RPC_URL_DEVNET: `${UP}/server` });
  let text = await r.text();
  const headers = Object.fromEntries(r.headers);
  if (site.page || site.mode === "old") {
    const j = JSON.parse(text);
    if (site.page && j.pools.length > site.page) { j.pools.length = site.page; j.cut = true; }
    if (site.mode === "old") { j.at = realClock() - 50_000; headers.age = "10"; }
    text = JSON.stringify(j);
  }
  if (site.mode === "unnamed" || site.mode === "short") {
    const j = JSON.parse(text);
    j.pools.forEach((row, n) => {
      const board = row.length === 3;
      if (site.mode === "unnamed" && n % 3 === 0) row.fill(null, board ? 1 : 2);
      if (site.mode === "short" && n === 5) row[board ? 0 : 1] = row[board ? 0 : 1].slice(0, 40);   // a pool cut short
    });
    text = JSON.stringify(j);
  }
  if (!res.destroyed) res.writeHead(r.status, headers).end(text);   // a page that gave up is gone
}
await new Promise((ok) => node.listen(0, "127.0.0.1", ok));
const PORT = node.address().port, UP = `http://127.0.0.1:${PORT}`;
const NET = (via) => ({ cluster: "devnet", rpcUrl: `${UP}/page`, program: P, poolsUrl: via ? `${UP}/api/pools?cluster=devnet` : "" });

const calls = (who, method) => chain.calls.filter((c) => c.who === who && (!method || c.method === method));
const mintsAsked = (who) => calls(who, "getMultipleAccounts").flatMap((c) => c.mints);
const fresh = () => { chain.calls = []; chain.most = 0; site.urls = []; };
const newest = (n) => chain.pools.slice(-n).reverse();
const named = (list) => list.every((p) => { const w = names.get(p.mint.toBase58()); return w && p.name === w.name && p.symbol === w.symbol; });
// a pool's fields as plain text, so two reads can be compared whole: keys in base58, amounts as numbers
const plain = (p) => JSON.stringify(p, (k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof PublicKey ? v.toBase58() : v));
const BOARD = ["mint", "name", "symbol", "virtualSol", "realSol", "tokens", "graduationSol", "graduationMcap", "burned", "creatorFees", "treasuryFees",
  "creatorFeesPaid", "treasuryFeesPaid", "volume", "openedAt", "graduatedAt", "feeBps", "treasuryShareBps", "graduated", "opening", "price", "marketCap", "progress"];
const boardOf = (p) => plain(Object.fromEntries(BOARD.map((k) => [k, p[k]])));

/* ---------- 1. read directly ---------- */
head("1. read directly");
grow(400);
Chain.setNet(NET(false));
{
  fresh();
  let list = await Chain.listPools({ limit: 12 });
  const top = newest(12).map((p) => p.mint);
  line(list.length === 12 && list.map((p) => p.mint.toBase58()).join() === top.join() && named(list) && list.total === 400,
    `listPools({ limit: 12 }): the newest 12 of ${list.total}, each with its name (${list.length})`);
  line(calls("page", "getProgramAccounts").length === 1 && mintsAsked("page").length === 12 && mintsAsked("page").every((m) => top.includes(m)),
    `and only their 12 mints read, not the 400 (${mintsAsked("page").length} mints asked, in ${calls("page", "getMultipleAccounts").length} call)`);
  fresh();
  list = await Chain.listPools({ limit: 12 });
  line(named(list) && calls("page", "getProgramAccounts").length === 1 && !calls("page", "getMultipleAccounts").length, "asked again: the pools read again, the metadata kept (no mint read)");

  fresh(); chain.delay = 40;
  list = await Chain.listPools();
  chain.delay = 0;
  line(list.length === 400 && named(list) && list.total === 400 && list.every((p, k) => k === 0 || list[k - 1].openedAt >= p.openedAt), `listPools(): all ${list.length}, newest first, each with its name`);
  line(mintsAsked("page").length === 388 && new Set(mintsAsked("page")).size === 388 && calls("page", "getMultipleAccounts").length === 4,
    `only the 388 mints not kept are read, each once (${mintsAsked("page").length} in ${calls("page", "getMultipleAccounts").length} calls)`);
  line(chain.most >= 2 && chain.most <= 4, `and the lots go side by side, not one after another (${chain.most} at once at most)`);
  fresh();
  list = await Chain.listPools();
  line(list.length === 400 && named(list) && !calls("page", "getMultipleAccounts").length, "the board's next read, 30 s on: one account list, no mint read");

  // the pools come as they always have: every field, keys as PublicKeys, amounts as bigints, the link too
  const one = list.find((p) => p.mint.toBase58() === chain.pools[35].mint), d = chain.pools[35].data;
  line(one && one.address.toBase58() === chain.pools[35].pubkey && one.creator.toBase58() === b58(d.subarray(40, 72)) && one.treasury.toBase58() === b58(d.subarray(72, 104))
    && one.vault.toBase58() === b58(d.subarray(104, 136)) && one.hookProgram.toBase58() === b58(d.subarray(136, 168)) && one.realSol === 35_000_000n && one.volume === 500_000_035n
    && one.openedAt === 1_800_000_035 && one.opening?.state === "open" && one.opening.seats === 3 && one.uri === names.get(one.mint.toBase58()).uri,
  "a pool from listPools() has every field it had: address, creator, treasury, vault, hook program, amounts, batch, link");

  // a coin's page reads its pool again and again: its metadata are kept too
  const pick = chain.pools[123], at = Chain.poolAddress(new PublicKey(pick.mint)).toBase58();
  chain.accounts.set(at, pick.data);
  fresh();
  const p = await Chain.readPool(new PublicKey(pick.mint));
  line(p && p.name === "Coin 123" && calls("page", "getAccountInfo").length === 1 && !calls("page", "getMultipleAccounts").length, "readPool of a listed coin: its pool read, its metadata kept");

  // a mint the node does not serve (yet) is not kept as nameless: the next read asks for it again
  const gone = chain.pools[399].mint, saved = chain.mints.get(gone);
  Chain.setNet(NET(false));                              // another cluster's setNet forgets what was kept
  chain.mints.delete(gone);
  fresh();
  list = await Chain.listPools({ limit: 12 });
  line(mintsAsked("page").length === 12, `setNet forgets the kept metadata (another cluster, its own coins): ${mintsAsked("page").length} mints read again`);
  line(list[0].mint.toBase58() === gone && list[0].name === "" && named(list.slice(1)), "a mint the node did not serve: no name for it, the others named");
  chain.mints.set(gone, saved);
  fresh();
  list = await Chain.listPools({ limit: 12 });
  line(mintsAsked("page").join() === gone && list[0].name === "Coin 399", "and the next read asks for that one again, and only that one");
}

/* ---------- 2. through the site's server ---------- */
head("2. through the site's server");
{
  Chain.setNet(NET(false));
  const whole = await Chain.listPools();                 // the direct read, to compare with
  Chain.setNet(NET(true));
  fresh(); site.asked = 0;
  let list = await Chain.listPools({ board: true });
  line(list.length === 400 && list.total === 400 && named(list) && site.asked === 1 && !calls("page").length,
    `listPools({ board: true }): all ${list.length}, named, in one ask of the site's server and no call from the page to the node`);
  line(calls("server", "getProgramAccounts").length === 1 && mintsAsked("server").length === 400, `the server read the list once and each of the 400 mints once (${mintsAsked("server").length})`);
  const diff = list.findIndex((p, k) => boardOf(p) !== boardOf(whole[k]));
  line(diff < 0, `each board pool is the direct read's on every field the board shows${diff >= 0 ? ` (not pool ${diff})` : ""}`);
  line(list.every((p) => !("address" in p) && !("creator" in p) && !("treasury" in p) && !("vault" in p) && !("hookProgram" in p) && !("uri" in p)),
    "and has no address, creator, treasury, vault, hook program or link, as said");

  fresh();
  list = await Chain.listPools({ limit: 12 });
  line(list.length === 12 && list.total === 400 && list.every((p, k) => plain(p) === plain(whole[k])) && !calls("page").length && !calls("server").length,
    "listPools({ limit: 12 }): the same 12 pools as a direct read, field by field; nothing asked of the node (the server's list is a moment old)");
  fresh();
  list = await Chain.listPools();
  line(list.length === 400 && list.every((p, k) => plain(p) === plain(whole[k])) && !calls("page").length, "listPools(): the same 400 as a direct read, field by field, the links too");
  const pick = chain.pools[200];
  chain.accounts.set(Chain.poolAddress(new PublicKey(pick.mint)).toBase58(), pick.data);
  fresh();
  const p = await Chain.readPool(new PublicKey(pick.mint));
  line(p?.name === "Coin 200" && !calls("page", "getMultipleAccounts").length, "a coin's page then reads its pool, and the name the server sent is kept");

  // the server has not read some coins' metadata yet (null): the page reads those, and only those
  Chain.setNet(NET(true));
  site.mode = "unnamed"; fresh();
  list = await Chain.listPools({ board: true });
  site.mode = "ok";
  line(list.length === 400 && named(list) && mintsAsked("page").length === 134, `coins sent without their names: the page reads those ${mintsAsked("page").length} mints itself, and every coin is named`);
}

/* ---------- 3. the site's server failing ---------- */
head("3. the site's server failing");
{
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  grow(3);                                               // three new coins, so a list a moment old would show
  for (const [mode, what] of [["broken", "HTTP 500"], ["missing", "404 (a server without /api/pools)"], ["garbage", "an answer that is not JSON"], ["short", "a pool cut short"]]) {
    Chain.setNet(NET(true));
    shift += 10_000;                                     // past the server's list
    site.mode = mode; site.asked = 0; fresh();
    const list = await Chain.listPools({ limit: 12 });
    line(list.length === 12 && list[0].mint.toBase58() === chain.pools.at(-1).mint && named(list) && site.asked === 1 && calls("page", "getProgramAccounts").length === 1,
      `${what}: the node read directly, the newest 12 named`);
    fresh();
    await Chain.listPools({ board: true });
    line(site.asked === 1 && calls("page", "getProgramAccounts").length === 1, "and within the minute the server is not asked again");
  }
  shift += 61_000; site.mode = "ok"; site.asked = 0; fresh();
  let list = await Chain.listPools({ limit: 12 });
  line(site.asked === 1 && !calls("page").length && named(list), "a minute on, the server is asked again, and the page calls the node no more");

  // no answer in time: a slice waits 5 s for the server, then reads the node (the landing gives up at 8 s)
  Chain.setNet(NET(true));
  site.mode = "slow"; fresh();
  const t0 = realNow();
  list = await Chain.listPools({ limit: 12 });
  const took = realNow() - t0;
  site.mode = "ok";
  line(list.length === 12 && named(list) && took >= 4900 && took < 6400 && calls("page", "getProgramAccounts").length === 1,
    `a server that does not answer in time: the node read directly, in ${(took / 1000).toFixed(1)} s`);
  Date.now = realNow;
}

/* ---------- 4. what the pages ask for ---------- */
head("4. what the pages ask for");
{
  const page = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  const asks = (html) => [...html.matchAll(/Chain\.listPools\(([^)]*)\)/g)].map((m) => m[1].trim());
  const landing = asks(page("index.html")), board = asks(page("coins.html"));
  line(landing.length === 1 && /^\{\s*limit:\s*12\s*\}$/.test(landing[0]), `the landing shows 12 coins and asks for the newest 12 (${landing.join(" ") || "no call"})`);
  line(board.length === 1 && /^\{\s*board:\s*true\s*\}$/.test(board[0]), `the coin board asks for every pool in the board's form (${board.join(" ") || "no call"})`);
  const html = page("coins.html");
  line(/num\(pools\.readAt\)/.test(html) && /allCoins = num\(pools\.total\)/.test(html) && /Math\.max\(n, allCoins\)/.test(html) && !/read from ' \+ N\.place \+ ' just now/.test(html),
    "the board dates its status by when the pools were read (readAt), and counts every coin in its title (total)");
  const coinHtml = page("coin.html"), coin = asks(coinHtml);
  line(coin.length === 1 && /^\{\s*limit:\s*1,\s*sort:\s*'volume'\s*\}$/.test(coin[0]) && !/pools\.sort\(/.test(coinHtml) && /if \(!pools\.total\)/.test(coinHtml) && /'the busiest coin on '/.test(coinHtml),
    `a coin's page with no coin named asks for the one most traded (${coin.join(" ") || "no call"}), sorts nothing itself, says "no coins" by the total, and calls it the busiest coin`);
}

/* ---------- 5. the site's server slow or busy ---------- */
head("5. the site's server slow or busy");
// a clock past every list the server read in section 3 (which moved it on), so the server reads its list again
let later = 120_000;
Date.now = () => realClock() + later;
{
  // the server's metadata slow to come (6 s): a slice comes in its 3 s with null names, and the page reads those 12
  Chain.setNet(NET(true));
  grow(12);                                              // twelve new coins, whose metadata the server has not read
  chain.serverDelay = 6000; fresh(); site.asked = 0;
  let t0 = realClock();
  let list = await Chain.listPools({ limit: 12 });
  let took = realClock() - t0;
  chain.serverDelay = 0;
  line(list.length === 12 && named(list) && site.asked === 1 && !calls("page", "getProgramAccounts").length && mintsAsked("page").length === 12 && took < 4500,
    `metadata slow on the server: the server's slice in ${(took / 1000).toFixed(1)} s, the 12 names read by the page, no account list read from the page`);
  fresh();
  await Chain.listPools({ limit: 12 });
  line(site.asked === 2 && !calls("page", "getProgramAccounts").length, "and the server is asked again next time (it did not fail)");
  await sleep(3500);                                     // the server's round of metadata under way ends

  for (const [as, what] of [[503, "a 503 with a retry-after of 1 s"], [429, "a 429 (too many asks from one address)"]]) {
    Chain.setNet(NET(true));
    site.busy = 1; site.busyAs = as; site.asked = 0; fresh();
    t0 = realClock();
    list = await Chain.listPools({ limit: 12 });
    took = realClock() - t0;
    line(list.length === 12 && named(list) && site.asked === 2 && !calls("page").length && took >= 950,
      `${what}: asked again ${(took / 1000).toFixed(1)} s on, and nothing read from the page`);
  }
  Chain.setNet(NET(true));
  site.busy = 1; site.busyAs = 503; site.asked = 0; fresh();
  list = await Chain.listPools({ board: true });
  line(list.length === chain.pools.length && site.asked === 2 && !calls("page").length, `the whole board, busy once: asked again, all ${list.length} pools, nothing read from the page`);

  // busy twice: listPools fails (the page tries on its next round), and the node is not read from the page
  Chain.setNet(NET(true));
  site.busy = 5; site.busyAs = 503; site.asked = 0; fresh();
  let threw = null;
  try { await Chain.listPools({ limit: 12 }); } catch (err) { threw = err; }
  line(threw && site.asked === 2 && !calls("page").length, `still busy: listPools fails ("${threw?.message}"), after 2 asks, with no call from the page to the node`);
  site.busy = 0; fresh();
  list = await Chain.listPools({ limit: 12 });
  line(list.length === 12 && site.asked === 3 && !calls("page").length, "and the next round asks the server at once: a busy server is not left aside");
}

/* ---------- 6. a list in several answers, and its age ---------- */
head("6. a list in several answers, and its age");
{
  Chain.setNet(NET(false));
  const whole = await Chain.listPools();                 // the direct read, to compare with
  const n = chain.pools.length;
  line(Math.abs(whole.readAt - Date.now()) < 1500, "read directly: readAt is when the node gave the pools");

  Chain.setNet(NET(true));
  site.page = 150; site.asked = 0; fresh();
  let list = await Chain.listPools();
  const afters = site.urls.filter((u) => u.includes("&after=")).length;
  line(list.length === n && list.total === n && list.every((p, k) => plain(p) === plain(whole[k])) && site.asked === Math.ceil(n / 150) && afters === site.asked - 1 && !calls("page").length,
    `150 pools an answer: all ${list.length} in ${site.asked} answers, each after the last pool of the one before, the same as a direct read`);
  fresh(); site.asked = 0;
  list = await Chain.listPools({ board: true });
  line(list.length === n && list.total === n && list.every((p, k) => boardOf(p) === boardOf(whole[k])) && site.asked === Math.ceil(n / 150),
    `the board's form in pages too: all ${list.length}`);

  // two coins launched between the first answer and the next, and the server's list read again: none twice, none missed
  site.onAfter = () => { site.onAfter = null; grow(2); later += 5000; };
  Chain.setNet(NET(true));
  fresh(); site.asked = 0;
  list = await Chain.listPools({ board: true });
  const mints = list.map((p) => p.mint.toBase58());
  line(list.length === n && new Set(mints).size === n && mints.join() === whole.map((p) => p.mint.toBase58()).join() && calls("server", "getProgramAccounts").length >= 1,
    `coins launched between two answers, the server's list read again: the ${list.length} of the first answer's list, none twice, none missed`);

  // past 4 answers, or a page that fails: the newest that came, and the total says how many there are
  Chain.setNet(NET(true));
  site.page = 50; site.asked = 0; fresh();
  list = await Chain.listPools({ board: true });
  line(list.length === 200 && list.total === chain.pools.length && site.asked === 4 && !calls("page").length,
    `50 pools an answer: 4 answers at most, the newest ${list.length} of ${list.total}`);
  site.page = 150; site.failAfter = true; site.asked = 0; fresh();
  list = await Chain.listPools({ board: true });
  site.failAfter = false;
  line(list.length === 150 && list.total === chain.pools.length && site.asked === 2 && !calls("page").length,
    `a page after the first fails: the newest ${list.length} of ${list.total}, and the node is not read from the page`);
  site.noAfter = true; site.asked = 0; fresh();
  list = await Chain.listPools({ board: true });
  site.noAfter = false;
  line(list.length === 150 && new Set(list.map((p) => p.mint.toBase58())).size === 150 && list.total === chain.pools.length && site.asked === 2,
    `a server that ignores after= and sends the first answer again: it is not taken for the next page (${list.length} pools, none twice)`);
  site.page = 0;

  // a list the server read 50 s before it answered, kept 10 s at the edge: readAt says a minute ago
  Chain.setNet(NET(true));
  site.mode = "old"; fresh();
  list = await Chain.listPools({ board: true });
  site.mode = "ok";
  const age = (Date.now() - list.readAt) / 1000;
  line(age > 58 && age < 62.5, `a list read 50 s before the answer and kept 10 s at the edge: read ${age.toFixed(1)} s ago, by the server's clock`);
}

/* ---------- 7. the busiest coin: sorted by volume ---------- */
head("7. the busiest coin: sorted by volume");
{
  // volumes of every kind: past 2^53 (as Numbers the two largest would be equal; the older coin has the larger), two
  // coins at the same volume, and every eleventh never traded
  const MAX = 2n ** 64n - 1n;
  const vol = (i) => (i === 20 ? MAX : i === 380 ? MAX - 1n : i === 50 || i === 300 ? 2_000_000_000_000n : i % 11 === 0 ? 0n : BigInt((i * 7919) % 1009) * 1_000_000n);
  chain.pools.forEach((p) => p.data.writeBigUInt64LE(vol(p.i), 248));
  const want = [...chain.pools].sort((a, b) => (vol(b.i) > vol(a.i) ? 1 : vol(b.i) < vol(a.i) ? -1 : b.i - a.i)).map((p) => p.mint);
  const mintsOf = (list) => list.map((p) => p.mint.toBase58()).join(), n = chain.pools.length;
  later += 61_000;                                       // past the server's list, so it reads the new volumes

  Chain.setNet(NET(false));
  const direct = await Chain.listPools({ sort: "volume" });   // the direct read, to compare with
  line(mintsOf(direct) === want.join() && direct.total === n && direct[0].volume === MAX && named(direct),
    `read directly, sort "volume": all ${direct.length}, the most traded first (${direct[0]?.volume} lamports, not the newer coin at ${MAX - 1n}), the newer of two at the same volume first, the never traded last`);

  Chain.setNet(NET(true));
  fresh(); site.asked = 0;
  let list = await Chain.listPools({ limit: 1, sort: "volume" });
  line(list.length === 1 && list.total === n && plain(list[0]) === plain(direct[0]) && site.asked === 1 && site.urls[0].endsWith("&limit=1&sort=volume") && !calls("page").length,
    `listPools({ limit: 1, sort: "volume" }): one ask (${site.urls[0]?.replace(/^.*\?/, "")}), one pool of ${list.total}, the most traded, whole as a direct read; nothing asked of the node from the page`);
  fresh(); site.asked = 0;
  list = await Chain.listPools({ limit: 10, sort: "volume" });
  const board = await Chain.listPools({ limit: 10, board: true, sort: "volume" });
  line(mintsOf(list) === want.slice(0, 10).join() && list.every((p, k) => plain(p) === plain(direct[k])) && board.every((p, k) => boardOf(p) === boardOf(direct[k]))
    && board.length === 10 && site.asked === 2 && !calls("page").length,
    "limit 10: the ten most traded, the same as a direct read field by field; the board's form too");
  fresh();
  list = await Chain.listPools({ limit: 12 });
  line(mintsOf(list) === newest(12).map((p) => p.mint).join(), "with no sort, the newest first as before");

  // the whole list by volume, the server cutting it at 150: one answer, no after= (it has no next page)
  site.page = 150; site.asked = 0; fresh();
  list = await Chain.listPools({ sort: "volume" });
  site.page = 0;
  line(list.length === 150 && list.total === n && mintsOf(list) === want.slice(0, 150).join() && site.asked === 1 && !site.urls.some((u) => u.includes("&after=")) && !calls("page").length,
    `the list by volume cut at 150 by the server: the ${list.length} most traded of ${list.total}, in ${site.asked} ask, no after= asked`);

  // the server failing, or none: the node read from the page, sorted by volume and then cut, only those coins' names read
  for (const [mode, what] of [["broken", "the site's server failing (HTTP 500)"], [null, "no site's server"]]) {
    Chain.setNet(NET(mode !== null));
    site.mode = mode ?? "ok"; site.asked = 0; fresh();
    list = await Chain.listPools({ limit: 10, sort: "volume" });
    site.mode = "ok";
    const asked = mintsAsked("page"), top = want.slice(0, 10);
    line(mintsOf(list) === top.join() && list.every((p, k) => plain(p) === plain(direct[k])) && list.total === n && calls("page", "getProgramAccounts").length === 1
      && asked.length === 10 && asked.every((m) => top.includes(m)) && site.asked === (mode ? 1 : 0),
      `${what}: the node read from the page, sorted by volume, then cut: the same ten, and only their ${asked.length} mints read`);
  }

  // an order the list does not have: refused before anything is asked
  Chain.setNet(NET(true));
  fresh(); site.asked = 0;
  let threw = null;
  try { await Chain.listPools({ limit: 1, sort: "price" }); } catch (err) { threw = err; }
  line(threw && site.asked === 0 && !chain.calls.length, `sort "price": listPools fails ("${threw?.message}"), nothing asked`);

  // no coins yet: an empty list with a total of 0 (the coin page says so), from the server and from the node
  const saved = chain.pools;
  chain.pools = [];
  later += 61_000; fresh();
  list = await Chain.listPools({ limit: 1, sort: "volume" });
  Chain.setNet(NET(false));
  const none = await Chain.listPools({ limit: 1, sort: "volume" });
  chain.pools = saved;
  line(list.length === 0 && list.total === 0 && none.length === 0 && none.total === 0 && calls("server", "getProgramAccounts").length === 1,
    "no coins yet: an empty list and a total of 0, from the server and from the node");
}
Date.now = realClock;

node.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall pool list checks passed");
process.exit(failed ? 1 : 0);
