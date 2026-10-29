// Writes the pool program's id for one cluster into the site (site/net.js) and its server (server/config.mjs), then
// checks that the two name the same programs, as server/check.mjs does. Only the program's value changes in each
// file; `git diff` shows it. Run it once check-deploy.mjs passes on that cluster, before the site is pushed: the program
// goes up before the site that uses it.
//
//   node programs/deploy/set-program.mjs mainnet <program id>            (says what it would change, changes nothing)
//   WRITE=1 node programs/deploy/set-program.mjs mainnet <program id>    (changes the two files)
//   ROOT=<a copy of the repository> node set-program.mjs mainnet <id>    (works on that copy instead)
//
// Like the rest of the kit, it only shows unless told: WRITE=1 writes. The devnet site runs on the devnet program
// (CbAjrr…), which a rehearsal leaves alone: moving devnet off it takes FORCE=1 as well.
//
// On Vercel the server can also take the id from PROGRAM_MAINNET (or PROGRAM_DEVNET), which wins over config.mjs; the
// pages only read net.js. Keep them the same.

import { PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.ROOT ?? join(HERE, "..", ".."));
const WRITE = process.env.WRITE === "1";
const FORCE = process.env.FORCE === "1";
/** The program the devnet site runs on today. */
const DEVNET_PROGRAM = "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK";
const stop = (text) => { console.error(`stop: ${text}`); process.exit(1); };

const [cluster, id] = process.argv.slice(2);
if (cluster !== "devnet" && cluster !== "mainnet") stop("usage: set-program.mjs <devnet|mainnet> <program id>");
let key;
try { key = new PublicKey(id ?? ""); } catch { key = null; }
if (!key || key.toBase58() !== id) stop(`"${id ?? ""}" is not a base58 address`);

const files = { net: join(root, "site", "net.js"), config: join(root, "server", "config.mjs") };
const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return stop(`no file at ${file}`); } };

/**
 * net.js: the cluster's block in NETS (`    devnet: {` to its `    },`), and in it the one `program: "…"` line.
 * config.mjs: the cluster's one line in CLUSTERS, and its `program: "…"`.
 */
const spots = {
  net: (text) => {
    const block = new RegExp(`^( *)${cluster}: \\{\\r?\\n[\\s\\S]*?^\\1\\},?\\r?$`, "m").exec(text);
    if (!block) return { error: `no "${cluster}: {" block in site/net.js` };
    const inside = [...block[0].matchAll(/^ *program: "([^"]*)"/gm)];
    if (inside.length !== 1) return { error: `${inside.length} program lines in net.js's ${cluster} block, not one` };
    const at = block.index + inside[0].index + inside[0][0].indexOf('"') + 1;
    return { at, old: inside[0][1] };
  },
  config: (text) => {
    const lines = [...text.matchAll(new RegExp(`^ *${cluster}: \\{[^\\n]*?\\bprogram: "([^"]*)"`, "gm"))];
    if (lines.length !== 1) return { error: `${lines.length} "${cluster}: {" lines with a program in server/config.mjs, not one` };
    const at = lines[0].index + lines[0][0].lastIndexOf('"', lines[0][0].length - 2) + 1;
    return { at, old: lines[0][1] };
  },
};

const texts = { net: read(files.net), config: read(files.config) };
const found = { net: spots.net(texts.net), config: spots.config(texts.config) };
for (const k of ["net", "config"]) if (found[k].error) stop(found[k].error);

const other = cluster === "devnet" ? "mainnet" : "devnet";
for (const [k, label] of [["net", "site/net.js"], ["config", "server/config.mjs"]]) {
  const was = found[k].old;
  console.log(`${label}: ${cluster} program ${was ? `${was} -> ` : "(empty) -> "}${id}${was === id ? " (already)" : ""}`);
}
const movesDevnet = cluster === "devnet" && id !== DEVNET_PROGRAM && [found.net.old, found.config.old].includes(DEVNET_PROGRAM);
if (movesDevnet && !FORCE) {
  stop(`this moves the devnet site off ${DEVNET_PROGRAM}, the program it runs on. A rehearsal never does: FORCE=1 if it is meant`);
}
if (!WRITE) { console.log("nothing written: WRITE=1 writes it"); process.exit(0); }

for (const k of ["net", "config"]) {
  const { at, old } = found[k];
  if (old === id) continue;
  let after = texts[k].slice(at + old.length);
  // net.js lines its comments up in a column: the spaces before this line's comment give way to the longer value.
  if (k === "net") after = after.replace(/^(",)( +)(?=\/\/)/, (_, end, gap) => end + " ".repeat(Math.max(1, gap.length - (id.length - old.length))));
  writeFileSync(files[k], texts[k].slice(0, at) + id + after);
}

// The same checks as server/check.mjs, on the files as they are now.
let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const netJs = readFileSync(files.net, "utf8");
const { CLUSTERS } = await import(`${pathToFileURL(files.config).href}?read=${Date.now()}`);
line(CLUSTERS[cluster].program === id, `server/config.mjs names ${id} for ${cluster}`);
line(spots.net(netJs).old === id, `site/net.js names ${id} for ${cluster}`);
line(netJs.includes(`program: "${CLUSTERS.devnet.program}"`), "site/net.js names the same devnet program as server/config.mjs");
line(/mainnet:[\s\S]*?program: "([^"]*)"/.exec(netJs)?.[1] === CLUSTERS.mainnet.program, "and the same mainnet program");
if (CLUSTERS[other].program === id) console.log(`  note ${other} has the same id: a program's address is per cluster, and Nox's mainnet one is new`);
console.log(failed ? `\n${failed} check(s) failed` : `\ndone. Next: git diff, then the Vercel variable PROGRAM_${cluster.toUpperCase()} (same id, or none), then the push.`);
process.exit(failed ? 1 : 0);
