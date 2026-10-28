// A coin with an opening batch, for real on devnet through the site's own bundle (../vendor/chain.js): it launches
// with the shortest window (2 minutes) and the creator's seat in the launch, checks that nobody can buy before the
// settle, adds to the seat and takes some back, then in the window's last minute checks that no SOL goes in and some
// still comes out, waits out the window, settles and claims the seat in one transaction, then trades. Every number is
// checked against the pool and the program's own math. One wallet does it all (the devnet wallet, which may launch
// while launches are closed). The waits are on the chain's clock (the Clock sysvar), not this machine's.
//
//   KEYPAIR=~/.config/solana/devnet.json node batch-check.mjs            (sends; about 3 minutes, about 0.05 SOL)

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection } from "@solana/web3.js";

const require = createRequire(import.meta.url);
const Chain = require("../vendor/chain.js");
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
Chain.setNet({ cluster: "devnet", rpcUrl: RPC, program: process.env.PROGRAM ?? "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK" });
const conn = new Connection(RPC, "confirmed");

const path = (process.env.KEYPAIR ?? "~/.config/solana/devnet.json").replace(/^~/, homedir());
const key = Chain.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const me = key.publicKey;
const wallet = { publicKey: me, signTransaction: async (tx) => { tx.partialSign(key); return tx; } };

process.on("uncaughtException", (err) => { console.log(`  FAIL uncaught: ${String(err?.message ?? err).slice(0, 300)}`); process.exit(1); });

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const s = (lamports) => Chain.sol(lamports).toFixed(9);
const t = (units) => Chain.tokens(units).toLocaleString("en-US", { maximumFractionDigits: 6 });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const L = (sol) => BigInt(Math.round(sol * 1e9));

