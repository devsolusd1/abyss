// Opening batches with several wallets, for real on devnet through the site's own bundle (../vendor/chain.js). Three
// coins launch one after the other with the shortest window (2 minutes):
//   A, a batch that buys: the creator and three other wallets take seats of different sizes, one takes all of it back
//     and comes back in, one takes some back in the last minute. A wallet with no seat settles it, then each seat
//     claims on its own, in another order than they came in: each gets floor(tokens × its SOL / the total), so every
//     seat pays one price and only the rounding's dust stays in the vault. Then every seat sells all it got.
//   B, a refund: two seats with under 0.01 SOL in all. One settles and claims in one transaction, with no token account
//     opened; the other claims after. Each gets back exactly the SOL it put in, and its seat's rent.
//   C, an empty batch: the creator's seat takes all of it back. The settle buys nothing and owes nothing.
// The other wallets are made from the devnet wallet's own key, the same on every run. They are funded from it at the
// start, and at the end each closes its emptied token account and sends its SOL back. A run that stops halfway leaves
// the SOL where it is; SWEEP=1 then finds every seat of these wallets, takes it back (before the close) or settles and
// claims it (after), sells what was claimed, and sends the SOL back. Every number is checked against the pools and the
// program's own rounding, on the chain's clock.
//
//   KEYPAIR=~/.config/solana/devnet.json node seats-check.mjs             (sends; about 4 minutes, about 0.05 SOL)
//   KEYPAIR=~/.config/solana/devnet.json SWEEP=1 node seats-check.mjs     (gets back what a stopped run left)

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as web3 from "@solana/web3.js";

const require = createRequire(import.meta.url);
const Chain = require("../vendor/chain.js");
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
Chain.setNet({ cluster: "devnet", rpcUrl: RPC, program: process.env.PROGRAM ?? "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK" });
const conn = new web3.Connection(RPC, "confirmed");

const path = (process.env.KEYPAIR ?? "~/.config/solana/devnet.json").replace(/^~/, homedir());
const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
const MAIN = web3.Keypair.fromSecretKey(secret);
// each other wallet: a seed from the devnet wallet's key and its number, the same on every run
const derived = (n) => web3.Keypair.fromSeed(createHash("sha256").update(secret).update(`nox seats-check ${n}`).digest());
const W = Array.from({ length: 6 }, (_, i) => derived(i + 1));
const [W1, W2, W3, W4, W5, W6] = W;
const FUND = [0.05, 0.04, 0.05, 0.01, 0.02, 0.02];
const asWallet = (kp) => ({ publicKey: new Chain.PublicKey(kp.publicKey.toBase58()), signTransaction: async (tx) => { tx.partialSign(Chain.Keypair.fromSecretKey(kp.secretKey)); return tx; } });
const me = asWallet(MAIN).publicKey;

const stop = () => { console.log("\n  stopped halfway: run it again with SWEEP=1 to get the SOL back"); process.exit(1); };
process.on("uncaughtException", (err) => { console.log(`  FAIL uncaught: ${String(err?.message ?? err).slice(0, 300)}`); stop(); });
process.on("unhandledRejection", (err) => { console.log(`  FAIL uncaught: ${String(err?.message ?? err).slice(0, 300)}`); stop(); });

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const s = (lamports) => Chain.sol(lamports).toFixed(9);
const t = (units) => Chain.tokens(units).toLocaleString("en-US", { maximumFractionDigits: 6 });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const L = (sol) => BigInt(Math.round(sol * 1e9));
const FEE = 5000n;                                       // one signature, no priority fee
const name = (kp) => kp === MAIN ? "the creator" : `W${W.indexOf(kp) + 1}`;

