// The wallet every page shares. Any element with [data-wallet] becomes the connect button:
// it shows "Connect wallet", the short address once connected, and disconnects on a second
// press. Pages read window.Wallet.current ({ name, publicKey, signTransaction }) and listen
// with Wallet.on(fn), which is called with the wallet or null whenever it changes.
//
// Loaded after vendor/chain.js (deferred). A wallet the visitor already trusted on this site
// reconnects silently on the next page.
(function () {
  "use strict";
  var listeners = [];
  var W = (window.Wallet = { current: null });

  function short(k) { var s = String(k); return s.slice(0, 4) + "…" + s.slice(-4); }

  function paint() {
    var cur = W.current;
    document.querySelectorAll("[data-wallet]").forEach(function (b) {
      b.textContent = cur ? short(cur.publicKey) : (b.getAttribute("data-label") || "Connect wallet");
      b.setAttribute("aria-label", cur ? "Wallet " + cur.publicKey.toString() + ", press to disconnect" : "Connect a Solana wallet");
      b.classList.toggle("on", !!cur);
    });
  }

  function set(w) {
    W.current = w;
    try { if (w) sessionStorage.setItem("brasa.wallet", w.name); else sessionStorage.removeItem("brasa.wallet"); } catch (e) {}
    paint();
    listeners.forEach(function (fn) { try { fn(w); } catch (e) {} });
  }

  W.on = function (fn) { listeners.push(fn); };

  W.connect = async function (name) {
    if (!window.Chain) throw new Error("The chain layer did not load");
    var w = await Chain.connect(name);
    set(w);
    var list = Chain.wallets(), found = list.find(function (x) { return x.name === w.name; });
    if (found && found.provider.on) {
      found.provider.on("disconnect", function () { set(null); });
      found.provider.on("accountChanged", function (pk) {
        if (!pk) { set(null); return; }
        set({ name: w.name, publicKey: new Chain.PublicKey(pk.toString()), signTransaction: w.signTransaction, disconnect: w.disconnect });
      });
    }
    return w;
  };

  W.disconnect = async function () {
    var cur = W.current;
    set(null);
    try { if (cur && cur.disconnect) await cur.disconnect(); } catch (e) {}
  };

  /** Shows a short message next to the buttons, then clears it. */
  function say(text) {
    document.querySelectorAll("[data-wallet-note]").forEach(function (el) {
      el.textContent = text;
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.textContent = ""; }, 5000);
    });
  }
  W.say = say;

  async function silent() {
    var name = null;
    try { name = sessionStorage.getItem("brasa.wallet"); } catch (e) {}
    if (!name || !window.Chain) return;
    var found = Chain.wallets().find(function (x) { return x.name === name; });
    if (!found) return;
    try {
      var res = await found.provider.connect({ onlyIfTrusted: true });
      var pk = (res && res.publicKey) || found.provider.publicKey;
      if (!pk) return;
      set({
        name: found.name,
        publicKey: new Chain.PublicKey(pk.toString()),
        signTransaction: function (tx) { return found.provider.signTransaction(tx); },
        disconnect: function () { return found.provider.disconnect && found.provider.disconnect(); },
      });
    } catch (e) {}
  }

  document.addEventListener("DOMContentLoaded", function () {
    paint();
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-wallet]");
      if (!b) return;
      e.preventDefault();
      if (W.current) { W.disconnect(); return; }
      if (!window.Chain || !Chain.wallets().length) { say("No Solana wallet in this browser. Phantom, Solflare or Backpack work."); return; }
      W.connect().catch(function (err) { say(err && err.message ? err.message : "The wallet did not connect."); });
    });
    silent();
  });
})();
