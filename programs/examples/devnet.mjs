// Takes one coin through the pool program on devnet with real transactions: the config
// (once), a launch with the creator's first buy in the same transaction, then a sell and
// another buy. It doubles as a client example: every account list and argument layout a site
// needs is built here by hand.
//
//   npm install
//   KEYPAIR=~/.config/solana/devnet.json node devnet.mjs          (simulates only)
//   SEND=1 KEYPAIR=~/.config/solana/devnet.json node devnet.mjs   (sends)
//
// The keypair is the config's admin, launcher and treasury, and the coin's creator. A run
// costs about 0.03 SOL of rent and fees plus what it trades (0.5 + 0.2 SOL, partly sold back,
// the rest kept as tokens). Addresses and signatures go to devnet.json.

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const PROGRAM = new PublicKey(process.env.POOL_PROGRAM ?? "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR = (process.env.KEYPAIR ?? "~/.config/solana/devnet.json").replace(/^~/, homedir());
const SEND = process.env.SEND === "1";
const OUT = process.env.OUT ?? "devnet.json";

// The numbers the user chose: open at 30 SOL of market cap, graduate at 420, 1% split evenly.
const SOL = 1_000_000_000n;
const TOKEN = 1_000_000n;
const SUPPLY = 1_000_000_000n * TOKEN;
const VIRTUAL_SOL = 30n * SOL;
const GRADUATION_MCAP = 420n * SOL;
const FEE_BPS = 100;
const lamportsOf = (sol) => BigInt(Math.round(Number(sol) * 1e9));
const FIRST_BUY = lamportsOf(process.env.FIRST_BUY_SOL ?? 0.5);
const SECOND_BUY = lamportsOf(process.env.SECOND_BUY_SOL ?? 0.2);
/// Slippage the client accepts on every trade.
const SLIPPAGE_BPS = 100n;

/* ---------------- Encoding ---------------- */

const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u8 = (n) => Buffer.from([n]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => { const bytes = Buffer.from(s, "utf8"); return Buffer.concat([u32(bytes.length), bytes]); };
const meta = (pubkey, { signer = false, writable = false } = {}) => ({ pubkey, isSigner: signer, isWritable: writable });
const ix = (keys, ...data) => new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat(data) });

/* ---------------- Addresses ---------------- */

const pda = (seeds, program = PROGRAM) => PublicKey.findProgramAddressSync(seeds, program)[0];
const configAddress = pda([Buffer.from("config")]);
const programData = pda([PROGRAM.toBuffer()], LOADER);

function coinAddresses(mint) {
  const pool = pda([Buffer.from("pool"), mint.toBuffer()]);
  return { mint, pool, vault: getAssociatedTokenAddressSync(mint, pool, true, TOKEN_2022_PROGRAM_ID) };
}

/* ---------------- One builder per instruction ---------------- */

function configArgs({ admin, launcher, treasury, launchFee, minFeeBps, treasuryShareBps, launchesOpen }) {
  return Buffer.concat([
    admin.toBuffer(), launcher.toBuffer(), treasury.toBuffer(),
    u64(launchFee), u16(minFeeBps), u16(treasuryShareBps), u8(launchesOpen ? 1 : 0),
  ]);
}

const initConfig = (admin, args) =>
  ix([
    meta(admin, { signer: true, writable: true }), meta(configAddress, { writable: true }),
    meta(args.treasury, { writable: true }), meta(PROGRAM), meta(programData), meta(SystemProgram.programId),
  ], disc("init_config"), configArgs(args));

function launch({ creator, coin, treasury, name, symbol, uri, maxLaunchFee }) {
  const args = Buffer.concat([
    str(name), str(symbol), str(uri), u64(VIRTUAL_SOL), u64(GRADUATION_MCAP), u16(FEE_BPS), u64(maxLaunchFee),
  ]);
  return ix([
    meta(creator, { signer: true, writable: true }), meta(coin.mint, { signer: true, writable: true }),
    meta(configAddress), meta(coin.pool, { writable: true }), meta(coin.vault, { writable: true }),
    meta(treasury, { writable: true }), meta(TOKEN_2022_PROGRAM_ID), meta(ASSOCIATED_TOKEN_PROGRAM_ID),
    meta(SystemProgram.programId),
  ], disc("launch"), args);
}

