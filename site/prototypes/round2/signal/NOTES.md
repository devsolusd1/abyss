# Round 2 · "signal" · vinco

File: `index.html`, self-contained (inline CSS and JS, Google Fonts only, no library). Serve the site root and open `http://localhost:4900/prototypes/round2/signal/`.

## Name: vinco

*Vinco* is Portuguese for a crease, the mark a fold leaves. That is what graduation looks like in this system: the coin's line does not break or move to another pool, it creases once and carries on. The name is short, says the same in English as it is spelled (VEEN-ko), is Brazilian without being a postcard, and gives the product its verb: "the coin creased at 82.25 SOL". Backup if it is taken: **fio** (thread, one line that never breaks).

## The identity in 3 sentences

1. **Wordmark, colour, type.** The wordmark is `vinco` in lowercase Martian Mono, condensed, next to its mark: a short creased line in signal cyan with a square at the bend. The page is graphite black (`#0b0c0c`) with off-white ink, two greys and one signal colour (`#4be2ff`), used only for the line, struck words and live readings. Numerals are Martian Mono, a variable mono whose width axis moves with the reading, and sentences are Schibsted Grotesk.
2. **Drawing technique and motion.** Everything is drawn from one exact figure: SOL in across, the square root of price up. On that scale the curve is a straight line rooted at −30 (the 30 virtual SOL), and the pool is a second straight line rooted at 0. Graduation is the visible bend where one becomes the other, and the dashed ghosts show where each line would have gone. Motion is typesetting: changed digits drop into place one character at a time, leading zeros of a price stay grey, numerals widen as the curve fills, the 1,000,000,000 supply is struck through in cyan when 71,428,571 tokens burn, and captions re-set word by word.
3. **Interaction and navigation.** You drag along the line itself: on a phone with a finger, on a desktop just by moving the pointer. A leader joins the reading to the big numerals in the top-left columns. The page grid is the chart grid: 12 columns of 15 SOL each (4 columns of 45 on a phone). Navigation is the axis. Its pressable ticks (−30 virtual, 0 launch, 82.25 crease, 150 pool) move the reading, and a thin vertical axis on the right edge has one tick per section, plus a "launchpad · coming" tick that cannot be pressed.

## What the page shows, and what is live

- **Hero**: the life of a coin, simulated with the exact curve math. If you drag back after the crease, the reading stays on the pool's line ("the virtual floor never comes back"). Pressing 0 starts a new coin. The status in the top-right corner is live: it shows the coin count and trade count read from devnet.
- **One buy**: two marks on the axis, the SOL already in the pool and the size of your buy. The paragraph below is the program's own integer math (a port of `quoteBuy`, and `Chain.quoteBuy` when it is loaded). It shows the fee, the curve leg, the burn, the pool leg and the tokens you get, all inside one transaction.
- **Rules**: "1%" with the live devnet volume and fees; "LP token / remove liquidity / migration" struck out; a billion supply with no mint authority, no freeze authority and fixed metadata.
- **App proof**: a coin board row and the top of a coin page, both filled from `Chain.listPools()` and `Chain.history()`. The test coin's garbled name and symbol are never shown; it appears as "devnet coin" with its real mint, price, SOL in, market cap, volume and trades, each linked to the explorer. If devnet cannot be reached, both are labelled "offline sample".

## How the rest of the app carries it

- **Coin board.** One row per coin on the strict grid: name and mint, then the coin's own small line with its square sitting where it is now (before or after the bend), then the price with grey leading zeros, then SOL in against 82.25. Sorting would just reorder rows; nothing is boxed in cards. A coin that creased gets a small bend mark and its supply line struck. New trades re-set the digits in place, so the board reads like a typeset column.
- **Coin page with trading.** The coin's line takes the full right side, with the real trades as small squares above (buys) and below (sells) the line. Trading is done on the line: drag right of the square to buy, left to sell. The quote is typeset as one sentence ("Buy with 2.00 SOL, get 6,398,563 tokens"), and an exact amount can still be typed into an underlined field. Confirming would be a square-cornered key in signal cyan, never a pill and never a row of preset amounts. If a buy crosses the crease, the burn is struck through in the sentence before you sign. In this prototype, wallet trading is marked as coming.
- **Launch wizard (coming, team-only first).** The axis again, read left to right as the steps. At −30 you name the coin and set the symbol, and the wordmark-style type previews it. At 0 you set an optional first buy by dragging along the same line, with the exact tokens it buys. 82.25 shows what will happen at the crease, and 150 shows the pool, with the fee split and "no mint or freeze authority" struck in as facts. The final tick is the transaction. Each step is a tick you press, not a numbered form.

## Checks done

- Inline script extracted and run through `node --check` (passes).
- Rendered at 1440×900, 1440 tall and 375 px wide: no horizontal scroll (`scrollWidth` equals the viewport). Live devnet data loaded: 1 coin, 3 trades, 0.8253 SOL traded.
- Spot-checked the math: price at 79.07 SOL in is 0.0000003965 ((30+R)²/30e9); after the crease, 21.86 SOL in reads 0.0000000297 (R²/k); a 10 SOL buy from 70 SOL in gets 27,024,568 tokens and stops 2.35 SOL short of the crease.
- `prefers-reduced-motion`: no intro sweep, no digit or word animation, and the strikes appear at once.

Scratch screenshots and helpers are in `scratch/`.
