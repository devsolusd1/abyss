// Creates the pool program's config, once, right after the deploy: init_config, which the program takes only from its
// upgrade authority, so nobody else can get there first. Without SEND=1 it only simulates. With SEND=1 it sends, reads
// the config back and compares it with what was asked. A config already there is a stop, unless it is exactly the one
// asked (a send that landed after all): then it says so and exits with 0. Changes go through update_config, by the
// config's admin (the multisig's vault, after multisig.mjs handoff).
//
//   CLUSTER=devnet KEYPAIR=~/.config/solana/devnet.json PROGRAM=<id> node init-config.mjs
//   SEND=1 CLUSTER=mainnet KEYPAIR=<deploy wallet> PROGRAM=<id> LAUNCHER=<team wallet> TREASURY=<wallet> \
//     LAUNCH_FEE=<lamports> MIN_FEE_BPS=<n> TREASURY_SHARE_BPS=<n> node init-config.mjs
//   (on mainnet with RPC_URL exported first, read with read -rsp as MAINNET.md shows: never on the command line)
//
// KEYPAIR             the program's upgrade authority. It signs, and pays the config's rent (about 0.0013 SOL).
// ADMIN               KEYPAIR's address unless given: it changes the config later, and multisig.mjs handoff needs it to
//                     be KEYPAIR. On mainnet any other ADMIN is refused.
// LAUNCHER, TREASURY  the launcher may launch while launches are closed. The treasury takes the platform's part of the
//                     fees of every coin launched from then on (each pool keeps the one it was born with), and must be a
//                     plain wallet that holds its own rent. On devnet, KEYPAIR's address unless given. On mainnet both
//                     are required, and neither may be KEYPAIR: the deploy wallet is to hold nothing after the handoff.
// LAUNCH_FEE (lamports), MIN_FEE_BPS, TREASURY_SHARE_BPS
//                     on devnet, the devnet program's own config unless given (read from devnet only when one is
//                     missing). On mainnet all three are required: nothing goes there by default.
// LAUNCHES_OPEN       0 unless given: only the admin and the launcher launch. 1 opens launches to everyone.
// PRICE               the priority fee, in micro-lamports per compute unit: 0 on devnet; on mainnet, unless given, the
//                     75th percentile of what paying transactions paid for these accounts lately, kept between
//                     PRICE_FLOOR and PRICE_CAP (check-deploy.mjs recentPrice).
// RPC_URL             the node. Required on mainnet (a paid one); never printed. It must be of CLUSTER (its genesis hash).

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import {
  BPS, CONFIG_SIZE, DEVNET_PROGRAM, LOADER, MAX_FEE_BPS, MAX_LAUNCH_FEE, SYSTEM, addressOf, clusterError, clusterOf,
  configAddress, guardOutput, home, instructionMark, nodeFor, parseProgram, parseProgramdata, priceNote, readConfig,
  recentPrice, sol,
} from "./check-deploy.mjs";