/** buy and sell share their accounts. The mint is writable: the buy that graduates burns. */
function swapKeys(trader, coin) {
  return [
    meta(trader, { signer: true, writable: true }), meta(coin.pool, { writable: true }),
    meta(coin.mint, { writable: true }), meta(coin.vault, { writable: true }),
    meta(getAssociatedTokenAddressSync(coin.mint, trader, false, TOKEN_2022_PROGRAM_ID), { writable: true }),
    meta(TOKEN_2022_PROGRAM_ID), meta(SystemProgram.programId),
  ];
}

const buy = (trader, coin, solIn, minTokensOut) => ix(swapKeys(trader, coin), disc("buy"), u64(solIn), u64(minTokensOut));
const sell = (trader, coin, tokensIn, minSolOut) => ix(swapKeys(trader, coin), disc("sell"), u64(tokensIn), u64(minSolOut));

/* ---------------- The pool's math, to quote before signing (same as src/math.rs) ---------------- */

const ceilDiv = (a, b) => (a + b - 1n) / b;
const feeOf = (amount, bps) => ceilDiv(amount * BigInt(bps), 10_000n);

function isqrtCeil(n) {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x * x === n ? x : x + 1n;
}

function leg(sol, tokens, solIn) {
  const left = ceilDiv(sol * tokens, sol + solIn);
  return [tokens - left, left];
}

function quoteBuy(r, solIn, bps) {
  const fee = feeOf(solIn, bps);
  let rest = solIn - fee;
  const after = { ...r };
  let out = 0n;
  if (!after.graduated) {
    const room = after.graduationSol - after.realSol;
    const onCurve = rest < room ? rest : room;
    if (onCurve > 0n) {
      const [o, left] = leg(after.virtualSol + after.realSol, after.tokens, onCurve);
      out += o; after.tokens = left; after.realSol += onCurve; rest -= onCurve;
    }
    if (after.realSol === after.graduationSol) {
      after.tokens -= after.tokens * after.virtualSol / (after.virtualSol + after.realSol);
      after.graduated = true;
    }
  }
  if (after.graduated && rest > 0n) {
    const [o, left] = leg(after.realSol, after.tokens, rest);
    out += o; after.tokens = left; after.realSol += rest;
  }
  return { fee, tokensOut: out, after };
}

function quoteSell(r, tokensIn, bps) {
  const offset = r.graduated ? 0n : r.virtualSol;
  const x = offset + r.realSol;
  const newX = ceilDiv(x * r.tokens, r.tokens + tokensIn);
  const gross = x - newX;
  const fee = feeOf(gross, bps);
  return { fee, solOut: gross - fee };
}

const withSlippage = (amount) => amount * (10_000n - SLIPPAGE_BPS) / 10_000n;

/* ---------------- Reading state ---------------- */

const n64 = (data, at) => data.readBigUInt64LE(at);

/** The pool account: 8 bytes of discriminator, then the fields in `state.rs` order. */
async function readPool(connection, coin) {
  const d = (await connection.getAccountInfo(coin.pool)).data;
  return {
    virtualSol: n64(d, 168), realSol: n64(d, 176), tokens: n64(d, 184), graduationSol: n64(d, 192),
    burned: n64(d, 208), creatorFees: n64(d, 216), treasuryFees: n64(d, 224), volume: n64(d, 248),
    feeBps: d.readUInt16LE(272), graduated: d[276] === 1,
  };
}

async function tokensOf(connection, owner, mint) {
  const account = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  const info = await connection.getAccountInfo(account);
  return info ? info.data.readBigUInt64LE(64) : 0n;
}

/* ---------------- Running it ---------------- */

