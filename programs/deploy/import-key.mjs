// Makes the keypair file the Solana CLI and these scripts read (a JSON array of 64 numbers) from a wallet you already
// have: the private key a wallet app shows for one account (Phantom: Settings, Manage accounts, the account, Show
// private key), in base58, or the JSON array some wallets export. Only that account goes into the file, never the
// wallet's recovery phrase.
//
// The key is read from standard input, never from the command line, where ps and the shell history would keep it. It
// is never printed: only the address is. Run it in your own terminal, not in one an agent can read:
//
//   read -rsp 'Private key: ' PK && echo && printf %s "$PK" | node programs/deploy/import-key.mjs ~/nox-keys/mainnet-deploy.json; unset PK
//
// It refuses a file that exists already (it never overwrites a key), a path inside a git repository (this one is
// public), a key typed straight at it instead of piped, and a key that is not 64 bytes or whose second half is not the
// address of its first. The file is written readable by you alone.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

function stop(why) {
  console.error(`import-key: ${why}`);
  process.exit(1);
}

const given = process.argv[2];
if (!given) stop("usage: printf %s \"$PK\" | node programs/deploy/import-key.mjs <file to write, such as ~/nox-keys/mainnet-deploy.json>");
if (process.stdin.isTTY) stop("the key is read from a pipe, so it never shows on the screen: see the line at the top of this file");
const file = resolve(given.replace(/^~(?=$|\/)/, homedir()));
if (existsSync(file)) stop(`${file} exists already: this never overwrites a key. Pick another name, or use that file as it is`);

// The nearest folder that exists, and whether it is inside a git repository.
let dir = dirname(file);
while (!existsSync(dir)) dir = dirname(dir);
let top = "";
try { top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* not in one */ }
if (top) stop(`${file} is inside the git repository ${top}, where a key can end up committed. Keep keys outside it (~/nox-keys)`);

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const text = Buffer.concat(chunks).toString("utf8").trim();
chunks.length = 0;
if (!text) stop("nothing came in: paste the key at the prompt of read -rsp");

let bytes;
try {
  if (text.startsWith("[")) {
    const list = JSON.parse(text);
    if (!Array.isArray(list) || !list.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error();
    bytes = Uint8Array.from(list);
  } else {
    bytes = bs58.decode(text);
  }
} catch {
  stop("that is neither a base58 key nor a JSON array of numbers: copy the private key again from the wallet");
}
if (bytes.length !== 64) {
  bytes.fill(0);
  stop(`that key is ${bytes.length} bytes, not 64: copy the private key of the account (not its address, not the recovery phrase)`);
}

let address;
try {
  // Checks that the second half is the address of the first. The keypair reads its address from these same bytes,
  // so the address is taken as text now, before they are wiped below.
  address = Keypair.fromSecretKey(bytes).publicKey.toBase58();
} catch {
  bytes.fill(0);
  stop("the key's two halves do not match: it was cut or changed on the way. Copy it again from the wallet");
}

mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
writeFileSync(file, JSON.stringify(Array.from(bytes)), { mode: 0o600, flag: "wx" });
bytes.fill(0);
console.log(`wrote ${file}`);
console.log(`address ${address}`);
console.log("Check it is the address your wallet shows for that account.");
if (file.startsWith("/mnt/")) console.log("Note: this file is on a Windows drive, where Linux cannot keep it readable by you alone. ~/nox-keys is better.");