guardOutput();
const env = process.env;
const cluster = clusterOf(env.CLUSTER ?? "devnet");
const SEND = env.SEND === "1";
const rpc = nodeFor(cluster, env, { paid: true });
const conn = new Connection(rpc.url, "confirmed");
const program = addressOf(env.PROGRAM, "PROGRAM");
if (!env.KEYPAIR) throw new Error("KEYPAIR is the program's upgrade authority, which signs init_config");
const keyPath = home(env.KEYPAIR);
let wallet;
try { wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")))); }
catch (err) { throw new Error(`KEYPAIR: no keypair could be read from ${keyPath} (${err.code ?? "not a keypair file"})`); }
const me = wallet.publicKey;
const given = (name) => env[name] !== undefined && env[name] !== "";

// On mainnet every value is said on purpose: a default there would be the deploy wallet, or devnet's numbers.
if (cluster === "mainnet") {
  const missing = ["LAUNCHER", "TREASURY", "LAUNCH_FEE", "MIN_FEE_BPS", "TREASURY_SHARE_BPS"].filter((n) => !given(n));
  if (missing.length) throw new Error(`on mainnet every value is given on purpose; missing: ${missing.join(", ")}`);
  for (const name of ["LAUNCHER", "TREASURY"]) {
    if (addressOf(env[name], name).equals(me)) {
      throw new Error(`${name} is KEYPAIR, the deploy wallet: after the handoff it would still ${name === "LAUNCHER" ? "launch while launches are closed" : "take the platform's part of every coin's fees"}. Give the team's wallet`);
    }
  }
}
// The node, before anything is read from it.
const wrongNode = await clusterError(conn, cluster);
if (wrongNode) throw new Error(`${wrongNode}. CLUSTER is ${cluster}: check RPC_URL`);

let refused = 0;
const refuse = (text) => { refused++; console.log(`  STOP ${text}`); };
const ok = (text) => console.log(`  ok   ${text}`);
const note = (text) => console.log(`       ${text}`);
const explorer = (what, id) => `https://explorer.solana.com/${what}/${id}${cluster === "devnet" ? "?cluster=devnet" : ""}`;

console.log(`init_config for ${program.toBase58()} on ${cluster}, through ${rpc.label}, ${SEND ? "SENDING" : "dry run: simulation only"}`);
console.log(`  signer and payer ${me.toBase58()}`);

// 1. The numbers: given, or on devnet the devnet program's own (the ones the site was built and tested with), read only
// when one is missing. On mainnet all are given (above), so devnet is never asked.
const needDevnet = ["LAUNCH_FEE", "MIN_FEE_BPS", "TREASURY_SHARE_BPS"].some((n) => !given(n));
const base = needDevnet ? await readConfig(conn, new PublicKey(DEVNET_PROGRAM)) : null;
const pick = (name, read, fallback, what) => {
  if (given(name)) return read(env[name]);
  if (fallback === undefined) throw new Error(`${name} is not given, and the devnet program's config could not be read for ${what}`);
  return fallback;
};
const whole = (name, max) => (v) => {
  if (!/^\d+$/.test(String(v).trim())) throw new Error(`${name} must be a whole number, not "${v}"`);
  const n = BigInt(String(v).trim());
  if (n > BigInt(max)) throw new Error(`${name} is ${n}: the program takes at most ${max}`);
  return n;
};
const fromDevnet = base && !base.bad ? base : {};
// On mainnet LAUNCHER and TREASURY are given (above); KEYPAIR's address is a devnet default only.
const args = {
  admin: env.ADMIN ? addressOf(env.ADMIN, "ADMIN") : me,
  launcher: env.LAUNCHER ? addressOf(env.LAUNCHER, "LAUNCHER") : me,
  treasury: env.TREASURY ? addressOf(env.TREASURY, "TREASURY") : me,
  launchFee: pick("LAUNCH_FEE", whole("LAUNCH_FEE", MAX_LAUNCH_FEE), fromDevnet.launchFee, "launch_fee"),
  minFeeBps: Number(pick("MIN_FEE_BPS", whole("MIN_FEE_BPS", MAX_FEE_BPS), fromDevnet.minFeeBps, "min_fee_bps")),
  treasuryShareBps: Number(pick("TREASURY_SHARE_BPS", whole("TREASURY_SHARE_BPS", BPS), fromDevnet.treasuryShareBps, "treasury_share_bps")),
  launchesOpen: (() => {
    const v = String(env.LAUNCHES_OPEN ?? "0").trim();
    if (v !== "0" && v !== "1") throw new Error(`LAUNCHES_OPEN must be 0 or 1, not "${v}"`);
    return v === "1";
  })(),
};
const from = (name) => (given(name) ? "given" : `devnet ${DEVNET_PROGRAM.slice(0, 6)}…`);
console.log("\nthe config it makes");
note(`admin              ${args.admin.toBase58()}${args.admin.equals(me) ? " (KEYPAIR)" : ""}`);
note(`launcher           ${args.launcher.toBase58()}${args.launcher.equals(me) ? " (KEYPAIR)" : ""}`);
note(`treasury           ${args.treasury.toBase58()}${args.treasury.equals(me) ? " (KEYPAIR)" : ""}`);
note(`launch_fee         ${args.launchFee} lamports (${sol(args.launchFee)} SOL; ${from("LAUNCH_FEE")})`);
note(`min_fee_bps        ${args.minFeeBps} (${from("MIN_FEE_BPS")})`);
note(`treasury_share_bps ${args.treasuryShareBps} (${from("TREASURY_SHARE_BPS")})`);
note(`launches_open      ${args.launchesOpen}${args.launchesOpen ? " (anyone launches)" : " (only the admin and the launcher launch)"}`);

// The config on chain against what is asked, field by field.
const differences = (c) => [
  ["admin", args.admin.toBase58(), c.admin.toBase58()], ["launcher", args.launcher.toBase58(), c.launcher.toBase58()],
  ["treasury", args.treasury.toBase58(), c.treasury.toBase58()], ["launch_fee", args.launchFee, c.launchFee],
  ["min_fee_bps", args.minFeeBps, c.minFeeBps], ["treasury_share_bps", args.treasuryShareBps, c.treasuryShareBps],
  ["launches_open", args.launchesOpen, c.launchesOpen], ["bump is the address's", true, c.bumpOk],
].filter(([, asked, have]) => String(asked) !== String(have));

// 2. What the chain must hold for init_config to pass, each checked here so a stop says why. A config already there
// and exactly as asked is a send that landed: nothing to do.
console.log("\nbefore it");
const [config] = configAddress(program);
const programdata = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];
const existing = await readConfig(conn, program);
if (existing && !existing.bad && !differences(existing).length) {
  console.log(`  ok   the config at ${config.toBase58()} is there already, exactly as asked`);
  console.log(`\nalready done: nothing to send. Next: CLUSTER=${cluster} PROGRAM=${program.toBase58()} BUILD=… node check-deploy.mjs`);
  process.exit(0);
}
// A config to make on mainnet: its admin is KEYPAIR, since init_config runs once and the handoff takes the admin from
// KEYPAIR only; any other would leave the config with a key nobody may hold, and the handoff stuck, short of an upgrade.
// (ADMIN may still name the vault to see a config made and handed over already, above.)
if (cluster === "mainnet" && !args.admin.equals(me)) {
  refuse("on mainnet the admin is KEYPAIR, the deploy wallet, until multisig.mjs handoff gives it to the vault: leave ADMIN out");
}
const info = await conn.getAccountInfo(program, "confirmed");
if (!info) refuse(`there is no program at ${program.toBase58()} on ${cluster}: deploy it first (deploy.sh)`);
else if (!info.owner.equals(LOADER) || !info.executable || !parseProgram(info.data)?.programdata.equals(programdata)) {
  refuse(`${program.toBase58()} is not a program of the upgradeable loader`);
} else {
  const pdInfo = await conn.getAccountInfo(programdata, "confirmed");
  const pd = pdInfo ? parseProgramdata(pdInfo.data) : null;
  if (!pd?.authority) refuse("the program has no upgrade authority, so nobody can create its config");
  else if (!pd.authority.equals(me)) refuse(`the upgrade authority is ${pd.authority.toBase58()}, not KEYPAIR: only it can create the config`);
  else ok("KEYPAIR is the program's upgrade authority");
}
if (existing) {
  refuse(`the config exists already at ${config.toBase58()}${existing.bad ? ` (${existing.bad})` : `, not as asked (${differences(existing).map(([field, , have]) => `${field} is ${have}`).join(", ")})`}: init_config runs once; a change is update_config, by the admin`);
} else ok(`no config yet at ${config.toBase58()}`);
const [rent0, configRent, balance] = await Promise.all([
  conn.getMinimumBalanceForRentExemption(0), conn.getMinimumBalanceForRentExemption(CONFIG_SIZE), conn.getBalance(me, "confirmed"),
]);
const treasury = await conn.getAccountInfo(args.treasury, "confirmed");
if (!treasury || !treasury.owner.equals(SYSTEM) || treasury.data.length !== 0 || treasury.lamports < rent0) {
  refuse(`the treasury ${args.treasury.toBase58()} must be a plain wallet holding at least its rent, ${sol(rent0)} SOL (it holds ${treasury ? sol(treasury.lamports) : 0}${treasury && !treasury.owner.equals(SYSTEM) ? `, and belongs to ${treasury.owner.toBase58()}` : ""})`);
} else ok(`the treasury is a plain wallet with its rent (${sol(treasury.lamports)} SOL)`);

