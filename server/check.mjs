// Checks the site's server (rpc.mjs, history.mjs, price.mjs, birth.mjs) against fake nodes on this machine. Nothing
// touches a real cluster.
//
//   node server/check.mjs        (from the repo root; site/chain must have its node_modules, for a real transaction)

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { handleRpc, programsOf } from "./rpc.mjs";
import { handleHistory } from "./history.mjs";
import { CLUSTERS, addressBytes, publicPace, PUBLIC_GAP } from "./config.mjs";

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const PROGRAM = CLUSTERS.devnet.program;
/** The first bytes of one of the program's accounts: Anchor's mark of its kind, then its first field (a pool's mint). */
const accountData = (kind, first = Buffer.alloc(32, 1)) => Buffer.concat([createHash("sha256").update(`account:${kind}`).digest().subarray(0, 8), first]).toString("base64");

/* ---------- the program ids here and in site/net.js agree ---------- */
const netJs = readFileSync(new URL("../site/net.js", import.meta.url), "utf8");
line(netJs.includes(`program: "${PROGRAM}"`), "site/net.js names the same devnet program as server/config.mjs");
line(/mainnet:[\s\S]*?program: "([^"]*)"/.exec(netJs)?.[1] === CLUSTERS.mainnet.program, "and the same (still empty) mainnet program");

/* ---------- a fake node ---------- */
const node = { calls: [], times: [], batches: 0, sigs: [], txs: new Map(), owner: PROGRAM, data: accountData("Pool"), limit: Infinity, window: [], null: new Set() };
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body), list = Array.isArray(parsed) ? parsed : [parsed];
    if (Array.isArray(parsed)) node.batches++;
    const now = Date.now();
    const answer = list.map((c) => {
      node.calls.push(c.method); node.times.push(now);
      if (c.method === "getTransaction") {
        node.window = node.window.filter((t) => t > now - 1000); node.window.push(now);
        if (node.window.length > node.limit) return { jsonrpc: "2.0", id: c.id, error: { code: 429, message: "slow" } };
        const sig = c.params[0];
        if (node.null.has(sig)) return { jsonrpc: "2.0", id: c.id, result: null };
        const tx = node.txs.get(sig);
        // logged as the chain does: inside the pool program's invoke, and a forged line from another program after it
        return { jsonrpc: "2.0", id: c.id, result: tx ? { blockTime: tx.t, meta: { err: null, logMessages: [
          `Program ${PROGRAM} invoke [1]`, "Program log: x", ...tx.d.map((d) => `Program data: ${d}`), `Program ${PROGRAM} success`,
          "Program Evi1111111111111111111111111111111111111111 invoke [1]", "Program data: FORGED", "Program Evi1111111111111111111111111111111111111111 success",
        ] } } : null };
      }
      if (c.method === "getSignaturesForAddress") return { jsonrpc: "2.0", id: c.id, result: node.sigs.slice(0, c.params[1]?.limit ?? 1000) };
      if (c.method === "getAccountInfo") return { jsonrpc: "2.0", id: c.id, result: { context: { slot: 1 }, value: { owner: node.owner, lamports: 1, data: [node.data, "base64"], executable: false, rentEpoch: 0 } } };
      return { jsonrpc: "2.0", id: c.id, result: `${c.method} answered` };
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(parsed) ? answer : answer[0]));
  });
});
await new Promise((ok) => fake.listen(0, "127.0.0.1", ok));
const UP = `http://127.0.0.1:${fake.address().port}`;
const ENV = { RPC_URL_DEVNET: UP };
const SITE = "https://nox.example";
let ip = 0;
const rpc = (body, { origin, who, cluster = "devnet", method = "POST", env = ENV } = {}) => {
  const headers = { "content-type": "application/json", "x-forwarded-for": who ?? `10.0.0.${++ip % 250}` };
  if (origin) headers.origin = origin;
  return handleRpc(new Request(`${SITE}/api/rpc?cluster=${cluster}`, { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined }), env);
};
const call = (method, params = [], id = 1) => ({ jsonrpc: "2.0", id, method, params });

/* ---------- the door ---------- */
{
  let r = await rpc(call("getSlot"));
  line(r.status === 200 && (await r.json()).result === "getSlot answered", "a call the site makes is passed to the node");
  r = await rpc(call("requestAirdrop", ["x", 1]));
  line(r.status === 403, `a call it does not make is refused (${r.status})`);
  r = await rpc(call("getProgramAccounts", ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]));
  line(r.status === 403, "getProgramAccounts on another program is refused");
  r = await rpc(call("getSlot"), { origin: "https://elsewhere.example" });
  line(r.status === 403, "a page on another site is refused");
  r = await rpc(call("getSlot"), { origin: SITE });
  line(r.status === 200, "this site's own page passes");
  r = await rpc(null, { method: "GET" });
  line(r.status === 405, "GET is refused");
  r = await rpc(call("getSlot"), { cluster: "testnet" });
  line(r.status === 400, "an unknown cluster is refused");
  r = await rpc(call("getSlot"), { cluster: "mainnet" });
  line(r.status === 503, "mainnet has no node yet (no RPC_URL_MAINNET, no public fallback)");
  r = await rpc(Array.from({ length: 11 }, (_, i) => call("getSlot", [], i)));
  line(r.status === 400, "a batch of 11 is refused");
  r = await rpc([call("getSlot", [], 1), call("getBalance", ["x"], 2)]);
  const b = await r.json();
  line(r.status === 200 && Array.isArray(b) && b.length === 2, "a batch of 2 passes as a batch");
  r = await handleRpc(new Request(`${SITE}/api/rpc?cluster=devnet`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(40_000) }), ENV);
  line(r.status === 413, "a body over 32 KB is refused");
  r = await handleRpc(new Request(`${SITE}/api/rpc?cluster=devnet`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), ENV);
  line(r.status === 400, "a body that is not JSON is refused");
}

