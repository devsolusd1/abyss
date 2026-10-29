// Checks the chain layer against devnet by SIMULATION ONLY: nothing is signed or sent. It loads
// the built bundle (../vendor/chain.js), the very file the site ships. The trades go on a coin that trades (no opening
// batch, or one that is over, and not graduated); the opening batch's calls go on the first devnet coin in each state
// (for a batch that is over, a settled one, or a refunded one only when no settled coin fits) and on the first seat
// waiting in a batch that is over. A state no coin is in is said to be skipped, as is a call on a coin whose window
// moved on past that state by the time of the call. The batch's offline checks are check-opening.mjs.
//
//   npm run check
//   OWNER=<funded devnet address> npm run check

import { createRequire } from "node:module";
import { Connection } from "@solana/web3.js";

const require = createRequire(import.meta.url);
const Chain = require("../vendor/chain.js");
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM = process.env.PROGRAM ?? "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK";
Chain.setNet({ cluster: "devnet", rpcUrl: RPC, program: PROGRAM });
const conn = new Connection(RPC, "confirmed");
const OWNER = process.env.OWNER ?? "7f2MiAuyJ1Aaiheo9ctLgJmzGDWoDceyHEEuVB2mhPAA";

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const skip = (text) => console.log(`  skip ${text}`);

const config = await Chain.readConfig();
line(!!config, `config: admin ${config && Chain.short(config.admin)}, launches ${config?.launchesOpen ? "open" : "team only"}`);

const pools = await Chain.listPools();
line(pools.length > 0, `${pools.length} pool(s) on the program`);
// a coin that takes buys and sells now: a batch still open takes none, a graduated coin is another curve
const trades = (p) => !p.graduated && (!p.opening || p.opening.state === "settled" || p.opening.state === "refund");
const pool = pools.find(trades);
if (!pool) { line(false, "no coin on devnet that trades now (every one is graduated or in its opening batch)"); process.exit(1); }
console.log(`         ${pool.name} (${pool.symbol})  price ${pool.price.toExponential(4)} SOL  market cap ${pool.marketCap.toFixed(3)} SOL  `
  + `to graduation ${(pool.progress * 100).toFixed(2)}%  fee ${pool.feeBps / 100}%${pool.opening ? `  batch ${pool.opening.state}` : ""}`);

// the history of the busiest coin, read at the public node's pace (see readHistory)
const busiest = [...pools].sort((a, b) => (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0))[0];
const started = Date.now();
const read = await Chain.readHistory(busiest.mint);
const events = read.events;
const tradeEvents = events.filter((e) => e.kind === "trade");
line(read.complete && !read.error && (!read.whole || events.some((e) => e.kind === "launch")) && tradeEvents.length >= 3,
  `history of ${busiest.name}: ${read.have} of ${read.total} transactions, ${events.length} events, ${tradeEvents.length} trades `
  + `in ${((Date.now() - started) / 1000).toFixed(1)} s${read.error ? ` (${read.error})` : ""}`);
const points = Chain.pricePoints(events, busiest);
line(points.length === tradeEvents.length && points.every((p) => p.price > 0), `price points: ${points.map((p) => p.price.toExponential(3)).join(", ")}`);

const buy = await Chain.buildBuy({ pool, owner: OWNER, sol: 0.01 });
const buySim = await Chain.simulate(buy, OWNER);
line(buySim.ok, `buy 0.01 SOL -> ${Chain.tokens(buy.quote.tokensOut).toFixed(2)} tokens: ${buySim.ok ? "simulated cleanly" : buySim.error} (${buySim.units} units)`);

const wallet = await Chain.readWallet(OWNER, pool.mint);
if (wallet.tokens > 0n) {
  const sell = await Chain.buildSell({ pool, owner: OWNER, tokens: wallet.tokens / 10n });
  const sellSim = await Chain.simulate(sell, OWNER);
  line(sellSim.ok, `sell a tenth -> ${Chain.sol(sell.quote.solOut).toFixed(6)} SOL: ${sellSim.ok ? "simulated cleanly" : sellSim.error} (${sellSim.units} units)`);
}