// 3. The instruction (lib.rs InitConfig): the upgrade authority, the config, the treasury, the program, its program
// data, the system program; then ConfigArgs in Borsh.
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const meta = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const initConfig = new TransactionInstruction({
  programId: program,
  keys: [meta(me, true, true), meta(config, false, true), meta(args.treasury, false, true), meta(program), meta(programdata), meta(SystemProgram.programId)],
  data: Buffer.concat([
    instructionMark("init_config"), args.admin.toBuffer(), args.launcher.toBuffer(), args.treasury.toBuffer(),
    u64(args.launchFee), u16(args.minFeeBps), u16(args.treasuryShareBps), Buffer.from([args.launchesOpen ? 1 : 0]),
  ]),
});

let price = env.PRICE;
if (price === undefined || price === "") {
  if (cluster === "devnet") price = 0;
  else {
    const r = await recentPrice(conn, [me, config, args.treasury]);
    price = r.price;
    note(`priority fee ${price} micro-lamports per compute unit: ${priceNote(r)}`);
  }
}
price = Number(price);
if (!Number.isInteger(price) || price < 0) throw new Error("PRICE must be a whole number of micro-lamports per compute unit");

const build = async (units) => {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: me, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), initConfig],
  }).compileToLegacyMessage();
  return { tx: new VersionedTransaction(message), lastValidBlockHeight };
};

