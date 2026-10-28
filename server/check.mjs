// Checks the site's server (rpc.mjs, history.mjs) against a fake node on this machine. Nothing touches a real cluster.
//
//   node server/check.mjs        (from the repo root; site/chain must have its node_modules, for a real transaction)

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { handleRpc, programsOf } from "./rpc.mjs";
import { handleHistory } from "./history.mjs";
import { CLUSTERS, addressBytes } from "./config.mjs";

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const PROGRAM = CLUSTERS.devnet.program;

/* ---------- the program ids here and in site/net.js agree ---------- */
const netJs = readFileSync(new URL("../site/net.js", import.meta.url), "utf8");
line(netJs.includes(`program: "${PROGRAM}"`), "site/net.js names the same devnet program as server/config.mjs");
line(/mainnet:[\s\S]*?program: "([^"]*)"/.exec(netJs)?.[1] === CLUSTERS.mainnet.program, "and the same (still empty) mainnet program");

/* ---------- a fake node ---------- */
const node = { calls: [], batches: 0, sigs: [], txs: new Map(), owner: PROGRAM, limit: Infinity, window: [], null: new Set() };
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body), list = Array.isArray(parsed) ? parsed : [parsed];
    if (Array.isArray(parsed)) node.batches++;
    const now = Date.now();
    const answer = list.map((c) => {
      node.calls.push(c.method);
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
      if (c.method === "getAccountInfo") return { jsonrpc: "2.0", id: c.id, result: { context: { slot: 1 }, value: { owner: node.owner, lamports: 1, data: ["", "base64"], executable: false, rentEpoch: 0 } } };
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
  r = await hist("xyz");
  line(r.status === 400, "nor does something that is not an address");
  r = await hist(POOL, { origin: "https://elsewhere.example" });
  line(r.status === 403, "nor a page on another site");
}
{
  // the public node: one call every 1.3 s, so a long history comes over a few answers
  makeSigs(12, "free"); node.calls = [];
  const env = { RPC_URL_DEVNET: "" };
  const POOL2 = "FHfQPN22769p2qFcF6r2YooGnp2SRXmnMEH5cUN1Dny2";
  // the public node is the real one by default: point it at the fake one for this check
  const real = CLUSTERS.devnet.publicRpc;
  CLUSTERS.devnet.publicRpc = UP;
  const t0 = Date.now();
  let r = await hist(POOL2, { env });
  let b = await r.json();
  const took = Date.now() - t0;
  line(r.status === 200 && !b.complete && b.have >= 4 && b.have <= 7, `the public node, first answer: ${b.have} of ${b.total} in ${(took / 1000).toFixed(1)} s, not complete`);
  line(/s-maxage=1/.test(r.headers.get("cache-control")), "an answer still filling is kept only 1 s at the edge");
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

fake.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall server checks passed");
process.exit(failed ? 1 : 0);
