// The launch page's two market caps in dollars, checked offline: launch.html's own code (its number formats, the form's
// state, the dollars, the settings, the − and + steps and the price's reader), run in a vm as the page runs it, with
// the built bundle (../vendor/chain.js) for the program's bounds. Nothing is fetched and nothing is sent.
//   1. dollars typed are read to the cent: 5000, 5,000, $5,000.50, 12,5, 5k, 1.2m; anything else is refused
//   2. dollars to lamports, to the nearest lamport at SOL's price, and back to the same cents
//   3. the start's bounds shown in dollars are whole dollars inside the program's (1 to 1,000 SOL): typed, they pass;
//      a dollar further out does not, and the refusal names a bound that passes
//   4. the graduation's 2× and 100× the start, typed in dollars, pass, though rounding each to a lamport alone can put
//      them a few lamports outside; a cent further out is refused
//   5. the − and + steps go through round dollars between the bounds, and every one of them passes
//   6. with no price the fields are in SOL: a price is only one /api/price gave, read by the server under ten minutes
//      ago; SOL typed before it came is the same amount in dollars, and back in SOL the same lamports
//   7. a new price of SOL redraws the form but starts no new dry run, unless the unit changed or a bound was crossed,
//      and never over what the launch itself last said in the status
//   8. the strip's dollars say they are at SOL's price now; with no server for the price, the line under the market
//      caps does not promise to try again
//   9. the two fields' names say their unit, for screen readers, and the line under them describes both
//
//   node check-launch-usd.mjs [launch.html]      (another copy of the page, to see these fail on it)

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const Chain = require("../vendor/chain.js");
const PAGE = readFileSync(process.argv[2] || new URL("../launch.html", import.meta.url), "utf8");

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const head = (text) => console.log(`\n${text}`);
const between = (text, from, to) => { const a = text.indexOf(from), b = a < 0 ? -1 : text.indexOf(to, a); return b > a ? text.slice(a, b) : ""; };

/* ---------- the page's code, in a vm ---------- */

const SETTINGS = between(PAGE, "/* number formats", "function split()");
const parts = {
  "the formats, the form's state, the dollars and the settings": SETTINGS,
  "the − and + steps": between(PAGE, "// − and +: round amounts", "var steppers"),
  "the price's reader": between(PAGE, "var byHand = false;", "function priceMoved()"),
};
const fields = { "#fV": { value: "" }, "#fM": { value: "" }, "#fFee": { value: "1" }, "#tape": { innerHTML: "" }, "#rate": { innerHTML: "" } };
const net = { priceUrl: "http://127.0.0.1:1/api/price" };
// the page's code in a vm of its own, with what it needs from the rest of the page made up in extra; null when a part
// is missing or does not run
function pageIn(codes, extra, need) {
  const C = vm.createContext({ window: { Chain, NET: net }, Chain, NET: net, TextEncoder, setTimeout, clearTimeout,
    params: { get: () => null }, $: (s) => fields[s] || { value: "" }, ...extra });
  let loaded = true;
  for (const [what, code] of Object.entries(codes)) {
    if (!code) { line(false, `launch.html has ${what}`); loaded = false; continue; }
    try { vm.runInContext(code, C); } catch (e) { line(false, `${what} run: ${e.message}`); loaded = false; }
  }
  const missing = need.filter((f) => typeof C[f] !== "function");
  if (missing.length) line(false, `launch.html's functions are there; missing: ${missing.join(", ")}`);
  return loaded && !missing.length ? C : null;
}
const P = pageIn(parts, {
  answer: null, fetched: 0, moved: 0,
  priceMoved() { P.moved++; },
  async fetch() { P.fetched++; const a = P.answer; if (a instanceof Error) throw a; return { ok: a.status === 200, json: async () => a.body }; },
}, ["parseUsd", "usdToLam", "lamToUsd", "centsOf", "usdBound", "mcapLam", "toCents", "usdField", "fCents", "readPrice", "setUnit", "readSettings", "stepOf", "loadUsd"]);
line(!!P, "the page's dollar functions are there");
if (!P) { console.log(`\n${failed} check(s) failed`); process.exit(1); }

