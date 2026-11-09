// Checks the site's math against the program's own: programs/pool/src/math.rs, compiled on this machine with rustc (in
// WSL on Windows) into a small harness that answers trades read from stdin, against the three JavaScript copies the site
// runs (chain/src/index.mjs, its bundle vendor/chain.js, and assets/pool-math.js), to the lamport and the base unit:
//   1. random pools, under the line and over it, from before the pool's part of the fee (0), and graduated under the
//      first rules (burned > 0, some with stray bytes where the share is now)
//   2. walks that cross the line both ways, ending in a whole-bag sell
//   3. pools graduated under the first rules, walked under the new code, against the first rules' own math
//   4. opening batches: quoteSeat against the settle's one buy, shared by SOL as claim_seat shares it
//   5. the graduation line itself: graduation_sol, and buys of exactly it (or a lamport less) into pools just launched,
//      which land on the market cap's line or a hair under it
// Pool::reserves and Pool::owe need Anchor, so the harness holds copies of them; the check reads state.rs and lib.rs to
// see they still read as those copies. The harness builds with overflow checks on, as the program's release profile
// does: an arithmetic panic counts as a mismatch, since on chain it fails the transaction.
//   node check-math-rs.mjs        (rustc in ~/.cargo/bin or on the PATH, inside WSL on Windows; the harness builds
//                                  into ~/dex-target/check-math-rs)

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const site = fileURLToPath(new URL("..", import.meta.url));
const src = fileURLToPath(new URL("../../programs/pool/src/", import.meta.url));
globalThis.window = globalThis;
new Function(readFileSync(site + "assets/pool-math.js", "utf8"))();
const PM = window.PoolMath;
const C = await import("./src/index.mjs");
const B = require("../vendor/chain.js");
const STATE = readFileSync(src + "state.rs", "utf8"), LIB = readFileSync(src + "lib.rs", "utf8");

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const stop = (why) => { console.log(`  FAIL cannot run: ${why}`); process.exit(2); };

