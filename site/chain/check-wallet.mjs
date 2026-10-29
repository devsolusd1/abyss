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
//  11. the phone's wallet apps, with the built ../vendor/mwa.js (npm run build:mwa) run in the page: it is loaded only
//      in Android's own browser on a secure page with a wallet button and no wallet in the browser, after the page's
//      load (or at once for a press, or for the wallet kept from the last page); it registers the Mobile Wallet
//      Adapter on the page's cluster, signing legacy transactions; the wallet app is opened (location.assign, as the
//      package does) only from a fresh press, never by the silent reconnect, and a sign or a connect that comes after
//      the press went stale asks for a tap on a card first; the first connect on a phone puts it on a card beside the
//      links into Phantom and Solflare, so the package's dialogs about the browser's permission come up only for a
//      visitor who taps it; no wallet app reached (none answering, that permission turned down, its dialog closed)
//      puts up the links; a sign settles when the package lets go of the site under it; a failed load is tried again;
//      the picker with it beside another wallet; the package's authorization kept on the phone, for its cluster only
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
const MWA_JS = readFileSync(new URL("../vendor/mwa.js", import.meta.url), "utf8");

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
// the window's Event, for the bundles that subclass it (@wallet-standard/wallet's register event has its own `type`)
class FakeEvent {
  constructor(type, init = {}) { this.bubbles = !!init.bubbles; this.defaultPrevented = false; if (!("type" in this)) this.type = type; }
  preventDefault() { this.defaultPrevented = true; }
}