/** Sends what the site would send, signed by `kp`, after its own simulation passes. */
async function run(label, built, kp = MAIN) {
  const wallet = asWallet(kp);
  const sim = await Chain.simulate(built, wallet.publicKey);
  if (!sim.ok) { line(false, `${label}: the simulation failed: ${sim.error}`); console.log(sim.logs.slice(-6).join("\n")); stop(); }
  let sig;
  try { sig = await Chain.send(built, wallet); }
  catch (err) { line(false, `${label}: ${String(err?.message ?? err).slice(0, 300)}${err?.signature ? ` (${err.signature})` : ""}`); stop(); }
  console.log(`         ${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  return sig;
}
async function refused(label, built, words, kp = MAIN) {
  const sim = await Chain.simulate(built, asWallet(kp).publicKey);
  line(!sim.ok && String(sim.error).includes(words), `${label}: refused${sim.ok ? " (it was NOT)" : `, "${sim.error}"`}`);
}
async function solvent(pool) {
  const info = await conn.getAccountInfo(new web3.PublicKey(pool.address.toBase58()), "confirmed");
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(info.data.length));
  const owed = rent + pool.realSol + pool.creatorFees + pool.treasuryFees + (pool.opening ? pool.opening.sol : 0n);
  const vault = BigInt((await conn.getTokenAccountBalance(new web3.PublicKey(pool.vault.toBase58()), "confirmed")).value.amount);
  return BigInt(info.lamports) >= owed && vault === pool.tokens + (pool.opening ? pool.opening.tokensLeft : 0n);
}
const readPool = async (mint) => { for (let i = 0; i < 8; i++) { try { const p = await Chain.readPool(mint); if (p) return p; } catch {} await sleep(1500); } throw new Error("pool not read"); };
const balance = async (kp) => BigInt(await conn.getBalance(kp.publicKey, "confirmed"));
const seatRent = async (pool, kp) => { const seat = await Chain.readSeat(pool.address, kp.publicKey.toBase58()); return seat ? BigInt((await conn.getAccountInfo(new web3.PublicKey(seat.address.toBase58()), "confirmed")).lamports) : 0n; };
const tokenAddress = (kp, mint) => new web3.PublicKey(Chain.ata(kp.publicKey.toBase58(), String(mint)).toBase58());
const tokenAccount = (kp, mint) => conn.getAccountInfo(tokenAddress(kp, mint), "confirmed");
const TOKEN_2022 = new web3.PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/** Closes `kp`'s emptied token account of `mint` (Token-2022's CloseAccount), its rent back to `kp`. */
async function closeTokens(kp, mint) {
  const account = tokenAddress(kp, mint);
  const tx = new web3.Transaction().add(new web3.TransactionInstruction({ programId: TOKEN_2022, data: Buffer.from([9]), keys: [
    { pubkey: account, isSigner: false, isWritable: true }, { pubkey: kp.publicKey, isSigner: false, isWritable: true }, { pubkey: kp.publicKey, isSigner: true, isWritable: false },
  ] }));
  await web3.sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
}

/** Every other wallet's SOL back to the devnet wallet, less the network fee. */
async function sweep() {
  for (const kp of W) {
    const b = await balance(kp).catch(() => 0n);
    if (b <= FEE) continue;
    const tx = new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: MAIN.publicKey, lamports: b - FEE }));
    try { await web3.sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" }); console.log(`         swept ${s(b - FEE)} SOL back from ${name(kp)}`); }
    catch (err) { console.log(`  FAIL could not sweep ${name(kp)} (${kp.publicKey.toBase58()}): ${String(err?.message ?? err).slice(0, 160)}`); failed++; }
  }
}
/**
 * What a stopped run left: every seat of these wallets (an 81-byte Seat account of the program, its owner at byte 8 and
 * its pool at 40) is taken back before its batch's close, or settled and claimed after it. What a claim gave is sold,
 * and the token account closed. Each wallet is lent 0.005 SOL for the fees and rent first; the sweep then sends it all
 * back.
 */
async function recover() {
  const program = new web3.PublicKey(process.env.PROGRAM ?? "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK");
  for (const kp of [MAIN, ...W]) {
    const seats = await conn.getProgramAccounts(program, { commitment: "confirmed", filters: [{ dataSize: 81 }, { memcmp: { offset: 8, bytes: kp.publicKey.toBase58() } }] });
    for (const { account } of seats) {
      const poolInfo = await conn.getAccountInfo(new web3.PublicKey(account.data.subarray(40, 72)), "confirmed");
      const mint = new web3.PublicKey(poolInfo.data.subarray(8, 40)).toBase58(), owner = kp.publicKey.toBase58();
      if (kp !== MAIN && (await balance(kp)) < L(0.005)) {
        await web3.sendAndConfirmTransaction(conn, new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: MAIN.publicKey, toPubkey: kp.publicKey, lamports: Number(L(0.005)) })), [MAIN], { commitment: "confirmed" });
      }
      let pool = await readPool(mint);
      const seat = await Chain.readSeat(pool.address, owner);
      if (pool.opening.state === "open" && chainNow() < pool.opening.opensAt - 2) {
        await run(`${name(kp)} takes its seat back from ${Chain.short(mint)}`, await Chain.buildWithdraw({ pool, owner, sol: seat.sol }), kp);
        continue;
      }
      if (pool.opening.state === "open") { await waitUntil(pool.opening.opensAt + 4, `${Chain.short(mint)}'s window to close`); await settleWhenOver(`${name(kp)} settles ${Chain.short(mint)} and claims`, pool, kp, kp); }
      else await run(`${name(kp)} claims its seat in ${Chain.short(mint)}`, await Chain.buildSeatClaim({ pool, owner }), kp);
      pool = await readPool(mint);
      const held = (await Chain.readWallet(owner, mint)).tokens;
      if (held > 0n) await run(`${name(kp)} sells all ${t(held)}`, await Chain.buildSell({ pool, owner, tokens: Chain.tokens(held) }), kp);
      if ((await tokenAccount(kp, mint)) && (await Chain.readWallet(owner, mint)).tokens === 0n) await closeTokens(kp, mint);
    }
  }
}
const t0 = Date.now(), chainTs = await Chain.chainClock(), clockOff = chainTs - (t0 + Date.now()) / 2000;
const chainNow = () => Date.now() / 1000 + clockOff;
const waitUntil = async (at, what) => {
  const wait = Math.max(0, at - chainNow());
  console.log(`         waiting ${Math.ceil(wait)} s for ${what}…`);
  await sleep(wait * 1000);
};
/** The settle, once the chain's clock says the window is over (it can be a few seconds behind). */
async function settleWhenOver(label, pool, kp, claimFor) {
  for (let i = 0; i < 6; i++) {
    const b = await Chain.buildSettle({ pool, ...(claimFor ? { claimFor: claimFor.publicKey.toBase58() } : {}) });
    const sim = await Chain.simulate(b, asWallet(kp).publicKey);
    if (sim.ok) return run(label, b, kp);
    console.log(`         the chain's clock is behind (${sim.error}); again in 5 s`); await sleep(5000);
  }
  line(false, `${label}: the settle never passed its simulation`); stop();
}
if (process.env.SWEEP) { await recover(); await sweep(); process.exit(failed ? 1 : 0); }

