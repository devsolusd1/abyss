# Prototype B: capi

## Name: capi

From *capivara*, the Brazilian word for capybara. It is the name of the mascot and of the DEX, written in lowercase, with an orange as the dot on the i. It is short and easy to say in any language ("KAH-pee"). It is Brazilian without being hard for an international audience, and the capybara is known as the calm animal that sits in water and never leaves, which is what the pool does. Backup if the name is taken: **Lagoa**.

## Concept

Capi is a capybara who keeps one pool per coin and never leaves it. Everything the protocol does is shown in his pool: the water is real SOL, the float he sits on is the 30 virtual SOL, the oranges are the coin's tokens, and two jars on the deck collect the 1% fee. He speaks one short line per screen in the first person and reacts to what the visitor does. He blinks and twitches an ear, but his eyes never follow the pointer.

## Interactive centerpiece (hero)

- The visitor presses **Buy 1 / 5 / 20 SOL** or **Sell mine**. The water rises or falls, oranges fly out or come back, two drops go into the creator and treasury jars, and the figures underneath are given as sentences. Everything is labelled "Simulation · you drive it".
- When the water reaches the dashed **full line** (82.25 SOL), graduation runs inside that same buy. Capi says "Full line!", the float pops ("That was the 30 virtual SOL"), he drops into the real water, eats one orange ("−71.4M burned", "the price did not move"), and the label changes to "graduated here · now x·y=k". The pool and its address stay the same.
- The math is the brief's exactly: x = 30 + R, x·T = 30·10⁹, 1% fee first, graduation at √(420·30) − 30, burn T·30/x, then x·y=k on (R, T − burn). I checked it in Node: the price is 0.42 SOL per 1M tokens just before and just after the burn, and the burn is 71,428,571 tokens (7.14%).
- Moving the pointer over the water makes ripples. That is the pointer-reactive element, and it is not the eyes.
- **Rules screen, "Try to take it."**: seven pills (Pull the SOL out, Grab the LP tokens, Mint more, Freeze a wallet, Change the name, Move the pool, Take a cut). Capi shakes his head and gives the true answer each time. A tally reads "N tries. 0 taken."
- **Next screen, "Dry stones are done."**: stepping stones in a pond. Stones above water are live now (pools on devnet, team launches). Wet stones are coming soon (live numbers, coins board). Sunken stones come later (launchpad for everyone, transfer hooks). Tap a stone and Capi hops onto it and says one line about it.
- The **full math** sits behind one press, in a "The math" sheet.

## Navigation

The navigation is a small pond fixed at the bottom of the screen, with stepping stones in it: Pool, Rules and Next. The stone for the section you are in turns orange. Board and Launch are sunken stones marked "soon". They are not links. The same stones appear in the Next section, so the navigation and the roadmap share one picture of the world. The top bar holds only the wordmark, a "devnet" tag and the moon/sun button.

## Colours and fonts

- Page: white `#ffffff`. Ink: `#16181d`. Muted text: `#5f6772`.
- **One accent: tangerine `#ff6a1a`.** It is used for the pills, the oranges (tokens), the float, the active stone and the dot of the i.
- Environment colours, not accents: water `#8fd3e6` / `#3fa9c9` and ground `#eef0f3`. Capi's fur is `#c99368` with ink outlines.
- Night mode (`#0f1217` page, deep teal water) only comes from the moon/sun button at top right. The choice is saved in localStorage inside try/catch, and the page never follows the system's dark setting.
- Headings and Capi's voice use **Bricolage Grotesque** 700/800. Body text uses **Figtree**. Both come from Google Fonts.
- There is no serif, no mono, no gradients, no glass and no emoji. Pills have a visible bottom edge.

## How the rest of the site would carry it

- **Coins board, "the pond"**: every coin is a small pool tile showing its water level against its own full line. Tiles still on the curve show the float, and graduated tiles show Capi in the water. Status pills read "on the float" or "graduated". Filters are stepping stones, not tabs. All figures come from the chain.
- **Coin page**: that coin's own pool, full size, with real numbers. Amount pills (0.1 / 0.5 / 1 / 5 SOL) for buy and sell. Before you sign, Capi says what the trade will do ("You'd get 12.3M. Price after: 0.0312."). Under the pool there is a price chart. The activity list is written as ripples ("someone dropped 2 SOL in"). The fee jars show what the creator and treasury have earned.
- **Launch wizard** (team-only at first): Capi fills a new, empty pool in three steps. (1) Name and ticker, which appear printed on the float. (2) Image, which appears on Capi's orange. (3) Review, with a live preview of the new pool tile on the board. Before signing, Capi warns "Name and metadata are fixed forever."
- **Hooks** (later) would be new objects in the pool, so the same picture keeps working.

## Checks done

- The inline script parses (checked with `new Function` in Node 24).
- Headless Edge screenshots at 1440×900 and at 375 px wide, in light mode. Dark mode, buys, graduation, sell, the rules pills and the stone hop were run in the browser pane with no console errors and no horizontal scroll.
- `prefers-reduced-motion`: waves, bobbing, blinking, flights and the graduation sequence are switched off. State changes still happen instantly.
- localStorage failing (as it does in the preview pane) is handled.

## Known limits

- On a 375 px phone the pool scene is drawn about 0.65× its size, so the labels inside it are around 11 px.
- All numbers are the visitor's own simulation. There is no chain data yet, and the page says so in two places.
