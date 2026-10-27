// The colour worlds the brasa identity can wear. Loaded in <head> before anything paints, so
// the page's CSS variables are set before the first frame. Every colour the pages use, the
// three.js scene included, comes from here: switching palette needs no other change.
//
// Which palette shows: ?palette=<id> in the address, else the visitor's last choice on this
// device, else the first one.
(function () {
  // Six worlds from the colourist (dex/site/design/palettes.md), contrast measured there.
  var PALETTES = [
    {
      "id": "brasa",
      "name": "Brasa",
      "idea": "Today's live coal with its colours made consistent: one ember ramp instead of five near-duplicate oranges, one ghost grey instead of four, and the fog colour fixed. It stays the default because the name is the colour.",
      "scheme": "dark",
      "css": {
        "coal": "#0d0a09",
        "coal2": "#161110",
        "coal3": "#1f1917",
        "ink": "#f2e9df",
        "ash": "#9e948d",
        "ash2": "#6f6662",
        "line": "rgba(242,233,223,.12)",
        "line2": "rgba(242,233,223,.30)",
        "heatLow": "#8a2209",
        "heatMid": "#ff5a1f",
        "heatHigh": "#ffae63",
        "whiteHot": "#fff2df",
        "ok": "#7fd18b",
        "navTop": "#2b211d",
        "navLeft": "#5c1b08",
        "navRight": "#962c0b",
        "themeColor": "#0d0a09"
      },
      "three": {
        "background": "#0d0a09",
        "fog": "#0d0a09",
        "hemiSky": "#5a463d",
        "hemiGround": "#050303",
        "keyLight": "#ffe3c8",
        "rimLight": "#8ea3c0",
        "glowLight": "#ff5a1f",
        "floor": "#16110f",
        "coalBase": "#8c7b72",
        "crackCold": "#6e1203",
        "crackHot": "#ff5a14",
        "edge": "#ffc08a",
        "ghost": "#d7cec6",
        "diagonal": "#fff2df",
        "spark": "#ffb347",
        "slice": "#fff2df",
        "ash": "#9e948d"
      }
    },
    {
      "id": "pilot-light",
      "name": "Pilot light",
      "idea": "A blue gas flame on graphite. Cold is deep navy and graduation is the pale inner cone of a burner, lit by a neutral studio key and a cool rim. Everything stays in one blue, with no magenta and no neon, so it reads as a burner turning up, not as cyberpunk.",
      "scheme": "dark",
      "css": {
        "coal": "#0b0d10",
        "coal2": "#12161b",
        "coal3": "#1a2027",
        "ink": "#e9eef2",
        "ash": "#909ba5",
        "ash2": "#5f6a75",
        "line": "rgba(233,238,242,.12)",
        "line2": "rgba(233,238,242,.30)",
        "heatLow": "#173a8c",
        "heatMid": "#3a82ff",
        "heatHigh": "#9ccdff",
        "whiteHot": "#eef7ff",
        "ok": "#86d3a0",
        "navTop": "#1d232a",
        "navLeft": "#12306e",
        "navRight": "#2d64d8",
        "themeColor": "#0b0d10"
      },
      "three": {
        "background": "#0b0d10",
        "fog": "#0b0d10",
        "hemiSky": "#3c4856",
        "hemiGround": "#030405",
        "keyLight": "#f4f1ea",
        "rimLight": "#8fb0d6",
        "glowLight": "#3a82ff",
        "floor": "#11151a",
        "coalBase": "#7f8996",
        "crackCold": "#10308a",
        "crackHot": "#58a0ff",
        "edge": "#b4d8ff",
        "ghost": "#c9d3dd",
        "diagonal": "#f2f8ff",
        "spark": "#a6d6ff",
        "slice": "#eef7ff",
        "ash": "#909ba5"
      }
    },
    {
      "id": "verdigris",
      "name": "Verdigris",
      "idea": "Copper and its patina. The 30 SOL that isn't really there is drawn in verdigris green, the real SOL glows as hot copper, and a patina-green rim light edges the block. The heat stays warm while the world around it turns green, so the two parts of the pool read apart.",
      "scheme": "dark",
      "css": {
        "coal": "#0a1210",
        "coal2": "#101b18",
        "coal3": "#182622",
        "ink": "#e6efea",
        "ash": "#8ea59c",
        "ash2": "#5e736b",
        "line": "rgba(230,239,234,.12)",
        "line2": "rgba(230,239,234,.30)",
        "heatLow": "#7a3216",
        "heatMid": "#d9773f",
        "heatHigh": "#f5b48c",
        "whiteHot": "#fff1e7",
        "ok": "#9fe3b9",
        "navTop": "#1b2a26",
        "navLeft": "#55250f",
        "navRight": "#a9582e",
        "themeColor": "#0a1210"
      },
      "three": {
        "background": "#0a1210",
        "fog": "#0a1210",
        "hemiSky": "#3b5a51",
        "hemiGround": "#030605",
        "keyLight": "#ffe9d8",
        "rimLight": "#6fbfa6",
        "glowLight": "#d9773f",
        "floor": "#0f1916",
        "coalBase": "#8f7364",
        "crackCold": "#4f1a08",
        "crackHot": "#ec8248",
        "edge": "#f6be9a",
        "ghost": "#86cbb3",
        "diagonal": "#effaf4",
        "spark": "#ffc8a2",
        "slice": "#fff1e7",
        "ash": "#8ea59c"
      }
    },
    {
      "id": "gold-seam",
      "name": "Gold seam",
      "idea": "Black obsidian split by seams that fill with molten gold, from dark bronze to pale gold, with a cool steel rim on the glassy block. It is quiet, expensive and has the most contrast; the floor glow turns gold.",
      "scheme": "dark",
      "css": {
        "coal": "#0a0a0c",
        "coal2": "#131316",
        "coal3": "#1c1c21",
        "ink": "#f1ece2",
        "ash": "#9c978e",
        "ash2": "#69655f",
        "line": "rgba(241,236,226,.12)",
        "line2": "rgba(241,236,226,.30)",
        "heatLow": "#6a4810",
        "heatMid": "#d1a02a",
        "heatHigh": "#f2d37a",
        "whiteHot": "#fff8de",
        "ok": "#8fd19c",
        "navTop": "#1d1d22",
        "navLeft": "#4d360d",
        "navRight": "#a47c1c",
        "themeColor": "#0a0a0c"
      },
      "three": {
        "background": "#0a0a0c",
        "fog": "#0a0a0c",
        "hemiSky": "#3b3b46",
        "hemiGround": "#020203",
        "keyLight": "#fff4e2",
        "rimLight": "#a9b6cc",
        "glowLight": "#dba82c",
        "floor": "#111114",
        "coalBase": "#5f626e",
        "crackCold": "#3f2805",
        "crackHot": "#f0b53a",
        "edge": "#f7df9c",
        "ghost": "#cdc9c0",
        "diagonal": "#fff8de",
        "spark": "#ffdc80",
        "slice": "#fff8de",
        "ash": "#9c978e"
      }
    },
    {
      "id": "pau-brasil",
      "name": "Pau-brasil",
      "idea": "The red heartwood that gave Brazil its name: the heat runs from wine through carmine to a hot coral-red, deeper and redder than brasa's orange. The virtual box is pale sapwood yellow, the colour of the wood outside the heartwood. It is the founder's country, told through material.",
      "scheme": "dark",
      "css": {
        "coal": "#120807",
        "coal2": "#1c0e0c",
        "coal3": "#271613",
        "ink": "#f5e8e0",
        "ash": "#ab958d",
        "ash2": "#78615a",
        "line": "rgba(245,232,224,.12)",
        "line2": "rgba(245,232,224,.30)",
        "heatLow": "#7a1014",
        "heatMid": "#e3362b",
        "heatHigh": "#ff9473",
        "whiteHot": "#ffeadf",
        "ok": "#8ccf96",
        "navTop": "#2b1613",
        "navLeft": "#640d11",
        "navRight": "#b8261f",
        "themeColor": "#120807"
      },
      "three": {
        "background": "#120807",
        "fog": "#120807",
        "hemiSky": "#5e3a33",
        "hemiGround": "#060202",
        "keyLight": "#ffe8d6",
        "rimLight": "#a7b2c0",
        "glowLight": "#e3362b",
        "floor": "#1a0c0a",
        "coalBase": "#9c6b5c",
        "crackCold": "#5c0709",
        "crackHot": "#ff3a26",
        "edge": "#ffb6a2",
        "ghost": "#e8d5a3",
        "diagonal": "#fff0e6",
        "spark": "#ff9f76",
        "slice": "#ffeadf",
        "ash": "#ab958d"
      }
    },
    {
      "id": "cinza",
      "name": "Cinza",
      "idea": "Pale concrete, the ash after the fire: a dark block of coal on a light floor, like a product shot, with the floor matched to the page and the point lights warming the concrete as heat rises. On this ground the heat tokens in the page get deeper and more saturated as heat rises, so they stay readable, while the cracks in 3D still glow bright.",
      "scheme": "light",
      "css": {
        "coal": "#cdcbc6",
        "coal2": "#c2c0ba",
        "coal3": "#b7b5af",
        "ink": "#161514",
        "ash": "#4d4a46",
        "ash2": "#77736d",
        "line": "rgba(22,21,20,.14)",
        "line2": "rgba(22,21,20,.34)",
        "heatLow": "#6e3524",
        "heatMid": "#c8420f",
        "heatHigh": "#9c2808",
        "whiteHot": "#4a1204",
        "ok": "#18542b",
        "navTop": "#3a3532",
        "navLeft": "#7a2410",
        "navRight": "#c8420f",
        "themeColor": "#cdcbc6"
      },
      "three": {
        "background": "#cdcbc6",
        "fog": "#cdcbc6",
        "hemiSky": "#f3f2ef",
        "hemiGround": "#8d8a84",
        "keyLight": "#fff9f0",
        "rimLight": "#c9d0da",
        "glowLight": "#ff5a1f",
        "floor": "#96938d",
        "coalBase": "#8a8580",
        "crackCold": "#5a1404",
        "crackHot": "#ff5a14",
        "edge": "#2a211c",
        "ghost": "#34312e",
        "diagonal": "#f8f6f1",
        "spark": "#ff7a2a",
        "slice": "#fff6e8",
        "ash": "#4d4a46"
      }
    },
  ];

  var B = (window.BRASA = window.BRASA || {});
  B.palettes = PALETTES;

  function find(id) {
    for (var i = 0; i < PALETTES.length; i++) if (PALETTES[i].id === id) return PALETTES[i];
    return null;
  }

  /** The founder's pick (2026-10-22): "gostei dessa cor", of Pilot light. */
  var DEFAULT = "pilot-light";

  function chosen() {
    var id = null;
    try { id = new URLSearchParams(location.search).get("palette"); } catch (e) {}
    if (!find(id)) { try { id = localStorage.getItem("brasa.palette"); } catch (e) {} }
    return find(id) || find(DEFAULT) || PALETTES[0];
  }

  var VARS = {
    coal: "--coal", coal2: "--coal-2", coal3: "--coal-3", ink: "--ink", ash: "--ash", ash2: "--ash-2",
    line: "--line", line2: "--line-2", heatLow: "--heat-low", heatMid: "--heat-mid", heatHigh: "--heat-high",
    whiteHot: "--white-hot", ok: "--ok", navTop: "--nav-top", navLeft: "--nav-left", navRight: "--nav-right",
  };

  function apply(p) {
    var root = document.documentElement.style;
    Object.keys(VARS).forEach(function (k) { if (p.css[k]) root.setProperty(VARS[k], p.css[k]); });
    // The older names the stylesheet also uses.
    root.setProperty("--ember", p.css.heatMid);
    root.setProperty("--ember-hot", p.css.heatHigh);
    root.setProperty("--ember-deep", p.css.heatLow);
    root.setProperty("color-scheme", p.scheme || "dark");
    document.documentElement.setAttribute("data-palette", p.id);
    document.documentElement.setAttribute("data-scheme", p.scheme || "dark");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", p.css.themeColor || p.css.coal);
  }

  B.palette = chosen();
  apply(B.palette);

  /** Switches palette for this visitor. The page reloads so the scene is rebuilt in the new light. */
  B.setPalette = function (id) {
    if (!find(id)) return;
    try { localStorage.setItem("brasa.palette", id); } catch (e) {}
    try {
      var url = new URL(location.href);
      url.searchParams.set("palette", id);
      location.replace(url.toString());
    } catch (e) { location.reload(); }
  };

  /**
   * The colour trial: a row of swatches, one per palette, shown while the founder chooses.
   * Each swatch is the palette's ground with its heat ramp across the bottom. Remove the call
   * (or set TRIAL to false) once a palette is picked.
   */
  var TRIAL = true;
  B.mountTrial = function (el) {
    if (!TRIAL || !el || PALETTES.length < 2) return;
    var html = '<span class="trial-label">colour trial</span>';
    PALETTES.forEach(function (p) {
      var on = p.id === B.palette.id;
      html += '<button type="button" class="trial-sw' + (on ? " on" : "") + '" data-id="' + p.id + '" title="' + p.name + '" aria-label="' + p.name + ' palette"' + (on ? ' aria-current="true"' : "") +
        ' style="background:' + p.css.coal + ';border-color:' + (on ? p.css.ink : p.css.line2) + '">' +
        '<i style="background:linear-gradient(90deg,' + p.css.heatLow + ',' + p.css.heatMid + ',' + p.css.heatHigh + ')"></i></button>';
    });
    html += '<span class="trial-name">' + B.palette.name + "</span>";
    el.innerHTML = html;
    el.hidden = false;
    el.addEventListener("click", function (e) {
      var b = e.target.closest(".trial-sw");
      if (b && b.getAttribute("data-id") !== B.palette.id) B.setPalette(b.getAttribute("data-id"));
    });
    el.addEventListener("mouseover", function (e) {
      var b = e.target.closest(".trial-sw");
      el.querySelector(".trial-name").textContent = b ? b.title : B.palette.name;
    });
    el.addEventListener("mouseleave", function () { el.querySelector(".trial-name").textContent = B.palette.name; });
  };

  /** "#rrggbb" to [r, g, b] in 0..255. */
  B.rgb = function (hex) {
    var h = String(hex).replace("#", "");
    if (h.length === 3) h = h.replace(/./g, function (c) { return c + c; });
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  /** Mixes two hex colours: t = 0 gives a, 1 gives b. Returns [r, g, b]. */
  B.mix = function (a, b, t) {
    var x = B.rgb(a), y = B.rgb(b);
    return [0, 1, 2].map(function (i) { return Math.round(x[i] + (y[i] - x[i]) * t); });
  };
})();