/* ---------- the harness: math.rs as it is in the repository, with copies of Pool::reserves and Pool::owe ---------- */
const WIN = process.platform === "win32";
// the path rustc reads math.rs from: WSL sees C:\ as /mnt/c
const mathRs = WIN ? (src + "math.rs").replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_, d) => `/mnt/${d.toLowerCase()}/`) : src + "math.rs";
const HARNESS = `
#[path = "${mathRs}"]
#[allow(dead_code)]
mod math;
use math::*;
use std::io::{self, BufRead, Write};

// Pool::reserves, as state.rs has it
fn reserves(v: u64, real: u64, tokens: u64, mcap: u64, graduated: u8, burned: u64, share: u16) -> Reserves {
    let first_version = burned > 0;
    Reserves {
        virtual_sol: if first_version { 0 } else { v },
        real_sol: real,
        tokens,
        graduation_mcap: if first_version { 0 } else { mcap },
        graduated: first_version || graduated != 0,
        pool_share_bps: if first_version { 0 } else { share },
    }
}

// Pool::owe's split of what a trade owes: (treasury, creator)
fn owe(owed: u64, tshare: u16) -> (u64, u64) {
    let treasury = (owed as u128 * tshare as u128 / BPS as u128) as u64;
    (treasury, owed - treasury)
}

// G v mcap | B or S: v real tokens mcap graduated burned share amount fee_bps tshare
fn run(f: &[&str]) -> String {
    let n = |i: usize| f[i].parse::<u64>().unwrap();
    match f[0] {
        "G" => graduation_sol(n(1), n(2)).map_or("none".to_string(), |g| g.to_string()),
        "B" | "S" => {
            let r = reserves(n(1), n(2), n(3), n(4), n(5) as u8, n(6), n(7) as u16);
            let (amount, fee_bps, tshare) = (n(8), n(9) as u16, n(10) as u16);
            let done = if f[0] == "B" {
                buy(r, amount, fee_bps).map(|b| (b.fee, b.to_pool, b.tokens_out, b.graduates, b.after, b.owed()))
            } else {
                sell(r, amount, fee_bps).map(|s| (s.fee, s.to_pool, s.sol_out, false, s.after, s.owed()))
            };
            match done {
                Ok((fee, to_pool, out, graduates, after, owed)) => {
                    let (t, c) = owe(owed, tshare);
                    format!("ok {} {} {} {} {} {} {} {} {}", fee, to_pool, out, graduates as u8, after.real_sol, after.tokens, after.graduated as u8, t, c)
                }
                Err(e) => format!("err {:?}", e),
            }
        }
        _ => "bad".to_string(),
    }
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let stdin = io::stdin();
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.is_empty() {
            continue;
        }
        let answer = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&f))).unwrap_or_else(|_| "panic".to_string());
        writeln!(out, "{}", answer).unwrap();
    }
}
`;
const BIN = "$HOME/dex-target/check-math-rs/harness";
const sh = (script, input) => {
  const r = WIN ? spawnSync("wsl", ["-e", "bash", "-c", script], { input, encoding: "utf8", maxBuffer: 1 << 28 })
    : spawnSync("bash", ["-c", script], { input, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.error) stop(`${WIN ? "wsl" : "bash"}: ${r.error.message}`);
  return r;
};
{
  const built = sh(`export PATH="$HOME/.cargo/bin:$PATH"; command -v rustc >/dev/null || { echo "no rustc" >&2; exit 3; }
mkdir -p "$(dirname ${BIN})" && rustc --edition 2021 -O -C overflow-checks=on --crate-name harness -o ${BIN} -`, HARNESS);
  if (built.status !== 0) stop(`the harness did not build:\n${built.stderr}`);
}

// the copies above, against the source they copy
{
  const has = (text, ...parts) => parts.every((p) => text.includes(p));
  line(has(STATE, "let first_version = self.burned > 0;", "virtual_sol: if first_version { 0 } else { self.virtual_sol },",
    "real_sol: self.real_sol,", "tokens: self.token_reserve,", "graduation_mcap: if first_version { 0 } else { self.graduation_mcap },",
    "graduated: first_version || self.graduated != 0,", "pool_share_bps: if first_version { 0 } else { self.pool_share_bps },",
    "let treasury = (owed as u128 * self.treasury_share_bps as u128 / crate::math::BPS as u128) as u64;",
    "self.creator_fees.checked_add(owed - treasury)")
    && (LIB.match(/p\.owe\(outcome\.owed\(\)\)\?;/g) || []).length === 2 && LIB.includes("p.owe(o.owed())?;"),
    "the harness's Pool::reserves and Pool::owe read as state.rs has them, and lib.rs owes the fee less the pool's part in buy, sell and settle");
}

/* ---------- the cases ---------- */
let seed = 987654321n;
const rnd = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return Number(seed >> 11n) / 2 ** 53; };
const big = (n) => BigInt(Math.floor(n));
const SOL = 1_000_000_000n, S = C.SUPPLY, U64 = (1n << 64n) - 1n;
const ceilDiv = (a, b) => (a + b - 1n) / b;
const feeOf = (a, bps) => ceilDiv(a * BigInt(bps), 10_000n);

// the first rules (math.rs tests::first): the curve stopped at the line, dropped the virtual SOL, burned, and went on
// with the real reserves alone
function firstBuy(r, solIn, feeBps) {
  const fee = feeOf(solIn, feeBps), a = { ...r };
  let rest = solIn - fee, out = 0n, burned = 0n;
  if (!a.graduated) {
    const room = a.graduationSol - a.realSol, on = rest < room ? rest : room;
    if (on > 0n) { const x = a.virtualSol + a.realSol, left = ceilDiv(x * a.tokens, x + on); out += a.tokens - left; a.tokens = left; a.realSol += on; rest -= on; }
    if (a.realSol === a.graduationSol) { burned = a.tokens * a.virtualSol / (a.virtualSol + a.realSol); a.tokens -= burned; a.graduated = true; }
  }
  if (a.graduated && rest > 0n) { const left = ceilDiv(a.realSol * a.tokens, a.realSol + rest); out += a.tokens - left; a.tokens = left; a.realSol += rest; }
  return { out, burned, after: a };
}
function firstSell(r, tokensIn, feeBps) {
  const off = r.graduated ? 0n : r.virtualSol, x = off + r.realSol, nt = r.tokens + tokensIn, nx = ceilDiv(x * r.tokens, nt), gross = x - nx;
  return { out: gross - feeOf(gross, feeBps), after: { ...r, realSol: nx - off, tokens: nt } };
}

