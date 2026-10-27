# Prototype A: "a physical toy you can play with"

File: `index.html` (self-contained; Google Fonts only, no JS libraries).

## Name: Pote

`pote` is Portuguese for jar, and in English a "pot" is the money in the middle of the table. The product is one jar per coin, kept for life, so the name is the object on the page. Four letters, says the same in both languages, sits well as a lowercase wordmark next to a small jar glyph. It is the founder's own word without being hard for an international crowd.

Other names that fit the same toy, if Pote is taken: **Jarro** (Portuguese for jug), **Brim** (fill to the brim). Check the domain and the token ticker before choosing.

## The concept in three sentences

Every coin gets one jar, and the landing page is that jar on the table: you hold it down and SOL pours in, coins come out of a tap into your dish, and 1% drips off through a pipe into two cups, creator and treasury. The jar stands on a hatched false floor labelled "30 virtual SOL"; when the liquid touches the 420 SOL cap line, a trapdoor opens, the floor drops out, the liquid falls into its place, the top slice of coins burns away, and the price trace keeps going without a step. It is the same jar after that, now a plain x·y=k pool, and the visitor can keep pouring or sell back into it.

## The interactive centrepiece

- Press and hold anywhere on the jar (or the "Hold to pour" pill, which also works with Space or Enter). The bottle tips, the stream thickens the longer you hold, and the pill counts the SOL. A short tap pours 0.5 SOL. On touch, a 140 ms delay keeps a scroll from pouring.
- Pills: `+10 SOL`, `To the line` (fills past the cap so the visitor sees graduation; it becomes `+50 SOL` afterwards), `Sell half`, and a restart icon.
- Graduation happens inside the buy that crosses the line, as the program does it: the pour pauses for about two seconds of show (line flashes, trapdoor, falling floor, burn sparks), then the rest of the same buy carries on in the pool.
- The jar has a voice (a speech bubble) and a face that blinks and changes expression with what happens. Its eyes never follow the pointer. Sweeping the pointer across the jar makes the liquid slosh.
- Under the copy, the figures are said in one sentence ("A million coins cost 0.030 SOL. 0.00 SOL of real SOL is in. curve 82.2 SOL more and it graduates.") with a small price trace for the session; a dashed mark shows where it graduated, and the line does not jump there.
- Everything is labelled as a simulation of the curve math. No invented live numbers.

Math used (checked with node): V = 30, S = 1e9, graduation at R = sqrt(420*30) - 30 = 82.25 SOL; at that point 267.26M coins are left in the pool, 71.43M (7.14% of supply) burn, and the price is 0.420 SOL per million before and after. Fee 1% of every buy and sell, in SOL, split half and half. The jar is drawn to 200 SOL; past that the toy says it is full for the demo.

One point to confirm against the program: the toy lets the rest of a crossing buy continue in the x·y=k pool after graduation. If the program instead stops the buy at the line or refunds the rest, change `buy()` in the script.

## Colours and fonts

- White page `#ffffff`, ink `#15151a`, cool grey tiles `#f1f2f5`, muted text `#686c78`.
- One accent, watermelon `#ff3d68`: the SOL liquid, the bottle, the fee cups, the tube nav fill, one tag. Coins are ink chips; virtual SOL is a grey hatch, so "not real" reads at a glance.
- Night mode only by the moon/sun button at the top right, remembered in localStorage (wrapped in try/catch). Night page is `#2a292e` (the founder's trial colour), coins turn light.
- Headings: **Gabarito** 800/900 (round, chunky, toy-like, not a condensed grotesk). Body and numbers: **Onest** 400 to 700. No serif, no mono.

## Navigation

The header nav is a small graduated test tube. It fills with the accent as you scroll, and its three marks are the sections (play, tags, shelf). The facts section is a rail of hanging tags that swing when the pointer brushes them and turn over when pressed: a figure on the front ("0 LP tokens", "1% fee, paid in SOL", "7.1% burned at graduation"), one sentence on the back. Future pages sit on a shelf as sealed jars marked "soon" or "later"; pressing one wobbles it and says what it will be. None of them pretends to link anywhere.

## How the rest of the site carries the idea

- **Coins board:** a shelf of small jars, one per coin, each filled to its real level with its 420 line marked. A curve jar still shows its hatched floor; a graduated one does not. Jars bubble when a trade lands. Sort by pressing shelf labels (newest, closest to the line, most poured). Status pills are just "curve" (ink) and "pool" (accent).
- **Coin page and trading:** the coin's own jar on the left at full size, live from chain data, with the price trace under it. The buy box is the same toy: amount pills (0.1, 0.5, 1, 5 SOL), and "Hold to buy" pours, so the visitor sees the coins drop into their dish and the 1% split before signing. Sell runs the tap the other way. The activity list is a stack of small receipts ("4.2 SOL in, 51.3M out"), with the graduation buy marked.
- **Launch wizard (team-only at first):** three steps, and the jar fills in as you go: name and ticker go on the jar's label, the image becomes the label art, and the last step is the empty jar on its 30 SOL floor, shown on the board shelf next to the other jars as "your jar on the shelf". The fixed facts (1B supply, no mint, no freeze, metadata fixed) are printed on the jar's lid, not asked as settings.
