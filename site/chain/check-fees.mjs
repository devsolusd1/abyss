// The priority fee, checked offline: through the built bundle (../vendor/chain.js, the file the site ships), against a
// fake node on this machine. Nothing touches a real cluster and no real wallet signs. What goes out is read back from
// the bytes the fake node was sent.
//   1. every kind of transaction the site builds goes out with exactly one compute unit price (and one limit), the
//      75th percentile of the recent blocks that took a price (more than 0) for its writable accounts. The fake node
//      answers as a real one does: one minimum a block, most of them 0
//   2. those accounts are the transaction's writable ones, and only those, 128 at most (one with 131 is cut to 128)
//   3. the cap: with enormous recent fees, no transaction's priority fee (price × its limit) passes PRIORITY.maxLamports
//   4. a launch with a first buy reuses the buy's instructions: still one limit, one price, nothing twice, and within a
//      transaction's size with the longest name, symbol and link the program takes
//   5. a read that fails (refused by a server that does not allow the call yet, 429, too slow, not an answer) gives
//      PRIORITY.floor, what a read of blocks that all say 0 gives, and the send goes on
//   6. a transaction that has a price already keeps it, and gets no second one
//   7. a transaction simulated and then sent: one price each time, one reading for both, read again when it is stale
//   8. the floor and devnet: off devnet a price never goes under PRIORITY.floor, and a few blocks that took a price
//      among many that say 0 lift it; on devnet the price is 0 and the node is not asked, whatever it would say
//   9. the pages: launch.html's estimate counts one signature and the priority fee at its most; coin.html refuses a
//      commit or a buy that leaves too little for them; its Max keeps enough back
//
//   node check-fees.mjs

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as web3 from "@solana/web3.js";

const require = createRequire(import.meta.url);
const Chain = require("../vendor/chain.js");
const { PublicKey, Keypair } = Chain;
const page = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const head = (text) => console.log(`\n${text}`);
const num = (x) => (x == null ? "none" : x.toLocaleString("en-US"));

/* ---------- the fake node: blockhashes, recent fees, simulations, sends and statuses, the config ---------- */