const { MINV, MAXV, MULT_LO, MULT_HI } = P;
const LN = 1_000_000_000n;
// the page, as a visitor leaves it: the fields typed, in a unit at a price, and the settings it reads from them
function typed(unit, usd, v, m, fee = "1") {
  P.UNIT = unit; P.USD = usd; fields["#fV"].value = v; fields["#fM"].value = m; fields["#fFee"].value = fee;
  P.readSettings();
  return P.SET;
}
// what the program would say of the lamports the page would send
const programSays = (s) => Chain.launchProblems({ virtualSol: s.raw.v, graduationMcap: s.raw.m, feeBps: s.raw.fee });
// lamports for cents at a price with up to 4 decimals, to the nearest, worked out here apart from the page: cents/100
// dollars over (price × 10^4)/10^4 dollars a SOL, in lamports, is cents × 10^11 / (price × 10^4)
function exactLam(cents, usd) { const q = BigInt(Math.round(usd * 1e4)); return (2n * cents * 100_000_000_000n + q) / (2n * q); }
let seed = 0x6e6f78;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
// SOL's price: a few kept to check by eye, and random ones with up to 4 decimals from $0.37 to $9,999
const PRICES = [0.37, 1, 9.99, 23.5, 87.65, 142.07, 187.43, 199.9999, 250, 1234.5678, 4321.09,
  ...Array.from({ length: 40 }, () => Math.round((0.37 + rnd() ** 3 * 9999) * 1e4) / 1e4)];

/* ---------- 1. reading dollars ---------- */
head("1. dollars typed are read to the cent; anything else is refused");
{
  const good = [["5000", 500000n], ["5,000", 500000n], ["$5,000.50", 500050n], [" 5 000 ", 500000n], ["12,5", 1250n], ["0.07", 7n],
    ["5k", 500000n], ["69.42K", 6942000n], ["1.2m", 120000000n], ["1,234,567.89", 123456789n], ["187430", 18743000n]];
  for (const [raw, cents] of good) { const r = P.parseUsd(raw); line(r.cents === cents, `"${raw}" is ${r.err ? `refused: ${r.err}` : P.fCents(r.cents)}`); }
  const bad = ["", "$", ".", "abc", "5.123", "1,2345", "1,234,5", "-5", "5e3", "2k5", "1.2345678m9", "9".repeat(16), "2000000000000"];
  for (const raw of bad) { const r = P.parseUsd(raw); line(!!r.err, `"${raw}" is refused${r.err ? `: ${r.err}` : `, not read as ${r.cents}`}`); }
}

/* ---------- 2. dollars to lamports and back ---------- */
head("2. dollars to lamports at SOL's price, to the nearest lamport, and back to the same cents");
{
  let n = 0, off = 0, back = 0, nulls = 0;
  for (const usd of PRICES) {
    for (let i = 0; i < 200; i++) {
      const cents = BigInt(Math.floor(rnd() ** 2 * 2e9)) + 1n;     // $0.01 to $20M
      const lam = P.usdToLam(cents, usd);
      n++; if (lam !== exactLam(cents, usd)) off++;
      if (P.centsOf(lam, usd) !== cents) back++;
    }
  }
  line(off === 0, `${n} amounts from $0.01 to $20M at ${PRICES.length} prices: the nearest lamport in ${n - off} of them`);
  line(back === 0, `every one comes back to the cents typed (${back} do not)`);
  for (const usd of [null, 0, -1, NaN]) if (P.usdToLam(500000n, usd) !== null) nulls++;
  line(nulls === 0, "with no price (null, 0, below 0, not a number) there are no lamports at all");
  const s = typed("usd", 187.43, "5,000", "70,000");
  line(s.ok && s.raw.v === exactLam(500000n, 187.43) && s.raw.m === exactLam(7000000n, 187.43),
    `$5,000 and $70,000 at $187.43 go to the program as ${P.lamText(s.raw.v)} and ${P.lamText(s.raw.m)} SOL`);
}

