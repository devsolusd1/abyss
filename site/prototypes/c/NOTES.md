# Prototype C: "a living diagram"

## Name: **Tare**

To tare a scale is to take the container's weight off so the reading is true. That is what graduation does here: the 30 virtual SOL is taken off the pool (and 7.1% of the supply is burned) so the price reads the same, and from then on every SOL in the pool is real. One syllable, easy to say in English and Portuguese, works as a verb ("tared at 420"), and it is not a crypto cliche. Lowercase wordmark `tare`, next to a small vessel mark (orange SOL sitting on a dashed false floor).

Backups if the founder wants others in the same vein: **Plumb** (one pool, true and level), **Ballast** (the weight you drop).

## Concept in 3 sentences

The landing is one instrument: a drawing of a single pool, with SOL on one side and tokens on the other, that speaks in the first person about what is happening to it. A tape of trades runs under it. Drag it and you replay the coin's whole life: the curve fills, the hatched "virtual SOL" floor slides out, a block of tokens flies into the burner, the price gauge holds still, and the same vessel carries on as an x·y=k pool. Every part of the drawing can be pressed and explains itself in one line, so the mechanism is shown before anything has to be read.

## Interactive centerpiece

- **The pool (SVG, hand-drawn flat vector).** SOL column (orange liquid on a hatched 30 virtual SOL floor, with a "graduates here" line), token column (grey stack of 1B), a lid with a padlock (no LP token), 1% fee pipe into two tanks (creator, treasury), a burner, and an address plate ("one address, for life"). Each part is a button. Pressing it makes the pool explain that part.
- **The voice.** A speech box above the vessel, written in the first person, that changes with the phase ("I'm on my curve", "This buy graduates me…", "Same pool, same address…") with a live line under it (SOL in, SOL left to graduate). On mobile it stays pinned to the top of the panel so a pressed gauge still gets its answer in view.
- **The tape (the time scrubber).** A canvas strip of every trade (buys up, sells down) under a fixed orange read head. Drag it, flick it, tap a bar to jump there, use the arrow keys, or press play. The graduation trade has a wide stretch of tape, so scrubbing through it plays the graduation in slow motion and backwards. This is not a range input.
- **Gauges and the chart.** Price (holds steady and is outlined orange through graduation), real SOL in, tokens in the pool (with the burn), fees split. The price chart shows the whole life as a faint line and the part already played as a dark line. Pressing or dragging on the chart also moves through time.
- **"Drop a trade here" pills.** + buy 1 SOL, + buy 10 SOL, + sell 10% insert a trade at the read head. The whole life is recalculated on the real curve math and the pool reacts: "Your buy pulled my graduation 3 trades earlier.", or "Your buy graduated me, right inside the trade." The visitor's trades show orange on the tape with a "you" mark. Reset removes them.
- **Phase lamps** (curve, graduation, pool) light up as the life goes on, and pressing one jumps the tape there.
- The math is the spec's math: x = 30 + R, x·T = 30·1e9, a 1% fee in SOL split 50/50, graduation inside the buy at R ≈ 82.25, burn T·V/x (71.4M, 7.1%), and the same pool continuing on (R, T − burn). The life comes from a fixed seeded run, so it is the same on every visit. It is labelled "simulation" on the panel and in the footer, and the "simulation" tag explains itself when pressed.

**Navigation** is a rotary selector knob (top right), like a meter's mode dial: life / board / trade / launch. The three pages not built yet carry a small orange "soon". Turning to one makes the pool say it is coming and why, then the knob springs back. No link pretends to work.

**Alive, within the rules.** The SOL liquid ripples gently, sloshes when you drag the tape fast or move the mouse across the vessel, and the burner flame flickers once lit. There are no eyes, no mascot following the pointer, no peeking, and no wave footer. The page autoplays the life once on load, and any touch stops it. With `prefers-reduced-motion`, nothing autoplays, the voice appears without typing, and the ripple and the CSS animations are off.

## Colours and fonts

- Light by default for everyone, with no system dark scheme. Night mode only by the moon/sun button top right, remembered in `localStorage` (`tare-theme`, wrapped in try/catch).
- Day: white `#ffffff`, ink `#14161a`, grey text `#626973`, cool tiles `#f2f4f6`, token grey `#4a505a`. **One accent: signal orange `#ff5420`** (SOL, the read head, the graduation line, lit lamps).
- Night: `#101214` page, `#181b1f` panels, ink `#eceef1`, accent `#ff6a3d`.
- Headings: **Archivo** at expanded width (font-stretch 112–125%, weight 750–850). That is wide and technical, the opposite of a condensed poster grotesk. Body and labels: **Instrument Sans**, sentence case. No mono, no serif, no gradients, no glass, no emoji.

## How the rest of the site carries the idea

- **Coins board.** Each coin is a small version of the same vessel (a thumbnail of SOL level against the graduation line, plus the token column) with its name and two plain facts ("61 SOL in · 21 to graduate", or "pool · 1.2k SOL"). Sorting is done by turning the same knob idea (newest, closest to graduating, pool). Coins that graduate while you watch drop their hatched floor right there on the board. Real chain data replaces the simulation.
- **Coin page with trading.** The coin page is this instrument for one real coin. The tape is its real trade history, so scrubbing replays it. The buy/sell box sits where the "+ buy here" pills are now: amount pills (0.1, 0.5, 1, 5 SOL), and before you sign, the vessel shows a ghost of your trade (the level it would reach, the tokens you would get, the fee going into the two tanks, and if your buy would graduate the coin, the floor-drop preview). The pool's voice states the outcome in one line.
- **Launch wizard (team only, later everyone).** Three turns of the knob: name and image, then the plate (supply, authorities, fee, the same plate for every coin and not editable, which is the point), then "pour". The preview is a fresh empty vessel with the coin's name on its address plate, and the voice introduces itself: "I'm $NAME. All 1,000,000,000 of me start here."
- **Later features** (hooks) slot in as new parts on the drawing, each pressable with a one-line explanation, so the instrument grows instead of the page.

## Files

- `index.html`: single self-contained page (inline CSS and JS, Google Fonts only, no libraries).
- Checked: the inline script parses, the simulation graduates at trade #59 with price 0.4200 before and after the burn (71.43M burned), and there is no horizontal scroll at 375 px. Screenshots were taken at 1440 px and 375 px, light and dark.