/* ---------- transactions: only for the pool program ---------- */
{
  const require = createRequire(new URL("../site/chain/package.json", import.meta.url));
  const Chain = require("../vendor/chain.js");
  const web3 = require("@solana/web3.js");
  Chain.setNet({ cluster: "devnet", rpcUrl: UP, program: PROGRAM });
  const payer = web3.Keypair.generate().publicKey;
  const pool = {
    address: Chain.poolAddress(web3.Keypair.generate().publicKey), mint: web3.Keypair.generate().publicKey, vault: web3.Keypair.generate().publicKey,
    creator: payer, treasury: payer, feeBps: 100, virtualSol: 30_000_000_000n, realSol: 0n, tokens: Chain.SUPPLY, graduationSol: 42_000_000_000n, graduated: false,
  };
  const built = await Chain.buildBuy({ pool, owner: payer, sol: 0.01 });
  built.tx.feePayer = payer; built.tx.recentBlockhash = web3.Keypair.generate().publicKey.toBase58();
  const b64 = built.tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const programs = programsOf(b64);
  line(programs?.join() === ["ComputeBudget111111111111111111111111111111", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", PROGRAM].join(), `a buy reads as its three programs (${programs?.length})`);
  let r = await rpc(call("sendTransaction", [b64, { encoding: "base64" }]));
  line(r.status === 200, "a buy may be sent");
  r = await rpc(call("simulateTransaction", [b64, { encoding: "base64", sigVerify: false }]));
  line(r.status === 200, "and simulated");
  const transfer = new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: web3.Keypair.generate().publicKey, lamports: 1 }));
  transfer.feePayer = payer; transfer.recentBlockhash = built.tx.recentBlockhash;
  r = await rpc(call("sendTransaction", [transfer.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), { encoding: "base64" }]));
  line(r.status === 403, "a plain SOL transfer may not be sent through it");
  r = await rpc(call("sendTransaction", [b64]));
  line(r.status === 403, "a transaction without its encoding named is refused");
  r = await rpc(call("sendTransaction", ["AAAA", { encoding: "base64" }]));
  line(r.status === 403, "nonsense is refused");
  const sends = [];
  for (let i = 0; i < 14; i++) sends.push((await rpc(call("sendTransaction", [b64, { encoding: "base64" }]), { who: "9.9.9.9" })).status);
  line(sends.filter((s) => s === 200).length === 12 && sends.at(-1) === 429, `12 sends a minute from one address, then 429 (${sends.join(" ")})`);
}

/* ---------- shared answers ---------- */
{
  node.calls = [];
  const gpa = call("getProgramAccounts", [PROGRAM, { encoding: "base64" }]);
  await rpc(gpa); await rpc(gpa); await rpc({ ...gpa, id: 7 });
  line(node.calls.filter((m) => m === "getProgramAccounts").length === 1, "the program's accounts: three pages, one call to the node");
  const r = await rpc({ ...gpa, id: 9 });
  line((await r.json()).id === 9, "and each page gets its own id back");
  node.calls = [];
  await rpc(call("getAccountInfo", ["x"])); await rpc(call("getAccountInfo", ["x"]));
  line(node.calls.filter((m) => m === "getAccountInfo").length === 2, "a single account is always read fresh (a pool after a trade)");
}

