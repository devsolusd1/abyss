// SOL's price in US dollars for the pages' charts: /api/price. Read from Jupiter's price API, or CoinGecko when that
// fails, kept here for KEEP_MS and at the edge for a moment, so every visitor's chart costs the sources one call a
// half minute. Answer: { usd, source, at } (at: when it was read, in ms). The sources can be pointed elsewhere for
// tests (PRICE_JUPITER_URL, PRICE_COINGECKO_URL).

import { foreign, json } from "./config.mjs";

const KEEP_MS = 30_000;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const sources = (env) => [
  { name: "Jupiter", url: env.PRICE_JUPITER_URL || `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, read: (j) => j?.[SOL_MINT]?.usdPrice },
  { name: "CoinGecko", url: env.PRICE_COINGECKO_URL || "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", read: (j) => j?.solana?.usd },
];
let last = null;                                         // { usd, source, at }
let reading = null, failedAt = 0;                        // after a read that found no price, the sources rest 20 s

async function readOne(source) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 3000);   // both sources inside a page's 10 s wait
  try {
    const res = await fetch(source.url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 64 * 1024) return null;
    const usd = Number(source.read(JSON.parse(text)));
    return Number.isFinite(usd) && usd > 0 && usd < 1e6 ? usd : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function fresh(env) {
  for (const s of sources(env)) {
    const usd = await readOne(s);
    if (usd) return { usd, source: s.name, at: Date.now() };
  }
  return null;
}

export async function handlePrice(request, env = {}) {
  try {
    if (request.method !== "GET") return json({ error: "GET only" }, 405, { allow: "GET" });
    if (foreign(request)) return json({ error: "This server is for this site's own pages" }, 403);
    if ((!last || Date.now() - last.at >= KEEP_MS) && Date.now() - failedAt >= 20_000) {
      reading ??= fresh(env).finally(() => { reading = null; });
      const got = await reading;
      if (got) last = got; else failedAt = Date.now();
    }
    // a price up to ten minutes old still beats none; older than that, the chart goes back to SOL
    if (!last || Date.now() - last.at > 10 * 60_000) return json({ error: "No price for SOL just now" }, 503, { "cache-control": "public, s-maxage=10" });
    return json(last, 200, { "cache-control": "public, max-age=0, s-maxage=30, stale-while-revalidate=300" });
  } catch {
    return json({ error: "No price for SOL just now" }, 503);
  }
}
