// The clusters the site's server talks to, and where each one's node comes from. The node's URL (a paid one carries
// its key in it) is only ever read from the environment: RPC_URL_DEVNET, RPC_URL_MAINNET (Vercel: Project, Settings,
// Environment Variables; on this machine: a .env.local file at the repo root, which git ignores). Without one, devnet
// uses the public node; mainnet has no public fallback (the public mainnet node is not for apps). A paid node is sent
// batches of calls, unless RPC_BATCH=0 (for a plan that takes none; one that refuses a batch gets single calls for a
// while anyway: history.mjs callMany).
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

/** { name, url, paid, batch, program } for a cluster's name, or null for one the site does not know. */
export function clusterOf(name, env = {}) {
  const c = Object.prototype.hasOwnProperty.call(CLUSTERS, name) ? CLUSTERS[name] : null;
  if (!c) return null;
  const own = nodeUrl(env[c.rpcEnv]), plain = (v) => String(v ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  return { name, url: own || c.publicRpc, paid: Boolean(own), batch: Boolean(own) && plain(env.RPC_BATCH) !== "0", program: plain(env[c.programEnv]) || c.program };
}

/**
 * The public node's pace: about one call every 1.3 s per address (measured; 8 per 10.5 s), and when each cluster's
 * public node may be called next. Every call the history and the birth make to it (the pool check, the listings, the
 * transactions) takes a turn on this one mark, so in one instance together they keep it. The door (rpc.mjs) passes a
 * page's own calls on as they come. On Vercel each function runs in its own instances, with their own memory: there
 * /api/history and /api/birth each keep the pace alone and together can pass it, and a 429 makes the one that got it
 * wait a while.
 */
export const PUBLIC_GAP = 1312;
export const publicPace = {};                            // cluster name -> when the public node may be called next
const sleep = (ms) => new Promise((ok) => setTimeout(ok, Math.max(0, ms)));

/** Thrown when the public node's next turn comes after the answer's time is spent. */
export class OutOfTime extends Error {}

/** Waits for the public node's next turn and takes it (a paid node has no pace); false when it comes after `until`. */
export async function publicTurn(cluster, until = Infinity) {
  if (cluster.paid) return true;
  for (let wait; (wait = (publicPace[cluster.name] ?? 0) - Date.now()) > 0;) {
    if (Date.now() + wait > until) return false;
    await sleep(wait);                                   // and look again: another answer may have taken the turn
  }
  publicPace[cluster.name] = Date.now() + PUBLIC_GAP;
  return true;
}
/** The public node answered 429: nothing in this instance calls it for a while. */
export function backOff(cluster) { if (!cluster.paid) publicPace[cluster.name] = Date.now() + 12_000; }

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