/* ---------- 3. the start's bounds ---------- */
head(`3. the start's bounds in whole dollars, inside the program's ${P.lamText(MINV)} to ${P.lamText(MAXV)} SOL, at ${PRICES.length} prices`);
{
  const bad = [];
  for (const usd of PRICES) {
    const lo = P.usdBound(MINV, usd, true), hi = P.usdBound(MAXV, usd, false), L = (c) => P.usdToLam(c, usd);
    const tight = L(lo) >= MINV && (lo === 100n || L(lo - 100n) < MINV) && L(hi) <= MAXV && L(hi + 100n) > MAXV && lo % 100n === 0n && hi % 100n === 0n;
    if (!tight) bad.push(`$${usd}: not the tightest whole dollars inside (${P.fCents(lo)} to ${P.fCents(hi)})`);
    // typed, as the page shows them: the start at each end, the graduation at 2× and 100× it
    for (const [v, m] of [[lo, lo * 2n], [lo, lo * 100n], [hi, hi * 2n], [hi, hi * 100n]]) {
      const s = typed("usd", usd, P.usdField(v), P.usdField(m));
      if (!s.ok || programSays(s).length) bad.push(`$${usd}: ${P.fCents(v)} and ${P.fCents(m)} ${s.ok ? `pass the page but not the program: ${programSays(s).map((p) => p.message)}` : `are refused: ${Object.values(s.msgs).filter(Boolean)}`}`);
    }
    // a dollar further out is refused, and the refusal names the bound, which passes (above)
    if (lo > 100n) {
      const s = typed("usd", usd, P.usdField(lo - 100n), P.usdField(lo * 2n));
      if (s.ok || !s.msgs.virtualSol.includes(P.fCents(lo))) bad.push(`$${usd}: ${P.fCents(lo - 100n)} is not refused with ${P.fCents(lo)}: "${s.msgs.virtualSol}"`);
    }
    const s = typed("usd", usd, P.usdField(hi + 100n), P.usdField(hi * 2n));
    if (s.ok || !s.msgs.virtualSol.includes(P.fCents(hi))) bad.push(`$${usd}: ${P.fCents(hi + 100n)} is not refused with ${P.fCents(hi)}: "${s.msgs.virtualSol}"`);
  }
  line(!bad.length, `every bound shown passes the program, and a dollar beyond it is refused with it${bad.length ? `:\n         ${bad.slice(0, 6).join("\n         ")}` : ""}`);
  const lo = P.usdBound(MINV, 187.43, true), hi = P.usdBound(MAXV, 187.43, false);
  line(lo === 18800n && hi === 18743000n, `at $187.43 a SOL the start is ${P.fCents(lo)} to ${P.fCents(hi)}`);
  const s = typed("usd", 187.43, "187", "1,000");
  line(s.msgs.virtualSol === "The starting market cap must be at least $188 (1 SOL).", `$187 is refused: "${s.msgs.virtualSol}"`);
}

/* ---------- 4. the graduation's multiples, and rounding ---------- */
head(`4. the graduation at ${MULT_LO}× and ${MULT_HI}× the start, typed in dollars, passes; a cent further out does not`);
{
  let n = 0, naiveLo = 0, naiveHi = 0;
  const bad = [];
  for (const usd of PRICES) {
    const lo = P.usdBound(MINV, usd, true), hi = P.usdBound(MAXV, usd, false);
    for (let i = 0; i < 60; i++) {
      const vc = lo + BigInt(Math.floor(rnd() * Number(hi - lo))), vl = P.usdToLam(vc, usd);
      for (const [k, side] of [[MULT_LO, "lo"], [MULT_HI, "hi"]]) {
        const mc = vc * k, ml = P.usdToLam(mc, usd);
        // each rounded to a lamport alone, as a page would without holding it: a few lamports outside, now and then
        if (side === "lo" && ml < vl * k) naiveLo++;
        if (side === "hi" && ml > vl * k) naiveHi++;
        const s = typed("usd", usd, P.usdField(vc), P.usdField(mc)); n++;
        const inside = s.raw.m >= s.raw.v * MULT_LO && s.raw.m <= s.raw.v * MULT_HI, moved = s.raw.m > ml ? s.raw.m - ml : ml - s.raw.m;
        if (!s.ok || !inside || programSays(s).length || moved > 100n) bad.push(`$${usd}: ${P.fCents(vc)} and ${k}× it, ${P.fCents(mc)}: ${s.ok ? `${P.lamText(s.raw.v)} and ${P.lamText(s.raw.m)} SOL, moved ${moved} lamports` : s.msgs.graduationMcap}`);
        const out = typed("usd", usd, P.usdField(vc), P.usdField(side === "lo" ? mc - 1n : mc + 1n));
        if (out.ok || !out.msgs.graduationMcap.includes(P.fCents(mc))) bad.push(`$${usd}: a cent ${side === "lo" ? "under" : "over"} ${P.fCents(mc)} is not refused with it: "${out.msgs.graduationMcap}"`);
      }
    }
  }
  line(naiveLo > 0 && naiveHi > 0, `rounded alone, ${naiveLo} of these ${MULT_LO}× and ${naiveHi} of these ${MULT_HI}× would fall a few lamports outside the program's bounds`);
  line(!bad.length, `the page holds all ${n} inside, by no more than a few lamports, and refuses a cent beyond${bad.length ? `:\n         ${bad.slice(0, 6).join("\n         ")}` : ""}`);
  const s = typed("usd", 187.43, "5,000", "9,999.99");
  line(s.msgs.graduationMcap === "The graduation market cap must be at least 2× the start, $10,000.", `$9,999.99 after $5,000 is refused: "${s.msgs.graduationMcap}"`);
}