const cases = [];   // { op, pool, amount, feeBps, tag } or { op: "G", v, m }
const launchPool = (v, mcap, share = C.POOL_SHARE_BPS, tshare = 5000) =>
  ({ virtualSol: v, realSol: 0n, tokens: S, graduationSol: C.graduationSol(v, mcap), graduationMcap: mcap, graduated: false, burned: 0n, poolShareBps: share, treasuryShareBps: tshare });

// 1. random pools: 0 new under the line, 1 new over it, 2 from before the pool's part (0), 3 graduated under the first rules
for (let i = 0; i < 8000; i++) {
  const v = big(1 + rnd() * 999) * SOL, m = v * big(2 + rnd() * 98), g = C.graduationSol(v, m), kind = i % 4;
  let p;
  if (kind === 3) {
    const fb = firstBuy({ virtualSol: v, realSol: 0n, tokens: S, graduationSol: g, graduated: false }, g * 2n + big(rnd() * Number(g)) + SOL, 100);
    p = { ...fb.after, graduationMcap: m, burned: fb.burned, poolShareBps: rnd() < 0.5 ? 0 : C.POOL_SHARE_BPS, graduated: true };
  } else {
    // a state the curve can reach: bought into from launch
    const q = C.quoteBuy(launchPool(v, m, kind === 2 ? 0 : C.POOL_SHARE_BPS), kind === 1 ? g + big(rnd() * 3e11) : big(rnd() * Number(g)), 0);
    p = q.after;
  }
  p.treasuryShareBps = Math.floor(rnd() * 10_001);
  const fee = Math.floor(rnd() * 301), held = S - p.tokens;
  cases.push({ op: "B", pool: p, amount: big(rnd() * 3e11) + (rnd() < 0.05 ? 0n : 1n), feeBps: fee, tag: "random" });
  cases.push({ op: "S", pool: p, amount: rnd() < 0.1 ? held : rnd() < 0.05 ? big(rnd() * 1000) : big(rnd() * Number(held)), feeBps: fee, tag: "random" });
}

// 2. walks across the line both ways (the state carried by chain/src: should it part from math.rs, the first case after shows it)
for (let w = 0; w < 100; w++) {
  const v = big(1 + rnd() * 200) * SOL, m = v * big(2 + rnd() * 40), fee = Math.floor(rnd() * 301);
  let p = launchPool(v, m, [2000, 2000, 0, 10_000][w % 4], Math.floor(rnd() * 10_001)), held = 0n;
  for (let i = 0; i < 200; i++) {
    const buying = Math.floor(i / 25) % 2 === 0 ? rnd() < 0.75 : rnd() < 0.25;
    if (held === 0n || buying) {
      const amount = big(rnd() * Number(p.graduationSol) / 3) + 1000n, q = C.quoteBuy(p, amount, fee);
      cases.push({ op: "B", pool: p, amount, feeBps: fee, tag: "walk" });
      if (q.tokensOut > 0n) { held += q.tokensOut; p = q.after; }
    } else {
      const amount = 1n + big(rnd() * Number(held) / 2), q = C.quoteSell(p, amount, fee);
      cases.push({ op: "S", pool: p, amount, feeBps: fee, tag: "walk" });
      if (q.solOut > 0n) { held -= amount; p = q.after; }
    }
  }
  cases.push({ op: "S", pool: p, amount: held, feeBps: fee, tag: "whole bag" });
}