async function run(label, built) {
  const sim = await Chain.simulate(built, me);
  if (!sim.ok) { line(false, `${label}: the simulation failed: ${sim.error}`); console.log(sim.logs.slice(-6).join("\n")); process.exit(1); }
  let sig;
  try { sig = await Chain.send(built, wallet); }
  catch (err) { line(false, `${label}: ${String(err?.message ?? err).slice(0, 300)}${err?.signature ? ` (${err.signature})` : ""}`); process.exit(1); }
  console.log(`         ${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  return sig;
}
/** A transaction the program must refuse, with this message. */
async function refused(label, built, words) {
  const sim = await Chain.simulate(built, me);
  line(!sim.ok && String(sim.error).includes(words), `${label}: refused${sim.ok ? " (it was NOT)" : `, "${sim.error}"`}`);
}
async function solvent(pool) {
  const info = await conn.getAccountInfo(pool.address, "confirmed");
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(info.data.length));
  const owed = rent + pool.realSol + pool.creatorFees + pool.treasuryFees + (pool.opening ? pool.opening.sol : 0n);
  return BigInt(info.lamports) >= owed;
}
const readPool = async (mint) => { for (let i = 0; i < 8; i++) { try { const p = await Chain.readPool(mint); if (p) return p; } catch {} await sleep(1500); } throw new Error("pool not read"); };
// the chain's clock against this machine's, so a wait for a moment of the window lands on the program's own time
const t0 = Date.now(), chainTs = await Chain.chainClock(), clockOff = chainTs - (t0 + Date.now()) / 2000;
const chainNow = () => Date.now() / 1000 + clockOff;
const waitUntil = async (at, what) => {
  const wait = Math.max(0, at - chainNow());
  console.log(`         waiting ${Math.ceil(wait)} s for ${what}…`);
  await sleep(wait * 1000);
};

console.log(`wallet ${Chain.short(me)}  SENDING on devnet  (the chain's clock is ${clockOff >= 0 ? "+" : ""}${clockOff.toFixed(1)} s from this one)`);

// 1. the launch: a 2-minute batch, the creator's 0.02 SOL in a seat
const built = await Chain.buildLaunch({ creator: me, name: "Batch check", symbol: "BATCH", firstBuySol: 0.02, openingSecs: 120 });
line(built.opening && built.opening.secs === 120 && built.opening.commit === L(0.02) && built.quote === null, "the launch carries a 2-minute batch and the creator's seat, no buy");
const launchedAt = chainNow();
await run("launch", built);
let pool = await readPool(built.mint);
let o = pool.opening;
line(o && o.state === "open" && o.sol === L(0.02) && o.seats === 1, `the pool opens in a batch: ${o && s(o.sol)} SOL in ${o && o.seats} seat`);
line(o && Math.abs(o.opensAt - (launchedAt + 120)) < 60, `it closes about 2 minutes from the launch (${o && new Date(o.opensAt * 1000).toISOString()})`);
line(pool.realSol === 0n && pool.tokens === Chain.SUPPLY, "nothing was bought: every token is in the pool");
line(await solvent(pool), "the pool holds what it owes, the batch's SOL included");

// 2. before the settle: no buy, no settle; more SOL in, some back out
await refused("a buy during the batch", await Chain.buildBuy({ pool, owner: me, sol: 0.01 }), "Buying opens once the opening batch is settled");
await refused("a settle before the close", await Chain.buildSettle({ pool }), "still open");
await run("commit 0.01", await Chain.buildCommit({ pool, owner: me, sol: 0.01 }));
await run("withdraw 0.005", await Chain.buildWithdraw({ pool, owner: me, sol: 0.005 }));
pool = await readPool(built.mint); o = pool.opening;
let seat = await Chain.readSeat(pool.address, me);
line(seat && seat.sol === L(0.025) && o.sol === L(0.025) && o.seats === 1, `the seat holds ${seat && s(seat.sol)} SOL, the batch ${s(o.sol)} SOL`);

// 3. the last minute: no SOL goes in, some still comes out
if (chainNow() > o.opensAt - Chain.OPENING.lockSecs - 2) { line(false, "the batch's last minute began before the checks above were done: nothing tested in it"); process.exit(1); }
await waitUntil(o.opensAt - 30, "the batch's last minute (30 s before the close)");
await refused("a commit in the last minute", await Chain.buildCommit({ pool, owner: me, sol: 0.01 }), "last minute");
await run("withdraw 0.001 in the last minute", await Chain.buildWithdraw({ pool, owner: me, sol: 0.001 }));
pool = await readPool(built.mint); o = pool.opening;
seat = await Chain.readSeat(pool.address, me);
line(seat && seat.sol === L(0.024) && o.sol === L(0.024) && o.seats === 1, `SOL still came out in the last minute: the seat holds ${seat && s(seat.sol)} SOL, the batch ${s(o.sol)} SOL`);
const expected = Chain.quoteSeat(pool, seat.sol, o.sol);

// 4. the close, then the settle and the seat's claim in one transaction: one buy with all of it, the seat's share out
await waitUntil(o.opensAt + 4, "the window to close");
let settled = null;
for (let i = 0; i < 6 && !settled; i++) {
  const b = await Chain.buildSettle({ pool, claimFor: me });
  const sim = await Chain.simulate(b, me);
  if (sim.ok) settled = await run("settle and claim", b);
  else { console.log(`         the chain's clock is behind (${sim.error}); again in 5 s`); await sleep(5000); }
}
line(Boolean(settled), "anyone can settle once the window is over, and a seat's owner claims in the same transaction");
pool = await readPool(built.mint); o = pool.opening;
line(o.state === "settled" && o.totalSol === L(0.024) && o.tokens === expected.tokens, `the batch bought ${t(o.tokens)} tokens with ${s(o.totalSol)} SOL, as quoted (${t(expected.tokens)})`);
line(pool.tokens === Chain.SUPPLY - o.tokens && pool.realSol === expected.batch.after.realSol, `the reserve moved by that one buy: ${s(pool.realSol)} real SOL in`);
const w = await Chain.readWallet(me, pool.mint);
line(w.tokens === expected.tokens && o.seats === 0 && o.tokensLeft === 0n, `the seat took all ${t(w.tokens)} tokens; no seat or token left waiting`);
line((await Chain.readSeat(pool.address, me)) === null, "the seat account is closed, its rent back");
line(await solvent(pool), "solvent after the settle and the claim");

// 5. trading
await run("buy 0.01", await Chain.buildBuy({ pool, owner: me, sol: 0.01 }));
pool = await readPool(built.mint);
await run("sell 1,000", await Chain.buildSell({ pool, owner: me, tokens: 1000 }));
pool = await readPool(built.mint);
line(await solvent(pool), "solvent after trading");

// 6. the history: the batch's moves, its one buy, and who traded
await sleep(3000);
const h = await Chain.readHistory(pool.mint, { limit: 20 });
const kinds = h.events.map((e) => e.kind);
for (const k of ["launch", "commit", "withdraw", "settle", "seat"]) line(kinds.includes(k), `the history has the ${k} event`);
line(h.events.filter((e) => e.kind === "withdraw").length === 2, "both withdrawals are in it, the last-minute one too");
line(h.events.some((e) => e.kind === "settle" && e.signature === settled) && h.events.some((e) => e.kind === "seat" && e.signature === settled && !e.refund),
  "the settle and the seat's claim are one transaction");
const trades = h.events.filter((e) => e.kind === "trade");
const batchBuy = trades.find((e) => e.batch);
line(batchBuy && batchBuy.sol === o.totalSol && batchBuy.byCreator === false, "the batch's buy is a trade by the pool itself, not by the creator");
line(trades.filter((e) => !e.batch).length === 2 && trades.filter((e) => !e.batch).every((e) => e.byCreator === true), "the later buy and sell say the creator made them");
const launchEv = h.events.find((e) => e.kind === "launch");
line(launchEv && launchEv.opensAt === o.opensAt, "the launch event carries when the batch closed");

console.log(failed ? `\n${failed} check(s) failed` : `\nevery batch check passed: https://explorer.solana.com/address/${pool.mint}?cluster=devnet`);
process.exit(failed ? 1 : 0);
