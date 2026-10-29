// The opening batch in the chain layer, checked offline: through the built bundle (../vendor/chain.js, the file the
// site ships), against a fake node on this machine and the program's own source (programs/pool/src). Nothing touches a
// real cluster and no real wallet signs.
//   1. errors in words: each of the program's (PoolError), a shortfall of SOL or of tokens, a seat already gone
//      (Anchor's 3012), compute run out
//   2. a transaction that lands and fails: Chain.send throws with the program's reason in words
//   3. the events, built field by field from lib.rs's own #[event] structs, decoded through readHistory
//   4. the batch's constants and the error list against state.rs and lib.rs, and the Pool, Seat and Clock accounts read
//      back from bytes laid out as state.rs (and Solana's Clock) lay them out
//   5. a settle with a seat's claim: the seat's token account is left out only when the pool and the clock, read again
//      as it is built, say the settle buys nothing for sure; the pool it is given does not decide
//
//   node check-opening.mjs

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const Chain = require("../vendor/chain.js");
const { PublicKey, Keypair } = Chain;
const rust = (file) => readFileSync(new URL(`../../programs/pool/src/${file}`, import.meta.url), "utf8");
const LIB = rust("lib.rs"), STATE = rust("state.rs");

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const head = (text) => console.log(`\n${text}`);

/* ---------- the fake node: blockhashes, sends and statuses; accounts; a pool's transactions ---------- */

const P = "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK";
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const node = { status: null, sent: 0, accounts: new Map(), lists: new Map(), txs: new Map(), filters: null, down: false, multiple: 0 };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const { id, method, params } = JSON.parse(body);
    const send = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, result })); };
    // down: the node refuses reads of accounts, as one that is behind does
    if (node.down && /^get(Account|MultipleAccounts)/.test(method)) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "Node is behind" } }));
    }
    const ctx = (value) => send({ context: { slot: 1 }, value });
    const account = (key) => {
      const a = node.accounts.get(key);
      return a ? { data: [a.data.toString("base64"), "base64"], executable: false, lamports: 1_000_000_000, owner: a.owner, rentEpoch: 0, space: a.data.length } : null;
    };
    switch (method) {
      case "getLatestBlockhash": return ctx({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 });
      case "sendTransaction": node.sent++; return send("sent");
      case "getSignatureStatuses": return ctx([node.status]);
      case "getBlockHeight": return send(1);
      case "getAccountInfo": return ctx(account(params[0]));
      case "getMultipleAccounts": node.multiple++; return ctx(params[0].map(account));
      case "getProgramAccounts":
        node.filters = params[1]?.filters ?? null;
        return send([...node.accounts].filter(([, a]) => a.pool).map(([pubkey]) => ({ pubkey, account: account(pubkey) })));
      case "getSignaturesForAddress":
        return send((node.lists.get(params[0]) ?? []).map((s, i) => ({ signature: s.signature, slot: 1000 - i, err: null, memo: null, blockTime: s.blockTime, confirmationStatus: "finalized" })));
      case "getTransaction": {
        const t = node.txs.get(params[0]);
        return send(t ? { blockTime: t.blockTime, slot: 1, meta: { err: null, logMessages: [`Program ${P} invoke [1]`, ...t.data.map((d) => `Program data: ${d}`), `Program ${P} success`] } } : null);
      }
      default: return send(null);
    }
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
Chain.setNet({ cluster: "fake", rpcUrl: `http://127.0.0.1:${server.address().port}`, program: P, historyPace: 50, historyWindowMs: 50 });

const sha = (s) => createHash("sha256").update(s).digest().subarray(0, 8);
const MINT = Keypair.generate().publicKey;
const POOL = Chain.poolAddress(MINT);
const me = Keypair.generate();
const wallet = { publicKey: me.publicKey, signTransaction: async (tx) => { tx.partialSign(me); return tx; } };
/** A pool as a page holds it, with its batch as read. */
const poolAs = (opening) => ({
  address: POOL, mint: MINT, vault: Chain.ata(POOL, MINT), feeBps: 100, virtualSol: 30_000_000_000n, realSol: 0n, tokens: Chain.SUPPLY,
  graduationSol: 82_000_000_000n, graduated: false, opening: { state: "open", opensAt: 0, sol: 0n, totalSol: 0n, tokens: 0n, tokensLeft: 0n, seats: 1, ...opening },
});
const E = (code, at = 1) => ({ err: { InstructionError: [at, { Custom: code }] } });
const said = (name) => Chain.POOL_ERRORS.find((e) => e[0] === name)[1];

