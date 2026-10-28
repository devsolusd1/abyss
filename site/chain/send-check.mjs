// Trades and claims for real on devnet through the site's own bundle (../vendor/chain.js), then checks every
// number against the pool: a buy, a sell of exactly what it bought, the creator's claim and the platform's.
// The wallet must be the coin's creator and its treasury, as the devnet wallet is for every devnet coin.
//
//   KEYPAIR=~/.config/solana/devnet.json node --experimental-websocket send-check.mjs              (simulates only)
//   SEND=1 KEYPAIR=~/.config/solana/devnet.json node --experimental-websocket send-check.mjs       (sends)
//   COIN=<mint or symbol>  BUY=<SOL, default 0.01>

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection } from "@solana/web3.js";

// the bundle is built for browsers and confirms over window.WebSocket (node 20 has one behind --experimental-websocket)
if (typeof window === "undefined") globalThis.window = globalThis;
if (typeof WebSocket === "undefined") { console.log("run with node --experimental-websocket (node 22 has it built in)"); process.exit(1); }
const require = createRequire(import.meta.url);
const Chain = require("../vendor/chain.js");
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
Chain.setNet({ cluster: "devnet", rpcUrl: RPC, program: process.env.PROGRAM ?? "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK" });
const conn = new Connection(RPC, "confirmed");

const SEND = process.env.SEND === "1";
const BUY = Number(process.env.BUY ?? 0.01);
const path = (process.env.KEYPAIR ?? "~/.config/solana/devnet.json").replace(/^~/, homedir());
const key = Chain.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const me = key.publicKey;
const wallet = { publicKey: me, signTransaction: async (tx) => { tx.partialSign(key); return tx; } };

process.on("uncaughtException", (err) => { console.log(`  FAIL uncaught: ${String(err?.message ?? err).slice(0, 300)}`); process.exit(1); });

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const s = (lamports) => Chain.sol(lamports).toFixed(9);
const t = (units) => Chain.tokens(units).toLocaleString("en-US", { maximumFractionDigits: 6 });
const balance = async () => BigInt(await conn.getBalance(me, "confirmed"));
const feeOf = async (sig) => BigInt((await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).meta.fee);

/** The pool's own floor: its rent plus its reserve plus every fee it owes. */
async function solvent(pool) {
  const info = await conn.getAccountInfo(pool.address, "confirmed");
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(info.data.length));
  const floor = rent + pool.realSol + pool.creatorFees + pool.treasuryFees;
  return { ok: BigInt(info.lamports) >= floor, spare: BigInt(info.lamports) - floor };
}