/* ---------- 5. − and + ---------- */
head("5. − and + go through round dollars between the bounds, and every step passes");
{
  const round = (x) => { const e = 10 ** Math.floor(Math.log10(x)), k = Math.round(x / e * 10) / 10; return P.NICE.includes(k) && Math.abs(k * e - x) < 1e-6; };
  const bad = [];
  let steps = 0;
  for (const usd of [1, 23.5, 142.07, 187.43, 1234.5678]) {
    const lo = Number(P.usdBound(MINV, usd, true)) / 100, hi = Number(P.usdBound(MAXV, usd, false)) / 100;
    // the start: up from its lowest to its highest, each written as the page writes it, the graduation at 4× it
    const seen = [];
    let x = lo;
    while (x != null && seen.length < 200) {
      seen.push(x);
      const s = typed("usd", usd, P.usdField(BigInt(Math.round(x * 100))), P.usdField(BigInt(Math.round(x * 400)))); steps++;
      if (!s.ok) bad.push(`$${usd}: the start's step ${x} is refused: ${s.msgs.virtualSol}`);
      x = P.stepOf("v", 1);
    }
    if (seen[0] !== lo || seen[seen.length - 1] !== hi) bad.push(`$${usd}: the start's steps run ${seen[0]} to ${seen[seen.length - 1]}, not ${lo} to ${hi}`);
    seen.slice(1, -1).forEach((y) => { if (!round(y)) bad.push(`$${usd}: ${y} is not a round step`); });
    if (P.stepOf("v", 1) !== null) bad.push(`$${usd}: + goes past the highest start`);
    // the graduation for a start of $5,000 (or the nearest end, when that is outside): down from 100× to 2×
    const v = Math.min(hi, Math.max(lo, 5000));
    typed("usd", usd, P.usdField(BigInt(v * 100)), P.usdField(BigInt(v * 100) * MULT_HI));
    const down = [];
    let y = v * Number(MULT_HI);
    while (y != null && down.length < 200) {
      down.push(y);
      const s = typed("usd", usd, P.usdField(BigInt(v * 100)), P.usdField(BigInt(Math.round(y * 100)))); steps++;
      if (!s.ok || programSays(s).length) bad.push(`$${usd}: the graduation's step ${y} is refused: ${s.msgs.graduationMcap}`);
      y = P.stepOf("m", -1);
    }
    if (down[down.length - 1] !== v * Number(MULT_LO)) bad.push(`$${usd}: the graduation's steps end at ${down[down.length - 1]}, not ${v * Number(MULT_LO)}`);
    down.slice(1, -1).forEach((z) => { if (!round(z)) bad.push(`$${usd}: ${z} is not a round step`); });
  }
  line(!bad.length, `${steps} steps at 5 prices, each a round amount but the ends, and each passes${bad.length ? `:\n         ${bad.slice(0, 6).join("\n         ")}` : ""}`);
  typed("usd", 187.43, "5,000", "70,000");
  const up = [P.stepOf("v", 1), P.stepOf("v", -1), P.stepOf("m", 1), P.stepOf("m", -1)];
  line(up.join(" ") === "6000 4000 80000 60000", `from $5,000 and $70,000: + and − give ${up.map((u) => `$${u}`).join(", ")}`);
  const presets = P.PRESETS.map((su) => {
    const s = typed("usd", 187.43, P.usdField(BigInt(su.usdV) * 100n), P.usdField(BigInt(su.usdM) * 100n), String(su.fee / 100));
    return { su, ok: s.ok && su.usdM / su.usdV === su.M / su.V };
  });
  line(presets.every((p) => p.ok), `the four ready-made settings in dollars pass, each the same multiple as in SOL: ${presets.map((p) => `$${p.su.usdV} to $${p.su.usdM}`).join(", ")}`);
}