// 3. pools graduated under the first rules, walked under the new code: the same integers as the first rules gave
let firstBad = 0;
for (let w = 0; w < 100; w++) {
  const v = big(1 + rnd() * 300) * SOL, m = v * big(2 + rnd() * 98), g = C.graduationSol(v, m), fee = 100 + Math.floor(rnd() * 201);
  const fb = firstBuy({ virtualSol: v, realSol: 0n, tokens: S, graduationSol: g, graduated: false }, g * 2n + SOL, fee);
  let old = fb.after, p = { ...fb.after, graduationMcap: m, burned: fb.burned, poolShareBps: 0, treasuryShareBps: 5000 }, held = fb.out;
  for (let i = 0; i < 60; i++) {
    if (held === 0n || rnd() < 0.5) {
      const amount = big(rnd() * 50e9) + 1000n, a = firstBuy(old, amount, fee), q = C.quoteBuy(p, amount, fee);
      cases.push({ op: "B", pool: p, amount, feeBps: fee, tag: "first rules" });
      if (a.out !== q.tokensOut || a.after.realSol !== q.after.realSol || a.after.tokens !== q.after.tokens || q.poolFee !== 0n || !q.after.graduated || q.graduates) firstBad++;
      old = a.after; p = q.after; held += a.out;
    } else {
      const amount = rnd() < 0.25 ? held : 1n + big(rnd() * Number(held)), a = firstSell(old, amount, fee), q = C.quoteSell(p, amount, fee);
      cases.push({ op: "S", pool: p, amount, feeBps: fee, tag: "first rules" });
      if (a.out === 0n && q.solOut === 0n) continue;
      if (a.out !== q.solOut || a.after.realSol !== q.after.realSol || a.after.tokens !== q.after.tokens || q.poolFee !== 0n || !q.after.graduated) firstBad++;
      old = a.after; p = q.after; held -= amount;
    }
  }
}

// 4. opening batches: the settle is one buy on the fresh pool
const seats = [];
for (let i = 0; i < 1000; i++) {
  const v = big(1 + rnd() * 999) * SOL, m = v * big(2 + rnd() * 98), fee = Math.floor(rnd() * 301), g = C.graduationSol(v, m);
  const p = launchPool(v, m, i % 5 === 0 ? 0 : C.POOL_SHARE_BPS, Math.floor(rnd() * 10_001));
  const total = rnd() < 0.3 ? g + big(rnd() * 5e11) : big(rnd() * Number(g)) + C.OPENING.minBatch, seat = 1_000_000n + big(rnd() * Number(total - 1_000_000n));
  cases.push({ op: "B", pool: p, amount: total, feeBps: fee, tag: "batch" });
  seats.push({ at: cases.length - 1, pool: { ...p, feeBps: fee }, total, seat });
}

// 5. the line: graduation_sol, and one buy of exactly it, or a lamport less, into the pool just launched with no fee (on
// the market cap's line, or a hair under it where the token reserve left is rounded up, as for 10 and 90: a tenth of
// them have V·M a square), and with a fee
for (let i = 0; i < 2000; i++) {
  const v = big(1 + rnd() * 999) * SOL, m = i % 10 ? v * big(2 + rnd() * 98) + big(rnd() * 1e9) : v * [4n, 9n, 16n, 25n, 36n, 49n, 64n, 81n][i / 10 % 8], g = C.graduationSol(v, m);
  cases.push({ op: "G", v, m, tag: "line" });
  for (const [amount, feeBps] of [[g, 0], [g - 1n, 0], [g, 100]]) cases.push({ op: "B", pool: launchPool(v, m), amount, feeBps, tag: "line buy" });
}

/* ---------- run math.rs, and the three copies ---------- */
const row = (c) => c.op === "G" ? `G ${c.v} ${c.m}`
  : [c.op, c.pool.virtualSol, c.pool.realSol, c.pool.tokens, c.pool.graduationMcap, c.pool.graduated ? 1 : 0, c.pool.burned, c.pool.poolShareBps, c.amount, c.feeBps, c.pool.treasuryShareBps].join(" ");