const fmtSol = (lamports) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);
const fmtTokens = (units) => (Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
const explorer = (what, id) => `https://explorer.solana.com/${what}/${id}?cluster=devnet`;

async function run(connection, payer, ixs, signers, label) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ixs);
  if (!SEND) {
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(payer, ...signers);
    const sim = await connection.simulateTransaction(tx);
    console.log(`${label}: simulated, ${sim.value.err ? `FAILED ${JSON.stringify(sim.value.err)}` : "ok"},`
      + ` ${sim.value.unitsConsumed} compute units`);
    if (sim.value.err) console.log(sim.value.logs.join("\n"));
    return null;
  }
  const signature = await sendAndConfirmTransaction(connection, tx, [payer, ...signers], { commitment: "confirmed" });
  console.log(`${label}: ${explorer("tx", signature)}`);
  return signature;
}

const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8"))));
const me = wallet.publicKey;
console.log(`wallet ${me.toBase58()}, ${fmtSol(BigInt(await connection.getBalance(me)))} SOL, ${SEND ? "SENDING" : "dry run"}`);
const record = { cluster: "devnet", program: PROGRAM.toBase58(), signatures: {} };

// 1. The config, once. On devnet the wallet is admin, launcher and treasury.
if (!(await connection.getAccountInfo(configAddress))) {
  const args = { admin: me, launcher: me, treasury: me, launchFee: 0n, minFeeBps: 100, treasuryShareBps: 5000, launchesOpen: false };
  record.signatures.config = await run(connection, wallet, [initConfig(me, args)], [], "config");
  if (!SEND) {
    console.log("The launch needs the config; run with SEND=1 to go on.");
    process.exit(0);
  }
}
record.config = configAddress.toBase58();

// 2. The launch, with the creator's first buy in the same transaction.
const mint = Keypair.generate();
const coin = coinAddresses(mint.publicKey);
const opening = {
  virtualSol: VIRTUAL_SOL, realSol: 0n, tokens: SUPPLY,
  graduationSol: isqrtCeil(VIRTUAL_SOL * GRADUATION_MCAP) - VIRTUAL_SOL, graduated: false,
};
const first = quoteBuy(opening, FIRST_BUY, FEE_BPS);
const launchIxs = [
  launch({
    creator: me, coin, treasury: me, name: process.env.COIN_NAME ?? "Pool Test", symbol: process.env.COIN_SYMBOL ?? "POOL",
    uri: process.env.COIN_URI ?? "", maxLaunchFee: 0n,
  }),
  createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(mint.publicKey, me, false, TOKEN_2022_PROGRAM_ID),
    me, mint.publicKey, TOKEN_2022_PROGRAM_ID),
  buy(me, coin, FIRST_BUY, withSlippage(first.tokensOut)),
];
record.signatures.launch = await run(connection, wallet, launchIxs, [mint], "launch + first buy");
if (!SEND) process.exit(0);
Object.assign(record, Object.fromEntries(Object.entries(coin).map(([k, v]) => [k, v.toBase58()])));

// 3. Sell a quarter back, then buy again.
let pool = await readPool(connection, coin);
const held = await tokensOf(connection, me, mint.publicKey);
const quarter = held / 4n;
const sold = quoteSell({ ...pool }, quarter, pool.feeBps);
record.signatures.sell = await run(connection, wallet, [sell(me, coin, quarter, withSlippage(sold.solOut))], [], "sell a quarter");
pool = await readPool(connection, coin);
const second = quoteBuy({ ...pool }, SECOND_BUY, pool.feeBps);
record.signatures.buy = await run(connection, wallet, [buy(me, coin, SECOND_BUY, withSlippage(second.tokensOut))], [], "second buy");

// 4. What the chain says now.
pool = await readPool(connection, coin);
const summary = {
  tokensHeld: fmtTokens(await tokensOf(connection, me, mint.publicKey)),
  realSol: fmtSol(pool.realSol),
  tokenReserve: fmtTokens(pool.tokens),
  feesOwed: { creator: fmtSol(pool.creatorFees), treasury: fmtSol(pool.treasuryFees) },
  volumeSol: fmtSol(pool.volume),
  graduated: pool.graduated,
};
console.log(summary);
console.log(`coin: ${explorer("address", mint.publicKey.toBase58())}`);
record.summary = summary;
writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
console.log(`written to ${OUT}`);
