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
  - `net.js` picks the cluster and the program.
  - `chain/` is the chain layer, bundled into `vendor/chain.js` with `npm install && npm run build`.
    `npm run check` simulates a buy, a sell, both fee claims and a launch against devnet. `send-check.mjs` sends a
    buy, a sell of what it bought and both claims for real (with `SEND=1` and the coin creator's devnet keypair in
    `KEYPAIR`), then checks every number against the pool. `check-history.mjs` checks the trade history reader
    against a fake node on this machine that rate-limits like devnet's public one (about ten `getTransaction` calls in
    ten seconds per address): the reader fetches one transaction every 1.3 s, newest first, and keeps them in
    localStorage, so a coin page fills in its trades as they come and a reload needs only the new ones.
- `site/prototypes`: the design rounds; `round7` is the black hole.

## Run the site

```
node site/serve.mjs
```

Then open http://localhost:4900. On Vercel, `vercel.json` serves `site/` as the root, and
`/coins` opens `coins.html`, as `serve.mjs` does.
