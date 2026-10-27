# brasa: six palettes for the same block

Same model, same rule: the heat colours show heat (progress to 420) and nothing else. Every palette has the same 33 tokens, so the page and the three.js scene can be recoloured from one object. The same values as data are in `palettes.json` next to this file.

Checked on 2026-10-22 in a test copy of `prototypes/round2/object/index.html` with every colour swapped for these tokens. The prototype itself was not touched. Screenshots were taken at 292 px wide only (the pane was narrow) with 55 SOL and 120 SOL in the pool. The burn sparks were not looked at in any palette.

## The six moods, in one line each

1. **Brasa (cleaned).** Today's look with its colours made consistent: one ember ramp instead of five near-duplicate oranges, one ghost grey instead of four, and the fog colour fixed.
2. **Pilot light.** A blue gas flame on graphite. Cold is deep navy and graduation is the pale inner cone of a burner. It is the coolest and most technical of the six, with no magenta and no neon.
3. **Verdigris.** Copper and its patina. The 30 SOL that isn't really there is drawn in verdigris green, the real SOL glows as hot copper, and the rim light is patina-green.
4. **Gold seam.** Black obsidian split by seams that fill with molten gold. It is quiet and expensive, has the most contrast, and the floor glow turns gold.
5. **Pau-brasil.** The red heartwood that gave Brazil its name. The heat is crimson, not orange. The virtual box is pale sapwood yellow, the colour of the wood outside the heartwood.
6. **Cinza.** Pale concrete, the ash after the fire. A dark block of coal stands on a light floor like a product shot. On this ground the heat tokens in the page get deeper and more saturated as heat rises, so they stay readable. The cracks in 3D still glow.

## Page tokens (CSS)

| token | where it goes | brasa | pilot light | verdigris | gold seam | pau-brasil | cinza |
|---|---|---|---|---|---|---|---|
| coal | page, stage, tile wells | `#0d0a09` | `#0b0d10` | `#0a1210` | `#0a0a0c` | `#120807` | `#cdcbc6` |
| coal2 | tiles, coin head | `#161110` | `#12161b` | `#101b18` | `#131316` | `#1c0e0c` | `#c2c0ba` |
| coal3 | spare surface | `#1f1917` | `#1a2027` | `#182622` | `#1c1c21` | `#271613` | `#b7b5af` |
| ink | text, figure curve | `#f2e9df` | `#e9eef2` | `#e6efea` | `#f1ece2` | `#f5e8e0` | `#161514` |
| ash | muted text, sell slivers | `#9e948d` | `#909ba5` | `#8ea59c` | `#9c978e` | `#ab958d` | `#4d4a46` |
| ash2 | disabled "soon" only | `#6f6662` | `#5f6a75` | `#5e736b` | `#69655f` | `#78615a` | `#77736d` |
| line | hairlines | `rgba(242,233,223,.12)` | `rgba(233,238,242,.12)` | `rgba(230,239,234,.12)` | `rgba(241,236,226,.12)` | `rgba(245,232,224,.12)` | `rgba(22,21,20,.14)` |
| line2 | borders, slider track | `rgba(242,233,223,.30)` | `rgba(233,238,242,.30)` | `rgba(230,239,234,.30)` | `rgba(241,236,226,.30)` | `rgba(245,232,224,.30)` | `rgba(22,21,20,.34)` |
| heatLow | ramp 0.35, bar start | `#8a2209` | `#173a8c` | `#7a3216` | `#6a4810` | `#7a1014` | `#6e3524` |
| heatMid | ramp 0.7, band, thumb, buy slivers | `#ff5a1f` | `#3a82ff` | `#d9773f` | `#d1a02a` | `#e3362b` | `#c8420f` |
| heatHigh | ramp 1, real-SOL label, focus | `#ffae63` | `#9ccdff` | `#f5b48c` | `#f2d37a` | `#ff9473` | `#9c2808` |
| whiteHot | graduation labels, 2D diagonal | `#fff2df` | `#eef7ff` | `#fff1e7` | `#fff8de` | `#ffeadf` | `#4a1204` |
| ok | live dot, live tag | `#7fd18b` | `#86d3a0` | `#9fe3b9` | `#8fd19c` | `#8ccf96` | `#18542b` |
| navTop | nav cube top, cold ramp 0 | `#2b211d` | `#1d232a` | `#1b2a26` | `#1d1d22` | `#2b1613` | `#3a3532` |
| navLeft | nav cube left face | `#5c1b08` | `#12306e` | `#55250f` | `#4d360d` | `#640d11` | `#7a2410` |
| navRight | nav cube right face | `#962c0b` | `#2d64d8` | `#a9582e` | `#a47c1c` | `#b8261f` | `#c8420f` |
| themeColor | meta theme-color | `#0d0a09` | `#0b0d10` | `#0a1210` | `#0a0a0c` | `#120807` | `#cdcbc6` |

## Scene tokens (three.js)