/* ---------- 6. no price: SOL ---------- */
head("6. with no price the fields are in SOL; going from one unit to the other keeps what was typed");
{
  const prices = [[{ usd: 187.43 }, 187.43], [{ usd: "187.43" }, 187.43], [{ usd: 0 }, null], [{ usd: -3 }, null], [{ usd: "x" }, null],
    [{ usd: 1e6 }, null], [{ usd: Infinity }, null], [{}, null], [null, null], ["187", null]];
  line(prices.every(([j, want]) => P.readPrice(j) === want), "a price is a number of dollars above 0 and under a million, as the server sends it; nothing else is one");
  // the price's reader, against answers made up here
  const load = async (answer, before = {}) => {
    Object.assign(P, { USD: null, USD_FROM: "", USD_AT: 0, USD_STATE: "loading", UNIT: "sol", launched: null, busy: false, byHand: false, moved: 0, fetched: 0 }, before);
    P.answer = answer;
    await P.loadUsd();
    return { usd: P.USD, state: P.USD_STATE, moved: P.moved, fetched: P.fetched };
  };
  const ok = { status: 200, body: { usd: 187.43, source: "Jupiter", at: Date.now() } };
  let r = await load(ok);
  line(r.usd === 187.43 && r.state === "ok" && r.moved === 1 && P.USD_FROM === "Jupiter", `an answer of $187.43 from Jupiter is the price (${r.state}, ${r.usd})`);
  for (const [answer, what] of [[{ status: 503, body: { error: "No price for SOL just now" } }, "a 503"], [{ status: 200, body: { usd: 0 } }, "a price of 0"],
    [{ status: 200, body: null }, "an empty answer"], [new Error("offline"), "no answer"]]) {
    r = await load(answer);
    line(r.usd === null && r.state === "none" && r.moved === 1, `${what}: no price, so SOL (${r.state})`);
  }
  r = await load(new Error("offline"), { USD: 190, USD_FROM: "Jupiter", USD_AT: Date.now() - 11 * 60000, USD_STATE: "ok" });
  line(r.usd === null && r.state === "none" && r.moved === 1, "no new price, and the last one read 11 minutes ago: SOL again");
  r = await load(new Error("offline"), { USD: 190, USD_FROM: "Jupiter", USD_AT: Date.now() - 60000, USD_STATE: "ok", UNIT: "usd" });
  line(r.usd === 190 && r.state === "ok" && r.moved === 0, "no new price, and the last one read a minute ago: still that one, nothing to change");
  r = await load({ status: 200, body: { usd: 190 } }, { USD: 190, USD_AT: Date.now() - 60000, USD_STATE: "ok", UNIT: "sol" });
  line(r.usd === 190 && r.moved === 1, "the same price again, with the fields still in SOL (put off while typing): they go to dollars now");
  // the server hands on a price up to ten minutes old, and its edge one older still: the age is the server's reading
  const old = Date.now() - 11 * 60000, read4 = Date.now() - 4 * 60000;
  r = await load({ status: 200, body: { usd: 187.43, source: "Jupiter", at: old } });
  line(r.usd === null && r.state === "none", `an answer whose price the server read 11 minutes ago is no price: SOL (${r.state}, ${r.usd})`);
  r = await load({ status: 200, body: { usd: 187.43, source: "Jupiter", at: old } }, { USD: 190, USD_AT: Date.now() - 2 * 60000, USD_STATE: "ok", UNIT: "usd" });
  line(r.usd === 190 && r.moved === 0, "nor does it replace one kept from 2 minutes ago");
  r = await load({ status: 200, body: { usd: 187.43, source: "Jupiter", at: read4 } });
  line(r.usd === 187.43 && P.USD_AT === read4, "one the server read 4 minutes ago is the price, and is 4 minutes old here too, so it goes 6 minutes later");
  const before = Date.now();
  r = await load({ status: 200, body: { usd: 187.43, source: "Jupiter", at: Date.now() + 30 * 60000 } });
  line(r.usd === 187.43 && P.USD_AT <= Date.now() && P.USD_AT >= before, "one read in this page's future (another clock) is as old as now, never kept longer than ten minutes from here");
  r = await load(ok, { busy: true });
  line(r.usd === null && r.fetched === 0 && r.moved === 0, "while a launch is being built the price is not read, so the settings it was built with stay");
  net.priceUrl = "";
  r = await load(ok);
  net.priceUrl = "http://127.0.0.1:1/api/price";
  line(r.usd === null && r.state === "none" && r.fetched === 0, "a page with no server for the price (opened from a file): SOL, nothing fetched");
  // SOL, with no price
  let s = typed("sol", null, "30", "420");
  line(s.ok && s.raw.v === 30n * LN && s.raw.m === 420n * LN && s.raw.vc === null, `in SOL, 30 and 420 are ${P.lamText(s.raw.v)} and ${P.lamText(s.raw.m)} SOL, as before`);
  s = typed("sol", null, "0.5", "420");
  line(s.msgs.virtualSol === "The starting market cap must be at least 1 SOL.", `in SOL, 0.5 is refused in SOL: "${s.msgs.virtualSol}"`);
  s = typed("usd", null, "5,000", "70,000");
  line(!s.ok && s.raw.v === null, "dollars with no price to turn them into SOL never pass: nothing launches on a made-up price");
  // into dollars: SOL typed before the price came is the same amount, to the cent, inside the bounds it was inside
  P.ORIGIN = null;
  typed("sol", null, "30", "420");
  P.USD = 187.43; P.setUnit("usd");
  line(P.UNIT === "usd" && fields["#fV"].value === "5,622.90" && fields["#fM"].value === "78,720.60", `30 and 420 SOL typed, at $187.43: ${fields["#fV"].value} and ${fields["#fM"].value} dollars`);
  const bad = [];
  for (const usd of PRICES) {
    for (const [v, m] of [["1", "2"], ["1", "100"], ["1000", "2000"], ["1000", "100000"], ["33.333333333", "66.666666666"], ["7.777777777", "777.7777777"]]) {
      P.ORIGIN = null;
      const a = typed("sol", null, v, m), vl = a.raw.v, ml = a.raw.m;
      P.USD = usd; P.setUnit("usd");
      const b = typed("usd", usd, fields["#fV"].value, fields["#fM"].value);
      // a cent in lamports; the start moves by about one, the graduation (held to its multiple of the start) by about
      // its multiple's worth
      const cent = BigInt(Math.ceil(1e7 / usd)), gap = (x, y) => (x > y ? x - y : y - x);
      if (!b.ok || programSays(b).length || gap(b.raw.v, vl) > 2n * cent || gap(b.raw.m, ml) > (ml / vl + 2n) * cent) {
        bad.push(`$${usd}: ${v} and ${m} SOL became ${fields["#fV"].value} and ${fields["#fM"].value}: ${b.ok ? `${P.lamText(b.raw.v)} and ${P.lamText(b.raw.m)} SOL` : Object.values(b.msgs).filter(Boolean)}`);
      }
    }
  }
  line(!bad.length, `SOL at the bounds and between, at ${PRICES.length} prices: the same amounts in dollars, to about a cent, and they still pass${bad.length ? `:\n         ${bad.slice(0, 6).join("\n         ")}` : ""}`);
  // what the page put there itself goes over as the same ready-made setting
  P.ORIGIN = P.PRESETS[0];
  typed("sol", null, "30", "420");
  P.USD = 187.43; P.setUnit("usd");
  line(fields["#fV"].value === "5,000" && fields["#fM"].value === "70,000", `the house setting, put there by the page: ${fields["#fV"].value} and ${fields["#fM"].value} dollars`);
  // back into SOL, when the price is lost: the very lamports the dollars were checked as
  P.ORIGIN = null;
  const d = typed("usd", 187.43, "5,000", "10,000");
  P.setUnit("sol");
  const e = typed("sol", null, fields["#fV"].value, fields["#fM"].value);
  line(P.UNIT === "sol" && e.ok && e.raw.v === d.raw.v && e.raw.m === d.raw.m, `$5,000 and $10,000 back into SOL: ${fields["#fV"].value} and ${fields["#fM"].value}, the same lamports`);
}

