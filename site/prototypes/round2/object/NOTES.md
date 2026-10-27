# Round 2, "object": brasa

File: `index.html`. It has inline CSS and JS, Google Fonts (Anybody, Martian Mono), and one library: three.js r128 from cdnjs. It loads `/net.js` and `/vendor/chain.js` (deferred, in that order). Open it at http://localhost:4900/prototypes/round2/object/.

## Name: brasa

*Brasa* is Portuguese for a live coal (an ember). Brazil is named after pau-brasil, the tree whose red dye looked like embers, so the founder's country is already in the word. In this identity the pool is one block of coal:
- real SOL heats it up as it comes in;
- at graduation, 7.14% of the supply burns off as sparks;
- after that it keeps glowing, because nobody can pull the liquidity, so it never goes out.

It has two syllables, is easy to say in English (BRAH-sah), and works as a lowercase wordmark. Backups in the same vein: **Forja** (forge) and **Tição** (a burning log, harder in English). Check domains and tickers before choosing.

## Identity in three sentences

1. The wordmark is `brasa` in Anybody at weight 800 and 150% width. The palette is coal `#0d0a09`, warm ink `#f2e9df` and ash `#9b918b`. A heat ramp runs from deep red through ember `#ff5a1f` to `#ffb46b`, and it is used only to show heat (progress to 420), never as decoration. Headlines are set in Anybody 300 at 118% width, and the numbers pinned to objects are in lowercase Martian Mono.
2. The drawing is one real-time three.js block, lit like a product photo: a warm key light with soft shadow, a cool rim light, and three ember point lights that warm the floor. The block's **width is the SOL inside, its depth is the tokens left, its top area never changes (x·y = k), and the slope of its top diagonal is the price**. Each part has its own look:
   - Real SOL is charcoal with glowing cracks drawn in code.
   - The 30 virtual SOL is a hatched, see-through wire box.
   - Tokens that a buy takes peel off the back as thin sheets.
   - Graduation crumbles the virtual box into ash and burns the 71.43M slice into sparks.
   - The block that is left has a diagonal parallel to the old one: same slope, same price.
   - The market-cap number widens or narrows its own font (variable `wdth`) as the block changes shape.
3. Interaction:
   - You **hold the block to buy** (the rate speeds up), **drag to turn it** (horizontal on touch, so the page still scrolls), and tap for a 1 SOL pulse. "Sell instead" flips the hold.
   - Numbers are pinned in 3D on hairline leaders that push out along each face's normal.
   - The navigation is a small block in the top right whose three faces are the three destinations: how it works, coins (soon), launch (soon). There is no row of links, no bottom bar and no toggle.

## How the rest of the product carries it

- **Coin board.** Every coin is a still render of its own block, made with the same scene, camera and light: one shared WebGL context renders every tile. The shape tells you the state at a glance:
  - long, thin and mostly hatched: just launched;
  - square and hot: close to 420;
  - wide and flat: bought far past graduation.

  Under each block sit the market cap and a thin heat line. The proof section shows the real devnet coin this way: its real numbers, with its test name hidden. Two dimmed tiles next to it are labelled as example shapes.
- **Coin page.** The coin's block sits at the top with the same pinned labels. The trade control uses the same gesture: you **hold** to buy or sell, and the button fills with ember. The quote is put in the block's terms ("the block gets 3.24% wider"). In the proof it is exact to the lamport, because it calls `Chain.quoteBuy` / `quoteSell` on the live pool. Trades are slivers whose length is the SOL amount (ember for buys, ash for sells), each linking to the explorer. Nothing is sent: wallets are marked as coming. For a price chart, the natural fit is the corner's path along the x·y=k curve (the top-view figure on the landing), not candles.
- **Launch wizard (not built).** It would "cast" a new block:
  1. The block starts as the hatched 30 SOL ghost.
  2. Name and symbol are typed onto its front face (fixed metadata).
  3. An optional first buy is a hold that lights the first sliver of coal.
  4. To confirm, you read the stamp band (1B supply, no mint, no freeze, 1% fee split, no LP token) and press it.
  5. The last screen shows the pool's address, which never changes.

## What is real and what is simulated

- **Simulated:** the hero block is a simulation the visitor drives, and it is labelled "Simulation. You are driving it." The example tiles are labelled as examples too. The top-view figure is driven by a slider.
- **Read from devnet:** the "Live on devnet" line (coin count, trade count, time of the last trade, program link), and the board tile and coin page for the real coin (market cap 31.15 SOL, 0.568 real SOL, 3 trades when tested).
- **When devnet does not answer:** the page says so and falls back to labelled examples.

After graduation the simulated market cap reads about 390 SOL, not 420, because it counts the 928.57M tokens that still exist. `Chain.priceOf` does the same. The founder may want to choose which number the product shows.

## Fallbacks and checks

- **No WebGL, or three.js unreachable:** an SVG still drawing of the same block, with the same pinned labels. Holding and tapping still update it.
- **`prefers-reduced-motion`:** no sway, particles, sheets or smoothing. The block renders only when something changes, and graduation is shown as a single change of state.
- **Checked:**
  - `node --check` on the extracted inline script passes;
  - no console errors;
  - no horizontal scroll at 375 px (scrollWidth 375) or at 1440 px;
  - graduation sequence, live devnet read, no-WebGL still and reduced motion were all looked at in screenshots.
- **Not tested:** a real touch phone and Safari.
- Scratch screenshots are in `scratch/`.
