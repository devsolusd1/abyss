// Bundles src/mwa.mjs and Solana Mobile's Mobile Wallet Adapter into ONE file the site loads on Android only:
// ../vendor/mwa.js, which sets window.NoxMwa ({ register }). assets/wallet.js adds its script tag when it is needed;
// no page names it.
//
//   npm install && npm run build:mwa
//
// Three changes to the packages on the way. Each is checked against the text it changes, and the build stops if that
// text is not as it was (a new version of the package): look before bundling it.
//   - the package's dialogs (the ones about the browser's permission to reach apps on the phone) would fetch a font
//     from Google: the link is taken out, so they use the phone's own font and nothing is fetched from elsewhere
//   - qrcode is left out (a stub that throws stands in): only the remote mode draws with it, a QR code for a computer,
//     which register() never sets up
//   - @solana/errors' table of messages is emptied: only a build outside production reads it, and this one is
//     production (an error from those packages gives its number)
// The licenses of what is bundled (each package's own file, a text shared by several once) go at the end of the file.

import { build } from "esbuild";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const root = here("./");
const out = here("../vendor/mwa.js");

const FONTS = /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\s*<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]*" rel="stylesheet">/;
const MOBILE = /[\\/]@solana-mobile[\\/]wallet-standard-mobile[\\/]lib[\\/]esm[\\/]index\.browser\.js$/;
const ERRORS = /[\\/]@solana[\\/]errors[\\/]dist[\\/]index\.browser\.mjs$/;
const DEV_ONLY = /if \(process\.env\.NODE_ENV !== "production"\) \{\s*return getHumanReadableErrorMessage\(code, context\);/;

const stop = (why) => { throw new Error(`${why}: check the package before bundling it`); };
const count = (src, text) => src.split(text).length - 1;

const trim = {
  name: "trim",
  setup(b) {
    b.onLoad({ filter: MOBILE }, (args) => {
      const src = readFileSync(args.path, "utf8");
      if (!FONTS.test(src)) stop("the package's font links are not where they were");
      // qrcode: imported once, and drawn with once, by the remote mode's dialog
      if (count(src, 'import QRCode from "qrcode";') !== 1 || count(src, "QRCode.") !== 1 || count(src, "await QRCode.toCanvas(") !== 1) stop("the package uses qrcode elsewhere than for the remote mode's QR code");
      const cut = src.replace(FONTS, "");
      if (/fonts\.(googleapis|gstatic)\.com/.test(cut)) stop("the package still names Google's fonts");
      return { contents: cut, loader: "js" };
    });
    b.onResolve({ filter: /^qrcode$/ }, (args) => {
      if (!MOBILE.test(args.importer)) stop(`${args.importer} imports qrcode too`);
      return { path: "qrcode", namespace: "left-out" };
    });
    b.onLoad({ filter: /.*/, namespace: "left-out" }, () => ({
      contents: 'export default { toCanvas() { throw new Error("no QR codes here: the remote mode is left out of this build"); } };',
      loader: "js",
    }));
    b.onLoad({ filter: ERRORS }, (args) => {
      const src = readFileSync(args.path, "utf8");
      const start = src.indexOf("var SolanaErrorMessages = {"), end = start < 0 ? -1 : src.indexOf("\n};\n", start);
      // the table is read in one place, which only a build outside production calls
      if (end < 0 || count(src, "SolanaErrorMessages") !== 2 || count(src, "getHumanReadableErrorMessage(") !== 2 || !DEV_ONLY.test(src)) stop("@solana/errors reads its messages differently");
      return { contents: src.slice(0, start) + "var SolanaErrorMessages = {" + src.slice(end + 1), loader: "js" };
    });
  },
};

const result = await build({
  absWorkingDir: root,
  entryPoints: [here("./src/mwa.mjs")],
  outfile: out,
  write: false,
  metafile: true,
  bundle: true,
  format: "iife",
  globalName: "NoxMwa",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  plugins: [trim],
  banner: { js: "/* Mobile Wallet Adapter for Android. BUILT FILE, do not edit: the source is chain/src/mwa.mjs, rebuilt with `npm run build:mwa` in chain/. The licenses of the packages in it are at the end. */" },
  logLevel: "warning",
});

const code = result.outputFiles[0].text;
if (/fonts\.(googleapis|gstatic)\.com/.test(code)) throw new Error("vendor/mwa.js names Google's fonts");

/* ---------- the licenses: each bundled package's own file, as it ships it ---------- */

// the package a bundled file comes from: its folder under the last node_modules in its path
const packageOf = (file) => file.match(/^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/)?.[1] ?? null;
const inputs = Object.values(result.metafile.outputs)[0].inputs;
const dirs = new Set(Object.entries(inputs).filter(([, i]) => i.bytesInOutput > 0).map(([file]) => packageOf(file)).filter(Boolean));
const texts = new Map();                                 // a license's text -> the packages that ship it
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  const file = readdirSync(join(root, dir)).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  if (!file) stop(`${pkg.name} ships no license file`);
  const text = readFileSync(join(root, dir, file), "utf8").replace(/\r\n/g, "\n").trim();
  if (!texts.has(text)) texts.set(text, []);
  texts.get(text).push(`${pkg.name}@${pkg.version} (${pkg.license})`);
}
const blocks = [...texts].map(([text, names]) => [names.sort(), text]).sort((a, b) => a[0][0].localeCompare(b[0][0]));
const licenses = "/* The licenses of the packages bundled above, each text as its packages ship it.\n\n"
  + blocks.map(([names, text]) => `=== ${names.join(", ")}\n\n${text}`).join("\n\n").replace(/\*\//g, "*\\/")
  + "\n*/\n";

const file = code + licenses;
writeFileSync(out, file);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`vendor/mwa.js  ${kb(Buffer.byteLength(file))} (${kb(gzipSync(file).length)} gzip; licenses ${kb(Buffer.byteLength(licenses))} of it, ${dirs.size} packages)`);
