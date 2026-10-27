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
- `site`: the pages. `index.html` (the landing), `coins.html`, `coin.html` and `launch.html`.
  - `assets/bh.js` draws the black hole.
  - `assets/nox.css` is the look the pages share.
  - `net.js` picks the cluster and the program.
  - `chain/` is the chain layer, bundled into `vendor/chain.js` with `npm install && npm run build`.
- `site/prototypes`: the design rounds; `round7` is the black hole.

## Run the site

```
node site/serve.mjs
```

Then open http://localhost:4900. On Vercel, `vercel.json` serves `site/` as the root, and
`/coins` opens `coins.html`, as `serve.mjs` does.