/* ---------- 1. errors in words ---------- */
head("1. errors in words");
{
  const all = Chain.POOL_ERRORS.every(([, words], i) => Chain.explain(E(7000 + i)) === words && !/Program error/.test(words));
  line(all, `each of the ${Chain.POOL_ERRORS.length} program errors (7000 to ${7000 + Chain.POOL_ERRORS.length - 1}) comes out in the site's words`);
  line(Chain.explain(E(7019)) === "Seats close in the opening batch's last minute", `a commit in the last minute (7019): "${Chain.explain(E(7019))}"`);
  const noOpening = Chain.explain(E(7017));
  line(/settled already/.test(noOpening) && !/going on/.test(noOpening), `a second settle, or a commit or withdrawal after the settle (7017): "${noOpening}"`);

  const commit = await Chain.buildCommit({ pool: poolAs(), owner: me.publicKey, sol: 0.01 });
  const sell = await Chain.buildSell({ pool: poolAs({ state: "settled" }), owner: me.publicKey, tokens: 1000 });
  const buy = await Chain.buildBuy({ pool: poolAs({ state: "settled" }), owner: me.publicKey, sol: 0.01 });   // [limit, token account, buy]
  const lamportsLogs = ["Program 11111111111111111111111111111111 invoke [2]", "Transfer: insufficient lamports 1000, need 10000000", "Program 11111111111111111111111111111111 failed: custom program error: 0x1"];
  const tokensLogs = ["Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]", "Program log: Error: insufficient funds", "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x1"];
  const cases = [
    ["a commit short of SOL, with the System Program's logs", { ...E(1), logs: lamportsLogs }, commit.tx, "Not enough SOL"],
    ["a commit short of SOL, no logs (a landed transaction's status)", E(1), commit.tx, "Not enough SOL"],
    ["a buy short of SOL, no logs", E(1, 2), buy.tx, "Not enough SOL"],
    ["a sell short of tokens, with Token-2022's logs", { ...E(1), logs: tokensLogs }, sell.tx, "Not enough tokens"],
    ["a sell short of tokens, no logs", E(1), sell.tx, "Not enough tokens"],
    ["a shortfall with the System Program's logs, on a sell", { ...E(1), logs: lamportsLogs }, sell.tx, "Not enough SOL"],
    ["code 1 with no transaction to look at", E(1), undefined, "Not enough SOL"],
  ];
  for (const [what, err, tx, want] of cases) {
    const got = Chain.explain(err, tx);
    line(got === want, `${what}: "${got}"`);
  }
  const seatLogs = ["Program log: AnchorError caused by account: seat. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized."];
  const gone = Chain.explain({ ...E(3012), logs: seatLogs });
  line(/no seat/.test(gone) && /claimed or emptied/.test(gone), `a claim or withdrawal after the seat closed (3012 on the seat): "${gone}"`);
  line(Chain.explain(E(3012)) === gone, "the same with no logs (in this site's transactions only a seat can be missing)");
  const other = Chain.explain({ ...E(3012), logs: ["Program log: AnchorError caused by account: config. Error Code: AccountNotInitialized. Error Number: 3012."] });
  line(other === "Program error 3012", `3012 on another account is not said to be a seat: "${other}"`);
  const cu = Chain.explain({ err: { InstructionError: [1, "ComputationalBudgetExceeded"] } });
  line(/compute/.test(cu), `compute run out: "${cu}"`);
  line(Chain.explain(E(7000 + Chain.POOL_ERRORS.length)) === `Program error ${7000 + Chain.POOL_ERRORS.length}`, "a code past the program's list is given as its number");
}

