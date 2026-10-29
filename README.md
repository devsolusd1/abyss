# Nox

A Solana launchpad where each coin gets one pool for life. The coin starts on a bonding curve
and keeps trading in the same pool after it graduates: no migration. The site draws every coin
as a pixel black hole whose disk is the real SOL in its pool.

**Devnet only, unaudited.** Program `CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK`. No hooks yet.

## What is here

- `programs/pool`: the Anchor program (`src/lib.rs`, `math.rs`, `state.rs`, `token.rs`) and `DESIGN.md`.
- `programs/pool-tests`: its tests. `programs/test.sh` builds the program and runs them (Linux or WSL).
  `programs/upgrade-test.sh` builds the program as it was before the opening batch (`DEX_OLD_COMMIT`, b73a4b1),
  launches and trades coins with it, upgrades to the current one, and checks the old coins still trade.
- `programs/examples`: `devnet.mjs` launches and trades a test coin (it only simulates unless `SEND=1`),
  and the records of the coins launched on devnet.
- `programs/deploy`: the mainnet kit, and `MAINNET.md`, its steps in Portuguese. `build.sh` builds a commit for a new
  program id, `deploy.sh` deploys it once (resumable from its buffer), `init-config.mjs` makes the config with launches
  closed, `multisig.mjs` makes a Squads v4 multisig, has each member sign a harmless proposal, hands the upgrade
  authority and the config's admin to its vault in one transaction, then runs upgrades and config changes by vote and
  timelock; `check-deploy.mjs` reads it all back (the bytes on chain against the build, the config, the multisig),
  and `set-program.mjs` puts the id in the site. Nothing is sent without `SEND=1`, except by `sol.sh`, which runs the
  CLI command it is given (with the node's URL filtered out of what it prints, and never `config` nor a write to the
  site's devnet program). `check-multisig.mjs` checks `multisig.mjs` offline and by simulation. The whole path was
  rehearsed on devnet on 2026-10-29 with a test program (`AC6DWrFxeiDbvAmE5QKXXTH2c4iriqz9YKJQ3zWwgf59`).
- `site`: the pages. `index.html` (the landing), `coins.html`, `coin.html`, `launch.html` and `sim.html`
  (the simulator: launch a coin in the browser and trade it against a made-up crowd, with play SOL).
  - `assets/bh.js` draws the black hole.
  - `assets/nox.css` is the look the pages share.
  - `assets/pool-math.js` is the program's math without the chain code; `assets/sim.js` is the simulated market and
    `assets/chart.js` the pixel candle chart. `node site/chain/check-pool-math.mjs` checks the math against `chain/src`.
  - `net.js` picks the cluster and the program (`?net=mainnet` for the rest of a visit), and gives the pages the
    words that follow the cluster (`NET.place` is "devnet" or "Solana").
  - `chain/` is the chain layer, bundled into `vendor/chain.js` with `npm install && npm run build`.
    `npm run check` simulates a buy, a sell, both fee claims and a launch against devnet, and the opening batch's
    calls on devnet coins in each of its states. `check-opening.mjs` checks the batch's side of the layer offline: its
    events byte by byte, its numbers and errors against the program's source, the error words, and the settle's claim
    against a fake node. `check-fees.mjs` checks the priority fee every sent transaction gets (one price, from the
    node's recent fees for its writable accounts, between a floor and a cap of 0.0001 SOL; none on devnet) against a
    fake node. `check-wallet.mjs` runs `assets/wallet.js` against fake Wallet Standard wallets: how they are found, the
    picker when there are several, signing, account changes and the phone links when there is none.
    `check-pools.mjs` checks the coin list against the site's server and a fake node: slices, pages, a busy server,
    and the list's age. `check-launch-usd.mjs` checks the launch page's two market caps in dollars: the conversion
    to the lamports sent, the limits, and SOL when the price is missing. `send-check.mjs` sends a
    buy, a sell of what it bought and both claims for real (with `SEND=1` and the coin creator's devnet keypair in
    `KEYPAIR`), then checks every number against the pool. `batch-check.mjs` launches a coin with a 2-minute opening
    batch and takes it through its seat, the settle, the claim and trading, for real (about 3 minutes, same
    `KEYPAIR`). `seats-check.mjs` runs three batches at once with six wallets made from that keypair: one that buys
    (four seats, each claim checked to the unit, then every seat sells), a refund and an empty one; it sends their SOL
    back at the end, and `SWEEP=1` gets back what a stopped run left (about 4 minutes, same `KEYPAIR`). `check-history.mjs` checks the trade history reader
    against a fake node on this machine that rate-limits like devnet's public one (about ten `getTransaction` calls in
    ten seconds per address): the reader fetches one transaction every 1.3 s, newest first, and keeps them in
    localStorage, so a coin page fills in its trades as they come and a reload needs only the new ones.
- `site/prototypes`: the design rounds; `round7` is the black hole.
- `api/` and `server/`: the site's own server, two Vercel functions.
  - `/api/rpc?cluster=…` passes the pages' JSON-RPC calls to the cluster's node, so a paid node's key never reaches a
    browser. Only the calls the site makes pass; transactions only when every instruction goes to the pool program,
    the compute budget or the token account program (plus Lighthouse and Memo, which wallets add as they sign, only
    beside a pool instruction); each address has a share of calls; the program's account list
    is shared between visitors for 3 s.
  - `/api/history?cluster=…&pool=…` answers a pool's latest 100 transactions with their event lines in one call, for
    every visitor at once (kept in memory, cached at the edge for a moment).
  - `/api/pools?cluster=…` gives the coin list for every visitor at once: the program's pools read every 4 s, each
    coin's name read once (a launched coin's metadata cannot change), `limit=` for the newest few, `board=1` for the
    numbers only, and `after=` for the next page.
  - `/api/price` gives SOL in dollars for the charts and the launch page's market caps (Jupiter, CoinGecko when that
    fails), kept 30 s.
  - `/api/birth?cluster=…&pool=…` gives a coin's launch, its first ten buyers (or seats in its opening batch) and, for each, the wallet that sent it
    its first SOL before the buy, one hop, with the transaction (facts only; kept an hour once there are ten).
  - `node server/check.mjs` checks them all against fake nodes.

## The node's address

The server reads it from the environment, never from a file in git: `RPC_URL_DEVNET` and `RPC_URL_MAINNET` (a paid
node, such as Helius, whose URL carries its key). On Vercel: Project, Settings, Environment Variables. On this machine:
a `.env.local` file at the repo root with `RPC_URL_DEVNET=…` (git ignores `.env*`), which `serve.mjs` reads.
Without one, devnet uses the public node (slow for the history: about one transaction a second) and mainnet has none.
The paid path asks for ten transactions per JSON-RPC batch; a node that refuses batches is asked one call at a time
for the next ten minutes, and `RPC_BATCH=0` makes that the rule.
When the program is on mainnet, its id goes in `site/net.js` and `server/config.mjs` (or `PROGRAM_MAINNET`):
`programs/deploy/set-program.mjs mainnet <id>` shows the change, and writes it with `WRITE=1`.

## Run the site

```
node site/serve.mjs
```

Then open http://localhost:4900. On Vercel, `vercel.json` serves `site/` as the root, and
`/coins` opens `coins.html`, as `serve.mjs` does; `api/` holds the functions, which `serve.mjs` runs too.