class Text {
  constructor(data) { this.data = data; this.parentNode = null; }
  get textContent() { return this.data; }
  remove() { const p = this.parentNode; if (p) { p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null; } }
}
class El extends Target {
  constructor(tag, doc) { super(); this.tagName = tag.toUpperCase(); this.doc = doc; this.childNodes = []; this.parentNode = null; this.attrs = {}; this.style = { setProperty(k, v) { this[k] = v; } }; this.rect = null; }
  // the package's spinner and dialogs set their markup as a string, inside a shadow root: kept, not parsed
  get innerHTML() { return this.html ?? ""; }
  set innerHTML(v) { this.html = String(v); }
  attachShadow() { const root = new El("#shadow", this.doc); root.getElementById = (id) => root.querySelector(`#${id}`); return (this.shadow = root); }
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
  getElementById(id) { return this.querySelector(`#${id}`); }
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

/**
 * A page with wallet.js run in it. `ua` and `secure` are the browser's user agent and isSecureContext (a phone's,
 * for the Mobile Wallet Adapter); `active` is navigator.userActivation.isActive (whether the last press is fresh);
 * `local` is what localStorage holds; `fast` cuts the 3 s the package waits for the wallet app to take focus to 0.3 s,
 * and keeps the package's console lines in `logs`; `perm` is the state of Chrome's permission to reach apps on the
 * device ("granted", "prompt": not asked yet, "denied"), which the package asks about first.
 */
function page({ before = [], inject = {}, cluster = "devnet", touch = false, stored = null, width = 1024, ua = null, secure = false, active = true, button: hasButton = true, local = {}, fast = false, perm = "granted" } = {}) {
  const doc = new Doc(), store = new Map(stored ? [["brasa.wallet", stored]] : []), disk = new Map(Object.entries(local));
  const win = new Target(), opened = [], logs = [], act = { isActive: active }, lna = { state: perm, onchange: null };
  const quiet = { log() {}, debug() {}, info() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  Object.assign(win, {
    document: doc, Chain, NET: { cluster }, innerWidth: width, innerHeight: 800, console: fast ? quiet : console, clearTimeout,
    setTimeout: fast ? (fn, ms, ...a) => setTimeout(fn, ms === 3000 ? 300 : ms, ...a) : setTimeout,
    navigator: {
      userAgent: ua ?? (touch ? "Mozilla/5.0 (Linux; Android 14) Mobile" : "Mozilla/5.0 (Windows NT 10.0)"),
      userActivation: act,
      // Chrome's permission to reach apps on the device (the package asks about it first, with dialogs of its own)
      permissions: { query: async () => lna },
    },
    isSecureContext: secure,
    // the package opens the wallet app by sending the page to a solana-wallet: link: kept here, and nothing opens
    location: { href: "https://nox.example/coin?mint=Abc&net=devnet", origin: "https://nox.example", hostname: "nox.example", assign: (u) => opened.push(String(u)) },
    matchMedia: (q) => ({ matches: (touch || /Android|iPhone/.test(ua ?? "")) && q === "(pointer: coarse)" }),
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    localStorage: { getItem: (k) => disk.get(k) ?? null, setItem: (k, v) => disk.set(k, String(v)), removeItem: (k) => disk.delete(k) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    PointerEvent: class {},
    Event: FakeEvent, URL, TextEncoder, TextDecoder, atob, btoa, crypto: globalThis.crypto,
    ...inject,
  });
  win.window = win;
  win.addEventListener = win.addEventListener.bind(win); win.dispatchEvent = win.dispatchEvent.bind(win);
  doc.documentElement.clientWidth = width;
  const button = doc.body.appendChild(doc.createElement(hasButton ? "button" : "span"));
  if (hasButton) button.setAttribute("data-wallet", "");
  button.textContent = "Connect wallet";
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
  // the page's load event; the script tag wallet.js added for the phone's wallet apps, and running it as it loads
  const loaded = async () => { use(); win.dispatchEvent(event("load", { bubbles: false })); await settle(); };
  const mwaTag = () => doc.querySelectorAll("script").find((s) => s.src === "/vendor/mwa.js") ?? null;
  const runMwa = async () => {
    use();
    const s = mwaTag();
    if (!s) return false;
    vm.runInContext(MWA_JS, win, { filename: "mwa.js" });
    s.dispatchEvent(event("load", { bubbles: false }));
    await settle();
    return true;
  };
  return {
    win, doc, W: win.Wallet, button, note, store, disk, opened, act, lna, logs, press, key, loaded, mwaTag, runMwa,
    picker: () => doc.querySelector(".w-pick"), names: () => { use(); return win.Wallet.list().map((x) => x.name); },
  };
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
line(!A.picker() && A.W.current?.name === "Alpha" && A.W.current.label === "Alpha" && String(A.W.current.publicKey) === alphaKey, `the only wallet is connected at once (${A.W.current?.name}), with no picker`);
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
  const own = (name) => COIN.match(new RegExp(`\\n(?:async )?function ${name}\\(e?\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0] ?? "";
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

/* ---------- 11. the phone's wallet apps ---------- */
head("11. the phone's wallet apps: the Mobile Wallet Adapter (the built vendor/mwa.js), on Android only");
{
  const CHROME = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
  const WEBVIEW = "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const NAME = "Mobile Wallet Adapter", CACHE = "SolanaMobileWalletAdapterDefaultAuthorizationCache";
  const LINKS = "No wallet app answered on this phone. Open this page in Phantom or Solflare.";
  const phone = (more = {}) => page({ ua: CHROME, secure: true, fast: true, ...more });
  // the link the package sends the page to, which Android hands to the wallet app
  const isAssoc = (u) => /^solana-wallet:\/v1\/associate\/local\?association=[\w.-]+&port=\d+&v=v1$/.test(u ?? "");
  // what the package keeps on the phone once a wallet app authorized the site (its default cache, in localStorage)
  const kept = (address, { chain = "solana:devnet", signs = true } = {}) => ({ [CACHE]: JSON.stringify({
    accounts: [{ address, label: "Main", chains: [chain], features: ["solana:signTransaction"] }], auth_token: "token", chain,
    capabilities: { features: signs ? ["solana:signTransactions"] : [], supports_sign_and_send_transactions: true, supported_transaction_versions: ["legacy", 0], max_transactions_per_request: 10, max_messages_per_request: 10 },
  }) });
  // the wallet object the package registers, as any app on the page would get it
  const grab = (P) => { let got = null; P.win.addEventListener("wallet-standard:register-wallet", (e) => e.detail({ register: (w) => { got = w; return () => {}; } })); return () => got; };
  const settled = (p) => p.then((t) => ({ t }), (e) => ({ e }));
  // the package's dialogs (each in a shadow root of its own, made as it first opens): their styles, which tell them apart
  const dialogs = (Q) => Q.doc.querySelectorAll("div").filter((d) => d.shadow).map((d) => d.shadow.querySelector("style")?.textContent ?? "");
  const rowsOf = (Q) => (Q.picker()?.querySelectorAll("button") ?? []).map((b) => b.textContent).join();
  const CARD = `${NAME},Open in Phantom,Open in Solflare`;
  const tap = (Q, i = 0) => Q.picker()?.querySelectorAll("button")[i]?.dispatchEvent(event("click"));   // a row of the card
  const browse = `https://phantom.app/ul/browse/${encodeURIComponent("https://nox.example/coin?mint=Abc&net=devnet")}?ref=${encodeURIComponent("https://nox.example")}`;

  // where it is loaded
  const P = phone(), mwaOf = grab(P);
  line(!P.mwaTag(), "Android's own browser, a secure page with a wallet button, no wallet in the browser: nothing loaded before the page's load");
  await P.loaded();
  line(P.mwaTag()?.async === true, "after it, /vendor/mwa.js, async");
  await P.runMwa();
  const m = mwaOf(), mSign = m?.features["solana:signTransaction"];
  line(P.names().join() === NAME && P.W.list()[0].icon?.startsWith("data:image/svg+xml;base64,") && !P.logs.length, `it registers the Mobile Wallet Adapter, which wallet.js lists, with its icon (${P.names().join(", ")})`);
  line(m?.chains.join() === "solana:devnet" && mSign?.supportedTransactionVersions.includes("legacy") && typeof m.features["standard:connect"]?.connect === "function",
    "for the page's cluster only (solana:devnet), signing legacy transactions: what usable() asks");
  line(P.opened.length === 0 && P.W.current === null, "loading it opens nothing and connects nothing");
  line(P.W.openIn().length === 2, "the links into Phantom and Solflare still stand by: the Mobile Wallet Adapter is not a wallet in the browser");
  const notHere = async (label, more) => { const Q = page({ fast: true, secure: true, ...more }); await Q.loaded(); line(!Q.mwaTag(), label); return Q; };
  await notHere("a computer: not loaded", { ua: DESKTOP });
  const ios = await notHere("an iPhone: not loaded (iOS has no Mobile Wallet Adapter)", { ua: IPHONE });
  await ios.press();
  line(ios.note.textContent === "No Solana wallet in this browser. Open this page in Phantom or Solflare." && ios.note.querySelectorAll("a").length === 2, "there a press gets the links into Phantom and Solflare, as before");
  const wv = await notHere("an app's web view on Android (X's, Telegram's…): not loaded, the package does nothing there", { ua: WEBVIEW });
  await wv.press();
  line(!wv.mwaTag() && wv.note.querySelectorAll("a").length === 2, "and a press there gets the links");
  await notHere("a page that is not secure (http): not loaded", { ua: CHROME, secure: false });
  await notHere("a page with no wallet button: not loaded", { ua: CHROME, button: false });
  await notHere("a wallet injected in the browser (as inside Phantom's own): not loaded", { ua: CHROME, inject: { phantom: { solana: injected({ isPhantom: true }) } } });
  await notHere("a standard wallet in the browser already: not loaded", { ua: CHROME, before: [stdWallet("Phantom").w] });

  // a press: the first connect's card, the wallet app, and no app answering
  const early = phone();
  await early.press();
  line(!!early.mwaTag() && early.opened.length === 0, "a press before the page's load loads it at once; nothing opens until it has run");
  await early.runMwa();
  line(rowsOf(early) === CARD && early.doc.querySelector("#w-pick-h")?.textContent === "open your wallet" && early.opened.length === 0 && !dialogs(early).length,
    `then that press, the first connect on this phone, gets a card: the wallet app and the links into two wallets' browsers (${rowsOf(early)}); nothing opens yet`);
  tap(early);
  await later(50);
  line(early.opened.length === 1 && isAssoc(early.opened[0]) && !early.picker(), `a tap on the wallet app's row opens it, once (${early.opened[0]?.slice(0, 52)}…)`);
  await later(400);
  line(early.note.textContent === LINKS && early.note.querySelectorAll("a").length === 2 && early.W.current === null,
    `no wallet app answering: the package's own dialog does not come up, the note has wallet.js's links ("${early.note.textContent}")`);
  {
    const L = phone();
    await L.loaded(); await L.runMwa();
    await L.press();
    tap(L, 1);
    await later(50);
    line(L.opened.join() === browse && !L.picker() && L.W.current === null && !dialogs(L).length,
      "a tap on Open in Phantom takes the page into Phantom's browser; the package is not asked, so none of its dialogs come up");
  }

  // the browser's permission to reach apps on the phone, which the package asks about before it looks for one
  {
    const Q = phone({ perm: "prompt" });
    await Q.loaded(); await Q.runMwa();
    await Q.press();
    line(rowsOf(Q) === CARD && !dialogs(Q).length && Q.opened.length === 0, "that permission not asked yet: a press gets the card with the links first, none of the package's dialogs");
    tap(Q);
    await later(50);
    line(dialogs(Q).some((t) => t.includes("permission-prompt-mock")) && Q.opened.length === 0 && Q.note.textContent === "",
      "a tap on the wallet app: the package's dialog about it comes up, and nothing is opened yet");
    await Q.key("Escape");                               // closes the package's dialog
    await later(50);
    line(Q.note.textContent === "No wallet app was opened. Open this page in Phantom or Solflare." && Q.note.querySelectorAll("a").length === 2 && Q.W.current === null && Q.opened.length === 0,
      `closing that dialog: the links, not the package's words ("${Q.note.textContent}")`);
  }
  {
    const Q = phone({ perm: "denied" });
    await Q.loaded(); await Q.runMwa();
    await Q.press();
    tap(Q);
    await later(50);
    line(Q.note.textContent === "The browser did not let this page reach a wallet app. Open this page in Phantom or Solflare." && Q.note.querySelectorAll("a").length === 2 && Q.opened.length === 0,
      `that permission turned down: the links, at once ("${Q.note.textContent}")`);
    await Q.press();
    line(Q.note.querySelectorAll("a").length === 2 && rowsOf(Q) === CARD, "the next press gets the card again, the links on it too");
    await Q.key("Escape");
  }

  // a load that failed, and a second press while the wallet app is asked
  {
    const F = phone();
    await F.loaded();
    F.mwaTag().dispatchEvent(event("error", { bubbles: false }));
    await settle();
    line(!F.mwaTag(), "/vendor/mwa.js failing to load (a weak signal): its tag goes");
    await F.press();
    line(!!F.mwaTag() && F.note.textContent === "", "the next press asks for it again, and waits for it");
    await F.runMwa();
    line(rowsOf(F) === CARD, "once it has come, that press gets the card with the wallet app on it");
    await F.key("Escape");
    const E = phone();
    await E.loaded(); await E.runMwa();
    await E.press();
    tap(E);
    await later(30);
    await E.press();                                     // again, while the first connect waits for an app
    await later(30);
    line(E.opened.length === 1 && !E.picker() && E.note.textContent === "", "a second press while the wallet app is asked does nothing of its own: no second card, no error");
    await later(400);
    line(E.note.textContent === LINKS, "and the first connect ends as it would have");
  }
  const R = phone();
  let isReady = false;
  R.W.ready().then(() => { isReady = true; });
  await settle();
  line(!!R.mwaTag() && !isReady, "Wallet.ready() before the page's load loads it at once, and waits for it");
  await R.runMwa();
  line(isReady && R.names().join() === NAME, "then resolves, the Mobile Wallet Adapter listed");
  const D = page();
  let dReady = false;
  D.W.ready().then(() => { dReady = true; });
  await settle();
  line(dReady && !D.mwaTag(), "on a computer it resolves at once, loading nothing");

  // the next page: silently, from what the package keeps, never opening the app
  const addr = web3.Keypair.generate().publicKey.toBase58();
  const back = phone({ stored: NAME, local: kept(addr) });
  line(!!back.mwaTag(), "the wallet kept from the last page being the Mobile Wallet Adapter, it is loaded at once");
  await back.runMwa(); await settle();
  line(back.W.current?.name === NAME && String(back.W.current.publicKey) === addr && back.opened.length === 0,
    "and it reconnects silently from the authorization the package keeps on the phone: the wallet app is not opened");
  line(back.W.current?.label === "your wallet app", "a page names it to the visitor as their wallet app");
  const none = phone({ stored: NAME });
  await none.runMwa(); await later(50);
  line(none.W.current === null && none.opened.length === 0, "with nothing kept, the silent reconnect connects nothing and opens nothing");
  const main = phone({ stored: NAME, cluster: "mainnet", local: kept(addr) }), mainOf = grab(main);
  await main.runMwa(); await later(50);
  line(main.W.current === null && main.opened.length === 0 && main.disk.has(CACHE) && mainOf()?.chains.join() === "solana:mainnet" && main.names().join() === NAME,
    "a mainnet page registers it for solana:mainnet, and does not use (nor drop) a devnet authorization: nothing connects, nothing opens");
  const sendsOnly = phone({ stored: NAME, local: kept(addr, { signs: false }) });
  await sendsOnly.runMwa(); await later(50);
  line(sendsOnly.W.current === null && !sendsOnly.disk.has(CACHE) && sendsOnly.opened.length === 0,
    "a wallet app that only signs and sends (the page sends itself, through the site's server): left out, its authorization forgotten");

  // signing: from a press, or from a tap on the card
  {
    const built = await buyFor(back.W.current.publicKey);
    back.act.isActive = false;                           // the press that began the trade has gone stale (a read, a simulation)
    let res = settled(back.W.current.signTransaction(built.tx));
    await settle();
    const card = back.picker();
    line(!!card && back.doc.querySelector("#w-pick-h")?.textContent === "sign in your wallet" && card.querySelectorAll("button").length === 1 && card.querySelector("button").textContent === NAME && back.opened.length === 0,
      "a sign after the press went stale: a one-row card asks for a tap, and nothing opens");
    await back.key("Escape");
    let r = await res;
    line(r.e?.message === "Signing cancelled" && back.opened.length === 0, "closing it cancels the sign (the pages say nothing was sent); nothing opened");
    res = settled(back.W.current.signTransaction(built.tx));
    await settle();
    back.act.isActive = true;                            // the tap on the row is a fresh press
    back.picker().querySelector("button").dispatchEvent(event("click"));
    await later(50);
    line(back.opened.length === 1 && isAssoc(back.opened[0]), "a tap on the row opens the wallet app, once");
    r = await res;
    line(r.e?.missing === true && r.e.message === "No wallet app answered on this phone" && back.note.textContent === LINKS && back.W.current?.name === NAME,
      `no wallet app answering: the sign fails saying so ("${r.e?.message}"), the note has the links`);
    res = settled(back.W.current.signTransaction(built.tx));
    await later(50);
    line(!back.picker() && back.opened.length === 2, "with a fresh press, no card: the wallet app opens at once");
    await res;
    // the package letting go of the site while a sign is out: the page's disconnect, or the same inside the package
    // (a wallet app that turns down the authorization it kept); its sign would never settle
    const within = (p, ms) => Promise.race([settled(p), later(ms).then(() => ({ pending: true }))]);
    const going = within(back.W.current.signTransaction(built.tx), 1000);
    await later(20);
    await back.W.disconnect();
    r = await going;
    line(r.e?.message === "The wallet disconnected before it signed" && back.W.current === null && back.opened.length === 3,
      `the page disconnecting while the wallet app is asked to sign: the sign fails at once ("${r.e?.message ?? (r.pending ? "still pending" : "it signed")}"), so a trade button does not stay on Working…`);
    const again = phone({ stored: NAME, local: kept(addr) }), againOf = grab(again);
    await again.runMwa(); await settle();
    const going2 = within(again.W.current.signTransaction(built.tx), 1000);
    await later(20);
    await againOf().features["standard:disconnect"].disconnect();   // what the package does when its reauthorize fails
    r = await going2;
    line(r.e?.message === "The wallet disconnected before it signed" && again.W.current === null && !again.disk.has(CACHE) && again.button.textContent === "Connect wallet",
      "the package forgetting the authorization by itself in the middle of a sign: the same, and the page shows Connect wallet again");
  }

  // the coin page's hold button, the finger still down
  {
    const H = phone();
    await H.loaded(); await H.runMwa();
    const { doc, win } = H;
    const hold = doc.body.appendChild(doc.createElement("button")); hold.id = "hold";
    const label = hold.appendChild(doc.createElement("span"));
    hold.rect = { left: 16, right: 344, top: 500, bottom: 540, width: 328, height: 40 };
    const noteEl = doc.body.appendChild(doc.createElement("p"));
    const own = (name) => COIN.match(new RegExp(`\\n(?:async )?function ${name}\\(e?\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0] ?? "";
    Object.assign(win, { $: (sel) => doc.querySelector(sel), holdBtn: hold, noteEl, busy: false, HOLD_MS: 600, paintHold() {}, execute() {}, note: (text) => { noteEl.textContent = text; } });
    vm.runInContext(own("holdStart") + own("connectWallet"), win, { filename: "coin.html" });
    hold.addEventListener("pointerdown", win.holdStart);
    H.act.isActive = false;                              // a finger going down is not yet a press Chrome counts
    label.dispatchEvent(event("pointerdown", { pointerType: "touch", button: 0 }));
    await settle();
    line(rowsOf(H) === CARD && doc.querySelector("#w-pick-h")?.textContent === "open your wallet" && H.picker().style.top === `${hold.rect.bottom + 8}px` && H.opened.length === 0,
      "the coin page's hold button, the finger still down, the Mobile Wallet Adapter its only wallet: the card, links and all, under it; nothing opens");
    hold.dispatchEvent(event("pointerup"));
    doc.querySelector(".w-back")?.dispatchEvent(event("click"));
    await settle();
    line(!!H.picker() && H.opened.length === 0, "the rest of that tap neither closes it nor opens anything");
    H.act.isActive = true;
    H.picker().querySelector("button").dispatchEvent(event("click"));
    await later(50);
    line(H.opened.length === 1 && isAssoc(H.opened[0]), "a tap on the row opens the wallet app");
    await later(400);
    line(noteEl.textContent === LINKS && noteEl.querySelectorAll("a").length === 2 && H.note.textContent === LINKS,
      `no app answering: the coin page's note says why, with the links ("${noteEl.textContent}"), and so does the wallet note`);
  }

  // the picker, with another wallet beside it
  {
    const K = phone();
    await K.loaded(); await K.runMwa();
    const beta = stdWallet("Beta");
    announce(K.win, beta.w);                             // one that registers after the page (a browser's extension, say)
    line(K.names().join() === `${NAME},Beta`, `the Mobile Wallet Adapter beside another wallet (${K.names().join(", ")})`);
    await K.press();
    let rows = K.picker()?.querySelectorAll("button") ?? [];
    line(K.doc.querySelector("#w-pick-h")?.textContent === "choose a wallet" && rows.length === 2 && rows[0].textContent === NAME && rows[0].querySelector("img")?.src.startsWith("data:image/svg+xml") && rows[1].textContent === "Beta",
      "a press opens the picker: a row each, the Mobile Wallet Adapter's with its icon");
    rows[1].dispatchEvent(event("click"));
    await settle();
    line(K.W.current?.name === "Beta" && K.opened.length === 0, "choosing the other one connects it; no app opens");
    await K.press();                                     // disconnects
    await K.press();
    K.picker().querySelectorAll("button")[0].dispatchEvent(event("click"));
    await later(50);
    line(K.opened.length === 1 && isAssoc(K.opened[0]) && !K.picker(), "choosing the Mobile Wallet Adapter (a fresh tap) opens the wallet app at once, with no second card");
    await later(400);
    line(K.note.textContent === "No wallet app answered on this phone." && !K.note.querySelector("a") && K.W.current === null,
      `no app answering, with a wallet in the browser: "${K.note.textContent}", no links`);
  }

  // what the page does with a wallet app's signature: it sends it itself, through its node, never the wallet
  {
    const app = stdWallet(NAME);                         // as the package's wallet is to wallet.js, with one that signs
    let viaWallet = 0;
    app.w.features["solana:signAndSendTransaction"] = { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signAndSendTransaction: async () => { viaWallet++; return []; } };
    const T = phone({ before: [app.w] });
    await T.press();
    const asked = app.s.connects.length;
    tap(T);                                              // the first connect's card: the app's row
    await settle();
    line(T.W.current?.name === NAME && asked === 1 && app.s.connects.length === 2 && app.s.connects[0]?.silent === true && app.s.connects[1] === null,
      "a connect asks the package silently first (what it keeps opens nothing), then, from the card, for the app");
    T.act.isActive = false;
    const before = sent.length, built = await buyFor(T.W.current.publicKey);
    const going = settled(Chain.send(built, T.W.current));
    await settle();
    T.act.isActive = true;
    T.picker()?.querySelector("button").dispatchEvent(event("click"));
    const r = await going;
    const out = sent.length > before ? web3.Transaction.from(Buffer.from(sent.at(-1), "base64")) : null;
    line(typeof r.t === "string" && sent.length === before + 1 && out?.verifySignatures() && out.instructions.at(-1).programId.equals(MEMO) && viaWallet === 0,
      "after the tap it signs, and Chain.send sends what it signed through the page's node (the site's /api/rpc); signAndSend is never called");
  }
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