const ran = sh(BIN, cases.map(row).join("\n") + "\n");
if (ran.status !== 0) stop(`the harness failed:\n${ran.stderr}`);
const rust = ran.stdout.trim().split("\n");
if (rust.length !== cases.length) stop(`the harness answered ${rust.length} of ${cases.length} cases`);

function answer(L, c) {
  if (c.op === "G") return String(L.graduationSol(c.v, c.m));
  const q = c.op === "B" ? L.quoteBuy(c.pool, c.amount, c.feeBps) : L.quoteSell(c.pool, c.amount, c.feeBps);
  const out = c.op === "B" ? q.tokensOut : q.solOut;
  if (out <= 0n) return "err ZeroOut";
  if (q.after.realSol > U64 || q.after.tokens > U64) return "err Overflow";
  const parts = L.feeParts(q.fee, c.pool);
  return ["ok", q.fee, q.poolFee, out, c.op === "B" && q.graduates ? 1 : 0, q.after.realSol, q.after.tokens, q.after.graduated ? 1 : 0, parts.treasury, parts.creator].join(" ");
}
const copies = { "chain/src": C, "vendor/chain.js": B, "assets/pool-math.js": PM };
let refused = 0, crossed = 0, panics = 0;
for (const o of rust) { if (o.startsWith("err")) refused++; if (o === "panic") panics++; if (o.startsWith("ok ") && o.split(" ")[4] === "1") crossed++; }
for (const [name, L] of Object.entries(copies)) {
  const bad = {};
  let first = null;
  cases.forEach((c, i) => {
    const js = answer(L, c);
    if (js === rust[i]) return;
    bad[c.tag] = (bad[c.tag] || 0) + 1;
    first ??= `\n         ${row(c)}\n         math.rs: ${rust[i]}\n         ${name}: ${js}`;
  });
  const n = Object.values(bad).reduce((a, b) => a + b, 0);
  line(!n, `${name} against math.rs: ${n} of ${cases.length} cases differ${n ? " (" + Object.entries(bad).map(([k, v]) => `${k} ${v}`).join(", ") + ")" + first : ""}`);
}
line(!panics, `math.rs: ${refused} refusals (dust), ${crossed} buys over the line, ${panics} arithmetic panics`);
{
  // the buys of the line's real SOL into pools just launched, as math.rs answered them: [on the line, a hair under it]
  const tally = { exact: [0, 0], less: [0, 0], fee: [0, 0] };
  cases.forEach((c, i) => {
    if (c.tag !== "line buy") return;
    const which = c.feeBps ? "fee" : c.amount === c.pool.graduationSol ? "exact" : "less", o = rust[i].split(" ");
    tally[which][o[0] === "ok" && o[7] === "1" ? 0 : 1]++;
  });
  line(tally.exact[0] > 0 && tally.exact[1] > 0 && !tally.less[0] && !tally.fee[0],
    `one buy of graduation_sol into a pool just launched: ${tally.exact[0]} on the market cap's line, ${tally.exact[1]} a hair under it (the token reserve it leaves is rounded up); a lamport less, ${tally.less[0]} on it; with a 1% fee, ${tally.fee[0]}`);
}
line(!firstBad, `pools graduated under the first rules, walked under the new code: ${firstBad} trades off the first rules' integers`);
{
  let bad = 0;
  for (const s of seats) {
    const o = rust[s.at].split(" "), q = C.quoteSeat(s.pool, s.seat, s.total);
    const want = o[0] === "ok" ? BigInt(o[3]) * s.seat / s.total : 0n;
    if (q.tokens !== want || (o[0] === "ok" && (q.batch.poolFee !== BigInt(o[2]) || (q.batch.graduates ? "1" : "0") !== o[4]))) bad++;
  }
  line(!bad, `quoteSeat against the settle's buy in math.rs: ${bad} of ${seats.length} seats differ`);
}
process.exit(failed ? 1 : 0);
