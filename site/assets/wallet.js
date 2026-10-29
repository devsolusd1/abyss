// The wallet every page shares. Any element with [data-wallet] becomes the connect button:
// it shows "Connect wallet", the short address once connected, and disconnects on a second
// press. Pages read window.Wallet.current ({ name, icon?, publicKey, signTransaction }) and listen
// with Wallet.on(fn), which is called with the wallet or null whenever it changes.
//
// Wallets are found two ways. First the Wallet Standard (its two events, written here by hand),
// keeping the wallets that sign Solana transactions on this page's cluster. Then, as a fallback,
// the objects older wallets put on the window (Chain.wallets()); a wallet that comes both ways is
// listed once. With one wallet a press connects it; with more, a small picker asks which. On a
// phone with no wallet in its browser, the note links to this page opened inside Phantom or
// Solflare, whose own browsers carry the wallet.
//
// On Android, the phone's own browser (Chrome and the like) also gets the wallet apps on the
// phone, through Solana Mobile's Mobile Wallet Adapter (vendor/mwa.js, loaded here only when it
// can help): one more standard wallet, "Mobile Wallet Adapter", which opens the wallet app to
// connect and to sign. The first connect on a phone puts it on a card beside the links into
// Phantom and Solflare, so a visitor with no wallet app is not walked through its dialogs first.
// Opening an app takes a press of the visitor's, so a call that comes too long after one (a
// trade read and simulated first) asks for a tap on a one-row card. A page that reads
// Wallet.list() on a press can wait for Wallet.ready(), which resolves once it is listed (at
// once where it does not apply). iOS has no such thing: there the links stay.
//
// Loaded after vendor/chain.js (deferred). A wallet the visitor already trusted on this site
// reconnects silently on the next page.
(function () {
  "use strict";
  var listeners = [];
  var W = (window.Wallet = { current: null });
  var KEY = "brasa.wallet";
  var src = null;                                        // what W.current came from: a standard wallet or an injected provider
  var unfollow = null;                                   // stops following its account changes

  /* ---------- the Wallet Standard ---------- */
  // A wallet that loads after this file sends "wallet-standard:register-wallet" with a function to
  // call with { register }; one that loaded before it waits for "wallet-standard:app-ready", which
  // carries { register }. Either way it ends up in `registered`, once.
  var registered = [], onRegister = [];
  var api = Object.freeze({
    register: function () {
      var added = [];
      for (var i = 0; i < arguments.length; i++) {
        var w = arguments[i];
        if (w && typeof w === "object" && registered.indexOf(w) < 0) { registered.push(w); added.push(w); }
      }
      onRegister.slice().forEach(function (fn) { try { fn(); } catch (e) {} });
      return function unregister() {
        added.forEach(function (w) { var i = registered.indexOf(w); if (i >= 0) registered.splice(i, 1); });
      };
    },
  });
  try {
    window.addEventListener("wallet-standard:register-wallet", function (e) {
      try { if (typeof e.detail === "function") e.detail(api); } catch (err) {}
    });
  } catch (e) {}
  try { window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api })); } catch (e) {}

  /** This page's cluster, as the Wallet Standard names it. */
  function chainId() { return "solana:" + (window.NET && NET.cluster === "mainnet" ? "mainnet" : "devnet"); }

  /** A standard wallet this page can use: it signs legacy transactions (what the site builds) on this cluster. */
  function usable(w) {
    var f = w.features, sign = f && f["solana:signTransaction"];
    if (!sign || typeof sign.signTransaction !== "function") return false;
    var v = sign.supportedTransactionVersions;
    if (Array.isArray(v) && v.indexOf("legacy") < 0) return false;
    return Array.isArray(w.chains) && w.chains.indexOf(chainId()) >= 0;
  }

  /** A wallet's icon, only as the standard has it: an image in a data: URL (nothing is fetched from elsewhere). */
  function iconOf(s) { return typeof s === "string" && /^data:image\/(svg\+xml|png|webp|gif|jpeg);/.test(s) ? s : null; }

  /** Every wallet this page can use, each once, standard ones first: { name, icon, std } or { name, icon, provider }. */
  function found() {
    var out = [], seen = {};
    registered.forEach(function (w) {
      var name = String(w.name || "").trim(), k = name.toLowerCase();
      if (!name || seen[k] || !usable(w)) return;
      seen[k] = 1;
      out.push({ name: name, icon: iconOf(w.icon), std: w });
    });
    var old = [];
    try { if (window.Chain) old = Chain.wallets(); } catch (e) {}
    old.forEach(function (x) {
      var k = x.name.toLowerCase();
      // the nameless window.solana ("Wallet") is most likely one of the standard ones
      if (seen[k] || (x.name === "Wallet" && out.length)) return;
      seen[k] = 1;
      out.push({ name: x.name, icon: null, provider: x.provider });
    });
    return out;
  }
  function byName(name, list) {
    var k = String(name).toLowerCase();
    return (list || found()).find(function (x) { return x.name.toLowerCase() === k; }) || null;
  }
  /** The wallets this page can use: [{ name, icon }]. */
  W.list = function () { return found().map(function (x) { return { name: x.name, icon: x.icon }; }); };

  /* ---------- connecting ---------- */

  function stop() { if (unfollow) { try { unfollow(); } catch (e) {} } unfollow = null; }

  function short(k) { var s = String(k); return s.slice(0, 4) + "…" + s.slice(-4); }

  function paint() {
    var cur = W.current;
    document.querySelectorAll("[data-wallet]").forEach(function (b) {
      b.textContent = cur ? short(cur.publicKey) : (b.getAttribute("data-label") || "Connect wallet");
      b.setAttribute("aria-label", cur ? "Wallet " + cur.publicKey.toString() + ", press to disconnect" : "Connect a Solana wallet");
      b.classList.toggle("on", !!cur);
    });
  }

  function set(w, from) {
    W.current = w;
    if (!w) stop();
    src = w ? from : null;
    if (w) noAnswer = null;
    try { if (w) sessionStorage.setItem(KEY, w.name); else sessionStorage.removeItem(KEY); } catch (e) {}
    if (w) document.querySelectorAll("[data-wallet-note]").forEach(function (el) { if (el._missing) { el._missing = false; el.textContent = ""; } });
    paint();
    listeners.forEach(function (fn) { try { fn(w); } catch (e) {} });
  }

  W.on = function (fn) { listeners.push(fn); };

  /** The account to use: the first one on this cluster, or else the first (the key is the same on every cluster). */
  function accountOf(accounts) {
    var list = Array.isArray(accounts) ? accounts.filter(function (a) { return a && typeof a.address === "string"; }) : [];
    return list.find(function (a) { return Array.isArray(a.chains) && a.chains.indexOf(chainId()) >= 0; }) || list[0] || null;
  }

  /**
   * The page's wallet for a standard wallet's account. `held.account` is the account it signs with: a change event
   * hands over a new object for the same account, and that one is used from then on.
   */
  function adapter(w, held) {
    return {
      name: String(w.name).trim(),
      label: isMwa(w) ? "your wallet app" : String(w.name).trim(),   // the wallet as a page names it to the visitor
      icon: iconOf(w.icon),
      publicKey: new Chain.PublicKey(held.account.address),
      // The wallet gets the bytes (the site's own signers, if any, signed already) and gives back the signed
      // transaction's bytes. It may have added to it, so what is sent is what came back, not what went out.
      // It only signs: the page sends (Chain.send, through the site's server), whatever else the wallet offers.
      signTransaction: async function (tx) {
        var bytes = new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
        if (isMwa(w) && !(await pressFor(w, "sign in your wallet"))) throw new Error("Signing cancelled");
        var sign = w.features["solana:signTransaction"], out;
        if (!sign) throw new Error("The wallet does not sign transactions here");
        try {
          var asked = sign.signTransaction({ account: held.account, transaction: bytes, chain: chainId() });
          out = await (isMwa(w) ? untilLetGo(w, asked) : asked);
        } catch (e) { throw lost(e); }
        var signed = out && out[0] && out[0].signedTransaction;
        if (!signed || !signed.length) throw new Error("The wallet gave nothing back");
        return Chain.Transaction.from(signed);
      },
      disconnect: function () { var d = w.features["standard:disconnect"]; return d && d.disconnect(); },
    };
  }

  /**
   * Connects a standard wallet (silently: only if this site is trusted already) and follows its account. Resolves
   * with the page's wallet, or null (silently: not trusted; the Mobile Wallet Adapter: its card closed unchosen).
   */
  async function connectStd(w, silently) {
    var c = w.features["standard:connect"], accounts = w.accounts;
    if (c && typeof c.connect === "function") {
      if (silently) accounts = (await c.connect({ silent: true })).accounts;
      else if (isMwa(w)) { accounts = await connectMwa(w, c); if (!accounts) return null; }
      else accounts = (await c.connect(undefined)).accounts;
    }
    if (silently && W.current) return null;              // the visitor connected one in the meantime
    // the Mobile Wallet Adapter learns from the wallet app what it can do: one that only signs and sends is of no use
    if (!usable(w)) {
      try { var d = w.features["standard:disconnect"]; if (d) await d.disconnect(); } catch (e) {}
      if (silently) return null;
      throw new Error("The wallet does not sign transactions here");
    }
    var a = accountOf(accounts);
    if (!a) { if (silently) return null; throw new Error("The wallet shared no account"); }
    var held = { account: a };
    stop();
    set(adapter(w, held), w);
    var ev = w.features["standard:events"];
    if (ev && typeof ev.on === "function") {
      // another account in the same wallet, or none (it disconnected)
      var off = ev.on("change", function (props) {
        if (src !== w || !props) return;
        if (props.features && !usable(w)) { set(null); return; }   // it no longer signs here
        if (!props.accounts) return;
        var next = accountOf(props.accounts);
        if (!next) { set(null); return; }
        if (next.address === held.account.address) { held.account = next; return; }
        held = { account: next };
        set(adapter(w, held), w);
      });
      unfollow = typeof off === "function" ? off : null;
    }
    return W.current;
  }

  /** Follows an injected provider's account changes, as older wallets announce them. */
  function followOld(name, provider, w) {
    if (!provider.on) return;
    var gone = function () { if (src === provider) set(null); };
    var moved = function (pk) {
      if (src !== provider) return;
      if (!pk) { set(null); return; }
      set({ name: name, publicKey: new Chain.PublicKey(pk.toString()), signTransaction: w.signTransaction, disconnect: w.disconnect }, provider);
    };
    provider.on("disconnect", gone);
    provider.on("accountChanged", moved);
    unfollow = function () {
      var off = provider.off || provider.removeListener;
      if (typeof off === "function") { off.call(provider, "disconnect", gone); off.call(provider, "accountChanged", moved); }
    };
  }

  async function connectOld(x) {
    var w = await Chain.connect(x.name);
    stop();
    set(w, x.provider);
    followOld(x.name, x.provider, w);
    return w;
  }

  /**
   * Connects the named wallet; with no name, the only one, or the one the visitor picks (the picker opens under
   * `at`, or else under the button just pressed). Resolves with the wallet, or null when the picker was closed unchosen.
   */
  W.connect = async function (name, at) {
    if (!window.Chain) throw new Error("The chain layer did not load");
    var list = found();
    if (!list.length) throw new Error("No Solana wallet found in this browser");
    var x = name ? byName(name, list) : list.length === 1 ? list[0] : await choose(list, at);
    if (!x) { if (name) throw new Error(name + " is not in this browser"); return null; }
    return x.std ? connectStd(x.std, false) : connectOld(x);
  };

  W.disconnect = async function () {
    var cur = W.current;
    set(null);
    try { if (cur && cur.disconnect) await cur.disconnect(); } catch (e) {}
  };

  /* ---------- the picker: a small card under the button, one row per wallet ---------- */

  var pick = null;                                       // the open one: { el, back, at, done, before }

  // The button pressed last, by a pointer or by Enter or Space. A page that asks for the picker without naming its
  // button gets it under this one: focus does not say which, since a press with the default prevented (the coin
  // page's hold button) or a click in Safari leaves focus where it was.
  var pressed = null;
  function pressOn(e) { var t = e.target; pressed = t && t.closest ? t.closest("button, a") : null; }
  document.addEventListener("pointerdown", pressOn, true);
  document.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") pressOn(e); }, true);
  function lastPressed() { return pressed && document.contains(pressed) ? pressed : null; }

  /** Opens the picker (headed `title`, or "choose a wallet") and resolves with the chosen wallet, or null when it closes unchosen. */
  function choose(list, at, title) {
    close(null);
    return new Promise(function (done) {
      var back = document.createElement("div"), el = document.createElement("div");
      back.className = "w-back";                         // a press outside the card lands here and closes it
      el.className = "w-pick";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");             // the clear layer under it takes the page's presses, and Tab stays in it
      el.setAttribute("aria-labelledby", "w-pick-h");
      var h = document.createElement("p");
      h.className = "kick"; h.id = "w-pick-h"; h.textContent = title || "choose a wallet";
      var ul = document.createElement("ul");
      list.forEach(function (x) {
        var li = document.createElement("li"), b = document.createElement("button"), mark, label = document.createElement("span");
        b.type = "button";
        if (x.icon) { mark = document.createElement("img"); mark.src = x.icon; mark.alt = ""; mark.width = 20; mark.height = 20; }
        else mark = document.createElement("i");         // a wallet with no icon of its own
        label.textContent = x.name;
        b.appendChild(mark); b.appendChild(label);
        b.addEventListener("click", function () { close(x); });
        li.appendChild(b); ul.appendChild(li);
      });
      el.appendChild(h); el.appendChild(ul);
      // A press outside closes it, if it began after the card was up. The press that opened it may end here: a tap
      // on a phone has its click land on this layer, where the finger was, and that click must not close it again.
      var armed = typeof window.PointerEvent === "undefined";
      back.addEventListener("pointerdown", function () { armed = true; });
      back.addEventListener("click", function () { if (armed) close(null); });
      // focus moved elsewhere by the page closes it; a press that focuses nothing (Safari's buttons) does not
      el.addEventListener("focusout", function (e) { if (pick && pick.el === el && e.relatedTarget && !el.contains(e.relatedTarget)) close(null, true); });
      document.body.appendChild(back);
      document.body.appendChild(el);
      pick = { el: el, back: back, at: at || lastPressed() || document.querySelector("[data-wallet]"), done: done, before: document.activeElement };
      place();
      var first = el.querySelectorAll("button")[0];
      if (first) first.focus();
    });
  }

  /** Closes the picker with the chosen wallet, or null; focus goes back where it was, unless it moved on already. */
  function close(choice, moved) {
    if (!pick) return;
    var p = pick;
    pick = null;
    p.el.remove(); p.back.remove();
    if (!moved && p.before && p.before !== document.body && p.before.focus) { try { p.before.focus(); } catch (e) {} }
    p.done(choice);
  }

  // Escape closes it wherever focus is; the arrows, Home and End move between its rows. Tab and Shift+Tab go round
  // them too: the card is the last thing on the page, so a Tab out of it would take focus off the page and then
  // to the links behind it, with the card still up.
  document.addEventListener("keydown", function (e) {
    if (!pick) return;
    if (e.key === "Escape") { e.preventDefault(); close(null); return; }
    // Enter or Space held down since before the card opened (on the coin page's hold button, say) repeats on its
    // first row; a repeat chooses nothing
    if (e.repeat && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); return; }
    var all = Array.prototype.slice.call(pick.el.querySelectorAll("button")), i = all.indexOf(document.activeElement);
    if (e.key === "Tab" && all.length) {
      e.preventDefault();
      all[i < 0 ? (e.shiftKey ? all.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
      return;
    }
    if (i < 0) return;
    var to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    all[(to + all.length) % all.length].focus();
  });

  /** Puts the card under its button (above it when there is no room below), inside the window's 16 px edges. */
  function place() {
    if (!pick) return;
    var el = pick.el, r = pick.at && pick.at.getBoundingClientRect ? pick.at.getBoundingClientRect() : null;
    var vw = document.documentElement.clientWidth || window.innerWidth || 0, vh = window.innerHeight || 0;
    var w = el.offsetWidth, h = el.offsetHeight, edge = 16, x, y;
    if (r && (r.width || r.height)) {
      x = r.left + r.width / 2 > vw / 2 ? r.right - w : r.left;
      y = r.bottom + 8 + h <= vh - 8 || r.top - 8 - h < 8 ? r.bottom + 8 : r.top - 8 - h;
    } else { x = (vw - w) / 2; y = (vh - h) / 2; }
    el.style.left = Math.round(Math.max(edge, Math.min(x, vw - w - edge))) + "px";
    el.style.top = Math.round(Math.max(8, Math.min(y, vh - h - 8))) + "px";
  }
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);

  /* ---------- notes ---------- */

  /** Shows a short message next to the buttons, then clears it. */
  function say(text) {
    document.querySelectorAll("[data-wallet-note]").forEach(function (el) {
      el._missing = false;
      el.textContent = text;
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.textContent = ""; }, 5000);
    });
  }
  W.say = say;

  /** A phone or a tablet: its main pointer is a finger. */
  function touch() {
    try { if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return true; } catch (e) {}
    return /Android|iPhone|iPad|iPod/i.test((window.navigator && navigator.userAgent) || "");
  }

  /**
   * On a touch device with no wallet in this browser (the phone's wallet apps, through the Mobile Wallet Adapter, do
   * not count): links that open this page inside a wallet's own browser. Otherwise [].
   */
  W.openIn = function () {
    if (found().some(function (x) { return !isMwa(x.std); }) || !touch()) return [];
    var url = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
    return [
      { name: "Phantom", href: "https://phantom.app/ul/browse/" + url + "?ref=" + ref },
      { name: "Solflare", href: "https://solflare.com/ul/v1/browse/" + url + "?ref=" + ref },
    ];
  };

  var noAnswer = null;                                   // the phone's wallet apps were asked last, and not reached: why, said

  /**
   * Says there is no wallet in this browser (or, the phone's wallet apps asked, that none was reached), in `el` or in
   * every [data-wallet-note]; on a phone, with the links of Wallet.openIn(). It stays until a wallet connects.
   */
  W.missing = function (el) {
    var links = W.openIn(), lead = noAnswer ? noAnswer + "." : null, first = lead || "No Solana wallet in this browser.";
    (el ? [el] : Array.prototype.slice.call(document.querySelectorAll("[data-wallet-note]"))).forEach(function (n) {
      clearTimeout(n._t);
      n._missing = true;
      n.textContent = "";
      if (!links.length) { n.textContent = lead || first + " Phantom, Solflare or Backpack work."; return; }
      n.appendChild(document.createTextNode(first + " Open this page in "));
      links.forEach(function (l, i) {
        var a = document.createElement("a");
        a.href = l.href; a.textContent = l.name;
        n.appendChild(a);
        n.appendChild(document.createTextNode(i < links.length - 1 ? " or " : "."));
      });
    });
  };

  /* ---------- the phone's wallet apps: the Mobile Wallet Adapter, on Android ---------- */
  // vendor/mwa.js (chain/src/mwa.mjs) registers the package's wallet in the Wallet Standard, where found() sees it.
  // It is loaded only where it can help: Android's own browser on a secure page (not an app's web view, where the
  // package does nothing), with no wallet in this browser already (inside Phantom's own browser, say), on a page with
  // a wallet button; and once the page has loaded, so that it delays nothing. A press before that, or the wallet kept
  // from the last page, loads it at once. A load that failed (a weak signal) is tried again on the next press.

  var MWA = "Mobile Wallet Adapter";                     // the name the package gives its wallet
  var mwaLoad = null;                                    // its loading, under way or done: resolves either way
  var mwaGoing = false;                                  // a connect out to the wallet app, not settled yet

  function isMwa(w) { return !!w && w.name === MWA; }

  /** Android's own browser, on a secure page: a web view (X's, Telegram's…) cannot reach the wallet apps, Solana Mobile's own shell can. */
  function android() {
    var ua = (window.navigator && navigator.userAgent) || "";
    if (!/android/i.test(ua) || !window.isSecureContext) return false;
    return ua.indexOf("Solana Mobile Web Shell") >= 0 || !/(WebView|Version\/.+(Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+)|; wv\).+(Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+))/i.test(ua);
  }

  function wantMwa() { return android() && !!document.querySelector("[data-wallet]") && !found().length; }

  function loadMwa() {
    if (mwaLoad) return mwaLoad;
    mwaLoad = new Promise(function (done) {
      var s = document.createElement("script");
      s.src = "/vendor/mwa.js";
      s.async = true;
      s.addEventListener("load", function () {
        try { window.NoxMwa.register({ chain: chainId(), notFound: noApp }); } catch (e) {}
        done();
      });
      s.addEventListener("error", function () { s.remove(); mwaLoad = null; done(); });
      (document.head || document.body).appendChild(s);
    });
    return mwaLoad;
  }

  // The package's failures before any wallet app answered, as the note and the error say them: none answered (the
  // package calls notFound first), the browser kept this page from them (its permission for apps on this device,
  // turned down), or none was opened (the package's own dialog about that permission closed, or 30 s went by).
  var UNREACHED = {
    ERROR_WALLET_NOT_FOUND: "No wallet app answered on this phone",
    ERROR_LOOPBACK_ACCESS_BLOCKED: "The browser did not let this page reach a wallet app",
    ERROR_ASSOCIATION_CANCELLED: "No wallet app was opened",
  };

  /** What the package calls when no wallet app on the phone answered: the note, with the links, in every [data-wallet-note]. */
  function noApp() { noAnswer = UNREACHED.ERROR_WALLET_NOT_FOUND; W.missing(); }

  /**
   * Resolves once the phone's wallet apps are in Wallet.list(), or there are none to come here (at once, but for
   * Android's own browser while vendor/mwa.js loads): a page that reads Wallet.list() on a press can wait for it.
   */
  W.ready = function () { return wantMwa() ? loadMwa() : Promise.resolve(); };

  /**
   * A failure of the package's before any wallet app answered: the links go up in every [data-wallet-note], and it
   * comes back as an error that says why, with .missing (a page leaves the note to them). Any other as it is.
   */
  function lost(err) {
    for (var e = err, i = 0; e && i < 6; e = e.cause, i++) {
      if (typeof e.code === "string" && Object.prototype.hasOwnProperty.call(UNREACHED, e.code)) {
        noAnswer = UNREACHED[e.code];
        W.missing();
        var out = new Error(noAnswer); out.missing = true; return out;
      }
    }
    return err;
  }

  /**
   * `p`, the Mobile Wallet Adapter's sign, unless the package lets go of this site first: when it forgets its
   * authorization (the page disconnected, or the wallet app turned down the one it kept) it tells its listeners there
   * are no accounts, and a sign under way then never settles, which would hold a page's trade on "Working…".
   */
  function untilLetGo(w, p) {
    var ev = w.features["standard:events"], off = null;
    if (!ev || typeof ev.on !== "function") return p;
    var gone = new Promise(function (_, fail) {
      off = ev.on("change", function (props) {
        if (props && Array.isArray(props.accounts) && !props.accounts.length) fail(new Error("The wallet disconnected before it signed"));
      });
    });
    return Promise.race([p, gone]).finally(function () { if (typeof off === "function") off(); });
  }

  /**
   * Whether the visitor's last press still lets the page open another app (Chrome allows it for a few seconds); true
   * where the browser does not tell.
   */
  function fresh() {
    var act = window.navigator && navigator.userActivation;
    return !act || typeof act.isActive !== "boolean" || act.isActive;
  }

  /**
   * Whether the Mobile Wallet Adapter may open the wallet app now: at once after a fresh press, or else once the
   * visitor taps the wallet on a card (headed `title`) under the button pressed last. `links` (Wallet.openIn()'s) go
   * on the card as rows of their own, and then it comes up after a fresh press too: a tap on one opens this page in
   * that wallet's browser. False when the card closes unchosen, or a link was taken.
   */
  async function pressFor(w, title, links) {
    links = links || [];
    if (!links.length && fresh()) return true;
    var rows = [{ name: String(w.name).trim(), icon: iconOf(w.icon), std: w }].concat(links.map(function (l) { return { name: "Open in " + l.name, icon: null, href: l.href }; }));
    var x = await choose(rows, null, title);
    if (x && x.href) { location.assign(x.href); return false; }
    return !!x;
  }

  /**
   * The Mobile Wallet Adapter's connect. The authorization the package keeps on the phone for this cluster first,
   * silently (it opens nothing); else the wallet app, from a press. Resolves with the accounts, or null when the card
   * closed unchosen, a link on it was taken, or another connect is still out (a second press while the app is asked).
   */
  async function connectMwa(w, c) {
    if (mwaGoing) return null;
    mwaGoing = true;
    try {
      var kept = (await c.connect({ silent: true })).accounts;
      if (kept && kept.length) return kept;
      // the first time on this phone, with no other wallet in the browser: the card, with the links into Phantom's and
      // Solflare's browsers beside the wallet app. The package asks for the browser's permission to reach apps on this
      // device before it looks for one, in dialogs of its own; a visitor with no wallet app is spared them, and one with
      // Phantom may rather take its browser
      if (!(await pressFor(w, "open your wallet", W.openIn()))) return null;
      try { return (await c.connect()).accounts; } catch (e) { throw lost(e); }
    } finally { mwaGoing = false; }
  }

  /* ---------- the next page: the same wallet, silently ---------- */

  /** A wallet registered by now, or within `ms` (a standard wallet may register after this page loaded). */
  function soon(name, ms) {
    var x = byName(name);
    if (x) return Promise.resolve(x);
    return new Promise(function (done) {
      var t = setTimeout(function () { end(null); }, ms);
      function look() { var y = byName(name); if (y) end(y); }
      function end(v) { clearTimeout(t); var i = onRegister.indexOf(look); if (i >= 0) onRegister.splice(i, 1); done(v); }
      onRegister.push(look);
    });
  }

  async function silent() {
    var name = null;
    try { name = sessionStorage.getItem(KEY); } catch (e) {}
    if (!name || !window.Chain) return;
    if (name === MWA && wantMwa()) await loadMwa();      // the phone's wallet apps: their script at once
    var x = await soon(name, 3000);
    if (!x || W.current) return;                         // gone, or the visitor connected in the meantime
    try {
      if (x.std) { await connectStd(x.std, true); return; }
      var res = await x.provider.connect({ onlyIfTrusted: true });
      var pk = (res && res.publicKey) || x.provider.publicKey;
      if (!pk || W.current) return;
      var w = {
        name: x.name,
        publicKey: new Chain.PublicKey(pk.toString()),
        signTransaction: function (tx) { return x.provider.signTransaction(tx); },
        disconnect: function () { return x.provider.disconnect && x.provider.disconnect(); },
      };
      set(w, x.provider);
      followOld(x.name, x.provider, w);
    } catch (e) {}
  }

  /** A press on a wallet button with no wallet connected; the phone's wallet apps first, if their script is still to come. */
  async function walletPress(b) {
    if (wantMwa()) await loadMwa();
    if (!found().length) { W.missing(); return; }
    // the phone's wallet apps not reached have put the links in the note already
    W.connect(null, b).catch(function (err) { if (!(err && err.missing)) say(err && err.message ? err.message : "The wallet did not connect."); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    paint();
    document.addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest("[data-wallet]") : null;
      if (!b) return;
      e.preventDefault();
      if (W.current) { W.disconnect(); return; }
      walletPress(b);
    });
    if (wantMwa()) {
      var later = function () { if (wantMwa()) loadMwa(); };
      if (document.readyState === "complete") later(); else window.addEventListener("load", later);
    }
    silent();
  });
})();