/* ---------- 7. a new price, and the dry run ---------- */
// the page's own onInput and priceMoved, with the drawing made up: a dry run is counted, never run
const names = [{ textContent: " in SOL" }, { textContent: " in SOL" }];
const Q = pageIn({
  "the formats, the form's state, the dollars and the settings": SETTINGS,
  "what a change in the form does": between(PAGE, "function onInput(now)", "[iV, iM].forEach"),
  "what a new price does": between(PAGE, "function priceMoved()", "/* ================= sizes"),
}, {
  N: { say: (a) => a }, dry: 0,
  iName: { value: "" }, iSym: { value: "" }, iUri: { value: "" }, iBuy: { value: "" }, metaFor: "", metaSeq: 0, metaBusy: false, metaTimer: 0,
  v() { Q.readSettings(); return { ok: Q.SET.ok, reasons: [] }; },
  renderPreview() {}, markPresets() {}, renderGets() {}, renderNeed() {}, renderGate() {}, paintPresets() {}, paintTape() {}, paintRate() {}, checkMeta() {},
  schedulePre() { Q.dry++; },
  document: { activeElement: null, querySelectorAll: (s) => (s === "[data-cur]" ? names : []) },
}, ["onInput", "priceMoved"]);
head("7. a new price of SOL redraws the form; a new dry run only when the settings change in kind, never over the launch's word");
if (Q) {
  // the page as a visitor left it, then SOL's price moves to usd: the dry runs it starts, and the unit it is in after
  const move = (unit, from, to, v, m, goSaid) => {
    Object.assign(Q, { UNIT: unit, USD: from, ORIGIN: null, launched: null, busy: false });
    fields["#fV"].value = v; fields["#fM"].value = m; fields["#fFee"].value = "1";
    Q.readSettings(); Q.goSaid = goSaid; Q.dry = 0;
    Q.USD = to; Q.priceMoved();
    return { dry: Q.dry, unit: Q.UNIT, ok: Q.SET.ok };
  };
  const goCode = between(PAGE, "async function go()", "var FIELDS"), guard = goCode.indexOf("if (busy || !allowed()) return;");
  line(guard > 0 && /goSaid = true/.test(goCode.slice(guard, goCode.indexOf("var res = v()"))), "the launch marks the status as its own before it writes anything there");
  let r = move("usd", 187.43, 190.12, "5,000", "70,000", true);
  line(r.dry === 0 && r.unit === "usd", `after the launch said why it did not go through, a new price leaves that in the status (${r.dry} dry run)`);
  r = move("usd", 187.43, 190.12, "5,000", "70,000", false);
  line(r.dry === 0, `a new price alone starts no dry run: no build, simulation and balance read every minute (${r.dry})`);
  r = move("sol", null, 187.43, "30", "420", false);
  line(r.dry === 1 && r.unit === "usd", `the price's first coming, SOL to dollars, starts one (${r.dry})`);
  r = move("usd", 187.43, 188.5, "188", "1,000", false);
  line(r.dry === 1 && !r.ok, `a price that puts $188 under 1 SOL starts one, which takes the old "it would land" away (${r.dry})`);
  r = move("usd", 187.43, null, "5,000", "70,000", true);
  line(r.dry === 0 && r.unit === "sol", `the price lost after the launch spoke: the fields go to SOL, and the status keeps its word (${r.dry})`);
  Q.goSaid = true; Q.dry = 0; Q.onInput();
  line(Q.goSaid === false && Q.dry === 1, "the person's next change lets the status go, and starts a dry run");
}

