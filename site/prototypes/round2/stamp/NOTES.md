# Round 2, "stamp": Selo

File: `index.html`. It is self-contained: Google Fonts only, no library. It loads `/net.js` and `/vendor/chain.js` from the site root and still works if they fail.

## Name: Selo

*Selo* is Portuguese for a seal, a postage stamp, and the guarantee seal on a product ("selo de garantia"). Every coin gets a seal, and every pool is sealed: there is no LP token and no withdraw instruction. The headline says it: "Pressed once. Sealed for good." It has four letters and is easy to say in English ("SEH-lo"). It works as a lowercase wordmark.

Backups in the same idea:
- **Lacre**: wax seal. *Lacrado* means sealed, and "lacrou" is Brazilian slang for nailing it.
- **Sinete**: signet.
- **Chop**: the name for a seal stamp in Asia.

Check the domain and the ticker before choosing.

## The identity in three sentences

1. Every coin gets a crest drawn from its mint address, and the same address always gives the same crest.
   - It is printed like a two-ink screenprint on a flat poster colour (12 grounds: lilac, mint, sun, sky, lime and others, never paper or cream).
   - Plate 1 is the silhouette: scalloped, cogged, burst, polygon, round, or an uneven pressed edge.
   - Plate 2 is two geometric figures overprinted in multiply, with a slight misregistration.
   - Plate 3 is black: the address written round the rim, plus a small accent.
   - The display face is Dela Gothic One, the text face Hanken Grotesk, and Azeret Mono is used only for addresses.
   - The wordmark "selo" is overprinted on Selo's own crest, which is drawn from the program address.
2. The crest is the progress bar.
   - On the curve, the second ink sweeps round like a clock hand as SOL comes in, and the unprinted part shows as a dashed outline.
   - At graduation, a 7.14% slice (the burned share of the supply) flies out of the crest and leaves a permanent notch.
   - After that the crest stays fully inked and notched: a plain pool, same address.
3. Everything you interact with is a printing object, and the page colour follows the crest:
   - a dial spins a random address;
   - a registration mark separates the inks into their plates, with a caption saying what each plate was drawn from;
   - pressed crests collect in a tray;
   - navigation is a sheet of three perforated stamps, and the section you are in gets a postmark;
   - pressing a new crest wipes the whole page to that crest's ground colour, so every coin's page is a different colour.

## What is on the landing

The page has four screens: the press, the price chart, "Sealed", and the board preview.

- **The press** (hero):
  - Type or paste any address. A valid 32-byte address is labelled as such; any other text still makes a crest.
  - Spin the dial for a random address, or separate the inks.
  - The "SOL in the pool" slider is marked as a simulation you drive. Its ruler is drawn to the real, uneven scale, and it reads out market cap, price per million tokens, tokens in the pool and tokens burned.
  - Crossing 82.25 SOL plays the burn.
  - Links like `?seal=<address>&sol=<SOL in>&inks=1` open the press already set up, so a crest can be shared.
- **"The price doesn't jump."**:
  - The curve is drawn with the real maths, and the area under it is inked up to the current SOL.
  - A dashed ghost line shows that without the burn the price would fall 27%.
  - Dragging on the chart moves the same simulation, and the crest rides the line.
- **"Sealed."**:
  - The current crest is split in two halves, 0.5% to the creator and 0.5% to Selo.
  - It states that there is no LP token and no withdraw instruction, plus a simulated fee figure from the run above.
- **Proof, on a black band**:
  - A board row: the real devnet coin, with its real crest from its mint, real market cap, progress and trade count. It is shown as "Devnet test coin" because its name is garbled test data. Two crests marked "simulated" show the curve and graduated states.
  - The top of the real coin's page:
    - real stats and an explorer link for the mint;
    - the price after each of its 3 real trades;
    - the trades, each linked to its transaction;
    - a Buy/Sell box that quotes exactly with `Chain.quoteBuy` / `Chain.quoteSell` on the live reserves.
  - The trade button says trading is coming.
  - If devnet does not answer, all of this switches to clearly labelled simulated data.

## How the product pages carry it

- **Coin board**:
  - Each coin is a tile in its own ground colour with its crest bleeding over the top edge.
  - You read the state from the crest: the share of ink is progress, and a notch means graduated.
  - Sorting by "closest to graduation" lines the crests up from bare outline to full ink.
  - The live state is the ink, so no separate progress bar is needed.
- **Coin page and trading**:
  - The whole page takes the coin's ground colour, with a giant crest bleeding off the top right.
  - Plate colours are reused for the UI: the price area is in the coin's second ink, the trade box in its first ink, and buy dots in its inks.
  - While a buy is previewed, the crest shows the ink the trade would add as a dashed sweep.
  - The buy that graduates a coin plays the burn for everyone watching.
  - Trades in the list carry small crests of the trader's address, so repeat traders are recognisable.
- **Launch wizard** (team-only first, everyone later):
  - Step 1: name and ticker.
  - Step 2: "pick your seal". The wizard makes several mint keypairs and shows their crests side by side, and the creator picks the crest they like. Choosing a seal means choosing a mint address.
  - Step 3: check the fixed facts. These are written round the crest's rim like a legend: 1B supply, no mint authority, no freeze, fixed metadata.
  - Step 4: hold to press, which signs the launch transaction. The crest is struck onto the page as a bare outline at 0%, ready to be inked by trades.

## Checks done

- The inline script passes `node --check`.
- Chrome headless at 1440 px and inside a 375 px frame shows no horizontal scroll.
- Interactions were exercised in the browser with no console errors.
- Live devnet data loaded: 1 pool, 3 trades.
- `prefers-reduced-motion` turns off the page wipe, the strike, the burn and all transitions.
- Scratch screenshots are in `scratch/`.
