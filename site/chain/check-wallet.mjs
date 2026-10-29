// The wallet every page shares (../assets/wallet.js), checked offline: it runs in a vm with a small fake window and
// document, beside the built bundle (../vendor/chain.js), and the wallets are fakes that announce themselves as real
// ones do through the Wallet Standard. Nothing touches a real cluster and no real wallet signs.
//   1. discovery: a wallet that loaded before the page (it waits for "app-ready") and one after it (it sends
//      "register-wallet") are both found; only those that sign legacy transactions on the page's cluster are kept
//   2. one wallet: a press connects it at once, with no picker, and the choice is kept for the next page
//   3. the adapter: the wallet gets the transaction's bytes and its own account; what comes back, which the wallet
//      changed, is a Transaction with the wallet's signature, and Chain.send sends those bytes
//   4. account changes: another account in the wallet replaces the page's, a new object for the same one is signed
//      with from then on, and no account is a disconnect
//   5. two wallets: the picker, its rows (name, icon), its keys (arrows, Home, End, Tab, Escape), a press outside it, a
//      choice, and where it is put on a wide and on a narrow window
//   6. a wallet that comes both ways (standard and injected) is listed once; injected ones are still a fallback
//   7. a mainnet page keeps the wallets that sign there
//   8. no wallet: the note, and on a touch device the links that open the page inside Phantom or Solflare
//   9. the next page: the wallet kept reconnects silently, also when it registers late; one not trusted stays out
//  10. the coin page's own code (its holdStart and connectWallet, read from ../coin.html): the hold button opens the
//      picker as it is pressed, so the picker goes under it, the rest of a tap does not close it, and Enter held
//      down does not choose for the visitor; a batch button gets it under itself
//
//   node check-wallet.mjs

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as web3 from "@solana/web3.js";

const require = createRequire(import.meta.url);
const Chain = require("../vendor/chain.js");
const SOURCE = readFileSync(new URL("../assets/wallet.js", import.meta.url), "utf8");
const COIN = readFileSync(new URL("../coin.html", import.meta.url), "utf8");

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const head = (text) => console.log(`\n${text}`);
const later = (ms = 0) => new Promise((ok) => setTimeout(ok, ms));
const settle = async () => { for (let i = 0; i < 8; i++) await later(); };

/* ---------- a small fake DOM: what wallet.js uses, no more ---------- */

class Target {
  constructor() { this.on = {}; }
  addEventListener(type, fn, opt) { (this.on[type] ??= []).push({ fn, capture: opt === true || !!opt?.capture }); }
  removeEventListener(type, fn) { const l = this.on[type], i = l ? l.findIndex((x) => x.fn === fn) : -1; if (i >= 0) l.splice(i, 1); }
  // the capture listeners from the top down, then the target's own, then the bubbling ones back up
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this;
    const path = [];
    for (let n = this; n; n = n.parentNode) path.push(n);
    const run = (n, capture) => {
      ev.currentTarget = n;
      for (const l of [...(n.on?.[ev.type] ?? [])]) if (capture === null || l.capture === capture) l.fn.call(n, ev);
    };
    for (let k = path.length - 1; k > 0; k--) run(path[k], true);
    run(this, null);
    if (ev.bubbles) for (let k = 1; k < path.length; k++) run(path[k], false);
    return !ev.defaultPrevented;
  }
}
const event = (type, more = {}) => ({ type, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...more });