| token | where it goes | brasa | pilot light | verdigris | gold seam | pau-brasil | cinza |
|---|---|---|---|---|---|---|---|
| background | scene.background | `#0d0a09` | `#0b0d10` | `#0a1210` | `#0a0a0c` | `#120807` | `#cdcbc6` |
| fog | scene.fog, raw hex | `#0d0a09` | `#0b0d10` | `#0a1210` | `#0a0a0c` | `#120807` | `#cdcbc6` |
| hemiSky | hemisphere sky | `#5a463d` | `#3c4856` | `#3b5a51` | `#3b3b46` | `#5e3a33` | `#f3f2ef` |
| hemiGround | hemisphere ground | `#050303` | `#030405` | `#030605` | `#020203` | `#060202` | `#8d8a84` |
| keyLight | key light, with shadow | `#ffe3c8` | `#f4f1ea` | `#ffe9d8` | `#fff4e2` | `#ffe8d6` | `#fff9f0` |
| rimLight | rim light | `#8ea3c0` | `#8fb0d6` | `#6fbfa6` | `#a9b6cc` | `#a7b2c0` | `#c9d0da` |
| glowLight | 3 point lights, slice end colour | `#ff5a1f` | `#3a82ff` | `#d9773f` | `#dba82c` | `#e3362b` | `#ff5a1f` |
| floor | floor plane | `#16110f` | `#11151a` | `#0f1916` | `#111114` | `#1a0c0a` | `#96938d` |
| coalBase | real block diffuse tint | `#8c7b72` | `#7f8996` | `#8f7364` | `#5f626e` | `#9c6b5c` | `#8a8580` |
| crackCold | emissive at 0% heat | `#6e1203` | `#10308a` | `#4f1a08` | `#3f2805` | `#5c0709` | `#5a1404` |
| crackHot | emissive at 100% heat | `#ff5a14` | `#58a0ff` | `#ec8248` | `#f0b53a` | `#ff3a26` | `#ff5a14` |
| edge | block edges, token sheets | `#ffc08a` | `#b4d8ff` | `#f6be9a` | `#f7df9c` | `#ffb6a2` | `#2a211c` |
| ghost | virtual box, hatch, "30 SOL" label | `#d7cec6` | `#c9d3dd` | `#86cbb3` | `#cdc9c0` | `#e8d5a3` | `#34312e` |
| diagonal | price line, old dashed line | `#fff2df` | `#f2f8ff` | `#effaf4` | `#fff8de` | `#fff0e6` | `#f8f6f1` |
| spark | pour, sell and burn sparks | `#ffb347` | `#a6d6ff` | `#ffc8a2` | `#ffdc80` | `#ff9f76` | `#ff7a2a` |
| slice | burned slice, start colour | `#fff2df` | `#eef7ff` | `#fff1e7` | `#fff8de` | `#ffeadf` | `#fff6e8` |

## Measured contrast (WCAG 2)

| | brasa | pilot light | verdigris | gold seam | pau-brasil | cinza |
|---|---|---|---|---|---|---|
| ink on coal (needs 7) | 16.4 | 16.7 | 16.2 | 16.8 | 16.5 | 11.3 |
| ash on coal (needs 4.5) | 6.7 | 6.9 | 7.2 | 6.8 | 7.0 | 5.4 |
| ash on coal2 | 6.3 | 6.4 | 6.7 | 6.4 | 6.6 | 4.8 |
| heatHigh on coal (text) | 10.8 | 11.7 | 10.7 | 13.5 | 9.2 | 4.8 |
| whiteHot on coal (text) | 17.9 | 18.0 | 17.2 | 18.6 | 17.0 | 9.4 |
| ghost on coal ("30 SOL" label) | 12.7 | 12.8 | 10.1 | 12.0 | 13.6 | 8.0 |
| ok on coal2 (live tag) | 10.2 | 10.2 | 11.9 | 10.4 | 10.3 | 4.9 |
| coal text on heatMid fill | 6.3 | 5.4 | 6.0 | 8.3 | 4.5 | 3.1 (fails: use heatHigh, 4.8) |
| ash2 on coal (disabled only) | 3.5 | 3.5 | 3.7 | 3.4 | 3.4 | 2.9 |

## What the page code needs so that data alone recolours it

These are the places where the prototype bakes in a colour that the tokens cannot reach. All of them were applied in the test copy and checked there.

- **Grey crack and coal textures.** The crack map is drawn in orange (`rgb(26,7,2)` with orange strokes and glow) and the coal noise is warm. A blue or gold emissive multiplied by an orange map comes out muddy, so draw both in grey and let `crackCold`/`crackHot`/`coalBase` set the hue. The hatch texture should be white, so that `ghost` is the only tint on it.
- **Fog is mixed after the sRGB encode in r128.** In the shader, tonemapping comes first, then encodings, then fog (checked in the page's `THREE.ShaderLib`). Pass the fog colour as a raw `new THREE.Color(hex)`, not through `col()`. Otherwise it renders darker than the background: invisible on coal, but obvious on Cinza.
- **Build the ramp from tokens:** `RAMP = [0: navTop, 0.35: heatLow, 0.7: heatMid, 1: heatHigh]`. The heat bar runs heatLow → heatMid (55%) → heatHigh, and the done state is heatHigh.
- **Text on a heat fill uses `coal`, not `ink`.** This covers the hold button while it fills. Today the button has light text on `#ff5a1f`, which is 2.6:1 and fails. On Cinza, fill with heatHigh instead of heatMid.
- **The token map for the colours still hard-coded in the code:**
  - the four ghost greys (`#c9c0b8`, `#d7cec6`, `#dcd3cb`, `#d3cac2`) → `ghost`;
  - the token sheets `#ffd2a8` → `edge`;
  - the ash particles `(.62,.58,.55)` → `ash`;
  - the slice fades `slice` → `glowLight`;
  - in the 2D still and the top-view figure: `#2b211d` → `navTop`, `#ffae63` → `heatHigh`, `#ff5a1f` → `heatMid`, `#fff2df` → `whiteHot`, `#f2e9df` and the axis lines → `ink`;
  - the live colours `#7fd18b` and `#a6dcae` → `ok`.
- **`ash2` is for disabled labels only.** It falls below 4.5:1 in every palette, as it does today. Move the "· preview" caption to `ash`.
- **Cinza only:** sparks use additive blending, which barely shows on a light ground. This is not yet checked in motion. If the burn looks weak, switch the particles on Cinza to normal blending so they read as dark soot.
