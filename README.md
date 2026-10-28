# Nox

A Solana launchpad where each coin gets one pool for life. The coin starts on a bonding curve
and keeps trading in the same pool after it graduates: no migration. The site draws every coin
as a pixel black hole whose disk is the real SOL in its pool.

**Devnet only, unaudited.** Program `CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK`. No hooks yet.

## What is here

- `programs/pool`: the Anchor program (`src/lib.rs`, `math.rs`, `state.rs`, `token.rs`) and `DESIGN.md`.
- `programs/pool-tests`: its tests. `programs/test.sh` builds the program and runs them (Linux or WSL).
- `programs/examples`: `devnet.mjs` launches and trades a test coin (it only simulates unless `SEND=1`),
  and the records of the coins launched on devnet.
- `site`: the pages. `index.html` (the landing), `coins.html`, `coin.html`, `launch.html` and `sim.html`
  (the simulator: launch a coin in the browser and trade it against a made-up crowd, with play SOL).
  - `assets/bh.js` draws the black hole.
  - `assets/nox.css` is the look the pages share.
  - `assets/pool-math.js` is the program's math without the chain code; `assets/sim.js` is the simulated market and
    `assets/chart.js` the pixel candle chart. `node site/chain/check-pool-math.mjs` checks the math against `chain/src`.
  - `net.js` picks the cluster and the program (`?net=mainnet` for the rest of a visit), and gives the pages the
    words that follow the cluster (`NET.place` is "devnet" or "Solana").
  - `chain/` is the chain layer, bundled into `vendor/chain.js` with `npm install && npm run build`.
    `npm run check` simulates a buy, a sell, both fee claims and a launch against devnet. `send-check.mjs` sends a
    buy, a sell of what it bought and both claims for real (with `SEND=1` and the coin creator's devnet keypair in
    `KEYPAIR`), then checks every number against the pool. `batch-check.mjs` launches a coin with a 2-minute opening
    batch and takes it through its seat, the settle, the claim and trading, for real (about 3 minutes, same
    `KEYPAIR`). `check-history.mjs` checks the trade history reader
    against a fake node on this machine that rate-limits like devnet's public one (about ten `getTransaction` calls in
    ten seconds per address): the reader fetches one transaction every 1.3 s, newest first, and keeps them in
    localStorage, so a coin page fills in its trades as they come and a reload needs only the new ones.
- `site/prototypes`: the design rounds; `round7` is the black hole.
- `api/` and `server/`: the site's own server, two Vercel functions.
  - `/api/rpc?cluster=…` passes the pages' JSON-RPC calls to the cluster's node, so a paid node's key never reaches a
    browser. Only the calls the site makes pass; transactions only when every instruction goes to the pool program,
    the compute budget or the token account program; each address has a share of calls; the program's account list
    is shared between visitors for 3 s.
  - `/api/history?cluster=…&pool=…` answers a pool's latest 100 transactions with their event lines in one call, for
    every visitor at once (kept in memory, cached at the edge for a moment).
  - `/api/price` gives SOL in dollars for the charts (Jupiter, CoinGecko when that fails), kept 30 s.
  - `/api/birth?cluster=…&pool=…` gives a coin's launch, its first ten buyers (or seats in its opening batch) and, for each, the wallet that sent it
    its first SOL before the buy, one hop, with the transaction (facts only; kept an hour once there are ten).
  - `node server/check.mjs` checks them all against fake nodes.

## The node's address

The server reads it from the environment, never from a file in git: `RPC_URL_DEVNET` and `RPC_URL_MAINNET` (a paid
node, such as Helius, whose URL carries its key). On Vercel: Project, Settings, Environment Variables. On this machine:
a `.env.local` file at the repo root with `RPC_URL_DEVNET=…` (git ignores `.env*`), which `serve.mjs` reads.
Without one, devnet uses the public node (slow for the history: about one transaction a second) and mainnet has none.
When the program is on mainnet, its id goes in `site/net.js` and `server/config.mjs` (or `PROGRAM_MAINNET`).

## Run the site

```
node site/serve.mjs
```

Then open http://localhost:4900. On Vercel, `vercel.json` serves `site/` as the root, and
`/coins` opens `coins.html`, as `serve.mjs` does; `api/` holds the functions, which `serve.mjs` runs too.