class Text {
  constructor(data) { this.data = data; this.parentNode = null; }
  get textContent() { return this.data; }
  remove() { const p = this.parentNode; if (p) { p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null; } }
}
class El extends Target {
  constructor(tag, doc) { super(); this.tagName = tag.toUpperCase(); this.doc = doc; this.childNodes = []; this.parentNode = null; this.attrs = {}; this.style = {}; this.rect = null; }
  get className() { return this.attrs.class ?? ""; }
  set className(v) { this.attrs.class = String(v); }
  get id() { return this.attrs.id ?? ""; }
  set id(v) { this.attrs.id = String(v); }
  get classList() {
    const el = this, list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => list().includes(c),
      add: (c) => { if (!list().includes(c)) el.className = [...list(), c].join(" "); },
      remove: (c) => { el.className = list().filter((x) => x !== c).join(" "); },
      toggle: (c, on) => { const has = list().includes(c), want = on === undefined ? !has : !!on; if (want && !has) el.className = [...list(), c].join(" "); if (!want && has) el.className = list().filter((x) => x !== c).join(" "); return want; },
    };
  }
  get children() { return this.childNodes.filter((n) => n instanceof El); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; if (v !== "" && v != null) this.appendChild(new Text(String(v))); }
  appendChild(n) { if (n.parentNode) n.remove(); n.parentNode = this; this.childNodes.push(n); return n; }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body;
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  matches(sel) {
    if (sel.includes(",")) return sel.split(",").some((one) => this.matches(one.trim()));
    if (sel[0] === "[") return this.hasAttribute(sel.slice(1, -1));
    if (sel[0] === ".") return this.classList.contains(sel.slice(1));
    if (sel[0] === "#") return this.id === sel.slice(1);
    return this.tagName === sel.toUpperCase();
  }
  closest(sel) { for (let n = this; n instanceof El; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) {
    const out = [], walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  focus() {
    const prev = this.doc.activeElement;
    if (prev === this) return;
    this.doc.activeElement = this;
    if (prev && prev !== this.doc.body) prev.dispatchEvent(event("focusout", { relatedTarget: this }));
  }
  getBoundingClientRect() { return this.rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  // only the picker has a size here: 240 wide (nox.css), a row of 36 per wallet under its title
  get offsetWidth() { return this.classList.contains("w-pick") ? 240 : 0; }
  get offsetHeight() { return this.classList.contains("w-pick") ? 40 + 36 * this.querySelectorAll("button").length : 0; }
}
class Doc extends Target {
  constructor() {
    super();
    this.documentElement = new El("html", this);
    this.documentElement.parentNode = this;
    this.documentElement.clientWidth = 1024;
    this.body = this.documentElement.appendChild(new El("body", this));
    this.activeElement = this.body;
  }
  createElement(tag) { return new El(tag, this); }
  createTextNode(text) { return new Text(text); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
  querySelector(sel) { return this.documentElement.querySelector(sel); }
  contains(n) { return this.documentElement.contains(n); }
}

/* ---------- fake wallets ---------- */

const ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
const MEMO = new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const account = (kp) => Object.freeze({ address: kp.publicKey.toBase58(), publicKey: kp.publicKey.toBytes(), chains: ["solana:devnet", "solana:mainnet"], features: ["solana:signTransaction"] });

/**
 * A Wallet Standard wallet. It signs with its keys after adding a memo of its own (a wallet may change what it signs),
 * and records what it was asked. `trusted`: a silent connect gets its account.
 */
function stdWallet(name, { chains = ["solana:devnet", "solana:mainnet"], sign = true, versions = ["legacy", 0], icon = ICON, trusted = false, refuse = false } = {}) {
  const s = { name, keys: [web3.Keypair.generate()], accounts: [], connects: [], signs: [], disconnects: 0, change: new Set(), trusted };
  const w = { version: "1.0.0", name, icon, chains, features: {}, get accounts() { return s.accounts; } };
  w.features["standard:connect"] = {
    version: "1.0.0",
    connect: async (input) => {
      s.connects.push(input ?? null);
      if (refuse) throw new Error("User rejected the request.");
      if (input?.silent && !s.trusted) return { accounts: [] };
      s.trusted = true; s.accounts = [account(s.keys[0])];
      return { accounts: s.accounts };
    },
  };
  w.features["standard:disconnect"] = { version: "1.0.0", disconnect: async () => { s.disconnects++; s.accounts = []; } };
  w.features["standard:events"] = { version: "1.0.0", on: (type, fn) => { if (type !== "change") return () => {}; s.change.add(fn); return () => s.change.delete(fn); } };
  if (sign) {
    w.features["solana:signTransaction"] = {
      version: "1.0.0", supportedTransactionVersions: versions,
      signTransaction: async (...inputs) => inputs.map(({ account: a, transaction, chain }) => {
        s.signs.push({ account: a, chain, bytes: transaction });
        const kp = s.keys.find((k) => k.publicKey.toBase58() === a.address);
        const tx = web3.Transaction.from(transaction);
        tx.add(new web3.TransactionInstruction({ programId: MEMO, keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(name) }));
        tx.partialSign(kp);
        return { signedTransaction: new Uint8Array(tx.serialize({ requireAllSignatures: false })) };
      }),
    };
  }
  s.emit = (accounts) => { s.accounts = accounts; for (const fn of [...s.change]) fn({ accounts }); };
  return { w, s };
}

/** What @wallet-standard/wallet's registerWallet does: announce now, and answer "app-ready" for a page that loads later. */
function announce(win, w) {
  const callback = (api) => api.register(w);
  win.dispatchEvent({ type: "wallet-standard:register-wallet", detail: callback });
  win.addEventListener("wallet-standard:app-ready", (e) => callback(e.detail));
}

/** An injected provider, as window.phantom.solana or window.solflare are. */
function injected(extra = {}) {
  const kp = web3.Keypair.generate(), on = {};
  const p = {
    ...extra, kp, connects: [], publicKey: null,
    connect: async (opts) => { p.connects.push(opts ?? null); p.publicKey = kp.publicKey; return { publicKey: kp.publicKey }; },
    disconnect: async () => {}, signTransaction: async (tx) => { tx.partialSign(kp); return tx; },
    on: (type, fn) => { (on[type] ??= []).push(fn); }, off: (type, fn) => { on[type] = (on[type] ?? []).filter((f) => f !== fn); },
    emit: (type, arg) => { for (const fn of on[type] ?? []) fn(arg); },
  };
  return p;
}

/* ---------- a page: a connect button and its note, wallet.js run in it ---------- */

function page({ before = [], inject = {}, cluster = "devnet", touch = false, stored = null, width = 1024 } = {}) {
  const doc = new Doc(), store = new Map(stored ? [["brasa.wallet", stored]] : []);
  const win = new Target();
  Object.assign(win, {
    document: doc, Chain, NET: { cluster }, innerWidth: width, innerHeight: 800, console, setTimeout, clearTimeout,
    navigator: { userAgent: touch ? "Mozilla/5.0 (Linux; Android 14) Mobile" : "Mozilla/5.0 (Windows NT 10.0)" },
    location: { href: "https://nox.example/coin?mint=Abc&net=devnet", origin: "https://nox.example" },
    matchMedia: (q) => ({ matches: touch && q === "(pointer: coarse)" }),
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    PointerEvent: class {},
    ...inject,
  });
  win.window = win;
  win.addEventListener = win.addEventListener.bind(win); win.dispatchEvent = win.dispatchEvent.bind(win);
  doc.documentElement.clientWidth = width;
  const button = doc.body.appendChild(doc.createElement("button"));
  button.setAttribute("data-wallet", ""); button.textContent = "Connect wallet";
  button.rect = { left: width - 124, right: width - 24, top: 100, bottom: 120, width: 100, height: 20 };
  const note = doc.body.appendChild(doc.createElement("p"));
  note.setAttribute("data-wallet-note", "");
  for (const w of before) announce(win, w);             // wallets that loaded first: they wait for app-ready
  // the bundle's Chain.wallets() reads the injected wallets from this realm's window: the page being checked
  const use = () => { globalThis.window = win; };
  use();
  vm.createContext(win);
  vm.runInContext(SOURCE, win, { filename: "wallet.js" });
  doc.dispatchEvent(event("DOMContentLoaded", { bubbles: false }));
  const press = async (el = button) => { use(); el.dispatchEvent(event("pointerdown")); el.focus(); el.dispatchEvent(event("click")); await settle(); };
  // a key on whatever has focus, and what a browser does with it when the page lets it: Enter presses a button, and
  // Tab from the picker (the last thing on the page) takes focus off the page
  const key = async (k, more = {}) => {
    use();
    const at = doc.activeElement ?? doc.body;
    if (at.dispatchEvent(event("keydown", { key: k, ...more }))) {
      if (k === "Enter" && at.tagName === "BUTTON") at.dispatchEvent(event("click"));
      if (k === "Tab") { doc.activeElement = doc.body; at.dispatchEvent(event("focusout", { relatedTarget: null })); }
    }
    await settle();
  };
  return { win, doc, W: win.Wallet, button, note, store, press, key, picker: () => doc.querySelector(".w-pick"), names: () => { use(); return win.Wallet.list().map((x) => x.name); } };
}

/* ---------- a fake node, for Chain.send ---------- */

const P = "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK";
const sent = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const { id, method, params } = JSON.parse(body);
    const send = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, result })); };
    const ctx = (value) => send({ context: { slot: 1 }, value });
    if (method === "getLatestBlockhash") return ctx({ blockhash: web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 });
    if (method === "sendTransaction") { sent.push(params[0]); return send("sent"); }
    if (method === "getSignatureStatuses") return ctx(params[0].map(() => ({ slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed" })));
    if (method === "getBlockHeight") return send(1);
    if (method === "getRecentPrioritizationFees") return send([]);
    return send(null);
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
Chain.setNet({ cluster: "devnet", rpcUrl: `http://127.0.0.1:${server.address().port}`, program: P });
const owner0 = web3.Keypair.generate().publicKey;
const POOL = {
  address: Chain.poolAddress(web3.Keypair.generate().publicKey), mint: web3.Keypair.generate().publicKey, vault: web3.Keypair.generate().publicKey,
  creator: owner0, treasury: owner0, feeBps: 100, virtualSol: 30_000_000_000n, realSol: 0n, tokens: Chain.SUPPLY, graduationSol: 42_000_000_000n, graduated: false,
};
const buyFor = async (owner) => {
  const built = await Chain.buildBuy({ pool: POOL, owner, sol: 0.01 });
  built.tx.feePayer = new Chain.PublicKey(owner.toString());
  built.tx.recentBlockhash = web3.Keypair.generate().publicKey.toBase58();
  return built;
};

/* ---------- 1. discovery and the filter ---------- */
head("1. discovery: standard wallets, before and after the page, kept by feature and cluster");
const alpha = stdWallet("Alpha");
const mainOnly = stdWallet("Main only", { chains: ["solana:mainnet"] });
const noSign = stdWallet("No sign", { sign: false });
const v0Only = stdWallet("Versioned only", { versions: [0] });
const notSolana = stdWallet("Other chain", { chains: ["ethereum:1"] });
const A = page({ before: [alpha.w, mainOnly.w, noSign.w, v0Only.w, notSolana.w] });
line(A.names().join() === "Alpha", `a wallet that loaded before the page is found, and the four that cannot sign legacy transactions on devnet are not (${A.names().join(", ")})`);
line(A.W.list()[0].icon === ICON, "its icon comes with it");

/* ---------- 2. one wallet connects at once ---------- */
head("2. one wallet: a press connects it, no picker");
let changes = [];
A.W.on((w) => changes.push(w));
await A.press();
const alphaKey = alpha.s.keys[0].publicKey.toBase58();
line(!A.picker() && A.W.current?.name === "Alpha" && String(A.W.current.publicKey) === alphaKey, `the only wallet is connected at once (${A.W.current?.name}), with no picker`);
line(alpha.s.connects.length === 1 && alpha.s.connects[0] === null, "through standard:connect, asked to show its prompt (not silent)");
line(A.store.get("brasa.wallet") === "Alpha" && A.button.classList.contains("on") && A.button.textContent === `${alphaKey.slice(0, 4)}…${alphaKey.slice(-4)}`, "the choice is kept for the next page, and the button shows the short key");
line(changes.length === 1 && changes[0] === A.W.current, "Wallet.on hears it");

/* ---------- 3. the adapter ---------- */
head("3. the adapter: bytes to the wallet, the wallet's own transaction back");
{
  const built = await buyFor(A.W.current.publicKey);
  const before = built.tx.instructions.length;
  const signed = await A.W.current.signTransaction(built.tx);
  const asked = alpha.s.signs[0];
  line(asked && asked.chain === "solana:devnet" && asked.account === alpha.s.accounts[0] && ArrayBuffer.isView(asked.bytes) && asked.bytes.constructor.name === "Uint8Array",
    "the wallet is asked with its own account object, the page's cluster, and a Uint8Array of the transaction");
  line(signed instanceof Chain.Transaction, "what comes back is a Transaction of the bundle's");
  line(signed.instructions.length === before + 1 && signed.instructions.at(-1).programId.toBase58() === MEMO.toBase58() && built.tx.instructions.length === before,
    "it is the wallet's: with the memo the wallet added (the page's own transaction is left as it was)");
  line(signed.signature?.length === 64 && signed.verifySignatures() && signed.feePayer.toBase58() === alphaKey, "it carries the wallet's signature, valid for what the wallet signed");
  // all the way through Chain.send: what goes out is what the wallet signed
  const again = await buyFor(A.W.current.publicKey);
  const sig = await Chain.send(again, A.W.current);
  const out = web3.Transaction.from(Buffer.from(sent.at(-1), "base64"));
  line(sent.length === 1 && out.instructions.at(-1).programId.equals(MEMO) && out.verifySignatures(),
    "Chain.send sends the wallet's bytes, memo and all, with a valid signature");
  line(out.signature && Buffer.from(out.signature).equals(Buffer.from(bs58(sig))), "and returns that transaction's signature");
}

/* ---------- 4. account changes ---------- */
head("4. account changes through standard:events");
{
  changes = [];
  const second = web3.Keypair.generate();
  alpha.s.keys.push(second);
  alpha.s.emit([account(second)]);
  line(String(A.W.current?.publicKey) === second.publicKey.toBase58() && changes.length === 1, "another account in the wallet replaces the page's, and Wallet.on hears it");
  const fresh = account(second);
  alpha.s.emit([fresh]);
  line(changes.length === 1, "a new object for the same account is not a change for the page");
  await A.W.current.signTransaction((await buyFor(second.publicKey)).tx);
  line(alpha.s.signs.at(-1).account === fresh, "but it is the one signed with from then on");
  alpha.s.emit([]);
  line(A.W.current === null && changes.at(-1) === null && !A.store.has("brasa.wallet") && A.button.textContent === "Connect wallet", "no account: disconnected, the kept choice dropped, the button back to Connect wallet");
  alpha.s.emit([account(second)]);
  line(A.W.current === null, "and events after that are not followed");
}

/* ---------- 5. two wallets: the picker ---------- */
head("5. two wallets: the picker");
{
  const beta = stdWallet("Beta", { icon: null });
  announce(A.win, beta.w);                               // a wallet that loads after the page: it sends register-wallet
  line(A.names().join() === "Alpha,Beta", `a wallet that loads after the page is found too (${A.names().join(", ")})`);
  await A.press();
  let p = A.picker();
  const rows = p ? p.querySelectorAll("button") : [];
  line(p && p.getAttribute("role") === "dialog" && p.getAttribute("aria-modal") === "true" && A.doc.querySelector("#w-pick-h")?.textContent === "choose a wallet" && p.getAttribute("aria-labelledby") === "w-pick-h",
    "a press opens a picker, a labelled modal dialog");
  line(rows.length === 2 && rows[0].textContent === "Alpha" && rows[1].textContent === "Beta" && rows[0].querySelector("img")?.src === ICON && rows[1].querySelector("i") && !rows[1].querySelector("img"),
    "a row per wallet: its name, its icon (a plain square for one with none)");
  line(A.doc.activeElement === rows[0] && A.W.current === null, "focus goes to the first row; nothing is connected yet");
  await A.key("ArrowDown");
  line(A.doc.activeElement === rows[1], "ArrowDown moves to the next row");
  await A.key("ArrowDown");
  line(A.doc.activeElement === rows[0], "and wraps to the first");
  await A.key("End"); const atEnd = A.doc.activeElement === rows[1];
  await A.key("Home");
  line(atEnd && A.doc.activeElement === rows[0], "End and Home go to the last and the first");
  await A.key("Tab"); const tab1 = A.doc.activeElement === rows[1];
  await A.key("Tab");
  line(tab1 && A.doc.activeElement === rows[0] && !!A.picker(), "Tab goes round the rows: from the last back to the first, never off the page behind the card");
  await A.key("Tab", { shiftKey: true });
  line(A.doc.activeElement === rows[1] && !!A.picker(), "Shift+Tab goes round the other way");
  A.doc.activeElement = A.doc.body;                      // a press on the card's title: focus on nothing
  await A.key("Tab");
  line(A.doc.activeElement === rows[0] && !!A.picker(), "with focus on nothing, Tab comes back to the first row, not to the page behind");
  await A.key("Escape");
  line(!A.picker() && !A.doc.querySelector(".w-back") && A.W.current === null && A.doc.activeElement === A.button && A.note.textContent === "",
    "Escape closes it: nothing connected, no error, focus back on the button");
  await A.press();
  A.doc.querySelector(".w-back").dispatchEvent(event("pointerdown"));
  A.doc.querySelector(".w-back").dispatchEvent(event("click"));
  await settle();
  line(!A.picker() && A.W.current === null, "a press outside it closes it too");
  await A.press();
  p = A.picker();
  const left = p.style.left, top = p.style.top;
  p.querySelectorAll("button")[1].dispatchEvent(event("click"));
  await settle();
  line(!A.picker() && !A.doc.querySelector(".w-back") && A.W.current?.name === "Beta" && beta.s.connects.length === 1 && alpha.s.connects.length === 1 && A.store.get("brasa.wallet") === "Beta",
    "a choice closes it and connects that wallet, and only that one; it is kept for the next page");
  line(left === `${1000 - 240}px` && top === "128px", `on a wide window it sits under the button, its right edge on the button's (${left}, ${top})`);
  await A.press();
  line(A.W.current === null && beta.s.disconnects === 1, "a press on the button again disconnects, and tells the wallet");
  const N = page({ before: [alpha.w, beta.w], width: 360 });
  N.button.rect = { left: 300, right: 350, top: 700, bottom: 720, width: 50, height: 20 };
  await N.press();
  const np = N.picker();
  line(np?.style.left === `${360 - 240 - 16}px` && np?.style.top === `${700 - 8 - (40 + 72)}px`, `on a 360 px phone it keeps 16 px from the edge and goes above a button near the bottom (${np?.style.left}, ${np?.style.top})`);
  await N.key("Escape");
  const R = page({ before: [stdWallet("Gamma", { refuse: true }).w, beta.w] });
  await R.press();
  R.picker().querySelectorAll("button")[0].dispatchEvent(event("click"));
  await settle();
  line(R.W.current === null && /rejected/.test(R.note.textContent), `a wallet that refuses: nothing connected, its reason in the note ("${R.note.textContent}")`);
}

/* ---------- 6. both ways, once ---------- */
head("6. a wallet both standard and injected is listed once; injected ones are a fallback");
{
  const std = stdWallet("Phantom");
  const phantom = injected({ isPhantom: true }), solflare = injected({ isSolflare: true });
  const B = page({ before: [std.w], inject: { phantom: { solana: phantom }, solflare } });
  line(B.names().join() === "Phantom,Solflare", `Phantom (standard and injected) once, Solflare (injected only) as well (${B.names().join(", ")})`);
  await B.press();
  B.picker().querySelectorAll("button")[0].dispatchEvent(event("click"));
  await settle();
  line(B.W.current?.name === "Phantom" && std.s.connects.length === 1 && phantom.connects.length === 0 && B.W.current.icon === ICON, "Phantom connects through the standard, not the injected object");
  await B.press();
  await B.press();
  B.picker().querySelectorAll("button")[1].dispatchEvent(event("click"));
  await settle();
  line(B.W.current?.name === "Solflare" && solflare.connects.length === 1 && String(B.W.current.publicKey) === solflare.kp.publicKey.toBase58(), "Solflare connects through its injected object");
  const next = web3.Keypair.generate();
  solflare.emit("accountChanged", next.publicKey);
  line(String(B.W.current?.publicKey) === next.publicKey.toBase58(), "and its accountChanged is followed");
  std.s.emit([account(std.s.keys[0])]);
  phantom.emit("disconnect");
  line(B.W.current?.name === "Solflare", "events from the wallet used before it do not touch it");
  const C = page({ before: [alpha.w], inject: { solana: injected() } });
  const D = page({ inject: { solana: injected() } });
  line(C.names().join() === "Alpha" && D.names().join() === "Wallet", "a nameless window.solana is left out beside a standard wallet, and kept alone");
}

/* ---------- 7. mainnet ---------- */
head("7. a mainnet page keeps the wallets that sign on mainnet");
{
  const devOnly = stdWallet("Devnet only", { chains: ["solana:devnet"] });
  const M = page({ cluster: "mainnet", before: [mainOnly.w, devOnly.w] });
  line(M.names().join() === "Main only", `the mainnet wallet is kept, the devnet-only one is not (${M.names().join(", ")})`);
  await M.press();
  await M.W.current.signTransaction((await buyFor(M.W.current.publicKey)).tx);
  line(mainOnly.s.signs.at(-1)?.chain === "solana:mainnet", "and is asked to sign for solana:mainnet");
}

/* ---------- 8. no wallet ---------- */
head("8. no wallet: the note, and on a phone the links into Phantom and Solflare");
{
  const E = page();
  await E.press();
  line(E.note.textContent === "No Solana wallet in this browser. Phantom, Solflare or Backpack work." && !E.note.querySelector("a"), "on a computer: the note names the wallets that work, with no links");
  const F = page({ touch: true });
  await F.press();
  const links = F.note.querySelectorAll("a"), url = encodeURIComponent("https://nox.example/coin?mint=Abc&net=devnet"), ref = encodeURIComponent("https://nox.example");
  line(F.note.textContent === "No Solana wallet in this browser. Open this page in Phantom or Solflare." && links.length === 2, `on a phone: "${F.note.textContent}"`);
  line(links[0]?.href === `https://phantom.app/ul/browse/${url}?ref=${ref}` && links[1]?.href === `https://solflare.com/ul/v1/browse/${url}?ref=${ref}`, "the links are the wallets' browse links, with this page and its origin encoded");
  const G = page({ touch: true, before: [stdWallet("Alpha").w] });
  line(G.W.openIn().length === 0, "a phone that has a wallet in its browser gets no links");
  announce(F.win, stdWallet("Late").w);
  await F.press();
  line(F.W.current?.name === "Late" && F.note.textContent === "", "the note goes once a wallet connects");
}

/* ---------- 9. the next page ---------- */
head("9. the next page: the kept wallet reconnects silently");
{
  const kept = stdWallet("Alpha", { trusted: true });
  const H = page({ stored: "Alpha", before: [kept.w] });
  await settle();
  line(H.W.current?.name === "Alpha" && kept.s.connects.length === 1 && kept.s.connects[0]?.silent === true, "a wallet registered before the page: connected with { silent: true }");
  const late = stdWallet("Alpha", { trusted: true });
  const I = page({ stored: "Alpha" });
  await later(50);
  announce(I.win, late.w);
  await settle();
  line(I.W.current?.name === "Alpha" && late.s.connects[0]?.silent === true, "one that registers after the page loaded: the same, once it comes");
  const unsure = stdWallet("Alpha");
  const J = page({ stored: "Alpha", before: [unsure.w] });
  await settle();
  line(J.W.current === null && unsure.s.connects.length === 1 && unsure.s.connects[0]?.silent === true, "one that does not trust the site yet: asked silently only, and left out");
  const phantom = injected({ isPhantom: true });
  const K = page({ stored: "Phantom", inject: { phantom: { solana: phantom } } });
  await settle();
  line(K.W.current?.name === "Phantom" && phantom.connects[0]?.onlyIfTrusted === true, "an injected one: onlyIfTrusted, as before");
}

/* ---------- 10. the coin page's hold button ---------- */
head("10. the coin page: its hold button opens the picker as it is pressed");
{
  const one = stdWallet("Alpha"), two = stdWallet("Beta");
  const Q = page({ before: [one.w, two.w] });
  const { doc, win } = Q;
  // the trade panel as coin.html has it: a batch button, the amount field, the hold button with its label inside
  const trade = doc.body.appendChild(doc.createElement("aside")); trade.id = "trade";
  const batch = trade.appendChild(doc.createElement("button")); batch.id = "batchBtn";
  batch.rect = { left: 100, right: 200, top: 300, bottom: 330, width: 100, height: 30 };
  const amt = trade.appendChild(doc.createElement("input")); amt.id = "amt";
  amt.rect = { left: 600, right: 900, top: 420, bottom: 450, width: 300, height: 30 };
  const hold = trade.appendChild(doc.createElement("button")); hold.id = "hold";
  const label = hold.appendChild(doc.createElement("span"));
  hold.rect = { left: 600, right: 900, top: 500, bottom: 540, width: 300, height: 40 };
  const noteEl = trade.appendChild(doc.createElement("p"));
  // the page's own two functions, beside what they lean on
  const own = (name) => COIN.match(new RegExp(`\\nfunction ${name}\\(e?\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0] ?? "";
  Object.assign(win, { $: (sel) => doc.querySelector(sel), holdBtn: hold, noteEl, busy: false, HOLD_MS: 600, paintHold() {}, execute() {}, note: (text) => { noteEl.textContent = text; } });
  vm.runInContext(own("holdStart") + own("connectWallet"), win, { filename: "coin.html" });
  line(typeof win.holdStart === "function" && typeof win.connectWallet === "function", "coin.html's holdStart and connectWallet are read from the page");
  hold.addEventListener("pointerdown", win.holdStart);
  hold.addEventListener("keydown", win.holdStart);
  batch.addEventListener("click", () => win.connectWallet()); // batchAct's first step with no wallet
  const under = (el) => { const p = Q.picker(), r = el.rect; return !!p && p.style.top === `${r.bottom + 8}px` && p.style.left === `${r.left + r.width / 2 > 512 ? r.right - 240 : r.left}px`; };
  const back = () => doc.querySelector(".w-back");

  amt.focus();
  label.dispatchEvent(event("pointerdown", { pointerType: "touch", button: 0 }));
  await settle();
  line(under(hold) && doc.activeElement === Q.picker()?.querySelectorAll("button")[0], `a press on the hold button, the amount field focused, opens the picker under the hold button (${Q.picker()?.style.left}, ${Q.picker()?.style.top})`);
  hold.dispatchEvent(event("pointerup"));
  back()?.dispatchEvent(event("click"));                 // a tap's click lands where the finger was: on the clear layer now
  await settle();
  line(!!Q.picker() && Q.W.current === null, "the rest of that tap (its click landing on the layer outside the card) does not close it");
  back()?.dispatchEvent(event("pointerdown")); back()?.dispatchEvent(event("click"));
  await settle();
  line(!Q.picker() && doc.activeElement === amt, "a press of its own outside the card does, and focus goes back to the amount field");

  hold.focus();
  await Q.key("Enter");
  const first = Q.picker()?.querySelectorAll("button")[0];
  line(under(hold) && !!first && doc.activeElement === first, "Enter on the hold button opens it under the button, focus on its first row");
  for (let i = 0; i < 3; i++) await Q.key("Enter", { repeat: true });
  line(!!Q.picker() && Q.W.current === null && one.s.connects.length === 0, "Enter held down since then repeats on that row and chooses nothing");
  await Q.key("Enter");
  line(!Q.picker() && Q.W.current?.name === "Alpha", "a fresh Enter on the row chooses it");
  await Q.W.disconnect();

  batch.dispatchEvent(event("pointerdown")); batch.dispatchEvent(event("click")); // a click in Safari: the button takes no focus
  await settle();
  line(under(batch), `a batch button gets it under itself, though focus is elsewhere (${Q.picker()?.style.left}, ${Q.picker()?.style.top})`);
  await Q.key("Escape");

  const O = page({ before: [one.w, two.w], inject: { PointerEvent: undefined } });
  await O.press();
  O.doc.querySelector(".w-back")?.dispatchEvent(event("click"));
  await settle();
  line(!O.picker(), "in a browser with no pointer events, a click outside closes it as before");
}

function bs58(text) {
  const ABC = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of text) n = n * 58n + BigInt(ABC.indexOf(ch));
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const ch of text) { if (ch !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}

server.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall wallet checks passed");
process.exit(failed ? 1 : 0);
