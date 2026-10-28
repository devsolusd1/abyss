// The clusters the site's server talks to, and where each one's node comes from. The node's URL (a paid one carries
// its key in it) is only ever read from the environment: RPC_URL_DEVNET, RPC_URL_MAINNET (Vercel: Project, Settings,
// Environment Variables; on this machine: a .env.local file at the repo root, which git ignores). Without one, devnet
// uses the public node; mainnet has no public fallback (the public mainnet node is not for apps).
// The program ids must match site/net.js (server/check.mjs checks that they do).

export const CLUSTERS = {
  devnet: { rpcEnv: "RPC_URL_DEVNET", publicRpc: "https://api.devnet.solana.com", program: "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK", programEnv: "PROGRAM_DEVNET" },
  mainnet: { rpcEnv: "RPC_URL_MAINNET", publicRpc: "", program: "", programEnv: "PROGRAM_MAINNET" },
};

/** A node URL from the environment: quotes around it dropped, and only http(s); anything else counts as none. */
function nodeUrl(value) {
  const v = String(value ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  if (!v) return "";
  try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:" ? v : ""; } catch { return ""; }
}

/** { name, url, paid, program } for a cluster's name, or null for one the site does not know. */
export function clusterOf(name, env = {}) {
  const c = Object.prototype.hasOwnProperty.call(CLUSTERS, name) ? CLUSTERS[name] : null;
  if (!c) return null;
  const own = nodeUrl(env[c.rpcEnv]);
  return { name, url: own || c.publicRpc, paid: Boolean(own), program: String(env[c.programEnv] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2") || c.program };
}

export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/* base58, for addresses */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
/** The 32 bytes of an address in base58, or null when it is not one. */
export function addressBytes(text) {
  if (typeof text !== "string" || text.length < 32 || text.length > 44) return null;
  let n = 0n;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const ch of text) { if (ch !== "1") break; out.unshift(0); }
  return out.length === 32 ? Uint8Array.from(out) : null;
}

/** The caller's address, as Vercel and the local server pass it on. */
export function callerOf(request) {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : request.headers.get("x-real-ip") || "local").trim();
}

/**
 * A page on another site may not use this one's server (servers can still call it: the limits below are for them).
 * The site's own host is the one the request came to, as the request names it or as the edge passed it on.
 */
export function foreign(request) {
  // a browser says where a request comes from: another site (or an img or script tag on one) is refused
  const from = request.headers.get("sec-fetch-site");
  if (from && from !== "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let host;
  try { host = new URL(origin).host; } catch { return true; }
  const own = new Set([request.headers.get("host"), request.headers.get("x-forwarded-host")].filter(Boolean));
  try { own.add(new URL(request.url).host); } catch { /* the headers are enough */ }
  return !own.has(host);
}

/** Calls per window per caller, kept in this instance's memory (best effort: each instance counts its own). */
export class Limiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.seen = new Map(); this.sweep = 0; }
  take(who, n = 1, now = Date.now()) {
    if (++this.sweep % 500 === 0) for (const [k, list] of this.seen) if (!list.length || list[list.length - 1] <= now - this.windowMs) this.seen.delete(k);
    const list = (this.seen.get(who) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length + n > this.max) { this.seen.set(who, list); return false; }
    for (let i = 0; i < n; i++) list.push(now);
    this.seen.set(who, list);
    return true;
  }
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