console.log(`wallet ${Chain.short(me)}  SENDING on devnet  (the chain's clock is ${clockOff >= 0 ? "+" : ""}${clockOff.toFixed(1)} s from this one)`);
console.log(`         other wallets: ${W.map((kp, i) => `W${i + 1} ${Chain.short(kp.publicKey.toBase58())}`).join(", ")}`);

// 0. the other wallets' SOL, in one transaction from the devnet wallet
{
  const tx = new web3.Transaction();
  W.forEach((kp, i) => tx.add(web3.SystemProgram.transfer({ fromPubkey: MAIN.publicKey, toPubkey: kp.publicKey, lamports: Number(L(FUND[i])) })));
  const sig = await web3.sendAndConfirmTransaction(conn, tx, [MAIN], { commitment: "confirmed" });
  console.log(`         fund ${FUND.reduce((a, b) => a + b, 0).toFixed(2)} SOL: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

// 1. three launches, each with a 2-minute batch
const launch = async (label, symbol, firstBuySol) => {
  const built = await Chain.buildLaunch({ creator: me, name: `Seats ${label}`, symbol, firstBuySol, openingSecs: 120 });
  await run(`launch ${label}`, built);
  console.log(`         coin ${label}: ${built.mint}  (page: /coin?mint=${built.mint})`);
  return readPool(built.mint);
};
let A = await launch("A", "SEATA", 0.02), B = await launch("B", "SEATB", 0), C = await launch("C", "SEATC", 0.002);
line(A.opening.seats === 1 && A.opening.sol === L(0.02) && B.opening.seats === 0 && B.opening.sol === 0n && C.opening.seats === 1,
  "A opens with the creator's 0.02 SOL seat, B with no seat (a launch without the creator's SOL), C with the creator's 0.002");

// 2. the seats, all before the last minute
await run("A: W1 commits 0.03", await Chain.buildCommit({ pool: A, owner: W1.publicKey.toBase58(), sol: 0.03 }), W1);
await run("A: W2 commits 0.015", await Chain.buildCommit({ pool: A, owner: W2.publicKey.toBase58(), sol: 0.015 }), W2);
await run("A: W2 takes all of it back", await Chain.buildWithdraw({ pool: A, owner: W2.publicKey.toBase58(), sol: 0.015 }), W2);
A = await readPool(A.mint);
line(A.opening.seats === 2 && (await Chain.readSeat(A.address, W2.publicKey.toBase58())) === null, "A: W2's emptied seat is closed, 2 seats left");
await run("A: W2 comes back with 0.01", await Chain.buildCommit({ pool: A, owner: W2.publicKey.toBase58(), sol: 0.01 }), W2);
await run("A: W3 commits 0.025", await Chain.buildCommit({ pool: A, owner: W3.publicKey.toBase58(), sol: 0.025 }), W3);
// every seat of A is in before its last minute (a commit in it would have been refused above); B and C close later
await run("B: W5 commits 0.003", await Chain.buildCommit({ pool: B, owner: W5.publicKey.toBase58(), sol: 0.003 }), W5);
await run("B: W6 commits 0.004", await Chain.buildCommit({ pool: B, owner: W6.publicKey.toBase58(), sol: 0.004 }), W6);
await run("C: the creator takes all of it back", await Chain.buildWithdraw({ pool: C, owner: me, sol: 0.002 }));
A = await readPool(A.mint); B = await readPool(B.mint); C = await readPool(C.mint);
line(A.opening.seats === 4 && A.opening.sol === L(0.085), `A: ${s(A.opening.sol)} SOL in ${A.opening.seats} seats`);
line(B.opening.seats === 2 && B.opening.sol === L(0.007), `B: ${s(B.opening.sol)} SOL in ${B.opening.seats} seats, under the 0.01 a batch needs`);
line(C.opening.seats === 0 && C.opening.sol === 0n, "C: nobody in it");
for (const p of [A, B, C]) line(await solvent(p), `${p === A ? "A" : p === B ? "B" : "C"}: the pool holds what it owes, the batch's SOL included`);

// 3. A's last minute: no more SOL in, some out (time is left for both before the close)
if (chainNow() > A.opening.opensAt - 35) { line(false, "too little of A's last minute is left to test it"); stop(); }
await waitUntil(A.opening.opensAt - 30, "A's last minute (30 s before its close)");
await refused("A: W1 commits in the last minute", await Chain.buildCommit({ pool: A, owner: W1.publicKey.toBase58(), sol: 0.01 }), "last minute", W1);
await run("A: W3 takes 0.005 back in the last minute", await Chain.buildWithdraw({ pool: A, owner: W3.publicKey.toBase58(), sol: 0.005 }), W3);
A = await readPool(A.mint);
const seatsA = [[MAIN, L(0.02)], [W1, L(0.03)], [W2, L(0.01)], [W3, L(0.02)]];
const read = await Promise.all(seatsA.map(([kp]) => Chain.readSeat(A.address, kp.publicKey.toBase58())));
line(A.opening.sol === L(0.08) && read.every((seat, i) => seat && seat.sol === seatsA[i][1]),
  `A at its close: ${seatsA.map(([kp, v]) => `${name(kp)} ${s(v)}`).join(", ")}: ${s(A.opening.sol)} SOL`);

// 4. A: a wallet with no seat settles it; then each seat claims, last in first
await waitUntil(A.opening.opensAt + 4, "A's window to close");
const expected = Chain.quoteSeat(A, A.opening.sol, A.opening.sol);
const w4Before = await balance(W4);
await refused("A: a seat's claim before the settle", await Chain.buildSeatClaim({ pool: A, owner: W1.publicKey.toBase58() }), "still open", W1);
await settleWhenOver("A: W4, with no seat, settles", A, W4);
line((await balance(W4)) === w4Before - FEE, "A: settling cost W4 the network fee only");
A = await readPool(A.mint);
const T = A.opening.tokens, S = A.opening.totalSol;
line(A.opening.state === "settled" && S === L(0.08) && T === expected.tokens, `A bought ${t(T)} tokens with ${s(S)} SOL in one buy, as quoted (${t(expected.tokens)})`);
let given = 0n;
for (const [kp, sol] of [...seatsA].reverse()) {
  await run(`A: ${name(kp)} claims`, await Chain.buildSeatClaim({ pool: A, owner: kp.publicKey.toBase58() }), kp);
  const got = (await Chain.readWallet(kp.publicKey.toBase58(), A.mint)).tokens, share = T * sol / S;
  given += got;
  // floor(T × sol / S) to the unit: the batch's one price for every seat, less under one unit of rounding
  line(got === share && (await Chain.readSeat(A.address, kp.publicKey.toBase58())) === null,
    `A: ${name(kp)} got ${t(got)} tokens for ${s(sol)} SOL, its share at the batch's one price to the unit, and its seat closed`);
}
A = await readPool(A.mint);
line(A.opening.seats === 0 && A.opening.tokensLeft === T - given && T - given < 4n,
  `A: every seat claimed; ${A.opening.tokensLeft} units of rounding dust stay in the vault`);
line(await solvent(A), "A: solvent after the settle and every claim");

// 5. B: under the minimum, a refund. W5 settles and claims at once, W6 claims after
await waitUntil(B.opening.opensAt + 4, "B's window to close");
B = await readPool(B.mint);
const w5Before = await balance(W5), w5Rent = await seatRent(B, W5);
await settleWhenOver("B: W5 settles and takes its SOL back", B, W5, W5);
B = await readPool(B.mint);
line(B.opening.state === "refund" && B.opening.tokens === 0n && B.realSol === 0n, "B: the batch bought nothing (a refund)");
line((await balance(W5)) === w5Before + L(0.003) + w5Rent - FEE, `B: W5 got back its 0.003 SOL and its seat's rent (${s(w5Rent)}), less the network fee`);
line((await tokenAccount(W5, B.mint)) === null, "B: no token account was opened for W5's refund");
const w6Before = await balance(W6), w6Rent = await seatRent(B, W6);
await run("B: W6 takes its SOL back", await Chain.buildSeatClaim({ pool: B, owner: W6.publicKey.toBase58() }), W6);
line((await balance(W6)) === w6Before + L(0.004) + w6Rent - FEE, "B: W6 got back its 0.004 SOL and its seat's rent, less the network fee");
line((await tokenAccount(W6, B.mint)) === null, "B: no token account was opened for W6's refund");
B = await readPool(B.mint);
line(B.opening.seats === 0 && B.opening.sol === 0n && await solvent(B), "B: no seat or SOL left waiting, and solvent");
line((await Chain.simulate(await Chain.buildBuy({ pool: B, owner: W6.publicKey.toBase58(), sol: 0.005 }), asWallet(W6).publicKey)).ok, "B: buying is open after the refund (simulated)");

// 6. C: nobody in it; the settle buys nothing and owes nothing
await waitUntil(C.opening.opensAt + 4, "C's window to close");
C = await readPool(C.mint);
await settleWhenOver("C: the creator settles the empty batch", C, MAIN);
C = await readPool(C.mint);
line(C.opening.state === "settled" && C.opening.totalSol === 0n && C.opening.tokens === 0n && C.realSol === 0n && C.tokens === Chain.SUPPLY,
  "C: settled with nothing in it: no buy, every token still in the pool");
line(await solvent(C), "C: solvent");
line((await Chain.simulate(await Chain.buildBuy({ pool: C, owner: me, sol: 0.005 }), me)).ok, "C: buying is open (simulated)");

// 7. A: every seat sells all it got, in the order they came in
for (const [kp] of seatsA) {
  A = await readPool(A.mint);
  const held = (await Chain.readWallet(kp.publicKey.toBase58(), A.mint)).tokens;
  await run(`A: ${name(kp)} sells all ${t(held)}`, await Chain.buildSell({ pool: A, owner: kp.publicKey.toBase58(), tokens: Chain.tokens(held) }), kp);
  const left = (await Chain.readWallet(kp.publicKey.toBase58(), A.mint)).tokens;
  if (left === 0n) await closeTokens(kp, A.mint);
  line(left === 0n && (await tokenAccount(kp, A.mint)) === null, `A: ${name(kp)} holds nothing after its sell, and its token account is closed`);
}
A = await readPool(A.mint);
line(await solvent(A), `A: solvent after every seat sold: ${s(A.realSol)} real SOL left in the curve`);
await sweep();                                           // the history needs none of the other wallets' SOL

// 8. A's history: every seat's move, one buy by the pool, the claims and the sells
let h = null;
for (let i = 0; i < 4 && !h?.complete; i++) {
  await sleep(i ? 5000 : 3000);
  try { h = await Chain.readHistory(A.mint, { limit: 40 }); } catch (err) { console.log(`         the history did not come in (${String(err?.message ?? err).slice(0, 80)}); again`); }
}
line(Boolean(h?.complete), `A's history read whole: ${h ? `${h.have} of ${h.total} transactions` : "nothing"}`);
const count = (kind) => (h?.events ?? []).filter((e) => e.kind === kind).length;
line(count("commit") === 5 && count("withdraw") === 2, `A's history: ${count("commit")} commitments (the creator's in the launch, W2's twice) and ${count("withdraw")} withdrawals`);
line(count("settle") === 1 && count("seat") === 4 && (h?.events ?? []).filter((e) => e.kind === "seat").every((e) => !e.refund), "A's history: one settle and four claims, none a refund");
const trades = (h?.events ?? []).filter((e) => e.kind === "trade");
line(trades.filter((e) => e.batch).length === 1 && trades.filter((e) => !e.batch && !e.buy).length === 4, "A's history: the batch's one buy by the pool, and the four sells");

console.log(failed ? `\n${failed} check(s) failed` : `\nevery seats check passed: A ${A.mint}, B ${B.mint}, C ${C.mint}`);
process.exit(failed ? 1 : 0);