// a buy of more SOL than the wallet has: the System Program's refusal (code 1) comes out in words
const tooMuch = await Chain.simulate(await Chain.buildBuy({ pool, owner: OWNER, sol: Chain.sol(wallet.sol) + 1 }), OWNER);
line(!tooMuch.ok && tooMuch.error === "Not enough SOL", `a buy of 1 SOL more than the wallet holds is refused: ${tooMuch.ok ? "it was NOT" : `"${tooMuch.error}"`}`);

// fee claims, on the first pool that owes something: the creator's signed by its creator, the platform's sent by OWNER
const owing = pools.find((p) => p.creatorFees > 0n) ?? null;
if (owing) {
  const claim = await Chain.buildClaim({ pool: owing, owner: owing.creator });
  const claimSim = await Chain.simulate(claim, owing.creator);
  line(claimSim.ok, `creator claims ${Chain.sol(claim.amount)} SOL from ${owing.name}: ${claimSim.ok ? "simulated cleanly" : claimSim.error} (${claimSim.units} units)`);
  const wrong = await Chain.simulate(await Chain.buildClaim({ pool: owing, owner: "11111111111111111111111111111112" }), OWNER);
  line(!wrong.ok, `someone else claiming the creator's fees is refused: ${wrong.error}`);
}
const owingT = pools.find((p) => p.treasuryFees > 0n) ?? null;
if (owingT) {
  const claimT = await Chain.buildClaim({ pool: owingT, owner: OWNER, creator: false });
  const claimTSim = await Chain.simulate(claimT, OWNER);
  line(claimTSim.ok, `platform's ${Chain.sol(claimT.amount)} SOL sent to the treasury: ${claimTSim.ok ? "simulated cleanly" : claimTSim.error} (${claimTSim.units} units)`);
}

const launch = await Chain.buildLaunch({ creator: OWNER, name: "Check", symbol: "CHK", uri: "", firstBuySol: 0.05 });
const launchSim = await Chain.simulate(launch, OWNER);
line(launchSim.ok, `launch with a first buy: ${launchSim.ok ? "simulated cleanly" : launchSim.error} (${launchSim.units} units)`);
if (!launchSim.ok) console.log(launchSim.logs.slice(-8).join("\n"));

/* ---------- the opening batch: commit, withdraw, settle and a seat's claim, on coins in each state devnet has ---------- */

// every seat on the program (a Seat is 8 + 32 + 32 + 8 + 1 bytes: owner, pool, sol, bump), and the chain's own clock
const seats = (await conn.getProgramAccounts(new Chain.PublicKey(PROGRAM), { filters: [{ dataSize: 81 }] })).map((a) => {
  const d = a.account.data;
  return { owner: new Chain.PublicKey(d.subarray(8, 40)), pool: new Chain.PublicKey(d.subarray(40, 72)).toBase58(), sol: d.readBigUInt64LE(72) };
});
// the chain's clock as this machine's plus the gap between them, asked again before each group of calls that depends
// on the window. The calls before one can take many seconds on the public node (it answers 429 and is asked again), so
// each such call looks at its coin's phase again just before it is simulated and once it is back (simulateAt)
let OFF = 0, measured = false;
async function measure() {
  try {
    const t0 = Date.now(), ts = await Chain.chainClock(), t1 = Date.now();
    if (!measured || t1 - t0 < 3000) { OFF = ts - (t0 + t1) / 2000; measured = true; }   // a slow answer says little about the time
  } catch (err) { if (!measured) throw err; }
}
await measure();
const chainNow = () => Date.now() / 1000 + OFF;
// a few seconds clear of each edge of the window: within them a coin is at its "edge", and nothing is tried on it
const LOCK = Chain.OPENING.lockSecs, CLEAR = 8;
function phase(p) {
  const o = p.opening;
  if (!o) return "none";
  if (o.state !== "open") return o.state;
  const t = o.opensAt - chainNow();
  return t > LOCK + CLEAR ? "open" : t < LOCK - CLEAR && t > CLEAR ? "last" : t < -CLEAR ? "due" : "edge";
}
const seatsOf = (p) => seats.filter((s) => s.pool === p.address.toBase58());
const said = (name) => Chain.POOL_ERRORS.find((e) => e[0] === name)[1];
const NO_SEAT = Chain.explain({ err: { InstructionError: [1, { Custom: 3012 }] } });   // Anchor's AccountNotInitialized
const SETTLE_CLAIM_UNITS = 140_000;                     // the settle's limit with a seat's claim in it (buildSettle)
console.log(`         ${seats.length} seat(s) on the program; the chain's clock: ${new Date(chainNow() * 1000).toISOString()}`);