/* ---------- 2. a transaction that lands and fails ---------- */
head("2. a transaction that lands and fails (Chain.send, then its status)");
{
  async function lands(built, err) {
    node.status = { slot: 1, confirmations: null, err, confirmationStatus: "confirmed" };
    try { return { sig: await Chain.send(built, wallet) }; } catch (e) { return { e }; }
  }
  const commit = () => Chain.buildCommit({ pool: poolAs(), owner: me.publicKey, sol: 0.01 });
  let r = await lands(await commit(), E(7019).err);
  const want = "Seats close in the opening batch's last minute";
  line(r.e && r.e.message.includes(want) && r.e.reason === want && typeof r.e.signature === "string",
    `a commit that reached the leader in the last minute: "${r.e?.message}" (reason "${r.e?.reason}", with its signature)`);
  r = await lands(await Chain.buildSettle({ pool: poolAs(), claimFor: me.publicKey }), E(7017).err);
  line(r.e && r.e.reason === said("NoOpening"), `a settle that lost the race to another: "${r.e?.reason}"`);
  r = await lands(await Chain.buildSell({ pool: poolAs({ state: "settled" }), owner: me.publicKey, tokens: 1000 }), E(1).err);
  line(r.e && r.e.reason === "Not enough tokens", `a sell whose tokens left the wallet on the way: "${r.e?.reason}"`);
  r = await lands(await commit(), E(1).err);
  line(r.e && r.e.reason === "Not enough SOL", `a commit whose SOL left the wallet on the way: "${r.e?.reason}"`);
  const sentBefore = node.sent;
  r = await lands(await commit(), null);
  line(r.sig && !r.e && node.sent === sentBefore + 1, `one that lands and passes gives its signature (${r.sig ? Chain.short(r.sig) : r.e?.message})`);
}

/* ---------- 3. the events, built from lib.rs, decoded through readHistory ---------- */
head("3. events built from lib.rs's #[event] structs, decoded through readHistory");
const SIZE = { Pubkey: 32, u64: 8, i64: 8, u32: 4, u16: 2, u8: 1, bool: 1 };
const sizeOf = (type) => SIZE[type] ?? (Number((type.match(/^\[u8;\s*(\d+)\]$/) ?? [])[1]) || NaN);
/** A struct's fields in order, as lib.rs or state.rs writes them: [{ name, type }]. */
function fieldsOf(text, name) {
  const m = text.match(new RegExp(`pub struct ${name}\\s*\\{([^}]*)\\}`));
  return m ? [...m[1].matchAll(/^\s*pub (\w+):\s*([^,\n]+),/gm)].map((f) => ({ name: f[1], type: f[2].trim() })) : null;
}
function put(type, v) {
  if (type === "Pubkey") return Buffer.from(new PublicKey(v).toBytes());
  const b = Buffer.alloc(sizeOf(type));
  if (type === "u64") b.writeBigUInt64LE(BigInt(v));
  else if (type === "i64") b.writeBigInt64LE(BigInt(v));
  else if (type === "u32") b.writeUInt32LE(v);
  else if (type === "u16") b.writeUInt16LE(v);
  else if (type === "u8" || type === "bool") b[0] = Number(v);
  return b;                                             // an array: zeros
}
let k = 0;   // every number differs from every other, so two fields read in each other's place never pass
const value = (type) => type === "Pubkey" ? Keypair.generate().publicKey : type === "u64" ? 1_000_003n * BigInt(++k) + 7n
  : type === "i64" ? 1_800_000_000 + 37 * ++k : type === "u32" ? 300 + ++k : type === "u16" ? 40 + ++k : type === "bool" ? true : type === "u8" ? 1 + (++k % 200) : 0;