// 4. The simulation, unsigned: the node checks everything but the signature.
const { tx: draft } = await build(200_000);
const sim = (await conn.simulateTransaction(draft, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" })).value;
const fee = 5_000 + Math.ceil((price * 200_000) / 1e6);
console.log("\nsimulation");
if (sim.err) {
  console.log(`  FAIL ${JSON.stringify(sim.err)}`);
  for (const l of (sim.logs ?? []).slice(-8)) note(l);
  if (!refused) refused++;
} else ok(`init_config passes: ${sim.unitsConsumed} compute units`);
note(`costs: the config's rent ${sol(configRent)} SOL, a fee of at most ${sol(fee)} SOL; KEYPAIR holds ${sol(balance)} SOL`);
if (balance < configRent + fee) refuse(`KEYPAIR is short: it needs ${sol(configRent + fee)} SOL`);

if (refused) {
  console.log(`\n${SEND ? "nothing sent" : "dry run"}: ${refused} reason(s) above why init_config would not pass`);
  process.exit(1);
}
if (!SEND) {
  console.log("\nready. Nothing was sent; SEND=1 sends it, then reads the config back.");
  process.exit(0);
}

// 5. Sent, then read back. The node gives up passing a transaction on after a few seconds, so the same signed bytes go
// again every 2 s until they land or their blockhash runs out (as multisig.mjs does). Sent twice, it still lands once.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const units = Math.ceil(sim.unitsConsumed * 1.2) + 1_000;
const { tx, lastValidBlockHeight } = await build(units);
tx.sign([wallet]);
const raw = tx.serialize();
const signature = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
console.log(`\nsent: ${explorer("tx", signature)}`);
for (;;) {
  await sleep(2_000);
  const status = (await conn.getSignatureStatuses([signature])).value[0];
  if (status?.err) throw new Error(`init_config failed on chain: ${JSON.stringify(status.err)}`);
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
  if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
    // A last look in the node's history: it may have landed between two looks.
    const late = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (late?.err) throw new Error(`init_config failed on chain: ${JSON.stringify(late.err)}`);
    if (late) break;
    console.log("\nit expired without landing: nothing changed. Run the same command again.");
    process.exit(1);
  }
  await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
}

let made = null;
for (let i = 0; i < 6 && !made; i++) {
  made = await readConfig(conn, program);
  if (!made) await sleep(1500);
}
if (!made || made.bad) throw new Error(`the config is not readable after the send${made?.bad ? `: ${made.bad}` : ""}`);
const wrong = differences(made);
console.log("\nthe config on chain");
for (const [field, asked, have] of wrong) console.log(`  FAIL ${field} ${have} (asked ${asked})`);
console.log(wrong.length ? `\n${wrong.length} field(s) differ from what was asked` : `  ok   every field as asked\n\nNext: CLUSTER=${cluster} PROGRAM=${program.toBase58()} BUILD=… node check-deploy.mjs`);
process.exit(wrong.length ? 1 : 0);