/* ---------- the history ---------- */
const hist = (pool, { env = ENV, limit, origin } = {}) => {
  const headers = { "x-forwarded-for": `10.1.0.${++ip % 250}` };
  if (origin) headers.origin = origin;
  return handleHistory(new Request(`${SITE}/api/history?cluster=devnet&pool=${pool}${limit ? `&limit=${limit}` : ""}`, { headers }), env);
};
const POOL = "CdQHmxkTu8Byxqy8rsu9mxAGQuAdEdsCT161QPNaRxAH";
function makeSigs(n, tag) {
  node.sigs = []; node.txs = new Map();
  for (let i = 0; i < n; i++) {
    const signature = `${tag}${String(i).padStart(4, "0")}`.padEnd(88, "x");
    node.sigs.unshift({ signature, slot: i, err: i === 3 ? { InstructionError: [0, "x"] } : null, memo: null, blockTime: 1_800_000_000 + i, confirmationStatus: "finalized" });
    node.txs.set(signature, { t: 1_800_000_000 + i, d: [`ZGF0YQ${i}`] });
  }
}
{
  line(addressBytes(POOL) && !addressBytes("xyz") && !addressBytes("0OIl".repeat(10)), "addresses are checked as 32 bytes of base58");
  makeSigs(40, "paid"); node.calls = []; node.batches = 0;
  let r = await hist(POOL);
  let b = await r.json();
  line(r.status === 200 && b.complete && b.total === 39 && b.have === 39 && Object.keys(b.txs).length === 39, `a paid node: all ${b.have} of ${b.total} in one answer (the failed one left out)`);
  line(node.batches === 4 && node.calls.filter((m) => m === "getTransaction").length === 39, `in ${node.batches} batches of up to 10`);
  line(/s-maxage=2/.test(r.headers.get("cache-control")), "and the edge may keep a complete answer 2 s");
  line(b.txs[node.sigs[0].signature]?.d?.[0] === "ZGF0YQ39", "each transaction's event lines come with it");
  node.calls = [];
  r = await hist(POOL); b = await r.json();
  line(b.complete && node.calls.filter((m) => m === "getTransaction").length === 0 && node.calls.filter((m) => m === "getSignaturesForAddress").length === 0, "asked again at once: nothing goes to the node");
  await new Promise((ok) => setTimeout(ok, 2100));
  node.calls = [];
  r = await hist(POOL); b = await r.json();
  line(node.calls.join() === "getSignaturesForAddress", "two seconds later: only the list is read again");
  r = await hist(POOL, { limit: 5 }); b = await r.json();
  line(b.total === 5 && b.signatures.length === 5, "limit=5 gives the latest 5");

  node.owner = "11111111111111111111111111111111";
  r = await hist("7f2MiAuyJ1Aaiheo9ctLgJmzGDWoDceyHEEuVB2mhPAA");
  line(r.status === 404, "an address that is not a pool of the program gets nothing");
  node.owner = PROGRAM;
  const { base58 } = await import("./config.mjs");
  node.data = accountData("Seat", Buffer.alloc(32, 2));
  r = await hist(base58(Buffer.alloc(32, 41)));
  line(r.status === 404, "nor a seat of an opening batch, though the program owns it");
  node.data = accountData("Config", Buffer.alloc(32, 2));
  r = await hist(base58(Buffer.alloc(32, 42)));
  line(r.status === 404, "nor the program's config");
  node.data = accountData("Pool");
  r = await hist("xyz");
  line(r.status === 400, "nor does something that is not an address");
  r = await hist(POOL, { origin: "https://elsewhere.example" });
  line(r.status === 403, "nor a page on another site");
}
{
  // the public node: one call every 1.3 s, so a long history comes over a few answers
  makeSigs(12, "free"); node.calls = []; node.times = [];
  const env = { RPC_URL_DEVNET: "" };
  const POOL2 = "FHfQPN22769p2qFcF6r2YooGnp2SRXmnMEH5cUN1Dny2";
  // the public node is the real one by default: point it at the fake one for this check
  const real = CLUSTERS.devnet.publicRpc;
  CLUSTERS.devnet.publicRpc = UP;
  const t0 = Date.now(), mark = t0 + 1500;
  publicPace.devnet = mark;                              // as if the birth had just taken the node's turn
  let r = await hist(POOL2, { env });
  let b = await r.json();
  const took = Date.now() - t0;
  line(r.status === 200 && !b.complete && b.have >= 4 && b.have <= 7, `the public node, first answer: ${b.have} of ${b.total} in ${(took / 1000).toFixed(1)} s, not complete`);
  const gaps = node.times.slice(1).map((t, i) => t - node.times[i]);
  line(node.calls[0] === "getAccountInfo" && node.calls[1] === "getSignaturesForAddress" && node.times[0] >= mark - 5 && gaps.every((g) => g >= PUBLIC_GAP - 5),
    `every call takes its turn, the pool check and the listing too: the first at the mark, then ${Math.min(...gaps)} ms apart at least`);
  line(/s-maxage=1/.test(r.headers.get("cache-control")), "an answer still filling is kept only 1 s at the edge");
  line(publicPace.devnet > t0, "and its calls set the public node's one mark, which the birth keeps too");
  const newest = node.sigs.filter((s) => !s.err).slice(0, b.have).map((s) => s.signature);
  line(newest.every((s) => b.txs[s]), "and what it has is the newest");
  r = await hist(POOL2, { env }); b = await r.json();
  line(b.complete || b.have >= 9, `the next answer goes on: ${b.have} of ${b.total}`);
  CLUSTERS.devnet.publicRpc = real;
}
{
  // a transaction the node does not serve (yet): the answer goes on without it, and no call loops on it
  makeSigs(6, "lost"); node.calls = [];
  node.null.add(node.sigs[1].signature);
  let r = await hist("QSj33hfaVGjppx8hxK1Ms6weBSvKdNZCD7Xv3dU8rhf"); let b = await r.json();
  const asked = node.calls.filter((m) => m === "getTransaction").length;
  line(!b.complete && b.have === 4 && b.total === 5 && asked <= 7, `one never served: ${b.have} of ${b.total}, not complete, ${asked} calls (no loop on it)`);
  node.null.clear();
  r = await hist("QSj33hfaVGjppx8hxK1Ms6weBSvKdNZCD7Xv3dU8rhf"); b = await r.json();
  line(b.complete, "once the node serves it, the next answer is complete");
}

/* ---------- what the review asked for ---------- */
{
  makeSigs(3, "forg");
  let r = await hist("QSj33hfaVGjppx8hxK1Ms6weBSvKdNZCD7Xv3dU8rhf"); let b = await r.json();
  line(Object.values(b.txs).every((t) => !t.d.includes("FORGED")), "a line another program logged in the same transaction is not passed on");
  r = await rpc(call("getAccountInfo", ["x", { encoding: "base64", sneaky: 1 }]));
  line(r.status === 403, "a setting the site does not send is refused");
  r = await rpc(call("getTransaction", ["sig", { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0, x: 2 }]));
  line(r.status === 403, "so a cache key cannot be varied with junk settings");
  let deep = "x"; for (let i = 0; i < 3000; i++) deep = [deep];
  r = await handleRpc(new Request(`${SITE}/api/rpc?cluster=devnet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call("getMultipleAccounts", [[deep]])) }), ENV);
  line(r.status >= 400 && r.status < 500, `deeply nested params get an answer, not a crash (${r.status})`);
  r = await handleRpc(new Request(`${SITE}/api/rpc?cluster=devnet`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify(call("getSlot")) }), ENV);
  line(r.status === 403, "a request a browser marks cross-site is refused, even without an Origin");
  r = await handleHistory(new Request(`${SITE}/api/history?cluster=devnet&pool=${POOL}`, { headers: { "sec-fetch-site": "cross-site" } }), ENV);
  line(r.status === 403, "on the history too (an img tag on another site)");
  r = await rpc(call("sendTransaction", ["A".repeat(1800), { encoding: "base64" }]));
  line(r.status === 403, "an oversized transaction is refused before it is parsed");

  // a node that does not answer: the error names nothing of the node's address
  const gone = { RPC_URL_DEVNET: "http://127.0.0.1:9/secret-key-here" };
  r = await rpc(call("getSlot"), { env: gone }); b = await r.text();
  line(r.status === 502 && !b.includes("secret"), `the rpc door: ${r.status}, "${JSON.parse(b).error.message}"`);
  r = await handleHistory(new Request(`${SITE}/api/history?cluster=devnet&pool=GwfA58i1111111111111111111111111111111111111`, { headers: {} }), gone);
  b = await r.text();
  line(r.status === 502 && !b.includes("secret"), `the history: ${r.status}, "${JSON.parse(b).error}"`);
  r = await rpc(call("getSlot"), { env: { RPC_URL_DEVNET: '"not a url with secret"' } });
  line(r.status !== 500, "a value that is not a URL counts as none (the public node)");
}
{
  // answers too large are not passed on, and big answers are not kept
  const big = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(5 * 1024 * 1024) })); });
  await new Promise((ok) => big.listen(0, "127.0.0.1", ok));
  const r = await rpc(call("getAccountInfo", ["x"]), { env: { RPC_URL_DEVNET: `http://127.0.0.1:${big.address().port}` } });
  const b = await r.json();
  line(r.status === 502 && /too large/.test(b.error.message), `a 5 MB answer: ${r.status}, "${b.error.message}"`);
  big.close();
  const mid = createServer((req, res) => { mid.n = (mid.n ?? 0) + 1; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "y".repeat(400 * 1024) })); });
  await new Promise((ok) => mid.listen(0, "127.0.0.1", ok));
  const env = { RPC_URL_DEVNET: `http://127.0.0.1:${mid.address().port}` };
  const gpa = call("getProgramAccounts", [PROGRAM, { encoding: "base64", filters: [{ dataSize: 1 }] }]);
  await rpc(gpa, { env }); await rpc(gpa, { env });
  line(mid.n === 2, `a 400 KB account list is passed on but not kept (${mid.n} calls for 2 asks)`);
  mid.close();
}