/* ---------- 8. the strip, and the line under the market caps ---------- */
const R = pageIn({
  "the formats, the form's state, the dollars and the settings": SETTINGS,
  "the line under the market caps": between(PAGE, "// the line under the two market caps", "/* the simulator"),
  "the strip": between(PAGE, "var TAPE = null;", "/* ================= SOL's price"),
}, { N: { say: (a) => a }, BH: { fromPool: (p) => ({ look: { V: p.v, M: p.m, fee: p.fee } }) } }, ["paintRate", "paintTape"]);
head("8. the strip's dollars are at SOL's price now and say so; with no server for the price, no promise to try again");
if (R) {
  R.TAPE = [{ symbol: "OLD", v: 30, m: 420, fee: 100, graduated: true, openedAt: Date.now() / 1000 - 3 * 86400 }, { symbol: "NEW", v: 20, m: 180, fee: 200, graduated: false, openedAt: Date.now() / 1000 - 60 }];
  Object.assign(R, { UNIT: "usd", USD: 187.43 });
  R.paintTape();
  const items = fields["#tape"].innerHTML.split("</span>").filter((s) => s.includes("launched"));
  line(items.length === 2 && items.every((s) => s.includes("SOL’s price now")) && !/opened at \$/.test(fields["#tape"].innerHTML),
    `in dollars each launch says its caps are at SOL's price now, never what it "opened at": "${items[0] ? items[0].replace(/<[^>]+>/g, "") : ""}"`);
  line(items[0] && items[0].includes("$5.6K") && items[0].includes("$78.7K"), "30 and 420 SOL at $187.43 are $5.6K and $78.7K there");
  Object.assign(R, { UNIT: "sol", USD: null });
  R.paintTape();
  line(fields["#tape"].innerHTML.includes("30 SOL virtual, graduates at 420"), "in SOL it is as before: 30 SOL virtual, graduates at 420");
  const rate = (url, state) => { net.priceUrl = url; Object.assign(R, { UNIT: "sol", USD: null, USD_STATE: state }); fields["#rate"]._t = null; R.paintRate(); return fields["#rate"].innerHTML; };
  let t = rate("", "none");
  line(!/tries again/.test(t) && /^In SOL/.test(t), `no server for the price (a file, or ?rpc=direct): "${t}"`);
  t = rate("http://127.0.0.1:1/api/price", "none");
  line(/tries again every minute/.test(t), `a server that gave no price: "${t}"`);
  t = rate("http://127.0.0.1:1/api/price", "loading");
  line(/until SOL’s price in dollars loads/.test(t), `before its answer: "${t}"`);
  net.priceUrl = "http://127.0.0.1:1/api/price";
}

