# Round 2, prototype "line": Ramal

File: `index.html` (self-contained: inline CSS and JS, Overpass from Google Fonts, no library). Served from the site root, it loads `/net.js` and `/vendor/chain.js` and reads devnet; without them it falls back to a clearly labelled simulation.

## Name: ramal

In Brazilian railways a *ramal* is a branch line that leaves the trunk and runs to its own destination. In Brazilian offices it is also a phone extension. Every coin here gets its own line that never merges into anything else, so the name is the product. It has five letters, lowercase, says "ha-MAHL" in Portuguese and "RAH-mal" in English, and nobody in crypto uses it. The wordmark carries its own mark: a white trunk stroke with a vermilion branch rising off it at 45 degrees and ending in a station ring.

Backups in the same world: **Linha** (line), **Baldeio** (from *baldeação*, changing trains, which is exactly what never happens here), **Terminal**.

## The identity in three sentences

Ramal is a transit system drawn on a dark enamel ground (#14181b, the colour of a station sign at night) in flat line colours (vermilion house line, signal yellow, blue, green, lilac, teal), set in Overpass, the open descendant of Highway Gothic, with heavy weights for station names and tabular numbers for every reading. Everything is drawn as wayfinding: thick strokes only at 0, 45 and 90 degrees, white station dots, ring interchanges, terminus bars, dashed track for anything planned or virtual, numbered line bullets for sections, and pictograms I drew by hand (a struck-out LP ticket, a blocked exit, a through-station, a locked coin, a flame at the burn terminus, a little train). Motion is the train itself: you drag it along the line, it glides between stations when you pick one, the track you have travelled lights up behind it, and the site's navigation is a line map in the header whose stations light up as you scroll, with the pages that do not exist yet drawn as dashed planned extensions marked "soon".

## What the landing shows

- **Hero, "No change of trains."**: one coin's whole life as a line. It climbs in 45 degree steps through stops at 60, 120 and 240 SOL market cap, reaches the **Interchange** (420 SOL cap, ring), then runs flat to the right as the **open track** with an arrow, "for good". A dashed grey track runs beside the curve section: the 30 virtual SOL. It ends in a buffer stop just before the interchange. Off the interchange a yellow spur drops to a terminus labelled "71.43M burned".
- **The train** is the control. Drag it (mouse or touch), click a station, use the arrow, PageUp/PageDown and Home/End keys (it is a slider), or press "Ride the line" to travel stop to stop. The departure sign beside it shows the exact curve math at that point: real SOL in, price per 1M tokens, market cap, tokens in the pool, and one plain sentence. Crossing the interchange closes the virtual track, slides three yellow token blocks down the burn spur, and the sign turns yellow and says the price holds (the cap shows "420 then 390", because the cap now counts the 928.57M tokens left). On a phone the line turns vertical and the sign rides along stuck to the bottom of the screen. On a tablet the sign sits beside the vertical line.
- **Line rules** (blue line, four stops): no LP token, no way out for pool money, one address all its life, a fixed coin.
- **The fare** (yellow): a junction diagram. A 1 SOL trade line splits off 1% at a junction, which splits again into creator and treasury. Small SOL dots run through it (static under reduced motion). Under it, the real devnet totals: SOL traded and SOL in fares.
- **On the network**: the identity on two real pages-to-be (both tagged "Page opens later"), built from devnet data.
- **Terminus footer**: the line runs off the page; a dashed branch is the "Launchpad for everyone, later".

Live versus simulated: the hero is tagged **Simulation**. The live bar under it, the fare totals, the board and the coin page come from `Chain.listPools()` and `Chain.history()`. The devnet coin's garbled name is never shown; it is "Test coin 1" / "Devnet test coin", with its real mint link, real cap, price, progress, trade count and its three real trades linked to the explorer. If devnet does not answer, an "Example coin" with 6.5 SOL in is shown and everything says simulation.

## How the other pages carry it

- **Coin board = the network map.** Each coin is a row in its own line colour, with a numbered bullet. Every row's track shares the same scale, so all the interchange rings line up in one column at 420 SOL cap: you read the whole market at a glance, who is close to graduating and who has passed onto the open track. A small train shows where each coin is now. Planned launches are dashed rows. Sorting or filtering would change the order of lines, never the map.
- **Coin page = riding one line.** The top is a station sign in the coin's colour (bullet, name, mint, a state plate saying "On the curve" or "Open track"), then the coin's own line with its train at the real position, its stops and the interchange ring. Under it, four readings and the trade **ticket** (punched edges, Buy and Sell as a square two-part switch, an amount, and an exact quote from the live reserves: tokens out, the fare split, the price after, and a yellow warning if the buy would cross the interchange with the burn). Below that, "Last departures": the real trades, each linked to the explorer. In the full page the price chart would be drawn as the same line, stepping at 45 degrees between trades.
- **Launch wizard = laying a new line.** Each step is a station on a short horizontal line that the train moves along: name and symbol (the station name sign fills in live), picture, line colour (picked from the flat palette, it becomes the coin's colour on the board), first buy (the train is placed on the curve and the sign shows what that buy gets), then review, shown as the finished line with its stops and interchange before signing. Steps not reached yet are dashed track. While launches are team-only, the wizard shows as a dashed planned line marked "opens later".

## What was avoided (round one feedback)

No mascot, face or speech bubble; no pill buttons and no row of Buy 1/5/20 SOL buttons (the train is the control); no night toggle (the dark ground is the identity, not a theme); no white page, no rounded grotesk, none of the banned fonts; no water, jars, scales, paper or gazette look; no floating bottom bar and no stock row of links (navigation is the header line map); no gradients, glass, emoji or icon-card rows; no ruled tables or mono capitals. Pages that do not exist are drawn as dashed planned stations and tagged "soon" or "opens later".

## Checks done

Inline script passes `node --check`. Checked at 375, 768 and 1440 px: no horizontal scroll, no clipped numbers on the sign at any stop. Drag, station click, keys and the interchange effects verified in the browser; live devnet data and the offline fallback (`?net=mainnet`, which has no RPC) both render. `prefers-reduced-motion` turns off the glide, the intro ride, the draw-ins and the moving fare dots.
