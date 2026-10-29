// Checks the site's server (rpc.mjs, history.mjs, price.mjs, birth.mjs, pools.mjs) against fake nodes on this machine.
// Nothing touches a real cluster.
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
// limit: getTransaction calls a second, past it each one gets a 429 in its answer (a paid plan's rate). busy: a
// method or a transaction's signature -> how many more requests that ask for it get HTTP 429 (a busy public node).
// asked: the transactions it served or answered null for. noBatch: how it refuses every batch (a plan that takes
// none): "object", one JSON-RPC error with id null; "list", that error in a list; "each", an error for each call, with
// its id; or an HTTP status, with a body that is not JSON.
const node = { calls: [], times: [], batches: 0, sigs: [], txs: new Map(), owner: PROGRAM, data: accountData("Pool"), limit: Infinity, window: [], null: new Set(), busy: new Map(), asked: [], noBatch: null };
/** A refusal of a batch (the calls in `list`), as a plan that takes none answers it; true when it answered. */
function refuseBatch(how, res, list) {
  if (!how) return false;
  const no = (id) => ({ jsonrpc: "2.0", id, error: { code: -32600, message: "Batch requests are not allowed on this plan" } });
  const answer = { object: no(null), list: [no(null)], each: list.map((c) => no(c.id)) }[how];
  if (answer) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  else res.writeHead(how, { "content-type": "text/plain" }).end("Request Entity Too Large");
  return true;
}
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body), list = Array.isArray(parsed) ? parsed : [parsed];
    if (Array.isArray(parsed)) node.batches++;
    if (Array.isArray(parsed) && refuseBatch(node.noBatch, res, list)) return;
    const now = Date.now();
    const refuse = list.map((c) => (c.method === "getTransaction" ? c.params?.[0] : c.method)).find((k) => node.busy.get(k) > 0);
    if (refuse) {
      node.busy.set(refuse, node.busy.get(refuse) - 1);
      for (const c of list) { node.calls.push(c.method); node.times.push(now); }
      res.writeHead(429).end();
      return;
    }
    const answer = list.map((c) => {
      node.calls.push(c.method); node.times.push(now);
      if (c.method === "getTransaction") {
        node.window = node.window.filter((t) => t > now - 1000); node.window.push(now);
        if (node.window.length > node.limit) return { jsonrpc: "2.0", id: c.id, error: { code: 429, message: "slow" } };
        const sig = c.params[0];
        node.asked.push(sig);
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
      if (c.method === "getRecentPrioritizationFees") return { jsonrpc: "2.0", id: c.id, result: [{ slot: 1, prioritizationFee: 0 }, { slot: 2, prioritizationFee: 1500 }] };
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

/* ---------- the recent priority fees, asked before each send ---------- */
{
  const { base58 } = await import("./config.mjs");
  const keys = (n, from = 1) => Array.from({ length: n }, (_, i) => base58(Buffer.alloc(32, from + i)));
  const fees = () => node.calls.filter((m) => m === "getRecentPrioritizationFees").length;
  const accounts = keys(3, 60);
  node.calls = [];
  let r = await rpc(call("getRecentPrioritizationFees", [accounts])), b = await r.json();
  line(r.status === 200 && b.result?.[1]?.prioritizationFee === 1500, "the recent priority fees for a transaction's accounts pass");
  r = await rpc(call("getRecentPrioritizationFees", []));
  line(r.status === 200 && fees() === 2, "and with no accounts (the whole cluster's), as web3.js sends it");
  r = await rpc(call("getRecentPrioritizationFees", [[...accounts].reverse()], 5)); b = await r.json();
  line(r.status === 200 && b.id === 5 && b.result?.length === 2 && fees() === 2, "the same accounts in another order a moment later: from memory, with the page's own id");
  r = await rpc(call("getRecentPrioritizationFees", [keys(2, 60)]));
  line(r.status === 200 && fees() === 3, "another set of accounts is asked for on its own");
  const realNow = Date.now;
  Date.now = () => realNow() + 3100;
  await rpc(call("getRecentPrioritizationFees", [accounts]));
  Date.now = realNow;
  line(fees() === 4, "three seconds on, the node is asked again");
  r = await rpc(call("getRecentPrioritizationFees", [keys(128)]));
  line(r.status === 200, "128 accounts pass");
  r = await rpc(call("getRecentPrioritizationFees", [keys(129)]));
  line(r.status === 403, `129 do not (${r.status})`);
  r = await rpc(call("getRecentPrioritizationFees", [[...accounts, "not an address"]]));
  line(r.status === 403, "nor something that is not an address");
  r = await rpc(call("getRecentPrioritizationFees", [accounts[0]]));
  line(r.status === 403, "nor an address that is not in a list");
  r = await rpc(call("getRecentPrioritizationFees", [accounts, { percentile: 5000 }]));
  line(r.status === 403, "nor a settings object (the site sends none)");
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
  // the share of sends counts transactions. Unsigned ones all carry the same signature (zeros), and each still counts
  const blockhash = () => web3.Keypair.generate().publicKey.toBase58();
  const unsigned = () => new web3.Transaction({ feePayer: payer, recentBlockhash: blockhash() }).add(...built.tx.instructions)
    .serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  // the page sends a transaction first with its preflight, then again with none (site/chain's confirm)
  const send = async (tx, who, preflight = false) => (await rpc(call("sendTransaction", [tx, preflight ? { encoding: "base64", skipPreflight: false } : { encoding: "base64", skipPreflight: true, maxRetries: 0 }]), { who })).status;
  let sends = [];
  for (let i = 0; i < 14; i++) sends.push(await send(unsigned(), "9.9.9.9"));
  line(sends.filter((s) => s === 200).length === 12 && sends.at(-1) === 429, `12 transactions a minute from one address, then 429, though their signatures are the same zeros (${sends.join(" ")})`);
  // a signed one sent again three times while the page waits for it, as site/chain's confirm does: one share
  const signer = web3.Keypair.generate(), mine = await Chain.buildBuy({ pool, owner: signer.publicKey, sol: 0.01 });
  const signed = () => { const t = new web3.Transaction({ feePayer: signer.publicKey, recentBlockhash: blockhash() }).add(...mine.tx.instructions); t.sign(signer); return t.serialize().toString("base64"); };
  const first = signed();
  sends = [];
  for (let i = 0; i < 4; i++) sends.push(await send(first, "9.9.9.8", i === 0));
  for (let i = 0; i < 11; i++) sends.push(await send(signed(), "9.9.9.8"));
  line(sends.every((s) => s === 200), `a transaction and three resends of it, then 11 others: all pass, 12 shares (${sends.join(" ")})`);
  line(await send(signed(), "9.9.9.8") === 429 && await send(first, "9.9.9.8") === 200, "a 13th transaction does not, and the first one sent again still does");
  line(await send(first, "9.9.9.8") === 429, "but not a fifth time: past four free resends, each one is a share");
  // the same bytes over and over: four resends are free, then each takes a share, and the shares run out
  const again = signed();
  sends = [];
  for (let i = 0; i < 20; i++) sends.push(await send(again, "9.9.9.7"));
  line(sends.filter((s) => s === 200).length === 16 && sends.at(-1) === 429, `the same transaction 20 times: 16 pass (1 + 4 free + 11), then 429 (${sends.join(" ")})`);
  // a resend with its preflight is a simulation too: it takes a share
  const checked = signed();
  sends = [];
  for (let i = 0; i < 12; i++) sends.push(await send(checked, "9.9.9.6", true));
  line(sends.every((s) => s === 200) && await send(signed(), "9.9.9.6") === 429, `a transaction and 11 resends of it with their preflight take 12 shares: the next transaction gets 429 (${sends.join(" ")})`);
  // ten copies of one transaction in one batch: the first and four free, then five shares
  const copies = signed(), batch = Array.from({ length: 10 }, (_, i) => call("sendTransaction", [copies, { encoding: "base64", skipPreflight: true, maxRetries: 0 }], i));
  r = await rpc(batch, { who: "9.9.9.5" });
  sends = [];
  for (let i = 0; i < 7; i++) sends.push(await send(signed(), "9.9.9.5"));
  line(r.status === 200 && sends.filter((s) => s === 200).length === 6 && sends.at(-1) === 429, `ten copies in one batch take six shares: six more transactions pass, then 429 (${sends.join(" ")})`);
}

/* ---------- transactions: what a wallet adds as it signs ---------- */
// Phantom appends Lighthouse assertions to what it signs, and some wallets a memo; the page sends what came back
{
  const require = createRequire(new URL("../site/chain/package.json", import.meta.url));
  const Chain = require("../vendor/chain.js");
  const web3 = require("@solana/web3.js");
  Chain.setNet({ cluster: "devnet", rpcUrl: UP, program: PROGRAM });
  const LIGHTHOUSE = new web3.PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"), MEMO = new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  const owner = web3.Keypair.generate().publicKey;
  const pool = {
    address: Chain.poolAddress(web3.Keypair.generate().publicKey), mint: web3.Keypair.generate().publicKey, vault: web3.Keypair.generate().publicKey,
    creator: owner, treasury: owner, feeBps: 100, virtualSol: 30_000_000_000n, realSol: 0n, tokens: Chain.SUPPLY, graduationSol: 42_000_000_000n, graduated: false,
  };
  const built = await Chain.buildBuy({ pool, owner, sol: 0.01 });
  // an assertion on the wallet's own account, as Lighthouse's are, and a memo signed by the wallet
  const guard = new web3.TransactionInstruction({ programId: LIGHTHOUSE, keys: [{ pubkey: owner, isSigner: false, isWritable: false }], data: Buffer.from([4, 0, 1, 2, 3]) });
  const memo = new web3.TransactionInstruction({ programId: MEMO, keys: [{ pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.from("nox") });
  const tx = (...ins) => new web3.Transaction({ feePayer: owner, recentBlockhash: web3.Keypair.generate().publicKey.toBase58() }).add(...ins)
    .serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const send = async (b64, who) => (await rpc(call("sendTransaction", [b64, { encoding: "base64" }]), { who })).status;
  const sim = async (b64, who) => (await rpc(call("simulateTransaction", [b64, { encoding: "base64", sigVerify: false }]), { who })).status;
  const changed = tx(...built.tx.instructions, guard, memo);
  line(programsOf(changed)?.slice(-2).join() === [LIGHTHOUSE.toBase58(), MEMO.toBase58()].join(), "a buy with a Lighthouse guard and a memo after it reads as those programs last");
  line(await send(changed, "9.9.8.1") === 200 && await sim(changed, "9.9.8.1") === 200, "a buy the wallet added a Lighthouse guard and a memo to may be sent, and simulated");
  line(await send(tx(guard, ...built.tx.instructions), "9.9.8.1") === 200, "and with the guard first");
  line(await send(tx(built.tx.instructions[0], guard, memo), "9.9.8.2") === 403, "a guard and a memo with only a compute budget, no pool instruction, are refused");
  line(await send(tx(memo), "9.9.8.2") === 403, "a memo alone is refused");
  const transfer = web3.SystemProgram.transfer({ fromPubkey: owner, toPubkey: web3.Keypair.generate().publicKey, lamports: 1 });
  line(await send(tx(...built.tx.instructions, guard, transfer), "9.9.8.3") === 403, "a buy with a guard and a SOL transfer is refused");
  const other = new web3.TransactionInstruction({ programId: web3.Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) });
  line(await send(tx(...built.tx.instructions, memo, other), "9.9.8.3") === 403, "a buy with a memo and an unknown program is refused");
  line(await send(tx(...built.tx.instructions, new web3.TransactionInstruction({ programId: new web3.PublicKey("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"), keys: [], data: Buffer.from("x") })), "9.9.8.4") === 403,
    "the old memo program is not one of them");
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
  const took = Date.now() - t0, first = b.have;
  // 7 s for the whole answer: the wait for the mark, the pool check and the listing, then three transactions
  line(r.status === 200 && !b.complete && b.have >= 2 && b.have <= 4 && took < 7500, `the public node, first answer: ${b.have} of ${b.total} in ${(took / 1000).toFixed(1)} s, not complete`);
  const gaps = node.times.slice(1).map((t, i) => t - node.times[i]);
  line(node.calls[0] === "getAccountInfo" && node.calls[1] === "getSignaturesForAddress" && node.times[0] >= mark - 5 && gaps.every((g) => g >= PUBLIC_GAP - 5),
    `every call takes its turn, the pool check and the listing too: the first at the mark, then ${Math.min(...gaps)} ms apart at least`);
  line(/s-maxage=1/.test(r.headers.get("cache-control")), "an answer still filling is kept only 1 s at the edge");
  line(publicPace.devnet > t0, "and its calls set the public node's one mark, which the birth keeps too");
  const newest = node.sigs.filter((s) => !s.err).slice(0, b.have).map((s) => s.signature);
  line(newest.every((s) => b.txs[s]), "and what it has is the newest");
  r = await hist(POOL2, { env }); b = await r.json();
  line(b.complete || b.have >= first + 3, `the next answer goes on: ${b.have} of ${b.total}`);
  CLUSTERS.devnet.publicRpc = real;
}
{
  // the public node answers 429, or its next turn comes after the answer's time: each answer comes at once with what it
  // has (with no list yet: "ask again shortly", not "the node did not answer"), the next ones make no call until the
  // pause is over, and then the reading goes on from where it stopped
  const { base58 } = await import("./config.mjs");
  const real = CLUSTERS.devnet.publicRpc, realNow = Date.now, env = { RPC_URL_DEVNET: "" };
  CLUSTERS.devnet.publicRpc = UP;
  let ahead = 0;
  Date.now = () => realNow() + ahead;                    // past the 12 s pause without waiting it out
  const P1 = base58(Buffer.alloc(32, 51)), P2 = base58(Buffer.alloc(32, 52));
  const ask = async (pool) => { const t = realNow(), r = await hist(pool, { env }); return { r, b: r.status === 200 ? await r.json() : null, took: realNow() - t }; };
  makeSigs(3, "slow"); node.calls = []; node.asked = [];
  publicPace.devnet = 0;
  node.busy.set("getAccountInfo", 1);
  let { r, b, took } = await ask(P1);
  line(r.status === 503 && r.headers.get("retry-after") && publicPace.devnet >= Date.now() + 11_000 && took < 1000,
    `a 429 on the pool check: "ask again shortly" at once (${r.status}, ${took} ms), and no call to the public node for 12 s`);
  node.calls = [];
  ({ r, took } = await ask(P2));
  line(r.status === 503 && !node.calls.length && took < 1000, `a pool never asked for, during the pause: no call, answered in ${took} ms, not after the pause (${r.status})`);
  ahead += 12_000; node.calls = [];
  node.busy.set("getSignaturesForAddress", 1);
  ({ r } = await ask(P1));
  line(r.status === 503 && node.calls.join() === "getAccountInfo,getSignaturesForAddress" && publicPace.devnet >= Date.now() + 11_000,
    `after the pause: the pool check, then a 429 on its first listing: "ask again shortly" (${r.status})`);
  ahead += 12_000; node.calls = [];
  node.busy.set(node.sigs[1].signature, 1);
  ({ r, b } = await ask(P1));
  line(r.status === 200 && b && !b.complete && b.have === 1 && b.total === 3 && publicPace.devnet >= Date.now() + 11_000,
    `after the pause: a 429 on its second transaction, the answer has the first (${b?.have} of ${b?.total}), not complete`);
  node.calls = [];
  ({ r, b, took } = await ask(P1));
  line(r.status === 200 && b?.have === 1 && !b.complete && !node.calls.length && took < 1000, `asked again during the pause: the same, at once, no call (${took} ms)`);
  ahead += 12_000;
  ({ r, b } = await ask(P1));
  line(b?.complete && node.asked.length === 3 && new Set(node.asked).size === 3, `after the pause: complete, each transaction served once (${node.asked.length})`);
  // ten minutes on the pool check is no longer kept, and the node's turn is late: an account read as a pool stays one,
  // so the answer is the list kept, not "ask again shortly"
  ahead += 10 * 60 * 1000 + 1000; node.calls = [];
  publicPace.devnet = Date.now() + 20_000;
  ({ r, b, took } = await ask(P1));
  line(r.status === 200 && b?.complete && b.have === 3 && !node.calls.length && took < 1000,
    `ten minutes on, with the node's turn late: the list kept, at once, no call (${r.status}, ${took} ms)`);
  publicPace.devnet = 0;
  Date.now = realNow;
  CLUSTERS.devnet.publicRpc = real;
}
{
  // a pool never listed, with the public node's next turn 6 s on (half a pause after a 429): its pool check and its
  // listing may wait past the answer's 7 s, since without a list the answer would be a 503 (the page then reads the
  // node itself for that read). It gets the list, with no transaction yet, under the page's 15 s
  const { base58 } = await import("./config.mjs");
  const real = CLUSTERS.devnet.publicRpc, env = { RPC_URL_DEVNET: "" };
  CLUSTERS.devnet.publicRpc = UP;
  makeSigs(3, "cold"); node.calls = [];
  const t0 = Date.now();
  publicPace.devnet = t0 + 6000;
  const r = await hist(base58(Buffer.alloc(32, 54)), { env }), b = r.status === 200 ? await r.json() : null, took = Date.now() - t0;
  line(r.status === 200 && b?.total === 3 && b.have === 0 && !b.complete && took < 12_000 && node.calls.join() === "getAccountInfo,getSignaturesForAddress",
    `a first list after a long wait for the node's turn: ${r.status}, ${b?.have} of ${b?.total} in ${(took / 1000).toFixed(1)} s, not complete`);
  publicPace.devnet = 0;
  CLUSTERS.devnet.publicRpc = real;
}
{
  // a paid node with a rate: past it some answers in a batch are 429. What was served is kept, the rest is not asked
  // for in a loop, and the next answer goes on
  const { base58 } = await import("./config.mjs");
  makeSigs(15, "rate"); node.calls = []; node.window = []; node.limit = 5;
  const P3 = base58(Buffer.alloc(32, 53));
  let r = await hist(P3), b = await r.json();
  const asked = node.calls.filter((m) => m === "getTransaction").length;
  line(r.status === 200 && !b.complete && b.have === 5 && b.total === 14 && asked <= 20, `a paid node's 429 on part of a batch: ${b.have} of ${b.total} kept, ${asked} asked, not complete`);
  await new Promise((ok) => setTimeout(ok, 1100));
  r = await hist(P3); b = await r.json();
  line(r.status === 200 && b.have === 10, `a second later the next answer goes on: ${b.have} of ${b.total}`);
  node.limit = Infinity;
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
{
  // a paid node on a plan that takes no batches: it answers one with a single error (id null), alone or in a list, with
  // an error for each call, or with HTTP 413. The same round goes again as single calls, and for ten minutes it is sent
  // no batch at all. RPC_BATCH=0 sends none
  const { base58 } = await import("./config.mjs");
  const { noBatches = {}, call: nodeCall } = await import("./history.mjs");
  const singles = () => node.calls.filter((m) => m === "getTransaction").length;
  let at = 200;
  const named = { object: "one error, id null", list: "a list with one error, id null", each: "an error for each call" };
  for (const how of ["object", "list", "each", 413]) {
    makeSigs(25, `nb${how}`); node.calls = []; node.batches = 0; node.noBatch = how; delete noBatches.devnet;
    let r = await hist(base58(Buffer.alloc(32, at++))), b = await r.json();
    line(r.status === 200 && b.complete && b.have === 24 && node.batches === 1 && singles() === 24,
      `a paid node that refuses a batch (${named[how] ?? `HTTP ${how}`}): all ${b.have} of ${b.total}, as ${singles()} single calls`);
    makeSigs(12, `nb${how}2`); node.calls = []; node.batches = 0;
    r = await hist(base58(Buffer.alloc(32, at++))); b = await r.json();
    line(b.complete && b.have === 11 && node.batches === 0, `and the next pool's history sends it no batch (${node.batches})`);
  }
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60 * 1000 + 1000;
  makeSigs(12, "nbback"); node.calls = []; node.batches = 0; node.noBatch = null;
  let r = await hist(base58(Buffer.alloc(32, at++))), b = await r.json();
  Date.now = realNow;
  line(b.complete && node.batches === 2, `ten minutes on, it is sent batches again (${node.batches})`);
  makeSigs(12, "nbenv"); node.calls = []; node.batches = 0; delete noBatches.devnet;
  r = await hist(base58(Buffer.alloc(32, at++)), { env: { ...ENV, RPC_BATCH: "0" } }); b = await r.json();
  line(b.complete && b.have === 11 && node.batches === 0 && singles() === 11, `RPC_BATCH=0: ${node.batches} batches, ${singles()} transactions asked for one by one, complete`);

  // an HTTP error from the node is an error with its status, and never the node's URL (it can carry the key)
  const shut = createServer((req, res) => res.writeHead(403, { "content-type": "text/plain" }).end("forbidden"));
  await new Promise((ok) => shut.listen(0, "127.0.0.1", ok));
  const err = await nodeCall({ url: `http://127.0.0.1:${shut.address().port}/?api-key=secret-key-here` }, { jsonrpc: "2.0", id: 1, method: "getSlot" }).then(() => null, (e) => e);
  line(err?.status === 403 && /403/.test(err.message) && !/secret/.test(err.message), `an HTTP error from the node names its status, not its URL ("${err?.message}")`);
  shut.close();
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
  const settled = (mint, sol, tokens, seats, refund = false) => { const n = Buffer.alloc(4); n.writeUInt32LE(seats); return Buffer.concat([tagOf("Settled"), mint, u64(sol), u64(tokens), n, Buffer.from([refund ? 1 : 0])]).toString("base64"); };
  const claimed = (mint, owner, sol, refund) => Buffer.concat([tagOf("SeatClaimed"), mint, owner, u64(sol), u64(0), Buffer.from([refund ? 1 : 0])]).toString("base64");
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
  const rv = events([settled(MINT, 6e6, 0, 3, true), claimed(MINT, A, 1e6, true)]);
  line(rv[0]?.kind === "settled" && rv[0].refund === true && rv[0].tokens === 0n && rv[1]?.kind === "other", "a refunded settle decodes as one, and a seat's claim counts as the pool's");
  const f = funder({ transaction: { message: { accountKeys: [funderKey, a, "11111111111111111111111111111111"] } }, meta: { preBalances: [5e9, 0, 1], postBalances: [3.99e9, 1e9, 1] } }, a);
  line(f && f.by === funderKey && f.sol === 1, `the funder is the account whose balance fell most (${f && f.by.slice(0, 4)}, ${f && f.sol} SOL)`);
  line(funder({ transaction: { message: { accountKeys: [a] } }, meta: { preBalances: [5], postBalances: [4] } }, a) === null, "a transaction where the wallet only spent gives no funder");

  // a fake chain: each address's signatures (newest first, with before/until/limit as the node reads them), the
  // transactions, the program's accounts, node errors still to give for a transaction, and every call made (with when).
  // delay: how long it takes to answer a request with a getTransaction in it. busy: a method or a transaction's
  // signature -> how many more requests that ask for it get HTTP 429 (their calls are marked refused). limit:
  // getTransaction calls a second, past it each one gets a 429 in its answer (a paid plan's rate). noBatch: how it
  // refuses every batch, as the history's fake node does (batches: how many it was sent). http: a transaction's
  // signature -> how many more requests that ask for it get HTTP 500 (with a JSON-RPC error)
  const chain = { sigs: new Map(), txs: new Map(), accounts: new Map(), errs: new Map(), calls: [], delay: 0, busy: new Map(), limit: Infinity, window: [], noBatch: null, batches: 0, http: new Map() };
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
      if (Array.isArray(parsed)) chain.batches++;
      if (Array.isArray(parsed) && refuseBatch(chain.noBatch, res, list)) return;
      const broken = list.map((cl) => cl.params?.[0]).find((k) => chain.http.get(k) > 0);
      if (broken) {
        chain.http.set(broken, chain.http.get(broken) - 1);
        for (const cl of list) chain.calls.push({ method: cl.method, params: cl.params ?? [], t: Date.now(), refused: true });
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: list[0].id ?? null, error: { code: -32603, message: "Internal error" } }));
        return;
      }
      const refuse = list.map((cl) => (cl.method === "getTransaction" ? cl.params?.[0] : cl.method)).find((k) => chain.busy.get(k) > 0);
      if (refuse) {
        chain.busy.set(refuse, chain.busy.get(refuse) - 1);
        for (const cl of list) chain.calls.push({ method: cl.method, params: cl.params ?? [], t: Date.now(), refused: true });
        res.writeHead(429).end();
        return;
      }
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
          const now = Date.now();
          chain.window = chain.window.filter((t) => t > now - 1000); chain.window.push(now);
          if (chain.window.length > chain.limit) return { jsonrpc: "2.0", id: cl.id, error: { code: 429, message: "slow" } };
          const errs = chain.errs.get(p[0]) ?? 0;
          if (errs > 0) { chain.errs.set(p[0], errs - 1); return { jsonrpc: "2.0", id: cl.id, error: { code: -32005, message: "Node is behind" } }; }
          return ok(chain.txs.get(p[0]) ?? (p[0].startsWith("spam") ? { blockTime: 1, slot: 1, transaction: { message: { accountKeys: [] } }, meta: { err: null, logMessages: [] } } : null));
        }
        return { jsonrpc: "2.0", id: cl.id, error: { code: -32601, message: "no" } };
      });
      const send = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.isArray(parsed) ? answer : answer[0])); };
      if (chain.delay && list.some((cl) => cl.method === "getTransaction")) setTimeout(send, chain.delay); else send();
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

  // two asks at once: the first one did not list (its last listing was 59 s before) and is on its last call when a
  // second one comes, a minute after that listing. The second may not open a listing under the first, which is past
  // its own listing and would end done with that one unread: the next ask a minute on lists what is new
  const POOLR = base58(keyOf(61)), MINTR = keyOf(62), [G1, G2, G3, GF] = [63, 64, 65, 66].map((n) => base58(keyOf(n)));
  chain.accounts.set(POOLR, isPoolOf(MINTR));
  walletTx(G1, "g1Fund", { from: GF });
  const g2Fund = walletTx(G2, "g2Fund", { from: GF });
  poolTx(POOLR, "launchR", [launched(MINTR, CREATOR)]);
  poolTx(POOLR, "buyG1", [trade(MINTR, keyOf(63), true, 1e8)]);
  const lastR = poolTx(POOLR, "buyG2", [trade(MINTR, keyOf(64), true, 1e8)]);
  chain.errs.set(g2Fund, 1);
  {
    chain.calls = [];
    let { j } = await birth(POOLR);                      // G2's funding is not served: not complete
    shift += 59_000; chain.delay = 300;
    const runA = birth(POOLR);                           // reads it again, slowly
    for (let k = 0; k < 400 && calls("getTransaction", g2Fund).length < 2; k++) await new Promise((ok) => setTimeout(ok, 5));
    shift += 2_000;
    const runB = birth(POOLR);
    const [a1, b1] = await Promise.all([runA, runB]);
    chain.delay = 0;
    line(a1.r.status === 200 && b1.r.status === 200 && a1.j.complete && b1.j.buyers.find((x) => x.wallet === G2)?.funding?.by === GF,
      "an ask that comes while another is on its last call gets that one's answer");
    const newer = poolTx(POOLR, "buyG3", [trade(MINTR, keyOf(65), true, 1e8)]);
    shift += 61_000; chain.calls = [];
    ({ j } = await birth(POOLR));
    const listedR = calls("getSignaturesForAddress", POOLR);
    line(j.complete && j.buyers.some((x) => x.wallet === G3 && x.signature === newer) && listedR.length === 1 && listedR[0].params[1].until === lastR,
      `and a minute on, what is new is listed and read: ${j.buyers.length} buyers (${listedR.length} listing, after the newest seen)`);
  }

  // a long batch: 61 transactions with its events before the settle (one wallet in and out 25 times, not one of the
  // first ten). The window does not stop the reading while the first seats wait on the settle
  const POOLL = base58(keyOf(67)), MINTL = keyOf(68), V = Array.from({ length: 9 }, (_, i) => keyOf(69 + i)), v = V.map(base58);
  chain.accounts.set(POOLL, isPoolOf(MINTL));
  poolTx(POOLL, "launchL", [launched(MINTL, CREATOR), seatEvent("Committed", MINTL, CREATOR, 1e8, 1e8)]);
  for (let i = 0; i < 9; i++) poolTx(POOLL, `v${i}in`, [seatEvent("Committed", MINTL, V[i], 2e8, 2e8)]);
  for (let i = 0; i < 25; i++) {
    poolTx(POOLL, `cyc${i}in`, [seatEvent("Committed", MINTL, keyOf(78), 1e6, 1e6)]);
    poolTx(POOLL, `cyc${i}out`, [seatEvent("Withdrawn", MINTL, keyOf(78), 1e6, 0)]);
  }
  poolTx(POOLL, "v0more", [seatEvent("Committed", MINTL, V[0], 1e8, 3e8)]);
  poolTx(POOLL, "settleL", [settled(MINTL, 2e9, 6e13, 10), trade(MINTL, keyOf(67), true, 2e9)]);
  poolTx(POOLL, "lateL", [trade(MINTL, keyOf(79), true, 1e8)]);
  {
    const { r, j } = await birth(POOLL);
    const seat0 = j.buyers?.find((x) => x.wallet === v[0])?.seat;
    line(j.buyers?.length === 10 && !j.buyers.some((x) => x.wallet === base58(keyOf(78))) && seat0?.sol === 0.3 && seat0.settled && j.buyers.every((x) => x.seat?.settled),
      `a batch past the window of 60 before its settle: the first seats followed on to it (${seat0?.sol} SOL, settled: ${seat0?.settled})`);
    line(j.complete && j.read === 62 && j.more && /s-maxage=3600/.test(r.headers.get("cache-control")), `and the reading stops at the settle, final (read ${j.read}, more: ${j.more})`);
  }

  // only FETCH stops it: a settle after 200 transactions that only name the pool is not reached, and the birth is final
  // with its seat not settled
  const POOLF = base58(keyOf(80)), MINTF = keyOf(81);
  chain.accounts.set(POOLF, isPoolOf(MINTF));
  poolTx(POOLF, "launchF", [launched(MINTF, CREATOR), seatEvent("Committed", MINTF, CREATOR, 1e8, 1e8)]);
  spam(POOLF, 200);
  poolTx(POOLF, "settleF", [settled(MINTF, 1e8, 3e12, 1), trade(MINTF, keyOf(80), true, 1e8)]);
  {
    chain.calls = [];
    const { r, j } = await birth(POOLF);
    line(j.complete && j.more && j.buyers[0]?.seat?.settled === false && j.buyers[0].seat.sol === 0.1 && calls("getTransaction").length === 200 && /s-maxage=3600/.test(r.headers.get("cache-control")),
      `a settle past FETCH: ${calls("getTransaction").length} fetched, final, the seat not settled`);
  }

  // a refunded batch (under 0.01 SOL) with three seats: one left all of it and came back, and a transaction carries
  // another pool's seat events and settle before this pool's own commit. Only this pool's events count
  const POOLRF = base58(keyOf(82)), MINTRF = keyOf(83), [R1, R2, R3, OTHERRF, LATE] = [84, 85, 86, 87, 88].map(keyOf);
  chain.accounts.set(POOLRF, isPoolOf(MINTRF));
  poolTx(POOLRF, "launchRF", [launched(MINTRF, CREATOR), seatEvent("Committed", MINTRF, CREATOR, 3e6, 3e6, 3e6)]);
  poolTx(POOLRF, "r1in", [seatEvent("Committed", MINTRF, R1, 1e6, 1e6, 4e6)]);
  poolTx(POOLRF, "r2in", [seatEvent("Committed", MINTRF, R2, 2e6, 2e6, 6e6)]);
  poolTx(POOLRF, "r2out", [seatEvent("Withdrawn", MINTRF, R2, 2e6, 0, 4e6)]);
  // the other pool's withdrawal comes after this pool's commit, so it would leave R1's seat empty if it counted
  poolTx(POOLRF, "mixedRF", [seatEvent("Committed", OTHERRF, R3, 5e8, 5e8, 5e8), settled(OTHERRF, 5e8, 1e13, 1),
    seatEvent("Committed", MINTRF, R1, 1e6, 2e6, 5e6), seatEvent("Withdrawn", OTHERRF, R1, 1e6, 0, 0)]);
  poolTx(POOLRF, "r2back", [seatEvent("Committed", MINTRF, R2, 1e6, 1e6, 6e6)]);
  poolTx(POOLRF, "settleRF", [settled(MINTRF, 6e6, 0, 3, true)]);
  poolTx(POOLRF, "claimRF", [claimed(MINTRF, R1, 2e6, true)]);
  poolTx(POOLRF, "lateRF", [trade(MINTRF, LATE, true, 1e8)]);
  {
    const { j } = await birth(POOLRF);
    const byW = Object.fromEntries((j.buyers ?? []).map((x) => [x.wallet, x]));
    const [r1, r2] = [byW[base58(R1)], byW[base58(R2)]];
    line(j.complete && !j.more && j.read === 9 && (j.buyers ?? []).map((x) => x.wallet).join() === [creator, base58(R1), base58(R2), base58(LATE)].join()
      && j.buyers.slice(0, 3).every((x) => x.batch && x.seat.settled) && byW[creator].seat.sol === 0.003 && !byW[base58(LATE)].batch,
      `a refunded batch: three seats settled with the SOL in them, and a buy after it (${j.buyers?.length} buyers, read ${j.read})`);
    line(r2?.sol === 0.002 && r2.seat?.sol === 0.001 && r2.seat.out === false, `a seat that left all of it and came back: ${r2?.seat?.sol} SOL at the settle, out: ${r2?.seat?.out}`);
    line(!byW[base58(R3)] && r1?.seat?.sol === 0.002 && r1.seat.out === false,
      `another pool's seat events and settle in the same transaction are not this pool's (R1's seat ${r1?.seat?.sol} SOL, out: ${r1?.seat?.out})`);
  }

  // a paid node that refuses a whole batch of transactions (HTTP 429): an answer with what it read before it (nothing
  // here), and the next ask reads on from there
  const POOLP = base58(keyOf(92)), MINTP = keyOf(93);
  chain.accounts.set(POOLP, isPoolOf(MINTP));
  const launchP = poolTx(POOLP, "launchP", [launched(MINTP, CREATOR)]);
  poolTx(POOLP, "buyP", [trade(MINTP, keyOf(94), true, 1e8)]);
  {
    chain.calls = []; chain.busy.set(launchP, 1);
    let { r, j } = await birth(POOLP);
    line(r.status === 200 && j && !j.complete && j.read === 0 && /s-maxage=1\b/.test(r.headers.get("cache-control")), `a paid node's 429 on a batch: ${r.status}, not complete`);
    chain.calls = [];
    ({ r, j } = await birth(POOLP));
    line(j.complete && j.read === 2 && j.buyers.length === 1 && !calls("getAccountInfo").length && !calls("getSignaturesForAddress", POOLP).length,
      "the next ask reads on from there: no pool check, no listing again");
  }

  // a paid node with a rate of 5 transactions a second: each batch of 10 gets 5 served and 5 refused (429 in its
  // answer). What was served is read, nothing is asked again in a loop, and each ask a second on reads on
  const POOLT = base58(keyOf(95)), MINTT = keyOf(96);
  chain.accounts.set(POOLT, isPoolOf(MINTT));
  poolTx(POOLT, "launchT", [launched(MINTT, CREATOR)]);
  for (let i = 0; i < 12; i++) poolTx(POOLT, `buyT${i}`, [trade(MINTT, keyOf(110 + i), true, 1e8)]);
  {
    chain.limit = 5; chain.window = []; chain.calls = [];
    let { r, j } = await birth(POOLT);
    line(r.status === 200 && j && !j.complete && j.read === 5 && j.buyers.length === 4 && calls("getTransaction").length === 10,
      `a paid node's 429 on part of a batch: the 5 served are read (read ${j?.read}, ${calls("getTransaction").length} asked), not complete`);
    shift += 1100;
    ({ j } = await birth(POOLT));
    line(!j.complete && j.read === 10, `a second later the next ask reads on (read ${j.read})`);
    shift += 1100;
    ({ r, j } = await birth(POOLT));
    line(j.complete && j.read === 11 && j.buyers.length === 10 && j.buyers.every((x) => x.funding?.none) && /s-maxage=3600/.test(r.headers.get("cache-control")),
      `and a second after that the birth is whole: ${j.buyers.length} buyers, read ${j.read}, final`);
    chain.limit = Infinity;
  }

  // a paid node on a plan that takes no batches (one error with id null, alone or in a list, an error for each call, or
  // HTTP 413): the birth reads the same transactions as single calls, whole in one ask. RPC_BATCH=0 sends it none from
  // the start
  {
    const { noBatches = {} } = await import("./history.mjs");
    let n = 170;
    const named = { object: "one error (id null)", list: "a list with one error (id null)", each: "an error for each call" };
    for (const how of ["object", "list", "each", 413, "RPC_BATCH=0"]) {
      const POOLN = base58(keyOf(n++)), MINTN = keyOf(n++);
      chain.accounts.set(POOLN, isPoolOf(MINTN));
      poolTx(POOLN, `launchN${how}`, [launched(MINTN, CREATOR), trade(MINTN, CREATOR, true, 1e8)]);
      for (let i = 0; i < 11; i++) poolTx(POOLN, `buyN${how}${i}`, [trade(MINTN, keyOf(150 + i), true, 1e8)]);
      delete noBatches.devnet; chain.noBatch = how === "RPC_BATCH=0" ? null : how; chain.batches = 0; chain.calls = [];
      const { r, j } = await birth(POOLN, how === "RPC_BATCH=0" ? { ...env, RPC_BATCH: "0" } : env);
      const singles = calls("getTransaction").length;
      line(r.status === 200 && j?.complete && j.read === 10 && j.buyers.length === 10 && j.buyers.every((x) => x.funding?.none) && chain.batches === (chain.noBatch ? 1 : 0) && singles === 10,
        `a birth with ${named[how] ? `a node that answers a batch with ${named[how]}` : typeof how === "number" ? `a node that answers a batch with HTTP ${how}` : how}: whole in one ask, ${chain.batches} batch(es) sent, ${singles} transactions asked for (read ${j?.read}, ${j?.buyers?.length} buyers)`);
    }
    chain.noBatch = null; delete noBatches.devnet;
  }

  // an HTTP error on a buyer's funding transaction (500, with a JSON-RPC error in it) is that transaction not served:
  // the other buyers go on, and the next ask reads it
  {
    const POOLH = base58(keyOf(136)), MINTH = keyOf(137), [H1, H2, HF] = [138, 139, 141].map((k) => base58(keyOf(k)));
    chain.accounts.set(POOLH, isPoolOf(MINTH));
    const h1Fund = walletTx(H1, "h1Fund", { from: HF });
    walletTx(H2, "h2Fund", { from: HF });
    poolTx(POOLH, "launchH", [launched(MINTH, CREATOR)]);
    poolTx(POOLH, "buyH1", [trade(MINTH, keyOf(138), true, 1e8)]);
    poolTx(POOLH, "buyH2", [trade(MINTH, keyOf(139), true, 1e8)]);
    chain.http.set(h1Fund, 1); chain.calls = [];
    let { r, j } = await birth(POOLH);
    let byW = Object.fromEntries((j?.buyers ?? []).map((x) => [x.wallet, x]));
    line(r.status === 200 && j && !j.complete && byW[H1]?.funding === null && byW[H2]?.funding?.by === HF,
      "an HTTP 500 on a buyer's funding transaction: not read, the next buyer goes on, not complete");
    ({ j } = await birth(POOLH));
    byW = Object.fromEntries((j?.buyers ?? []).map((x) => [x.wallet, x]));
    line(j?.complete && byW[H1]?.funding?.signature === h1Fund, "and the next ask reads it");
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

  // the public node answers 429: on the pool check, then on a transaction. Each answer is a 200 with what it has, not
  // complete; nothing in this instance calls the node for 12 s (an ask then comes back at once); after that the
  // reading goes on from where it stopped, with nothing read again
  {
    const real = CLUSTERS.devnet.publicRpc;
    CLUSTERS.devnet.publicRpc = CHAIN;
    const POOLB = base58(keyOf(89)), MINTB = keyOf(90), Q = base58(keyOf(91)), pub = { RPC_URL_DEVNET: "" };
    chain.accounts.set(POOLB, isPoolOf(MINTB));
    const launchB = poolTx(POOLB, "launchB", [launched(MINTB, CREATOR)]);
    const buyQ = poolTx(POOLB, "buyQ", [trade(MINTB, keyOf(91), true, 1e8)]);
    publicPace.devnet = 0; chain.calls = [];
    chain.busy.set("getAccountInfo", 1);
    let { r, j } = await birth(POOLB, pub);
    line(r.status === 200 && j && !j.complete && !j.launch && publicPace.devnet >= Date.now() + 11_000 && /s-maxage=1\b/.test(r.headers.get("cache-control")),
      `a 429 on the pool check: ${r.status}, not complete (ask again), and no call to the public node for 12 s`);
    shift += 12_000; chain.calls = [];
    chain.busy.set(buyQ, 1);
    ({ r, j } = await birth(POOLB, pub));
    line(r.status === 200 && !j.complete && j.read === 1 && j.launch?.signature === launchB && !j.buyers.length && publicPace.devnet >= Date.now() + 11_000,
      `after the pause: a 429 on its second transaction, the answer has the launch before it (read ${j.read}), not complete`);
    chain.calls = [];
    const t0 = realNow();
    ({ r, j } = await birth(POOLB, pub));
    line(r.status === 200 && !j.complete && j.read === 1 && !chain.calls.length && realNow() - t0 < 1000, `asked again during the pause: what it has, at once (${realNow() - t0} ms), no call`);
    shift += 12_000; chain.calls = [];
    ({ r, j } = await birth(POOLB, pub));
    line(j.complete && j.buyers[0]?.wallet === Q && j.buyers[0].funding?.none && chain.calls.map((x) => x.method).join() === "getTransaction,getSignaturesForAddress" && chain.calls[0].params[0] === buyQ,
      `after the pause: on from the refused transaction, nothing read again (${chain.calls.length} calls)`);
    publicPace.devnet = 0;
    CLUSTERS.devnet.publicRpc = real;
  }
  Date.now = realNow;
  chainNode.close();
}

