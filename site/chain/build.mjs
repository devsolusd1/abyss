// Bundles src/index.mjs and web3.js into ONE file the site loads with a script tag:
// ../vendor/chain.js, which sets window.Chain and is also a CommonJS module (require it from
// Node to test the very file that ships).
//
//   npm install && npm run build
//
// The page's net.js is NOT bundled: the page loads it first, so the cluster and the program
// can change without a rebuild.

import { build } from "esbuild";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const out = here("../vendor/chain.js");

await build({
  entryPoints: [here("./src/index.mjs")],
  outfile: out,
  bundle: true,
  format: "iife",
  globalName: "Chain",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  inject: [here("./src/buffer-shim.mjs")],
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  banner: { js: "/* Chain layer. BUILT FILE, do not edit: the source is chain/src, rebuilt with `npm run build` in chain/. */" },
  footer: { js: 'if (typeof module === "object" && module && module.exports) module.exports = Chain;' },
  logLevel: "warning",
});

console.log(`vendor/chain.js  ${(statSync(out).size / 1024).toFixed(0)} KB`);