/** Simulates, then sends when SEND=1. Returns the signature, or null on a dry run. */
async function run(label, built) {
  const sim = await Chain.simulate(built, me);
  if (!sim.ok) { line(false, `${label}: the simulation failed: ${sim.error}`); console.log(sim.logs.slice(-6).join("\n")); return null; }
  if (!SEND) { line(true, `${label}: simulated cleanly (${sim.units} units)`); return null; }
  let sig;
  try { sig = await Chain.send(built, wallet); }
  catch (err) { line(false, `${label}: ${String(err?.message ?? err).slice(0, 300)}${err?.signature ? ` (${err.signature})` : ""}`); console.log(String(err?.stack ?? "").split("\n").slice(1, 6).map((l) => l.slice(0, 160)).join("\n")); process.exit(1); }
  console.log(`         ${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  return sig;
}

console.log(`wallet ${Chain.short(me)}  ${SEND ? "SENDING on devnet" : "dry run (SEND=1 sends)"}`);
const pools = await Chain.listPools();
const want = process.env.COIN;
let pool = want ? pools.find((p) => p.mint.toString() === want || p.symbol === want) : pools.find((p) => !p.graduated && p.creator.equals(me));
if (!pool) { console.log("no coin to test on"); process.exit(1); }
line(pool.creator.equals(me) && pool.treasury.equals(me), `${pool.name} (${pool.symbol}): this wallet is its creator and its treasury`);
console.log(`         before: ${s(pool.realSol)} SOL in, ${t(pool.tokens)} tokens left, fees owed ${s(pool.creatorFees)} creator + ${s(pool.treasuryFees)} treasury`);
line((await solvent(pool)).ok, "the pool holds its rent, its reserve and every fee it owes");
const histBefore = await Chain.history(pool.mint, { limit: 5 });
const claimSigs = [];

/* ---------- buy ---------- */
let bal = await balance();
let held = (await Chain.readWallet(me, pool.mint)).tokens;
const buy = await Chain.buildBuy({ pool, owner: me, sol: BUY });
const q = buy.quote;
const buySig = await run(`buy ${BUY} SOL`, buy);
let after = pool, bought = 0n;
if (buySig) {
  after = await Chain.readPool(pool.mint);
  const nowHeld = (await Chain.readWallet(me, pool.mint)).tokens;
  bought = nowHeld - held;
  const paid = bal - await balance(), net = await feeOf(buySig);
  const toT = q.fee * BigInt(pool.treasuryShareBps) / 10_000n;
  line(bought === q.tokensOut, `got ${t(bought)} tokens, the quote said ${t(q.tokensOut)}`);
  line(after.realSol === q.after.realSol && after.tokens === q.after.tokens, `the pool moved to exactly the quote: ${s(after.realSol)} SOL in, ${t(after.tokens)} tokens left`);
  line(paid === BigInt(Math.round(BUY * 1e9)) + net, `the wallet paid ${s(paid)} SOL: the buy plus a network fee of ${s(net)}`);
  line(after.treasuryFees - pool.treasuryFees === toT && after.creatorFees - pool.creatorFees === q.fee - toT,
    `fee ${s(q.fee)} split ${s(q.fee - toT)} creator, ${s(toT)} treasury`);
  line(after.volume - pool.volume === BigInt(Math.round(BUY * 1e9)), `volume grew by the buy`);
  line((await solvent(after)).ok, "still solvent after the buy");
}

/* ---------- sell exactly what was bought ---------- */
if (SEND ? bought > 0n : held > 0n) {
  const units = SEND ? bought : held / 100n;
  const before = after;
  bal = await balance();
  held = (await Chain.readWallet(me, pool.mint)).tokens;
  const sell = await Chain.buildSell({ pool: before, owner: me, tokens: units });
  const sq = sell.quote;
  const sellSig = await run(`sell ${t(units)} tokens`, sell);
  if (sellSig) {
    after = await Chain.readPool(pool.mint);
    const got = await balance() - bal, net = await feeOf(sellSig);
    line(held - (await Chain.readWallet(me, pool.mint)).tokens === units, `${t(units)} tokens left the wallet`);
    line(got === sq.solOut - net, `the wallet got ${s(got + net)} SOL (the quote said ${s(sq.solOut)}) less a network fee of ${s(net)}`);
    line(after.realSol === sq.after.realSol && after.tokens === sq.after.tokens, `the pool moved to exactly the quote: ${s(after.realSol)} SOL in`);
    line(after.realSol >= pool.realSol, `a round trip leaves the pool no poorer: ${s(after.realSol - pool.realSol)} SOL more than before the buy`);
    line((await solvent(after)).ok, "still solvent after the sell");
  }
}

/* ---------- the creator's claim, then the platform's ---------- */
for (const creator of [true, false]) {
  const who = creator ? "creator" : "treasury";
  const before = SEND ? await Chain.readPool(pool.mint) : after;
  const owed = creator ? before.creatorFees : before.treasuryFees;
  if (owed === 0n) { console.log(`         nothing owed to the ${who}`); continue; }
  bal = await balance();
  const claim = await Chain.buildClaim({ pool: before, owner: me, creator });
  const sig = await run(`${who} claims ${s(owed)} SOL`, claim);
  if (!sig) continue;
  claimSigs.push(sig);
  const now = await Chain.readPool(pool.mint);
  const got = await balance() - bal, net = await feeOf(sig);
  line(got === owed - net, `the wallet got ${s(got + net)} SOL less a network fee of ${s(net)}`);
  line((creator ? now.creatorFees : now.treasuryFees) === 0n, `the pool owes the ${who} nothing now`);
  line((creator ? now.creatorFeesPaid - before.creatorFeesPaid : now.treasuryFeesPaid - before.treasuryFeesPaid) === owed, `its paid counter grew by ${s(owed)}`);
  line(now.realSol === before.realSol, "the reserve is untouched");
  line((await solvent(now)).ok, "still solvent after the claim");
  const again = await Chain.simulate(await Chain.buildClaim({ pool: now, owner: me, creator }), me);
  line(!again.ok && again.error === "Nothing to claim", `a second claim is refused: ${again.error}`);
}

/* ---------- the record the coin page reads ---------- */
if (SEND && buySig) {
  const events = await Chain.history(pool.mint, { limit: 10 });
  const trades = events.filter((e) => e.kind === "trade");
  const mine = trades.filter((e) => !histBefore.some((h) => h.signature === e.signature)).slice(0, 2);
  line(mine.length === 2 && mine.some((e) => e.buy) && mine.some((e) => !e.buy), `the history shows the new buy and sell (${mine.map((e) => e.buy ? "buy" : "sell").join(", ")})`);
  const claims = events.filter((e) => e.kind === "claim" && claimSigs.includes(e.signature));
  line(claims.length === claimSigs.length, `the history shows the ${claims.length} claim(s), paid to ${[...new Set(claims.map((e) => Chain.short(e.to)))].join(", ")}`);
  const final = await Chain.readPool(pool.mint);
  console.log(`         after: ${s(final.realSol)} SOL in, ${t(final.tokens)} tokens left, fees owed ${s(final.creatorFees)} + ${s(final.treasuryFees)}`);
}

console.log(failed ? `\n${failed} check(s) failed` : `\nall checks passed${SEND ? "" : " (dry run)"}`);
process.exit(failed ? 1 : 0);