const camel = (s) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
function same(type, got, want) {
  if (type === "Pubkey") return !!got && typeof got.toBase58 === "function" && got.toBase58() === new PublicKey(want).toBase58();
  if (type === "u64") return got === BigInt(want);
  if (type === "bool") return got === Boolean(want);
  return got === Number(want);
}
const KINDS = { TradeEvent: "trade", Launched: "launch", Committed: "commit", Withdrawn: "withdraw", Settled: "settle", SeatClaimed: "seat", Graduated: "graduation", FeesClaimed: "claim", CreatorChanged: "creator" };
const STRUCTS = Object.fromEntries([...LIB.matchAll(/#\[event\]\s*pub struct (\w+)/g)].map((m) => [m[1], fieldsOf(LIB, m[1])]));
{
  const missing = Object.keys(STRUCTS).filter((n) => n !== "ConfigUpdated" && !KINDS[n]);
  line(!missing.length && Object.keys(KINDS).every((n) => STRUCTS[n]), `lib.rs has ${Object.keys(STRUCTS).length} events; every one of a coin's is one the bundle reads${missing.length ? ` (not: ${missing.join(", ")})` : ""}`);

  /** One event's bytes and what it holds: lib.rs's fields in order, `set` overriding some, `cut` leaving off the last ones. */
  function event(name, set = {}, cut = 0) {
    const fields = STRUCTS[name].slice(0, STRUCTS[name].length - cut), values = {};
    for (const f of fields) values[f.name] = f.name in set ? set[f.name] : f.name === "mint" ? MINT : value(f.type);
    return { name, fields, values, b64: Buffer.concat([sha(`event:${name}`), ...fields.map((f) => put(f.type, values[f.name]))]).toString("base64") };
  }
  const trader = Keypair.generate().publicKey;
  // the pool's transactions, oldest first: each a list of events in its logs' order
  const txs = [
    [event("Launched")],
    [event("Committed")],
    [event("Withdrawn")],
    // a settle that graduates, with the seat's claim in it: the program logs them in this order
    [event("Graduated"), event("Settled", { refund: false }), event("TradeEvent", { trader: POOL, recipient: POOL, buy: true, graduated: true, by_creator: false }), event("SeatClaimed", { refund: false })],
    [event("TradeEvent", { trader, recipient: trader, buy: true, graduated: false, by_creator: true })],
    [event("TradeEvent", { buy: false, graduated: false }, 1)],    // from before by_creator
    [event("Settled", { refund: true, tokens: 0n }), event("SeatClaimed", { refund: true, tokens: 0n })],
    [event("Launched", {}, 1)],                                   // from before opens_at
    [event("FeesClaimed", { creator: true }), event("CreatorChanged")],
  ];
  const list = txs.map((evs, i) => ({ signature: `opening${String(i).padStart(3, "0")}`.padEnd(88, "x"), blockTime: 1_800_000_000 + i * 60, evs }));
  for (const s of list) node.txs.set(s.signature, { blockTime: s.blockTime, data: s.evs.map((e) => e.b64) });
  node.lists.set(POOL.toBase58(), [...list].reverse());           // newest first, as a node lists them
  const r = await Chain.readHistory(MINT);
  line(r.complete && !r.error && r.events.length === txs.flat().length, `read ${r.have} of ${r.total} transactions, ${r.events.length} events of ${txs.flat().length}`);

  for (const s of list) {
    s.evs.forEach((ev, n) => {
      const got = r.events.find((e) => e.signature === s.signature && e.n === n);
      const wrong = ev.fields.filter((f) => !got || !same(f.type, got[camel(f.name)], ev.values[f.name])).map((f) => f.name);
      const shown = ev.fields.filter((f) => f.type === "bool").map((f) => `${f.name} ${ev.values[f.name]}`).join(", ");
      line(got && got.kind === KINDS[ev.name] && !wrong.length,
        `${ev.name}${ev.fields.length < STRUCTS[ev.name].length ? " (its older, shorter form)" : ""}${shown ? ` (${shown})` : ""}: ${ev.fields.length} fields read in place${wrong.length ? `; wrong: ${wrong.join(", ")}` : ""}`);
    });
  }
  const at = (i, n) => r.events.find((e) => e.signature === list[i].signature && e.n === n);
  line(at(3, 2)?.batch === true && at(4, 0)?.batch === false && at(5, 0)?.batch === false,
    "the batch's buy (trader and recipient the pool) is marked as the batch's; a trade with trader and recipient one wallet is not");
  line(STRUCTS.TradeEvent.at(-1).name === "by_creator" && at(5, 0)?.byCreator === null, "a trade from before by_creator reads byCreator as null, not false");
  line(STRUCTS.Launched.at(-1).name === "opens_at" && at(7, 0)?.opensAt === 0 && at(0, 0)?.opensAt === Number(list[0].evs[0].values.opens_at),
    "a launch from before opens_at reads opensAt as 0; a new one, its time");
  const settle = r.events.filter((e) => e.signature === list[3].signature).sort((a, b) => a.n - b.n);
  line(settle.map((e) => `${e.n}:${e.kind}`).join(" ") === "0:graduation 1:settle 2:trade 3:seat", `a settle that graduates, in its logs' order: ${settle.map((e) => `${e.n}:${e.kind}`).join(" ")}`);
  const times = r.events.map((e) => e.time);
  line(times.every((t, i) => i === 0 || t >= times[i - 1]), "events oldest first");
}

/* ---------- 4. the program's numbers and layouts ---------- */
head("4. constants, errors and accounts against state.rs and lib.rs");
/** state.rs's constants whose value is plain arithmetic on numbers and earlier constants: { NAME: BigInt }. */
function consts(text) {
  const env = {};
  for (const m of text.matchAll(/^\s*(?:pub\s+)?const\s+(\w+)\s*:\s*[^=]+=\s*([^;]+);/gm)) {
    const toks = m[2].replace(/(\d)_(?=\d)/g, "$1").match(/\w+|[*/+-]/g) ?? [];
    const term = (t) => (/^\d+$/.test(t ?? "") ? BigInt(t) : Object.hasOwn(env, t ?? "") ? env[t] : null);
    let v = term(toks[0]);
    for (let i = 1; v !== null && i < toks.length; i += 2) {
      const x = term(toks[i + 1]), op = toks[i];
      v = x === null ? null : op === "*" ? v * x : op === "/" ? v / x : op === "+" ? v + x : op === "-" ? v - x : null;
    }
    if (v !== null) env[m[1]] = v;
  }
  return env;
}
const K = consts(STATE);
// the Pool account as state.rs lays it out: each field at its place (zero_copy: in order, no gap), LEN with its tag
const PF = fieldsOf(STATE, "Pool"), place = {};
let LEN = 8, aligned = true;
const ALIGN = { u64: 8, i64: 8, u32: 4, u16: 2 };        // a Pubkey or a byte array sits anywhere
for (const f of PF) { const n = sizeOf(f.type); if (ALIGN[f.type] && LEN % ALIGN[f.type] !== 0) aligned = false; place[f.name] = LEN; LEN += n; }
/** A Pool account's bytes, with `vals` by state.rs's field names (any field left out is 0). */
function poolData(vals) {
  const data = Buffer.alloc(LEN);
  sha("account:Pool").copy(data, 0);
  for (const f of PF) if (f.name in vals) put(f.type, vals[f.name]).copy(data, place[f.name]);
  return data;
}
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
/** The Clock sysvar's bytes: slot, epoch start, epoch, leader schedule epoch, then the unix time (Solana's layout). */
const clockAccount = (ts) => ({
  data: Buffer.concat([put("u64", 400_000_000n), put("i64", 1_700_000_000), put("u64", 900n), put("u64", 901n), put("i64", ts)]), owner: "Sysvar1111111111111111111111111111111111111",
});
{
  const pairs = [
    ["OPENING.minSecs", Chain.OPENING.minSecs, "MIN_OPENING_SECS"], ["OPENING.maxSecs", Chain.OPENING.maxSecs, "MAX_OPENING_SECS"],
    ["OPENING.lockSecs", Chain.OPENING.lockSecs, "OPENING_LOCK_SECS"], ["OPENING.minCommit", Chain.OPENING.minCommit, "MIN_COMMIT"],
    ["OPENING.minBatch", Chain.OPENING.minBatch, "MIN_BATCH"], ["SUPPLY", Chain.SUPPLY, "SUPPLY"],
    ["BOUNDS.minVirtualSol", Chain.BOUNDS.minVirtualSol, "MIN_VIRTUAL_SOL"], ["BOUNDS.maxVirtualSol", Chain.BOUNDS.maxVirtualSol, "MAX_VIRTUAL_SOL"],
    ["BOUNDS.minMultiple", Chain.BOUNDS.minMultiple, "MIN_GRADUATION_MULTIPLE"], ["BOUNDS.maxMultiple", Chain.BOUNDS.maxMultiple, "MAX_GRADUATION_MULTIPLE"],
    ["BOUNDS.maxFeeBps", Chain.BOUNDS.maxFeeBps, "MAX_FEE_BPS"],
  ];
  for (const [js, v, rs] of pairs) line(K[rs] !== undefined && BigInt(v) === K[rs], `${js} ${v}, state.rs ${rs} ${K[rs] ?? "(not found)"}`);

  const en = LIB.match(/#\[error_code\(offset = (\d+)\)\]\s*pub enum PoolError\s*\{([\s\S]*?)\n\}/);
  const variants = en ? [...en[2].matchAll(/^\s*(\w+),?\s*$/gm)].map((m) => m[1]) : [];
  const names = Chain.POOL_ERRORS.map((e) => e[0]);
  const off = variants.findIndex((v, i) => v !== names[i]);
  line(en && Number(en[1]) === 7000, `PoolError is numbered from ${en ? en[1] : "(not found)"}, where the bundle starts its list`);
  line(variants.length === names.length && off < 0,
    `PoolError has ${variants.length} errors, the bundle ${names.length}, the same names in the same order${off >= 0 ? `: they part at ${7000 + off} (${variants[off]} against ${names[off]})` : ""}`);

  // the Pool account: state.rs's fields in order, each written at its place, read back by readPool and listPools
  line(PF.length > 0 && aligned && PF.every((f) => sizeOf(f.type) > 0), `Pool: ${PF.length} fields, ${LEN - 8} bytes with no gap (zero_copy lays them out as written), ${LEN} with its tag`);
  const READS = {
    mint: "mint", creator: "creator", treasury: "treasury", vault: "vault", hook_program: "hookProgram", virtual_sol: "virtualSol", real_sol: "realSol",
    token_reserve: "tokens", graduation_sol: "graduationSol", graduation_mcap: "graduationMcap", burned: "burned", creator_fees: "creatorFees",
    treasury_fees: "treasuryFees", creator_fees_paid: "creatorFeesPaid", treasury_fees_paid: "treasuryFeesPaid", volume_sol: "volume",
    opened_at: "openedAt", graduated_at: "graduatedAt", fee_bps: "feeBps", treasury_share_bps: "treasuryShareBps", graduated: "graduated",
    opens_at: "opening.opensAt", opening_sol: "opening.sol", opening_total_sol: "opening.totalSol", opening_tokens: "opening.tokens",
    opening_tokens_left: "opening.tokensLeft", opening_seats: "opening.seats", opening_state: "opening.state",
  };
  const NOT_READ = new Set(["bump", "_pad", "_pad2", "_reserved"]);
  const unknown = PF.filter((f) => !READS[f.name] && !NOT_READ.has(f.name)).map((f) => f.name);
  line(!unknown.length, `every field of Pool is one the bundle reads or one it skips on purpose${unknown.length ? ` (not: ${unknown.join(", ")})` : ""}`);
  const STATES = { [K.OPENING_NONE]: "none", [K.OPENING_OPEN]: "open", [K.OPENING_SETTLED]: "settled", [K.OPENING_REFUND]: "refund" };
  const M2 = Keypair.generate().publicKey, vals = {};
  for (const f of PF) vals[f.name] = f.name === "mint" ? M2 : f.name === "graduated" ? 1 : f.name === "opening_state" ? Number(K.OPENING_SETTLED) : value(f.type);
  const data = poolData(vals);
  node.accounts.set(Chain.poolAddress(M2).toBase58(), { data, owner: P, pool: true });
  const p = await Chain.readPool(M2);
  const get = (path) => path.split(".").reduce((o, x) => (o == null ? o : o[x]), p);
  const wrong = PF.filter((f) => READS[f.name]).filter((f) => {
    const got = get(READS[f.name]), want = vals[f.name];
    if (f.name === "opening_state") return got !== STATES[want];
    if (f.name === "graduated") return got !== true;
    return !same(f.type, got, want);
  }).map((f) => f.name);
  line(p && !wrong.length, `a Pool laid out as state.rs has it reads back field by field${wrong.length ? `; wrong: ${wrong.join(", ")}` : ""}`);
  const states = [];
  for (const s of Object.keys(STATES).map(Number)) {
    data[place.opening_state] = s;
    const q = await Chain.readPool(M2);
    states.push(`${s} ${q.opening ? q.opening.state : "no batch"}`);
  }
  line(states.join(", ") === `${K.OPENING_NONE} no batch, ${K.OPENING_OPEN} open, ${K.OPENING_SETTLED} settled, ${K.OPENING_REFUND} refund`, `opening_state as state.rs numbers it: ${states.join(", ")}`);
  const listed = await Chain.listPools();
  line(node.filters?.[0]?.dataSize === LEN && listed.length === 1, `listPools asks for accounts of ${node.filters?.[0]?.dataSize} bytes, a Pool's ${LEN}`);

  // a seat: owner, pool, SOL, bump
  const SF = fieldsOf(STATE, "Seat"), owner = Keypair.generate().publicKey, sol = 123_456_789n;
  const seatVals = { owner, pool: POOL, sol, bump: 254 };
  const seat = Buffer.concat([sha("account:Seat"), ...SF.map((f) => put(f.type, seatVals[f.name]))]);
  line(SF.map((f) => f.name).join(" ") === "owner pool sol bump" && seat.length === 81, `Seat: ${SF.map((f) => `${f.name} ${f.type}`).join(", ")}, ${seat.length} bytes with its tag`);
  const seatKey = Chain.seatAddress(POOL, owner).toBase58();
  node.accounts.set(seatKey, { data: seat, owner: P });
  const s1 = await Chain.readSeat(POOL, owner);
  node.accounts.set(seatKey, { data: seat.subarray(0, seat.length - 1), owner: P });
  const s2 = await Chain.readSeat(POOL, owner);
  node.accounts.set(seatKey, { data: seat, owner: "11111111111111111111111111111111" });
  const s3 = await Chain.readSeat(POOL, owner);
  line(s1 && s1.sol === sol && s2 === null && s3 === null, `readSeat reads its SOL (${s1 ? s1.sol : "none"}); a seat a byte short, or of another program, is no seat`);

  // the cluster's clock
  const ts = 1_861_234_567;
  node.accounts.set(CLOCK, clockAccount(ts));
  const clock = await Chain.chainClock();
  line(clock === ts, `chainClock reads the Clock's unix time at byte 32: ${clock}`);
}

/* ---------- 5. a settle with a seat's claim: its token account, from the pool and the clock read as it is built ---------- */
head("5. a settle with a seat's claim");
{
  const CB = "ComputeBudget111111111111111111111111111111";
  const limit = (tx) => { const i = tx.instructions.find((x) => x.programId.toBase58() === CB && x.data[0] === 2); return i ? i.data.readUInt32LE(1) : null; };
  const claimTag = sha("global:claim_seat"), settleTag = sha("global:settle");
  const is = (ins, tag) => ins && ins.programId.toBase58() === P && tag.every((x, k) => ins.data[k] === x);
  const account = Chain.ata(me.publicKey, MINT);
  const opens = (ins) => ins && ins.programId.equals(Chain.ATA_PROGRAM) && ins.data[0] === 1 && ins.keys[1].pubkey.equals(account) && ins.keys[2].pubkey.equals(me.publicKey);
  /** What a settle with this wallet's claim holds: "opened" (limit, settle, token account, claim) or "left out" (limit, settle, claim). */
  function shape(tx) {
    const [, a, b, c] = tx.instructions;
    if (limit(tx) !== 140_000 || !is(a, settleTag)) return "wrong";
    if (tx.instructions.length === 4 && opens(b) && is(c, claimTag) && c.keys[5].pubkey.equals(account)) return "opened";
    if (tx.instructions.length === 3 && is(b, claimTag) && b.keys[5].pubkey.equals(account)) return "left out";
    return "wrong";
  }
  const T = 1_861_300_000, MIN = Chain.OPENING.minBatch, LOCK = Chain.OPENING.lockSecs;
  /** The node's pool (its batch open, closing at T, with `sol` in it) and its clock at `now`; null leaves one out. */
  function onNode({ sol, now, state = K.OPENING_OPEN, pool = true, clock = true }) {
    if (pool) node.accounts.set(POOL.toBase58(), { data: poolData({ mint: MINT, opens_at: T, opening_sol: sol, opening_seats: 1, opening_state: Number(state) }), owner: P });
    else node.accounts.delete(POOL.toBase58());
    if (clock) node.accounts.set(CLOCK, clockAccount(now)); else node.accounts.delete(CLOCK);
  }
  const given = poolAs({ opensAt: T, sol: 2_000_000_000n });   // the pool a page passes: read earlier, 2 SOL in it
  const cases = [
    ["0.005 SOL read in the window's last minute (30 s before the close)", { sol: 5_000_000n, now: T - 30 }, "left out"],
    ["0.005 SOL read right as the last minute starts (no SOL goes in from then)", { sol: 5_000_000n, now: T - LOCK }, "left out"],
    ["0.005 SOL read after the close", { sol: 5_000_000n, now: T + 5 }, "left out"],
    [`${Chain.sol(MIN - 1n)} SOL read after the close (a lamport under the ${Chain.sol(MIN)} a batch needs)`, { sol: MIN - 1n, now: T + 5 }, "left out"],
    [`${Chain.sol(MIN)} SOL read after the close (enough to buy)`, { sol: MIN, now: T + 5 }, "opened"],
    ["2 SOL read after the close", { sol: 2_000_000_000n, now: T + 5 }, "opened"],
    ["0.005 SOL read a second before the last minute (SOL can still go in)", { sol: 5_000_000n, now: T - LOCK - 1 }, "opened"],
    ["0.005 SOL in a batch read as settled already (the settle is refused anyway)", { sol: 5_000_000n, now: T + 5, state: K.OPENING_SETTLED }, "opened"],
    ["no pool on the node", { sol: 0n, now: T + 5, pool: false }, "opened"],
    ["no clock on the node", { sol: 5_000_000n, now: T + 5, clock: false }, "opened"],
  ];
  for (const [what, set, want] of cases) {
    onNode(set);
    const got = shape((await Chain.buildSettle({ pool: given, claimFor: me.publicKey })).tx);
    line(got === want, `${what}: the seat's token account ${got === "wrong" ? "(a transaction of the wrong shape)" : got}, 140,000 units`);
  }
  onNode({ sol: 2_000_000_000n, now: T + 5 });
  const asked = node.multiple;
  const small = shape((await Chain.buildSettle({ pool: poolAs({ opensAt: T, sol: 5_000_000n }), claimFor: me.publicKey })).tx);
  line(small === "opened" && node.multiple === asked + 1, `a pool passed with 0.005 SOL, 2 SOL on the node: ${small} (the node's read decides, in one call for the pool and the clock)`);
  onNode({ sol: 5_000_000n, now: T + 5 });
  node.down = true;
  const down = shape((await Chain.buildSettle({ pool: given, claimFor: me.publicKey })).tx);
  node.down = false;
  line(down === "opened", `a node that refuses the read: the seat's token account ${down}`);

  const alone = (await Chain.buildSettle({ pool: given })).tx;
  line(alone.instructions.length === 2 && is(alone.instructions[1], settleTag) && limit(alone) === 60_000, "a settle alone: no account opened, 60,000 units");
  const refund = (await Chain.buildSeatClaim({ pool: poolAs({ state: "refund" }), owner: me.publicKey })).tx;
  const bought = (await Chain.buildSeatClaim({ pool: poolAs({ state: "settled" }), owner: me.publicKey })).tx;
  line(refund.instructions.length === 2 && is(refund.instructions[1], claimTag) && bought.instructions.length === 3 && opens(bought.instructions[1]),
    "a seat's claim alone: its token account opened after a batch that bought, not after a refund");
}

server.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall opening batch checks passed");
process.exit(failed ? 1 : 0);