/**
 * Simulates. With `at` ([pool, phase]), a call that depends on the window: it is skipped when the coin is no longer in
 * that phase just before it, and an answer other than the one wanted is skipped, not failed, when the coin left that
 * phase while it was being simulated (it says something only of a phase the coin was in for the whole call).
 */
async function simulateAt(label, built, payer, at) {
  if (at && phase(at[0]) !== at[1]) { skip(`${label}: ${named(at[0])} is no longer ${at[1]} (${phase(at[0])} now)`); return null; }
  const sim = await Chain.simulate(built, payer);
  return { sim, moved: !!at && phase(at[0]) !== at[1] };
}
async function passes(label, built, payer = OWNER, at) {
  const r = await simulateAt(label, built, payer, at);
  if (!r) return null;
  const { sim, moved } = r;
  if (!sim.ok && moved) { skip(`${label}: "${sim.error}", with ${named(at[0])} past ${at[1]} by the end of it`); return null; }
  line(sim.ok, `${label}: ${sim.ok ? "simulated cleanly" : sim.error} (${sim.units} units)`);
  if (!sim.ok) console.log(sim.logs.slice(-6).join("\n"));
  return sim;
}
async function refused(label, built, words, payer = OWNER, at) {
  const r = await simulateAt(label, built, payer, at);
  if (!r) return;
  const { sim, moved } = r;
  if (moved && (sim.ok || sim.error !== words)) { skip(`${label}: ${sim.ok ? "it went through" : `"${sim.error}"`}, with ${named(at[0])} past ${at[1]} by the end of it`); return; }
  line(!sim.ok && sim.error === words, `${label}: refused${sim.ok ? " (it was NOT)" : `, "${sim.error}"`}${!sim.ok && sim.error !== words ? `, not "${words}"` : ""}`);
}
const named = (p) => `${p.name || Chain.short(p.mint)} (batch ${p.opening ? p.opening.state : "none"})`;
const first = (ph, extra = () => true) => pools.find((p) => phase(p) === ph && extra(p)) ?? null;

// a coin that opened at once: no batch to commit to or settle
const none = first("none");
if (none) {
  await refused(`commit on ${named(none)}`, await Chain.buildCommit({ pool: none, owner: OWNER, sol: 0.001 }), said("NoOpening"));
  await refused(`settle on ${named(none)}`, await Chain.buildSettle({ pool: none }), said("NoOpening"));
} else skip("no coin without a batch");

// a batch that is over: a second settle, a late commit, and OWNER's withdrawal and claim of a seat it does not have
const over = first("settled", (p) => !seatsOf(p).some((s) => s.owner.equals(new Chain.PublicKey(OWNER)))) ?? first("refund", (p) => !seatsOf(p).some((s) => s.owner.equals(new Chain.PublicKey(OWNER))));
if (over) {
  await refused(`a second settle on ${named(over)}`, await Chain.buildSettle({ pool: over }), said("NoOpening"));
  await refused(`a second settle with a claim on ${named(over)}`, await Chain.buildSettle({ pool: over, claimFor: OWNER }), said("NoOpening"));
  await refused(`a commit after the settle on ${named(over)}`, await Chain.buildCommit({ pool: over, owner: OWNER, sol: 0.001 }), said("NoOpening"));
  await refused(`a withdrawal with no seat on ${named(over)}`, await Chain.buildWithdraw({ pool: over, owner: OWNER, sol: 0.001 }), NO_SEAT);
  await refused(`a claim with no seat on ${named(over)}`, await Chain.buildSeatClaim({ pool: over, owner: OWNER }), NO_SEAT);
} else skip("no batch that is over without a seat of OWNER's");

// a seat still waiting in a batch that is over: its owner's claim, and its withdrawal refused
const waiting = pools.filter((p) => phase(p) === "settled" || phase(p) === "refund").flatMap((p) => seatsOf(p).map((s) => ({ p, s })))[0] ?? null;
if (waiting) {
  const { p, s } = waiting;
  await passes(`${Chain.short(s.owner)} claims its seat of ${Chain.sol(s.sol)} SOL on ${named(p)}`, await Chain.buildSeatClaim({ pool: p, owner: s.owner }), s.owner);
  await refused(`its withdrawal after the settle`, await Chain.buildWithdraw({ pool: p, owner: s.owner, sol: s.sol }), said("NoOpening"), s.owner);
} else skip("no seat waiting to be claimed in a batch that is over");

