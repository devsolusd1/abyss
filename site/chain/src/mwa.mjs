// The wallet apps on an Android phone, for the phone's own browser (Chrome and the like): Solana Mobile's Mobile
// Wallet Adapter, which hands a transaction to Phantom, Solflare or any wallet app that speaks it and gets it back
// signed, with the visitor still in the browser. Bundled by build-mwa.mjs into ../vendor/mwa.js (window.NoxMwa),
// which ../assets/wallet.js loads only where it can help: Android, no wallet in the browser already, a page with a
// wallet button. wallet.js then calls NoxMwa.register with its cluster and its links.
//
// What register() puts in the Wallet Standard (where wallet.js listens) is the package's own wallet, named
// "Mobile Wallet Adapter", set up as follows:
//   - the site as the wallet app shows it: "Nox", this origin, and the icon a page names with
//     <link rel="apple-touch-icon"> (a path on this origin, fetched by the wallet app; the favicon the pages draw
//     is a data: URL, which the protocol does not take), or none
//   - one chain: the page's cluster
//   - the package's own authorization cache (localStorage, on the phone), read only for that chain: an
//     authorization given on a devnet page is not used on a mainnet one, which asks again
//   - when no wallet app answers, `notFound` (wallet.js's links into Phantom and Solflare) in place of the
//     package's own dialog, whose button leads to a page elsewhere
//   - no remote mode (the QR code for a computer): registerMwa only does that given a relay, and none is given.
// registerMwa itself registers nothing outside a secure page on Android, nor in an app's web view.

import { createDefaultAuthorizationCache, registerMwa } from "@solana-mobile/wallet-standard-mobile";

let done = false;

/** The icon a page names for phones, as a path on this origin; null when there is none (or it is elsewhere). */
function iconPath() {
  try {
    const link = document.querySelector('link[rel~="apple-touch-icon"][href]');
    if (!link) return null;
    const url = new URL(link.getAttribute("href"), location.href);
    return url.origin === location.origin ? url.pathname.replace(/^\/+/, "") + url.search : null;
  } catch (e) {
    return null;
  }
}

/** The default cache, its authorization kept only for `chain`. */
function cacheFor(chain) {
  const base = createDefaultAuthorizationCache();
  return {
    clear: () => base.clear(),
    get: async () => {
      const a = await base.get();
      return a && a.chain === chain ? a : undefined;
    },
    set: (a) => base.set(a),
  };
}

/**
 * Registers the Mobile Wallet Adapter, once. `chain`: "solana:devnet" or "solana:mainnet"; `notFound`: called when
 * no wallet app on the phone answered.
 */
export function register({ chain, notFound } = {}) {
  if (done) return;
  done = true;
  if (chain !== "solana:devnet" && chain !== "solana:mainnet") chain = "solana:devnet";
  const appIdentity = { name: "Nox", uri: location.origin };
  const icon = iconPath();
  if (icon) appIdentity.icon = icon;
  registerMwa({
    appIdentity,
    chains: [chain],
    authorizationCache: cacheFor(chain),
    onWalletNotFound: async () => { try { if (typeof notFound === "function") notFound(); } catch (e) {} },
  });
}