/* ---------- 9. names for screen readers ---------- */
head("9. the two market caps' names say their unit, and the line under them describes both");
{
  const label = (id) => between(PAGE, `<label for="${id}">`, "</label>"), input = (id) => (PAGE.match(new RegExp(`<input id="${id}"[^>]*>`)) || [""])[0];
  for (const [id, what] of [["fV", "starting"], ["fM", "graduation"]]) {
    line(/<span class="vh" data-cur> in SOL<\/span>/.test(label(id)), `the ${what} market cap's label carries its unit, for screen readers: "${label(id).replace(/<[^>]+>/g, "")}"`);
    line(/aria-describedby="[^"]*\brate\b/.test(input(id)), `the ${what} market cap is described by the line with its SOL and the price too`);
  }
  if (Q) {
    names.forEach((x) => { x.textContent = " in SOL"; });
    Object.assign(Q, { UNIT: "sol", USD: 187.43, ORIGIN: null, goSaid: false }); Q.priceMoved();
    const usd = names.map((x) => x.textContent).join("|");
    Q.USD = null; Q.priceMoved();
    const sol = names.map((x) => x.textContent).join("|");
    line(usd === " in dollars| in dollars" && sol === " in SOL| in SOL", `the names change with the unit: "${usd}", then "${sol}"`);
  }
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall launch dollar checks passed");
process.exit(failed ? 1 : 0);