/* ---------- SOL in dollars ---------- */
{
  const { handlePrice } = await import("./price.mjs");
  const src = createServer((req, res) => {
    src.asked = (src.asked ?? 0) + 1;
    if (req.url.startsWith("/jup")) { res.writeHead(500).end(); return; }      // the first source is down
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ solana: { usd: 123.45 } }));
  });
  await new Promise((ok) => src.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${src.address().port}`, env = { PRICE_JUPITER_URL: `${base}/jup`, PRICE_COINGECKO_URL: `${base}/cg` };
  let r = await handlePrice(new Request(`${SITE}/api/price`), env); let b = await r.json();
  line(r.status === 200 && b.usd === 123.45 && b.source === "CoinGecko", `the first source down: the second one's price (${b.usd}, ${b.source})`);
  line(/s-maxage=30/.test(r.headers.get("cache-control")), "kept at the edge for 30 s");
  const asked = src.asked;
  r = await handlePrice(new Request(`${SITE}/api/price`), env); b = await r.json();
  line(b.usd === 123.45 && src.asked === asked, "asked again at once: from memory, no source asked");
  r = await handlePrice(new Request(`${SITE}/api/price`, { headers: { origin: "https://elsewhere.example" } }), env);
  line(r.status === 403, "a page on another site is refused");
  src.close();
}