/* ---------- the pool list: every pool for every visitor at once ---------- */
{
  const { handlePools, mintMetadata } = await import("./pools.mjs");
  const { noBatches = {} } = await import("./history.mjs");
  const { base58 } = await import("./config.mjs");
  delete noBatches.devnet;
  const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", TAG = createHash("sha256").update("account:Pool").digest().subarray(0, 8);
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const key = (kind, n) => { const b = Buffer.alloc(32, kind); b.writeUInt32LE(n + 1, 0); return b; };
  const str = (s) => { const v = Buffer.from(s, "utf8"), n = Buffer.alloc(4); n.writeUInt32LE(v.length); return Buffer.concat([n, v]); };
  const tlv = (type, body) => { const h = Buffer.alloc(4); h.writeUInt16LE(type, 0); h.writeUInt16LE(body.length, 2); return Buffer.concat([h, body]); };
  /** A Token-2022 mint as the launch leaves it: its metadata pointer, then its metadata. */
  const mintOf = (mint, name, symbol, uri) => Buffer.concat([Buffer.alloc(166, 0), tlv(18, Buffer.concat([Buffer.alloc(32), mint])),
    tlv(19, Buffer.concat([Buffer.alloc(32), mint, str(name), str(symbol), str(uri), Buffer.alloc(4)]))]).toString("base64");
  const account = (data, owner) => ({ data: [data.toString("base64"), "base64"], executable: false, lamports: 3_285_120, owner, rentEpoch: 18446744073709551615, space: data.length });

  // a node with n pools (the newest the last made) and their mints, plus four accounts that are not pools, as a node
  // that ignores the filters would send them: a seat and the config (the program's), a Pool-like account of another
  // program, and a Pool's mark on an account of another size. It counts requests, account lists, mint calls and mints.
  // delay: each call of mints that long; listDelay: the account list that long; refuse: the account list answered 429
  const ln = { text: "", mints: new Map(), requests: 0, gpa: 0, gma: 0, asked: [], delay: 0, listDelay: 0, refuse: false, down: false, times: [] };
  const NOT_POOLS = [];
  // a coin's metadata; `long`: as long as the program allows (a name of 32 bytes, a symbol of 10, a link of 200)
  const meta = (n, long) => (long ? [`Coin ${n}`.padEnd(32, "x"), `C${n}`.padEnd(10, "x"), `https://nox.example/c/${n}.json`.padEnd(200, "x")] : [`Coin ${n}`, `C${n}`, `https://nox.example/c/${n}.json`]);
  function makeChain(n, from, long = false) {
    const list = [];
    ln.mints = new Map();
    for (let i = 0; i < n; i++) {
      const d = Buffer.alloc(344), mint = key(7, from + i);
      TAG.copy(d, 0); mint.copy(d, 8);
      for (let k = 0; k < 4; k++) key(20 + k, from + i).copy(d, 40 + 32 * k);
      [30e9, 1e6 * i, 1e15 - i, 42e9, 420e9, 0, i, i, 0, 0, 5e8 + i].forEach((v, k) => d.writeBigUInt64LE(BigInt(v), 168 + 8 * k));
      d.writeBigInt64LE(BigInt(1_800_000_000 + i), 256); d.writeUInt16LE(100, 272); d.writeUInt16LE(5000, 274);
      list.push({ pubkey: base58(key(9, from + i)), account: account(d, PROGRAM) });
      ln.mints.set(base58(mint), mintOf(mint, ...meta(from + i, long)));
    }
    const odd = (tag, size, owner, k) => { const d = Buffer.alloc(size); tag.copy(d, 0); key(8, from + k).copy(d, 8); d.writeBigInt64LE(9_000_000_000n, Math.min(256, size - 8)); return { pubkey: base58(key(10, from + k)), account: account(d, owner) }; };
    const mark = (name) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
    const others = [odd(mark("Seat"), 344, PROGRAM, 0), odd(mark("Config"), 344, PROGRAM, 1), odd(TAG, 344, "11111111111111111111111111111111", 2), odd(TAG, 120, PROGRAM, 3)];
    NOT_POOLS.length = 0; NOT_POOLS.push(...others.map((a) => a.pubkey));
    list.splice(Math.floor(n / 2), 0, ...others);
    ln.text = JSON.stringify(list);
  }
  const listNode = createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      ln.requests++; ln.times.push(Date.now());
      if (ln.down) { res.writeHead(500, { "content-type": "text/plain" }).end("down"); return; }
      const parsed = JSON.parse(body), list = Array.isArray(parsed) ? parsed : [parsed];
      if (!Array.isArray(parsed) && parsed.method === "getProgramAccounts") {
        ln.gpa++;
        if (ln.refuse) { res.writeHead(429, { "content-type": "text/plain" }).end("slow down"); return; }
        if (ln.listDelay) await sleep(ln.listDelay);
        res.writeHead(200, { "content-type": "application/json" }).end(`{"jsonrpc":"2.0","id":${JSON.stringify(parsed.id)},"result":${ln.text}}`);
        return;
      }
      if (ln.delay) await sleep(ln.delay);
      const out = list.map((c) => {
        if (c.method !== "getMultipleAccounts") return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "no" } };
        ln.gma++; ln.asked.push(...c.params[0]);
        return { jsonrpc: "2.0", id: c.id, result: { context: { slot: 1 }, value: c.params[0].map((m) => (ln.mints.has(m) ? { data: [ln.mints.get(m), "base64"], executable: false, lamports: 1, owner: TOKEN_2022, rentEpoch: 0, space: 400 } : null)) } };
      });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    });
  });
  await new Promise((ok) => listNode.listen(0, "127.0.0.1", ok));
  const LIST_UP = `http://127.0.0.1:${listNode.address().port}`, env = { RPC_URL_DEVNET: LIST_UP };
  const ask = async (q = "", e = env, headers = {}) => {
    const r = await handlePools(new Request(`${SITE}/api/pools?cluster=devnet${q}`, { headers: { "x-forwarded-for": `10.4.${++ip % 250}.${ip % 7}`, ...headers } }), e);
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON: j stays null */ }
    return { r, text, j };
  };
  const counts = () => ({ requests: ln.requests, gpa: ln.gpa, gma: ln.gma });
  const zero = () => { ln.requests = 0; ln.gpa = 0; ln.gma = 0; ln.asked = []; ln.times = []; };
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  const KB = (n) => `${Math.floor(n / 1024)} KB`;

  const mm = mintMetadata(Buffer.from(mintOf(key(7, 1), "Nox ✶", "NOX", "https://nox.example/x.json"), "base64"));
  line(mm.join("|") === "Nox ✶|NOX|https://nox.example/x.json" && mintMetadata(Buffer.alloc(200)).join("") === "", `a mint's metadata decode (${mm.join(", ")}); a mint without them gives none`);
  const away = await ask("", env, { origin: "https://elsewhere.example" });
  line(away.r.status === 403, "a page on another site is refused");
  const post = await handlePools(new Request(`${SITE}/api/pools?cluster=devnet`, { method: "POST", body: "{}" }), env);
  line(post.status === 405, "POST is refused");
  const main = await handlePools(new Request(`${SITE}/api/pools?cluster=mainnet`), env), other = await handlePools(new Request(`${SITE}/api/pools?cluster=testnet`), env);
  line(main.status === 503 && other.status === 400, `mainnet has no program yet (${main.status}), an unknown cluster is refused (${other.status})`);

  let from = 100_000;
  for (const n of [400, 2000, 7000]) {
    const long = n === 7000;                             // the largest list with the longest metadata
    makeChain(n, from, long); from += n + 10;
    shift += 61_000; zero();                             // past the list read for the last size, and past giving it when the node fails
    // fifty visitors open the board at once
    const t0 = realNow();
    const board = await Promise.all(Array.from({ length: 50 }, () => ask("&board=1")));
    const took = realNow() - t0, b = board[0], size = Buffer.byteLength(b.text), per = (size - 60) / n, first = counts();
    const names = b.j?.pools?.every((row, k) => { const [name, symbol] = meta(from - 11 - k, long); return row[1] === name && row[2] === symbol; });
    line(board.every((x) => x.r.status === 200 && x.text === b.text) && b.j.total === n && b.j.pools.length === n && !b.j.cut && names && took < 5000,
      `${n} pools${long ? " (with the longest metadata)" : ""}: 50 visitors at once get the same board, all ${b.j?.pools?.length} named, newest first, in ${took} ms`);
    line(first.gpa === 1 && first.gma === Math.ceil(n / 100) && first.requests === 1 + Math.ceil(n / 1000) && new Set(ln.asked).size === n && ln.asked.length === n,
      `the node: ${first.gpa} account list and each mint once (${first.gma} calls of 100 in ${first.requests - 1} batch${first.requests === 2 ? "" : "es"}), for all 50: ${(first.requests / 50).toFixed(2)} requests a visitor`);
    line(size < 4 * 1024 * 1024 && /s-maxage=4\b/.test(b.r.headers.get("cache-control")) && /stale-while-revalidate=\d+/.test(b.r.headers.get("cache-control")),
      `the board's answer: ${KB(size)}, ${per.toFixed(0)} bytes a pool (about ${Math.floor((4 * 1024 * 1024 - 60) / per).toLocaleString("en-US")} pools under 4 MB), cached at the edge: ${b.r.headers.get("cache-control")}`);
    // the landing's 12 and a whole list, from the same read
    zero();
    const t1 = realNow();
    const [land, whole] = await Promise.all([Promise.all(Array.from({ length: 50 }, () => ask("&limit=12"))), ask("")]);
    const took2 = realNow() - t1, l = land[0].j, w = whole.j, wsize = Buffer.byteLength(whole.text);
    line(land.every((x) => x.r.status === 200) && l.pools.length === 12 && l.total === n && l.pools.every((row) => row.length === 5 && Buffer.from(row[1], "base64").length === 344) && ln.requests === 0 && took2 < 1000,
      `50 landings and a whole list a moment later: nothing asked of the node, 12 whole pools each (${KB(Buffer.byteLength(land[0].text))}), in ${took2} ms`);
    const fits = Math.floor((4 * 1024 * 1024) / ((wsize - 60) / w.pools.length));
    line(w.total === n && !w.pools.some((row) => NOT_POOLS.includes(row[0])) && w.pools.every((row) => Buffer.from(row[1], "base64").length === 344),
      "only Pool accounts of the program: the seat, the config, another program's account and a smaller one are left out");
    line(whole.r.status === 200 && wsize < 4 * 1024 * 1024 && w.total === n && (!long ? !w.cut && w.pools.length === n : w.cut && w.pools.length < n && w.pools[0][0] === b58Of(from - 11)),
      `the whole list (listPools() with no option): ${KB(wsize)}, ${w.pools.length} of ${n}${w.cut ? ", the newest that fit, cut: true" : ""} (about ${fits.toLocaleString("en-US")} pools fit${long ? " with the longest metadata" : ""})`);
    if (w.cut) {
      // the next page: the pools after the last one sent, by its openedAt and mint
      const last = Buffer.from(w.pools.at(-1)[1], "base64"), rest = await ask(`&after=${last.readBigInt64LE(256)}.${base58(last.subarray(8, 40))}`);
      const all = [...w.pools, ...(rest.j?.pools ?? [])].map((row) => row[0]);
      line(rest.r.status === 200 && rest.j.cut === false && all.length === n && all.every((a, k) => a === b58Of(from - 11 - k)),
        `and after=<openedAt>.<mint> of its last pool: the other ${rest.j?.pools?.length}, so the ${all.length} come newest first, none twice, none missed`);
      const bad = await ask("&after=yesterday");
      line(bad.r.status === 400, `an after= that does not name a pool is refused (${bad.r.status})`);
    }
    // the edge's copy runs out: one more read of the list, no mint again
    shift += 4100; zero();
    await Promise.all(Array.from({ length: 50 }, () => ask("&board=1")));
    line(ln.gpa === 1 && ln.gma === 0, `4 s on, 50 more visitors: ${ln.gpa} account list, ${ln.gma} mint calls`);
    // the door, as the board read it before: the whole account list for each visitor, shared only under 256 KB
    zero();
    const gpa = call("getProgramAccounts", [PROGRAM, { encoding: "base64", filters: [{ dataSize: 344 }, { memcmp: { offset: 0, bytes: base58(TAG) } }] }]);
    const d1 = await rpc(gpa, { env }), d2 = await rpc(gpa, { env }), dsize = Buffer.byteLength(await d1.text());
    line(n < 7000 ? d1.status === 200 && ln.gpa === (dsize > 256 * 1024 ? 2 : 1) : d1.status === 502 && d2.status === 502,
      `the old way, through /api/rpc: ${d1.status === 200 ? `${KB(dsize)} for each visitor, ${ln.gpa} reads for 2 visitors` : `${d1.status}, too large`}`);
  }
  function b58Of(n) { return base58(key(9, n)); }

  // metadata slow to come (2.2 s a batch): the answer gives what is in after 5 s, with null for the rest, kept 1 s at
  // the edge; the next answer waits for the batch under way and is whole. No mint is read twice
  {
    makeChain(2500, from); from += 2510;
    shift += 61_000; zero(); ln.delay = 2200;
    const t0 = realNow();
    let a = await ask("&board=1");
    const took = realNow() - t0, unnamed = a.j?.pools?.filter((row) => row[1] === null).length;
    line(a.r.status === 200 && a.j.pools.length === 2500 && unnamed === 500 && /s-maxage=1\b/.test(a.r.headers.get("cache-control")) && took < 6000,
      `metadata slow to come: an answer in ${(took / 1000).toFixed(1)} s, ${unnamed} of 2,500 without names (null), kept 1 s at the edge`);
    a = await ask("&board=1");
    ln.delay = 0;
    line(a.j?.pools?.every((row) => typeof row[1] === "string") && /s-maxage=4\b/.test(a.r.headers.get("cache-control")) && ln.asked.length === 2500 && new Set(ln.asked).size === 2500,
      `the next answer is whole, and each mint was read once (${ln.asked.length})`);
  }

  // the node fails: the list read last is given for a minute, then 502 (the page then reads the node itself)
  {
    shift += 4100; ln.down = true;
    let a = await ask("&board=1");
    const at = a.j?.at;
    line(a.r.status === 200 && a.j.pools.length === 2500, `the node down: the list read ${Math.round((Date.now() - at) / 1000)} s ago is given`);
    shift += 61_000;
    a = await ask("&board=1");
    line(a.r.status === 502 && !/127\.0\.0\.1/.test(a.text), `a minute on: ${a.r.status}, "${a.j?.error}"`);
    const before = ln.requests;
    a = await ask("&board=1");
    line(a.r.status === 502 && ln.requests === before, `asked again at once: ${a.r.status}, and no new read of the node for 3 s after a failed one (${ln.requests - before} requests)`);
    ln.down = false;
  }

  // the public node: every call at its turn, the list and each 100 mints
  {
    const real = CLUSTERS.devnet.publicRpc;
    CLUSTERS.devnet.publicRpc = LIST_UP;
    makeChain(150, from); from += 160;
    shift += 61_000; zero(); publicPace.devnet = 0;
    const a = await ask("&board=1", { RPC_URL_DEVNET: "" });
    const gaps = ln.times.slice(1).map((t, i) => t - ln.times[i]);
    line(a.r.status === 200 && a.j.pools.length === 150 && a.j.pools.every((row) => typeof row[1] === "string") && ln.requests === 3 && gaps.every((g) => g >= PUBLIC_GAP - 5),
      `the public node: the list and 2 calls of mints, ${Math.min(...gaps)} ms apart at least, all named`);
    publicPace.devnet = 0;
    CLUSTERS.devnet.publicRpc = real;
  }

  // no list kept (a new instance, or one a minute without a read) and the account list slow (6 s): a slice answers in
  // its 3 s and the whole board in its 5 s, a 503 with a retry-after; the read goes on, and the next answers get it
  {
    shift += 61_000; zero(); ln.listDelay = 6000;
    const t0 = realNow(), timed = (q) => ask(q).then((x) => Object.assign(x, { took: realNow() - t0 }));
    const [slice, board] = await Promise.all([timed("&limit=12"), timed("&board=1")]);
    line(slice.r.status === 503 && slice.r.headers.get("retry-after") === "3" && slice.took >= 2900 && slice.took < 3600,
      `a slow account list and nothing kept: the landing's slice gets ${slice.r.status} (retry-after ${slice.r.headers.get("retry-after")}) in ${(slice.took / 1000).toFixed(1)} s, before the page's 5 s`);
    line(board.r.status === 503 && board.took >= 4900 && board.took < 5600 && ln.gpa === 1,
      `and the whole board ${board.r.status} in ${(board.took / 1000).toFixed(1)} s, from the same read (${ln.gpa} account list)`);
    await sleep(Math.max(0, 6300 - (realNow() - t0)));
    ln.listDelay = 0;
    const after = await ask("&board=1");
    line(after.r.status === 200 && after.j.pools.length === after.j.total && ln.gpa === 1, `once that read is in: 200, all ${after.j?.pools?.length} pools, no new read`);
  }

  // a paid node that refuses the account list (429) and nothing kept: 503 with a retry-after, and no new read for 3 s
  {
    shift += 61_000; zero(); ln.refuse = true;
    const first = await ask("&board=1"), more = [];
    for (let k = 0; k < 10; k++) more.push(await ask(k % 2 ? "&board=1" : "&limit=12"));
    line(first.r.status === 503 && first.r.headers.get("retry-after") === "3" && more.every((x) => x.r.status === 503) && ln.gpa === 1,
      `the node refuses the account list: ${first.r.status} (retry-after ${first.r.headers.get("retry-after")}), and 10 asks after it read nothing more (${ln.gpa} account list asked)`);
    ln.refuse = false; shift += 3100;
    const a = await ask("&board=1");
    line(a.r.status === 200 && ln.gpa === 2, `3 s on, the list is read again: ${a.r.status}`);
  }

  // the landing's slice when the metadata are slow (6 s): it comes in its 3 s, with null for the names not in
  {
    makeChain(300, from); from += 310;
    shift += 61_000; zero(); ln.delay = 6000;
    const t0 = realNow(), a = await ask("&limit=12"), took = realNow() - t0;
    line(a.r.status === 200 && a.j.pools.length === 12 && a.j.pools.every((row) => row[2] === null) && /s-maxage=1\b/.test(a.r.headers.get("cache-control")) && took < 3600,
      `metadata slow to come: the landing's 12 in ${(took / 1000).toFixed(1)} s, before the page's 5 s, without names (the page reads those), kept 1 s at the edge`);
    await sleep(3200);                                   // the round under way ends
    ln.delay = 0;
  }
  Date.now = realNow;
  listNode.close();
}

fake.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall server checks passed");
process.exit(failed ? 1 : 0);
