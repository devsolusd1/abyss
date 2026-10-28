// Which cluster and program the site talks to. Loaded before vendor/chain.js, and read by it,
// so switching cluster needs no rebuild. `?net=devnet` or `?net=mainnet` on any page overrides
// the default for the rest of that visit (sessionStorage), `?net=` alone goes back to it.
//
// Calls go through the site's own server (/api/rpc, /api/history: api/ and server/ at the repo root), which holds the
// node's address and key; a page served from a file, or `?rpc=direct`, talks to the public node instead. When the
// site's server does not answer, devnet falls back to the public node (fallbackRpc).
//
// Words for the pages, so their text follows the cluster:
//   NET.label  the tag on strips and kickers: "devnet" or "mainnet"
//   NET.place  where things are, in a sentence: "devnet" or "Solana" ("Coins on devnet.", "read from Solana")
//   NET.Place  the same, to start a sentence: "Devnet" or "Solana"
//   NET.test   true on a test cluster (play money, nothing here is worth anything)
//   NET.say(onTest, onMain)  picks one of two texts
// and in the HTML, filled as soon as this runs (deferred scripts run before DOMContentLoaded):
//   <span data-net="place">devnet</span>   gets NET.place (or label, Place); the text inside is what devnet shows
//   <x data-net-only="devnet">…</x>        is taken off the page on another cluster (data-net-only="mainnet" too;
//                                          write that one with the hidden attribute: it is shown on its cluster)
(function () {
  const NETS = {
    devnet: {
      cluster: "devnet",
      label: "devnet", place: "devnet", Place: "Devnet", test: true,
      publicRpc: "https://api.devnet.solana.com",
      program: "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK",
      explorer: (what, id) => `https://explorer.solana.com/${what}/${id}?cluster=devnet`,
    },
    mainnet: {
      cluster: "mainnet",
      label: "mainnet", place: "Solana", Place: "Solana", test: false,
      publicRpc: "",                                     // the public mainnet node is not for apps: the site's server only
      program: "",                                       // filled in once the program is deployed there
      explorer: (what, id) => `https://explorer.solana.com/${what}/${id}`,
    },
  };
  const known = (k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(NETS, k);
  let pick = "devnet", asked = null;
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.has("net")) asked = qs.get("net");
  } catch (e) {}
  if (asked !== null) {
    if (known(asked)) pick = asked;                      // asked for this page, whether or not it can be kept
    try { if (known(asked)) sessionStorage.setItem("nox.net", asked); else sessionStorage.removeItem("nox.net"); } catch (e) {}
  } else {
    try { const kept = sessionStorage.getItem("nox.net"); if (known(kept)) pick = kept; } catch (e) {}
  }
  const net = { ...NETS[pick] };
  let direct = false, origin = null;
  try {
    direct = new URLSearchParams(location.search).get("rpc") === "direct";
    if (/^https?:$/.test(location.protocol)) origin = location.origin;
  } catch (e) {}
  const viaServer = Boolean(origin && !direct);
  net.rpcUrl = viaServer ? `${origin}/api/rpc?cluster=${net.cluster}` : net.publicRpc;
  net.fallbackRpc = viaServer && net.publicRpc ? net.publicRpc : "";
  net.historyUrl = viaServer ? `${origin}/api/history?cluster=${net.cluster}` : "";
  net.priceUrl = viaServer ? `${origin}/api/price` : "";           // SOL in dollars, for the charts
  net.ready = Boolean(net.rpcUrl && net.program);
  net.say = (onTest, onMain) => (net.test ? onTest : onMain);
  window.NET = net;

  function fill() {
    document.querySelectorAll("[data-net]").forEach((el) => {
      const word = net[el.getAttribute("data-net")];
      if (typeof word === "string" && el.textContent !== word) el.textContent = word;
    });
    document.querySelectorAll("[data-net-only]").forEach((el) => {
      if (el.getAttribute("data-net-only") !== net.cluster) { el.hidden = true; el.style.display = "none"; }
      else if (el.hidden) el.hidden = false;           // written hidden, so it does not flash on the other cluster
    });
  }
  net.fill = fill;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fill); else fill();
  }
})();