const P = "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK";
const CB = "ComputeBudget111111111111111111111111111111";
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const TREASURY = Keypair.generate().publicKey;
// fees: a list of recent fees, or "refused" (the site's server before it allowed the call), "limited" (429), "slow"
// (an answer after 8 s), "none" (a null result), "garbled" (not JSON)
const node = { fees: [], feeCalls: 0, asked: [], sent: new Set(), sims: [] };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const { id, method, params } = JSON.parse(body);
    const answer = (status, reply) => {
      try {
        if (res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof reply === "string" ? reply : JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
      } catch { /* the caller gave up */ }
    };
    const send = (result) => answer(200, { result });
    const ctx = (value) => send({ context: { slot: 1 }, value });
    switch (method) {
      case "getLatestBlockhash": return ctx({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 });
      case "getRecentPrioritizationFees": {
        node.feeCalls++; node.asked.push(params[0]);
        const f = node.fees;
        // what server/rpc.mjs answers for a call it does not pass
        if (f === "refused") return answer(403, { error: { code: -32601, message: "getRecentPrioritizationFees is not allowed here" } });
        if (f === "limited") return answer(429, { error: { code: 429, message: "Too many calls from here; slow down" } });
        if (f === "garbled") return answer(200, "<html>not a node</html>");
        if (f === "none") return send(null);
        if (f === "slow") return setTimeout(() => send(Array.from({ length: 150 }, (_, i) => ({ slot: i, prioritizationFee: 1e9 }))), 8000);
        return send(f.map((fee, i) => ({ slot: 1000 + i, prioritizationFee: fee })));
      }
      case "simulateTransaction": node.sims.push(params[0]); return ctx({ err: null, logs: [], accounts: null, unitsConsumed: 1000, returnData: null });
      case "sendTransaction": node.sent.add(params[0]); return send("sent");
      case "getSignatureStatuses": return ctx(params[0].map(() => ({ slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed" })));
      case "getBlockHeight": return send(1);
      case "getAccountInfo": return ctx(params[0] === CONFIG ? configAccount : null);
      case "getMultipleAccounts": return ctx(params[0].map(() => null));
      default: return send(null);
    }
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const RPC = `http://127.0.0.1:${server.address().port}`;
/** Points the chain layer at the fake node again, which also forgets the fees it read. */
const fresh = (cluster = "fake") => Chain.setNet({ cluster, rpcUrl: RPC, program: P });
fresh();

const me = Keypair.generate();
const wallet = { publicKey: me.publicKey, signTransaction: async (tx) => { tx.partialSign(me); return tx; } };
const CONFIG = Chain.configAddress().toBase58();
// the config as state.rs lays it out: admin, launcher, treasury, launch fee, lowest fee, treasury's share, open, bump
const configBytes = Buffer.alloc(8 + 110);
configBytes.set(me.publicKey.toBytes(), 8); configBytes.set(me.publicKey.toBytes(), 40); configBytes.set(TREASURY.toBytes(), 72);
configBytes.writeBigUInt64LE(0n, 104); configBytes.writeUInt16LE(0, 112); configBytes.writeUInt16LE(5000, 114); configBytes[116] = 1;
const configAccount = { data: [configBytes.toString("base64"), "base64"], executable: false, lamports: 1_000_000_000, owner: P, rentEpoch: 0, space: configBytes.length };

const MINT = Keypair.generate().publicKey;
const POOL = Chain.poolAddress(MINT);
const poolAs = (opening) => ({
  address: POOL, mint: MINT, vault: Chain.ata(POOL, MINT), feeBps: 100, virtualSol: 30_000_000_000n, realSol: 0n, tokens: Chain.SUPPLY,
  graduationSol: 82_000_000_000n, graduated: false, creator: me.publicKey, treasury: TREASURY, creatorFees: 1000n, treasuryFees: 1000n,
  opening: { state: "open", opensAt: 4_000_000_000, sol: 0n, totalSol: 0n, tokens: 0n, tokensLeft: 0n, seats: 1, ...opening },
});

/** Every kind of transaction the pages send, freshly built. */
async function everyKind() {
  const settled = poolAs({ state: "settled" }), open = poolAs();
  return [
    ["a buy", await Chain.buildBuy({ pool: settled, owner: me.publicKey, sol: 0.01 })],
    ["a sell", await Chain.buildSell({ pool: settled, owner: me.publicKey, tokens: 1000 })],
    ["the creator's fee claim", await Chain.buildClaim({ pool: settled, owner: me.publicKey })],
    ["the platform's fee claim", await Chain.buildClaim({ pool: settled, owner: me.publicKey, creator: false })],
    ["a commit", await Chain.buildCommit({ pool: open, owner: me.publicKey, sol: 0.01 })],
    ["a withdrawal", await Chain.buildWithdraw({ pool: open, owner: me.publicKey, sol: 0.01 })],
    ["a settle", await Chain.buildSettle({ pool: open })],
    ["a settle with a seat's claim", await Chain.buildSettle({ pool: open, claimFor: me.publicKey })],
    ["a seat's claim", await Chain.buildSeatClaim({ pool: settled, owner: me.publicKey })],
    ["a launch", await Chain.buildLaunch({ creator: me.publicKey, name: "Fee", symbol: "FEE" })],
    ["a launch with a first buy", await Chain.buildLaunch({ creator: me.publicKey, name: "Fee", symbol: "FEE", firstBuySol: 0.5 })],
    ["a launch with a batch and a seat", await Chain.buildLaunch({ creator: me.publicKey, name: "Fee", symbol: "FEE", firstBuySol: 0.01, openingSecs: 120 })],
  ];
}

/** What a serialized transaction holds: its compute unit prices and limits, its instructions, its signatures. */
function shape(bytes) {
  const raw = Buffer.from(bytes), tx = web3.Transaction.from(raw);
  const budget = (tag) => tx.instructions.filter((i) => i.programId.toBase58() === CB && i.data[0] === tag);
  const prices = budget(3).map((i) => Number(i.data.readBigUInt64LE(1))), limits = budget(2).map((i) => i.data.readUInt32LE(1));
  const limit = limits[0] ?? null, price = prices[0] ?? null;
  const priority = price === null || limit === null ? null : Math.ceil(price * limit / 1e6);
  return { raw, tx, prices, limits, price, limit, priority, signatures: tx.signatures.length };
}
/** Sends one built transaction; its shape as sent (the bytes the node got), or { error }. */
async function sent(built) {
  try { await Chain.send(built, wallet); } catch (error) { return { error }; }
  const b64 = built.tx.serialize().toString("base64");
  return node.sent.has(b64) ? shape(Buffer.from(b64, "base64")) : { error: new Error("the node did not get these bytes") };
}
const MAX = Chain.PRIORITY?.maxLamports, FLOOR = Chain.PRIORITY?.floor;
console.log(`PRIORITY: ${JSON.stringify(Chain.PRIORITY)}`);
/** 150 blocks' minimums as a node tells them: 0 in most, these in the rest (spread among the zeros). */
const blocks = (paid) => Array.from({ length: 150 }, (_, i) => (i % 15 === 14 && paid[(i - 14) / 15] !== undefined ? paid[(i - 14) / 15] : 0));

/* ---------- 1. one price on every transaction ---------- */
head("1. every kind of transaction goes out with exactly one compute unit price, the 75th percentile of the blocks that took one");
{
  fresh();
  // 140 blocks say 0, 10 say 10,000 to 100,000: the 75th percentile of those 10 is the 8th, 80,000 (the 75th
  // percentile of all 150 is 0)
  node.fees = blocks(Array.from({ length: 10 }, (_, i) => (i + 1) * 10_000));
  const kinds = await everyKind();
  const out = await Promise.all(kinds.map(([, b]) => sent(b)));
  kinds.forEach(([what], i) => {
    const s = out[i];
    line(!s.error && s.prices.length === 1 && s.limits.length === 1 && s.price === 80_000,
      `${what}: ${s.error ? s.error.message : `${s.prices.length} price(s) [${s.prices}], ${s.limits.length} limit(s) [${s.limits}], priority ${s.priority} lamports`}`);
  });
}

/* ---------- 2. the accounts asked about ---------- */
head("2. the fees asked for are those of the transaction's writable accounts");
{
  fresh();
  node.fees = [0]; node.asked = [];
  const settled = poolAs({ state: "settled" });
  const s = await sent(await Chain.buildBuy({ pool: settled, owner: me.publicKey, sol: 0.01 }));
  const asked = node.asked[0] ?? [];
  const want = [me.publicKey, POOL, MINT, settled.vault, Chain.ata(me.publicKey, MINT)].map(String);
  const readOnly = [Chain.TOKEN_2022, Chain.DONT_FRONT, "11111111111111111111111111111111", P].map(String);
  line(!s.error && node.asked.length === 1 && asked.length === want.length && want.every((k) => asked.includes(k)),
    `a buy asks about its ${asked.length} writable accounts: the wallet, the pool, the mint, the vault, the wallet's token account`);
  line(!readOnly.some((k) => asked.includes(k)), "and none of its read-only ones (Token-2022, the System Program, Jito's mark, the program)");
  // no transaction of the site's reaches 128 (1,232 bytes hold about 35 accounts), so one is made: a buy with 126 more
  // writable accounts, 131 in all. It is too big to simulate, but its price is read as it is prepared, before that
  node.asked = [];
  const big = await Chain.buildBuy({ pool: settled, owner: me.publicKey, sol: 0.01 });
  const more = Array.from({ length: 126 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }));
  big.tx.add({ programId: new PublicKey(P), keys: more, data: Buffer.alloc(0) });
  try { await Chain.simulate(big, me.publicKey); } catch { /* too large: expected */ }
  const cut = node.asked[0] ?? [];
  line(cut.length === 128 && cut[0] === me.publicKey.toBase58() && new Set(cut).size === 128,
    `one with 131 writable accounts asks about 128, as the node takes, the wallet first: ${cut.length} asked`);
}

/* ---------- 3. the cap ---------- */
head(`3. the cap: with enormous recent fees no priority fee passes ${MAX} lamports (${MAX / 1e9} SOL)`);
{
  fresh();
  node.fees = Array.from({ length: 150 }, () => 5e12);
  const kinds = await everyKind();
  const bare = await Chain.buildBuy({ pool: poolAs({ state: "settled" }), owner: me.publicKey, sol: 0.01 });
  bare.tx.instructions.shift();                         // no limit of its own: the runtime's most, 200,000 an instruction
  const out = await Promise.all([...kinds.map(([, b]) => sent(b)), sent(bare)]);
  kinds.forEach(([what], i) => {
    const s = out[i];
    line(!s.error && s.prices.length === 1 && s.priority <= MAX && s.price === Math.floor(MAX * 1e6 / s.limit),
      `${what}: ${s.error ? s.error.message : `${num(s.price)} micro-lamports × ${num(s.limit)} units = ${num(s.priority)} lamports`}`);
  });
  const b = out[kinds.length];
  line(!b.error && b.limits.length === 0 && b.prices.length === 1 && b.prices[0] * 400_000 / 1e6 <= MAX,
    `one with no limit of its own, priced for the 400,000 units its 2 instructions may use: ${b.error ? b.error.message : `${num(b.price)} micro-lamports, ${num(b.price === null ? null : b.price * 0.4)} lamports at most`}`);
}

/* ---------- 4. a launch with a first buy ---------- */
head("4. a launch with a first buy, built from the buy's own instructions: nothing twice");
{
  fresh();
  node.fees = [20_000];
  const s = await sent(await Chain.buildLaunch({ creator: me.publicKey, name: "Fee", symbol: "FEE", firstBuySol: 0.5 }));
  const ATA = Chain.ATA_PROGRAM.toBase58();
  const order = s.error ? [] : s.tx.instructions.map((i) => (i.programId.toBase58() === CB ? `budget:${i.data[0]}` : i.programId.toBase58() === P ? "pool" : i.programId.toBase58() === ATA ? "account" : "other"));
  const ids = s.error ? [] : s.tx.instructions.map((i) => `${i.programId.toBase58()}|${i.data.toString("hex")}|${i.keys.map((k) => k.pubkey.toBase58()).join(",")}`);
  line(!s.error && s.limits.length === 1 && s.prices.length === 1, `one limit (${s.limits}) and one price (${s.prices})`);
  line(order.join(" ") === "budget:2 pool account pool budget:3", `in order: ${order.join(", ")}`);
  line(ids.length > 0 && new Set(ids).size === ids.length, "no instruction appears twice");
  const long = await sent(await Chain.buildLaunch({ creator: me.publicKey, name: "N".repeat(32), symbol: "S".repeat(10), uri: "u".repeat(200), firstBuySol: 0.5 }));
  line(!long.error && long.raw.length <= 1232 && long.prices.length === 1,
    `the longest name (32), symbol (10) and link (200) with a first buy: ${long.error ? long.error.message : `${long.raw.length} of 1,232 bytes`}`);
}

/* ---------- 5. a read that fails ---------- */
head(`5. a read that fails gives the floor, ${FLOOR} micro-lamports, and the send goes on`);
for (const [mode, what] of [
  ["refused", "a server that does not pass the call yet (403, method not allowed)"],
  ["limited", "a 429"],
  ["none", "a null result"],
  ["garbled", "an answer that is not JSON"],
  ["slow", `a node that answers after 8 s (the wait is ${Chain.PRIORITY?.waitMs} ms)`],
]) {
  fresh();
  node.fees = mode;
  const t0 = Date.now();
  const s = await sent(await Chain.buildBuy({ pool: poolAs({ state: "settled" }), owner: me.publicKey, sol: 0.01 }));
  const ms = Date.now() - t0;
  // the send itself waits a second before it asks for the status
  const quick = mode !== "slow" || ms < (Chain.PRIORITY?.waitMs ?? 8000) + 2000;
  line(!s.error && s.prices.length === 1 && s.price === FLOOR && quick, `${what}: ${s.error ? s.error.message : `price ${s.price}, sent in ${ms} ms`}`);
}

/* ---------- 6. a price set already ---------- */
head("6. a transaction that has a compute unit price already keeps it, and gets no second one");
{
  fresh();
  node.fees = [30_000]; node.feeCalls = 0;
  const built = await Chain.buildBuy({ pool: poolAs({ state: "settled" }), owner: me.publicKey, sol: 0.01 });
  const data = Buffer.alloc(9); data[0] = 3; data.writeBigUInt64LE(777n, 1);
  built.tx.add({ programId: new PublicKey(CB), keys: [], data });
  const s = await sent(built);
  line(!s.error && s.prices.length === 1 && s.price === 777, `its own price of 777 goes out alone: ${s.error ? s.error.message : `[${s.prices}]`}`);
  line(node.feeCalls === 0, `and no fees were read for it (${node.feeCalls} calls)`);
}

/* ---------- 7. simulated, then sent ---------- */
head("7. a transaction simulated and then sent: one price each time, one reading for both");
{
  fresh();
  node.fees = [400_000]; node.feeCalls = 0; node.sims = [];
  const built = await Chain.buildCommit({ pool: poolAs(), owner: me.publicKey, sol: 0.01 });
  const sim = await Chain.simulate(built, me.publicKey);
  const simmed = node.sims.length ? shape(Buffer.from(node.sims[0], "base64")) : null;
  const s = await sent(built);
  line(sim.ok && simmed && simmed.prices.length === 1 && simmed.price === 400_000, `the simulation's transaction: ${simmed ? `[${simmed.prices}]` : "not simulated"}`);
  line(!s.error && s.prices.length === 1 && s.price === 400_000, `the one sent after it: ${s.error ? s.error.message : `[${s.prices}]`}`);
  line(node.feeCalls === 1, `fees read once for both (${node.feeCalls})`);
  fresh();                                               // the reading forgotten, as one older than PRIORITY.keepMs is
  node.fees = [600_000];
  const again = await sent(built);
  line(!again.error && again.prices.length === 1 && again.price === 600_000, `sent again with a new reading: the price is replaced, not added (${again.error ? again.error.message : `[${again.prices}]`})`);
}

/* ---------- 8. the floor ---------- */
head(`8. the floor: ${FLOOR} micro-lamports off devnet; none on devnet, where the node is not asked`);
{
  const buy = () => Chain.buildBuy({ pool: poolAs({ state: "settled" }), owner: me.publicKey, sol: 0.01 });
  fresh();
  node.fees = blocks([]);
  const off = await sent(await buy());
  line(!off.error && off.prices.length === 1 && off.price === FLOOR, `150 blocks that all say 0, off devnet: ${off.error ? off.error.message : off.price}, the same as a read that fails`);
  // most blocks 0 and a few with a price, as a real node tells of an account others write too: those few set it
  fresh();
  node.fees = blocks([300_000, 250_000, 400_000, 350_000, 300_000]);
  const few = await sent(await buy());
  line(!few.error && few.prices.length === 1 && few.price === 350_000,
    `145 blocks that say 0 and 5 that say 250,000 to 400,000: ${few.error ? few.error.message : num(few.price)} (the 75th percentile of the 5)`);
  for (const [fees, what] of [[blocks([]), "blocks that all say 0"], [Array.from({ length: 150 }, () => 5e12), "enormous fees"], ["limited", "a 429"], ["slow", "no answer in time"]]) {
    fresh("devnet");
    node.fees = fees; node.feeCalls = 0;
    const dev = await sent(await buy());
    line(!dev.error && dev.prices.length === 1 && dev.price === 0 && node.feeCalls === 0,
      `on devnet, with ${what}: ${dev.error ? dev.error.message : `price ${dev.price}, ${node.feeCalls} reads`} (still one price instruction)`);
  }
  fresh();
}

/* ---------- 9. the pages ---------- */
head("9. what the pages count for the network");
{
  const LAUNCH = page("launch.html"), COIN = page("coin.html");
  const between = (text, from, to) => { const a = text.indexOf(from), b = a < 0 ? -1 : text.indexOf(to, a); return b > a ? text.slice(a, b) : ""; };
  // launch.html's own constants and its estimate, run as the page runs them
  const code = between(LAUNCH, "/* rent the launch leaves", "/* ================= the form's state") + between(LAUNCH, "function launchFee()", "function renderNeed()");
  const ctx = vm.createContext({ window: { Chain }, Chain, Math, Number, LAMP: 1e9, bytes: (s) => Buffer.byteLength(s),
    F: { name: "Fee", symbol: "FEE", uri: "", first: 0, opening: 0 }, CFG: { cfg: { launchFee: 0n } } });
  let need = null;
  try { vm.runInContext(`${code}\nvar NEED = needLamports();`, ctx); need = ctx.NEED; } catch (e) { console.log(`         ${e.message}`); }
  const launch = await sent(await Chain.buildLaunch({ creator: me.publicKey, name: "Fee", symbol: "FEE" }));
  const base = 5000 * (launch.signatures ?? NaN), rent = need ? ctx.RENT_BASE + ctx.RENT_BYTE * 6 : NaN;
  line(need && ctx.NET_FEE === base, `launch.html's network fee is the launch's ${launch.signatures} signature(s): ${need ? ctx.NET_FEE : "-"} lamports`);
  line(need && need.total === rent + base + MAX, `its estimate counts the priority fee at its most: ${need ? need.total - rent : "-"} lamports for the network`);
  // coin.html's quote, run as the page runs it, for a wallet of 0.05 SOL: the whole of it into a seat or a buy leaves
  // nothing for the network; the whole of it less one signature and the priority fee at its most goes
  const quoteCode = between(COIN, "function reservesOf", "function renderQuote()");
  const quote = (phase, sol) => {
    const c = vm.createContext({ window: { Chain }, Chain, POOL: { ...poolAs({ state: phase === "open" ? "open" : "settled" }), burned: 0n },
      WAL: { sol: 50_000_000n, tokens: 0n }, side: "buy", amt: { value: String(sol) }, SLIP: 100n, maxUnits: null, maxText: null,
      batchPhase: () => phase, mySeat: () => null, fSol: (v) => v.toFixed(3), lam: (n) => Number(n) / 1e9, units: (n) => Number(n) / 1e6, tok: String });
    try { vm.runInContext(`${quoteCode}\nvar QUOTE = makeQuote();`, c); return c.QUOTE; } catch (e) { return { msg: e.message, bad: true }; }
  };
  const rest = (50_000_000 - 5000 - MAX) / 1e9;
  for (const [phase, what] of [["open", "a commit"], ["settled", "a buy"]]) {
    const all = quote(phase, 0.05), most = quote(phase, rest);
    line(all.bad && !all.q && /network fee/.test(all.msg), `${what} of all 0.05 SOL is refused: "${all.msg}"`);
    line(!most.bad && !!most.q, `${what} of ${rest} SOL, the rest after the network fee at its most, is quoted${most.msg ? `: "${most.msg}"` : ""}`);
  }
  // a guard on a number older than the priority fee: it fails only if the Max keeps less, or the cap grows
  const keep = BigInt((COIN.match(/var keep = (\d+)n/) ?? [])[1] ?? -1);
  const rentAta = Number((LAUNCH.match(/RENT_ATA = (\d+)/) ?? [])[1]);
  line(Number(keep) >= rentAta + 5000 + MAX, `coin.html's Max still keeps enough back, ${Number(keep) / 1e9} SOL: the token account (${rentAta}), the fee (5000) and the priority fee at its most (${MAX})`);
}

server.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall priority fee checks passed");
process.exit(failed ? 1 : 0);