/* ---------- a coin's birth ---------- */
{
  const { handleBirth, events, funder } = await import("./birth.mjs");
  const { base58 } = await import("./config.mjs");
  const tagOf = (name) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
  const keyOf = (n) => Buffer.alloc(32, n);
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const trade = (mint, trader, buy, sol) => Buffer.concat([tagOf("TradeEvent"), mint, trader, trader, Buffer.from([buy ? 1 : 0]), u64(sol), u64(sol * 30), u64(1), u64(1), u64(1), Buffer.from([0, 0])]).toString("base64");
  const launched = (mint, creator) => Buffer.concat([tagOf("Launched"), mint, creator, keyOf(0), u64(30e9), u64(52e9), Buffer.from([100, 0]), u64(0)]).toString("base64");
  const seatEvent = (name, mint, owner, sol, seatSol, total = 0) => Buffer.concat([tagOf(name), mint, owner, u64(sol), u64(seatSol), u64(total)]).toString("base64");
  const settled = (mint, sol, tokens, seats) => { const n = Buffer.alloc(4); n.writeUInt32LE(seats); return Buffer.concat([tagOf("Settled"), mint, u64(sol), u64(tokens), n, Buffer.from([0])]).toString("base64"); };
  const MINT = keyOf(5), CREATOR = keyOf(7), A = keyOf(8), B = keyOf(9), C = keyOf(10), FUNDER = keyOf(11);
  const [creator, a, b, c, funderKey] = [CREATOR, A, B, C, FUNDER].map(base58);

  // the decoders
  const ev = events([launched(MINT, CREATOR), trade(MINT, CREATOR, true, 2.5e8)]);
  line(ev.length === 2 && ev[0].kind === "launch" && ev[0].creator === creator && ev[1].trader === creator && ev[1].buy && ev[1].sol === 250000000n, "the launch and trade events decode");
  const cv = events([seatEvent("Committed", MINT, A, 5e8, 5e8, 7e8)]);
  line(cv.length === 1 && cv[0].kind === "commit" && cv[0].owner === a && cv[0].sol === 500000000n && cv[0].seatSol === 500000000n, "a seat taken in an opening batch decodes");
  const wv = events([seatEvent("Withdrawn", MINT, A, 2e8, 3e8, 4e8), settled(MINT, 9e8, 123, 4)]);
  line(wv[0]?.kind === "withdraw" && wv[0].seatSol === 300000000n && wv[0].total === 400000000n && wv[1]?.kind === "settled" && wv[1].sol === 900000000n && wv[1].tokens === 123n && wv[1].seats === 4 && !wv[1].refund,
    "a withdrawal and the batch's settle decode");
  const f = funder({ transaction: { message: { accountKeys: [funderKey, a, "11111111111111111111111111111111"] } }, meta: { preBalances: [5e9, 0, 1], postBalances: [3.99e9, 1e9, 1] } }, a);
  line(f && f.by === funderKey && f.sol === 1, `the funder is the account whose balance fell most (${f && f.by.slice(0, 4)}, ${f && f.sol} SOL)`);
  line(funder({ transaction: { message: { accountKeys: [a] } }, meta: { preBalances: [5], postBalances: [4] } }, a) === null, "a transaction where the wallet only spent gives no funder");

  // a fake chain: each address's signatures (newest first, with before/until/limit as the node reads them), the
  // transactions, the program's accounts, node errors still to give for a transaction, and every call made (with when)
  const chain = { sigs: new Map(), txs: new Map(), accounts: new Map(), errs: new Map(), calls: [] };
  const sigOf = (name) => name.padEnd(88, "x");
  let slot = 100;
  const listed = (who, signature, s, err) => {
    if (!chain.sigs.has(who)) chain.sigs.set(who, []);
    chain.sigs.get(who).unshift({ signature, slot: s, blockTime: 1_800_000_000 + s, err, memo: null, confirmationStatus: "finalized" });
  };
  /** A pool's next transaction, with these event lines logged by the program. */
  const poolTx = (pool, name, lines, err = null) => {
    const signature = sigOf(name), s = slot++;
    listed(pool, signature, s, err);
    chain.txs.set(signature, { blockTime: 1_800_000_000 + s, slot: s, transaction: { message: { accountKeys: [] } }, meta: { err, logMessages: [`Program ${PROGRAM} invoke [1]`, ...lines.map((d) => `Program data: ${d}`), `Program ${PROGRAM} success`] } });
    return signature;
  };
  /** A wallet's own transaction before its buys: `from` sent it `gain` lamports (no `from`: it only spent). */
  const walletTx = (wallet, name, { from, gain = 1e9, err = null } = {}) => {
    const signature = sigOf(name), s = slot++;
    listed(wallet, signature, s, err);
    chain.txs.set(signature, from
      ? { blockTime: 1_800_000_000 + s, slot: s, transaction: { message: { accountKeys: [from, wallet] } }, meta: { err, preBalances: [9e9, 0], postBalances: [9e9 - gain - 5000, gain], logMessages: [] } }
      : { blockTime: 1_800_000_000 + s, slot: s, transaction: { message: { accountKeys: [wallet, base58(keyOf(99))] } }, meta: { err, preBalances: [1e9, 0], postBalances: [5e8, 4.99e8], logMessages: [] } });
    return signature;
  };
  const spam = (pool, n) => { for (let i = 0; i < n; i++) listed(pool, sigOf(`spam${pool.slice(0, 6)}${i}`), slot++, null); };
  const isPoolOf = (mint) => ({ owner: PROGRAM, data: accountData("Pool", mint) });
  const chainNode = createServer((req, res) => {
    let body = ""; req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const parsed = JSON.parse(body), list = Array.isArray(parsed) ? parsed : [parsed];
      const answer = list.map((cl) => {
        const p = cl.params ?? [], ok = (result) => ({ jsonrpc: "2.0", id: cl.id, result });
        chain.calls.push({ method: cl.method, params: p, t: Date.now() });
        if (cl.method === "getAccountInfo") {
          const acc = chain.accounts.get(p[0]);
          return ok({ context: { slot: 1 }, value: acc ? { owner: acc.owner, lamports: 1, data: [acc.data, "base64"], executable: false, rentEpoch: 0 } : null });
        }
        if (cl.method === "getSignaturesForAddress") {
          const all = chain.sigs.get(p[0]) ?? [], o = p[1] ?? {};
          const from = (o.before ? all.findIndex((s) => s.signature === o.before) : -1) + 1;   // a signature it does not list: from the newest
          const u = o.until ? all.findIndex((s) => s.signature === o.until) : -1;
          return ok(all.slice(from, Math.min(u < 0 ? all.length : u, from + (o.limit ?? 1000))));
        }
        if (cl.method === "getTransaction") {
          const errs = chain.errs.get(p[0]) ?? 0;
          if (errs > 0) { chain.errs.set(p[0], errs - 1); return { jsonrpc: "2.0", id: cl.id, error: { code: -32005, message: "Node is behind" } }; }
          return ok(chain.txs.get(p[0]) ?? (p[0].startsWith("spam") ? { blockTime: 1, slot: 1, transaction: { message: { accountKeys: [] } }, meta: { err: null, logMessages: [] } } : null));
        }
        return { jsonrpc: "2.0", id: cl.id, error: { code: -32601, message: "no" } };
      });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.isArray(parsed) ? answer : answer[0]));
    });
  });
  await new Promise((ok) => chainNode.listen(0, "127.0.0.1", ok));
  const CHAIN = `http://127.0.0.1:${chainNode.address().port}`, env = { RPC_URL_DEVNET: CHAIN };
  let asker = 0;
  const birth = async (pool, e = env) => {
    const r = await handleBirth(new Request(`${SITE}/api/birth?cluster=devnet&pool=${pool}`, { headers: { "x-forwarded-for": `10.9.${++asker % 250}.9` } }), e);
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON: j stays null */ }
    return { r, j, text };
  };
  const calls = (method, who) => chain.calls.filter((x) => x.method === method && (!who || x.params[0] === who));
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;                    // later asks, a minute or hours on

  // a small chain: the launch with the creator's buy, then buys by A (funded by the creator), B (an older wallet),
  // C (no earlier transaction), and A again (not a new buyer); between them a transaction that names the pool and
  // carries another pool's launch and buy, and a failed one
  const POOL3 = base58(keyOf(30));
  chain.accounts.set(POOL3, isPoolOf(MINT));
  const D = keyOf(12), OTHER = keyOf(6);
  const fundA = walletTx(a, "fundA", { from: creator, gain: 2e9 });
  for (let i = 0; i < 1000; i++) listed(b, sigOf(`old${i}`), i, null);
  const launchSlot = slot;
  poolTx(POOL3, "launchsig", [launched(MINT, CREATOR), trade(MINT, CREATOR, true, 2.5e8)]);
  poolTx(POOL3, "buyA", [trade(MINT, A, true, 1e8)]);
  poolTx(POOL3, "elsewhere", [launched(OTHER, D), trade(OTHER, D, true, 5e8)]);
  poolTx(POOL3, "buyB", [trade(MINT, B, true, 2e8)]);
  const failedSig = poolTx(POOL3, "failed", [trade(MINT, D, true, 1e8)], { InstructionError: [0, "x"] });
  poolTx(POOL3, "buyC", [trade(MINT, C, true, 3e8)]);
  poolTx(POOL3, "buyA2", [trade(MINT, A, true, 4e8)]);
  {
    const { r, j } = await birth(POOL3);
    line(r.status === 200 && j.complete && j.launch?.creator === creator && j.launch.slot === launchSlot, `the launch: slot ${j.launch?.slot}, by ${j.launch?.creator.slice(0, 4)}`);
    line(j.launch?.firstBuy?.sol === 0.25 && j.launch.firstBuy.tokens === 7.5e3, `the creator's buy in the launch: ${j.launch?.firstBuy?.sol} SOL`);
    const byW = Object.fromEntries((j.buyers ?? []).map((x) => [x.wallet, x]));
    line(j.buyers?.length === 4 && byW[creator]?.creator && !byW[a]?.creator, `four first buyers, each once, the creator marked (${j.buyers?.length})`);
    line(!byW[base58(D)], "a buy in another pool, in a transaction that names this one, is not this pool's");
    line(!calls("getTransaction").some((x) => x.params[0] === failedSig), "a failed transaction is not fetched");
    line(j.read === 5 && j.more === false, `read: the 5 transactions with this pool's events, nothing after them (${j.read}, more: ${j.more})`);
    line(byW[a]?.funding?.by === creator && byW[a].funding.sol === 2 && byW[a].funding.signature === fundA, "A's SOL came from the creator's wallet, 2 SOL, with its transaction");
    line(byW[b]?.funding?.older === true, "B is an older wallet (1,000 transactions before)");
    line(byW[c]?.funding?.none === true, "C has no transfer before its buy");
    line(/s-maxage=60/.test(r.headers.get("cache-control")), "fewer than ten buyers: cached a minute at the edge");
  }

  // read on, not again: a young coin gets only its new transactions read a minute later; and a buyer's funding skips
  // its failed transactions and tries its oldest three
  const POOL5 = base58(keyOf(32)), MINT5 = keyOf(13), E1 = base58(keyOf(14)), E2 = base58(keyOf(15)), E3 = keyOf(17), E4 = keyOf(18);
  chain.accounts.set(POOL5, isPoolOf(MINT5));
  const e1Fail = walletTx(E1, "e1Fail", { from: base58(keyOf(16)), err: { InstructionError: [0, "x"] } });
  walletTx(E1, "e1Spend");
  const e1Fund = walletTx(E1, "e1Fund", { from: funderKey });
  const e2Spends = [walletTx(E2, "e2Spend1"), walletTx(E2, "e2Spend2"), walletTx(E2, "e2Spend3")];
  walletTx(E2, "e2Fund", { from: funderKey });
  poolTx(POOL5, "launch5", [launched(MINT5, CREATOR), trade(MINT5, CREATOR, true, 1e8)]);
  poolTx(POOL5, "buyE1", [trade(MINT5, keyOf(14), true, 1e8)]);
  const lastSeen = poolTx(POOL5, "buyE2", [trade(MINT5, keyOf(15), true, 1e8)]);
  {
    chain.calls = [];
    let { j } = await birth(POOL5);
    const byW = Object.fromEntries((j.buyers ?? []).map((x) => [x.wallet, x]));
    line(j.complete && j.buyers.length === 3, `a young coin: ${j.buyers?.length} buyers, complete`);
    line(byW[E1]?.funding?.by === funderKey && byW[E1].funding.signature === e1Fund && !calls("getTransaction").some((x) => x.params[0] === e1Fail),
      "a buyer's failed oldest transaction is skipped, one that only spent is passed, the next one funded it");
    const e2Read = calls("getTransaction").filter((x) => x.params[0].startsWith("e2")).map((x) => x.params[0]);
    line(byW[E2]?.funding?.none === true && e2Read.length === 3 && e2Spends.every((s) => e2Read.includes(s)), `none of a buyer's oldest three gave it SOL: none (${e2Read.length} read)`);
    chain.calls = [];
    ({ j } = await birth(POOL5));
    line(j.complete && chain.calls.length === 0, "asked again within the minute: nothing goes to the node");
    const newSigs = [poolTx(POOL5, "buyE3", [trade(MINT5, E3, true, 1e8)]), poolTx(POOL5, "buyE4", [trade(MINT5, E4, true, 1e8)])];
    shift += 61_000;
    chain.calls = [];
    ({ j } = await birth(POOL5));
    const listedPool = calls("getSignaturesForAddress", POOL5), fetched = calls("getTransaction").map((x) => x.params[0]);
    line(listedPool.length === 1 && listedPool[0].params[1].until === lastSeen, "a minute later: one listing, of the signatures after the newest seen");
    line(fetched.length === 2 && newSigs.every((s) => fetched.includes(s)) && !calls("getAccountInfo").length, `and only the two new transactions are fetched (${fetched.length})`);
    line(j.buyers.length === 5 && j.read === 5 && j.buyers[3].wallet === base58(E3) && j.buyers[1].funding?.by === funderKey, `five buyers now, the first three as they were (${j.buyers.length}, read ${j.read})`);
  }

  // an opening batch: the creator's seat taken in the launch, seats in and out, and more than ten wallets; after the
  // tenth the reading goes on to the settle, for the seats' last SOL
  const POOL4 = base58(keyOf(31)), MINT4 = keyOf(20), W = Array.from({ length: 11 }, (_, i) => keyOf(50 + i)), w = W.map(base58);
  chain.accounts.set(POOL4, isPoolOf(MINT4));
  poolTx(POOL4, "launch4", [launched(MINT4, CREATOR), seatEvent("Committed", MINT4, CREATOR, 5e8, 5e8)]);
  poolTx(POOL4, "w0in", [seatEvent("Committed", MINT4, W[0], 2e8, 2e8)]);
  poolTx(POOL4, "w0more", [seatEvent("Committed", MINT4, W[0], 1e8, 3e8)]);
  poolTx(POOL4, "w1in", [seatEvent("Committed", MINT4, W[1], 4e8, 4e8)]);
  poolTx(POOL4, "w1out", [seatEvent("Withdrawn", MINT4, W[1], 4e8, 0)]);
  for (let i = 2; i < 10; i++) poolTx(POOL4, `w${i}in`, [seatEvent("Committed", MINT4, W[i], 1e8, 1e8)]);
  poolTx(POOL4, "w0less", [seatEvent("Withdrawn", MINT4, W[0], 1e8, 2e8)]);
  poolTx(POOL4, "settle4", [settled(MINT4, 1.5e9, 4e13, 10), trade(MINT4, keyOf(31), true, 1.5e9)]);
  poolTx(POOL4, "w10buy", [trade(MINT4, W[10], true, 1e8)]);
  let finalText;
  {
    chain.calls = [];
    const { r, j, text } = await birth(POOL4);
    finalText = text;
    const byW = Object.fromEntries((j.buyers ?? []).map((x) => [x.wallet, x]));
    line(j.launch?.firstBuy?.batch === true && j.launch.firstBuy.sol === 0.5 && !("tokens" in j.launch.firstBuy), "the creator's seat in the launch is its first buy, batch: true");
    line(j.buyers?.length === 10 && !byW[w[9]] && !byW[POOL4] && !byW[w[10]], "ten first wallets: the eleventh seat, the batch's own buy and a later buyer are not among them");
    line(byW[creator]?.creator && byW[creator].batch && byW[creator].seat?.sol === 0.5 && byW[creator].seat.settled, "the creator's seat: 0.5 SOL, settled");
    line(byW[w[0]]?.sol === 0.2 && byW[w[0]].seat?.sol === 0.2 && byW[w[0]].seat.settled && !byW[w[0]].seat.out,
      `a seat followed past the tenth wallet to the settle: first 0.2, then 0.3, at the settle ${byW[w[0]]?.seat?.sol} SOL`);
    line(byW[w[1]]?.seat?.sol === 0 && byW[w[1]].seat.out === true && byW[w[1]].seat.settled, "a seat emptied before the settle: 0 SOL, out");
    line(j.read === 15 && j.more === true, `the reading stops at the settle, with a transaction after it (read ${j.read}, more: ${j.more})`);
    line(j.complete && /s-maxage=3600/.test(r.headers.get("cache-control")), "final: cached at the edge for an hour");
  }
  {
    shift += 2 * 60 * 60 * 1000;
    chain.calls = [];
    const { r, text } = await birth(POOL4);
    line(r.status === 200 && text === finalText && chain.calls.length === 0, `two hours later: the same answer, from memory, no call to the node (${chain.calls.length})`);
    const { j } = await birth(POOL5);
    line(j.complete && calls("getSignaturesForAddress").length === 1 && !calls("getTransaction").length && !calls("getAccountInfo").length,
      "a coin that is not final is still kept: only a listing of what is new");
  }

  // a batch of fewer than ten seats: the settle's buy, by the pool itself, is not a buyer; a buy after the settle is
  const POOL9 = base58(keyOf(39)), MINT9 = keyOf(24), S1 = keyOf(25), L1 = keyOf(26);
  chain.accounts.set(POOL9, isPoolOf(MINT9));
  poolTx(POOL9, "launch9", [launched(MINT9, CREATOR), seatEvent("Committed", MINT9, CREATOR, 3e8, 3e8)]);
  poolTx(POOL9, "s1in", [seatEvent("Committed", MINT9, S1, 2e8, 2e8)]);
  poolTx(POOL9, "settle9", [settled(MINT9, 5e8, 1e13, 2), trade(MINT9, keyOf(39), true, 5e8)]);
  poolTx(POOL9, "l1buy", [trade(MINT9, L1, true, 1e8)]);
  {
    const { j } = await birth(POOL9);
    const order = (j.buyers ?? []).map((x) => x.wallet), last = j.buyers?.[2];
    line(j.complete && order.join() === [creator, base58(S1), base58(L1)].join() && !order.includes(POOL9),
      `two seats and the settle: the pool's own buy in it is not a buyer (${order.length} wallets)`);
    line(j.buyers?.[1]?.seat?.sol === 0.2 && j.buyers[1].seat.settled && last && !last.batch && !("seat" in last) && last.sol === 0.1,
      "and a buy after the settle is one, without a seat");
  }

  // a node error on a buyer's funding transaction: it is not read, so no later sender and no "none" stand for it; the
  // other buyers go on, the answer stays incomplete, and the next ask tries the same transaction again
  const POOL10 = base58(keyOf(40)), MINT10 = keyOf(27), [X, Y, Z, F1, F2] = [41, 42, 43, 44, 45].map((n) => base58(keyOf(n)));
  chain.accounts.set(POOL10, isPoolOf(MINT10));
  const xFund = walletTx(X, "xFund", { from: F1 });
  walletTx(X, "xLater", { from: F2 });
  walletTx(Y, "yFund", { from: F2 });
  const zSpends = [walletTx(Z, "zSpend1"), walletTx(Z, "zSpend2"), walletTx(Z, "zSpend3")];
  poolTx(POOL10, "launch10", [launched(MINT10, CREATOR)]);
  poolTx(POOL10, "buyX", [trade(MINT10, keyOf(41), true, 1e8)]);
  poolTx(POOL10, "buyZ", [trade(MINT10, keyOf(43), true, 1e8)]);
  poolTx(POOL10, "buyY", [trade(MINT10, keyOf(42), true, 1e8)]);
  chain.errs.set(xFund, 1); chain.errs.set(zSpends[0], 2);
  {
    chain.calls = [];
    let { r, j } = await birth(POOL10);
    let byW = Object.fromEntries((j.buyers ?? []).map((x) => [x.wallet, x]));
    line(!j.complete && byW[X]?.funding === null && byW[Y]?.funding?.by === F2 && calls("getTransaction", xFund).length === 1 && /s-maxage=1\b/.test(r.headers.get("cache-control")),
      "a node error on a buyer's oldest transaction: no later sender for it, the next buyers go on, not complete");
    line(byW[Z]?.funding === null && calls("getTransaction", zSpends[0]).length === 1 && !calls("getTransaction", zSpends[1]).length, "and no \"none\" for one whose oldest was not read");
    ({ j } = await birth(POOL10));
    byW = Object.fromEntries((j.buyers ?? []).map((x) => [x.wallet, x]));
    line(!j.complete && byW[X]?.funding?.by === F1 && byW[X].funding.signature === xFund && byW[Z]?.funding === null,
      "asked again: the same transaction is read and its sender is the funder; one still failing stays unread");
    ({ j } = await birth(POOL10));
    byW = Object.fromEntries((j.buyers ?? []).map((x) => [x.wallet, x]));
    const zAsked = zSpends.map((s) => calls("getTransaction", s).length);
    line(j.complete && byW[Z]?.funding?.none === true && zAsked.join() === "3,1,1", `none once its oldest three were all served (asked ${zAsked.join(", ")} times)`);
  }

  // 5,000 transactions exactly: the start is in them (not tooOld); spam that only names the pool stops at 200 fetched.
  // 5,001: its start is further back than this pages.
  const POOL6 = base58(keyOf(33)), MINT6 = keyOf(21), POOL7 = base58(keyOf(34));
  chain.accounts.set(POOL6, isPoolOf(MINT6)); chain.accounts.set(POOL7, isPoolOf(keyOf(22)));
  poolTx(POOL6, "launch6", [launched(MINT6, CREATOR)]);
  spam(POOL6, 4999);
  poolTx(POOL7, "launch7", [launched(keyOf(22), CREATOR)]);
  spam(POOL7, 5000);
  {
    chain.calls = [];
    let { r, j } = await birth(POOL6);
    line(!j.tooOld && j.launch?.signature === sigOf("launch6") && calls("getSignaturesForAddress", POOL6).length === 6, `exactly 5,000: five pages and one more look, the start found (tooOld: ${j.tooOld})`);
    line(j.complete && j.read === 1 && j.more === true && calls("getTransaction").length === 200 && /s-maxage=3600/.test(r.headers.get("cache-control")),
      `spam after the launch: ${calls("getTransaction").length} fetched, read ${j.read}, more: ${j.more}, final`);
    chain.calls = [];
    ({ r, j } = await birth(POOL7));
    line(j.tooOld && j.complete && j.more && !j.buyers.length && !calls("getTransaction").length, `5,001: tooOld, nothing fetched (${calls("getSignaturesForAddress").length} listings)`);
  }

  // what the program owns and is not a pool: a seat, the config
  {
    const SEAT = base58(keyOf(35)), CONF = base58(keyOf(36)), ELSE = base58(keyOf(37));
    chain.accounts.set(SEAT, { owner: PROGRAM, data: accountData("Seat", keyOf(9)) });
    chain.accounts.set(CONF, { owner: PROGRAM, data: accountData("Config", keyOf(9)) });
    chain.accounts.set(ELSE, { owner: "11111111111111111111111111111111", data: accountData("Pool", MINT) });
    const seat = await birth(SEAT), conf = await birth(CONF), other = await birth(ELSE);
    line(seat.r.status === 404 && conf.r.status === 404 && other.r.status === 404, `a seat, the config, a Pool-like account of another program: not pools (${seat.r.status} ${conf.r.status} ${other.r.status})`);
  }

  // the public node: the birth waits on the mark the history sets
  {
    const real = CLUSTERS.devnet.publicRpc;
    CLUSTERS.devnet.publicRpc = CHAIN;
    const POOL8 = base58(keyOf(38));
    chain.accounts.set(POOL8, isPoolOf(keyOf(23)));
    poolTx(POOL8, "launch8", [launched(keyOf(23), CREATOR)]);
    publicPace.devnet = Date.now() + 30_000;             // as if the history had just taken the node's turns
    chain.calls = [];
    const t0 = realNow();
    let { j } = await birth(POOL8, { RPC_URL_DEVNET: "" });
    line(j && !j.complete && !j.buyers.length && !chain.calls.length && realNow() - t0 < 3000, "on the public node a birth keeps the history's pace: no call before the mark, the pool check included");
    const mark = Date.now() + 500;
    publicPace.devnet = mark;
    ({ j } = await birth(POOL8, { RPC_URL_DEVNET: "" }));
    const gaps = chain.calls.slice(1).map((x, i) => x.t - chain.calls[i].t);
    line(j.complete && chain.calls[0]?.method === "getAccountInfo" && chain.calls[0].t >= mark - 5 && chain.calls.length === 3 && gaps.every((g) => g >= PUBLIC_GAP - 5),
      `and with the mark near: its ${chain.calls.length} calls, the first at the mark, then ${Math.min(...gaps)} ms apart at least`);
    publicPace.devnet = 0;
    CLUSTERS.devnet.publicRpc = real;
  }
  Date.now = realNow;
  chainNode.close();
}

fake.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall server checks passed");
process.exit(failed ? 1 : 0);