// a batch taking SOL: a commit goes in, a buy and a settle do not; a seat's SOL comes back out
await measure();
const open = first("open");
if (open) {
  const at = [open, "open"];
  await passes(`commit 0.001 SOL on ${named(open)}`, await Chain.buildCommit({ pool: open, owner: OWNER, sol: 0.001 }), OWNER, at);
  await refused(`a buy during the batch on ${named(open)}`, await Chain.buildBuy({ pool: open, owner: OWNER, sol: 0.01 }), said("NotOpenYet"));
  await refused(`a settle before the close on ${named(open)}`, await Chain.buildSettle({ pool: open }), said("OpeningNotOver"), OWNER, at);
  const s = seatsOf(open)[0];
  if (s) await passes(`${Chain.short(s.owner)} takes 0.001 SOL back`, await Chain.buildWithdraw({ pool: open, owner: s.owner, sol: s.sol < 1_000_000n ? s.sol : 1_000_000n }), s.owner, at);
  else skip("no seat in that batch to withdraw from");
} else skip("no batch taking SOL now");

// a batch in its last minute: no SOL in, a seat's SOL still out
await measure();
const last = first("last");
if (last) {
  const at = [last, "last"];
  await refused(`a commit in the last minute on ${named(last)}`, await Chain.buildCommit({ pool: last, owner: OWNER, sol: 0.001 }), said("OpeningLocked"), OWNER, at);
  const s = seatsOf(last)[0];
  if (s) await passes(`${Chain.short(s.owner)} takes 0.001 SOL back in the last minute`, await Chain.buildWithdraw({ pool: last, owner: s.owner, sol: s.sol < 1_000_000n ? s.sol : 1_000_000n }), s.owner, at);
} else skip("no batch in its last minute");

// a batch whose window is over and not settled: anyone settles; a seat's owner settles and claims at once, even on a pool
// read before the last SOL moved. Its token account is opened unless the batch, read again as the settle is built,
// is under the SOL it needs to buy (after the close its SOL only goes down)
const due = first("due");
if (due) {
  await passes(`settle ${named(due)}`, await Chain.buildSettle({ pool: due }));
  await refused(`a commit after the close on ${named(due)}`, await Chain.buildCommit({ pool: due, owner: OWNER, sol: 0.001 }), said("OpeningClosed"));
  const s = seatsOf(due)[0];
  if (s) {
    await refused(`a withdrawal after the close`, await Chain.buildWithdraw({ pool: due, owner: s.owner, sol: s.sol }), said("OpeningClosed"), s.owner);
    // its SOL now: the list may have been read before the close, with SOL still coming out
    const sol = ((await Chain.readPool(due.mint))?.opening ?? due.opening).sol, refunds = sol < Chain.OPENING.minBatch;
    const opensAccount = (built) => built.tx.instructions.some((i) => i.programId.equals(Chain.ATA_PROGRAM));
    const built = await Chain.buildSettle({ pool: due, claimFor: s.owner });
    line(opensAccount(built) === !refunds, `${Chain.sol(sol)} SOL in the batch: the seat's token account ${opensAccount(built) ? "opened" : "left out"} in the settle with its claim`);
    const sim = await passes(`${Chain.short(s.owner)} settles and claims at once`, built, s.owner);
    line(sim && sim.ok && sim.units <= SETTLE_CLAIM_UNITS, `within the ${SETTLE_CLAIM_UNITS.toLocaleString("en-US")} units it asks for (${sim && sim.units})`);
    const stale = { ...due, opening: { ...due.opening, sol: refunds ? Chain.OPENING.minBatch : 0n } };
    const fromStale = await Chain.buildSettle({ pool: stale, claimFor: s.owner });
    line(opensAccount(fromStale) === !refunds, `the same from a pool read with ${Chain.sol(stale.opening.sol)} SOL in the batch: ${opensAccount(fromStale) ? "opened" : "left out"}, as the chain has it`);
    await passes(`the same from that pool read`, fromStale, s.owner);
  } else skip("no seat in that batch to settle and claim with");
} else skip("no batch waiting to be settled");

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
