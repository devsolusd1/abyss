// Checks multisig.mjs without sending anything and without any real key.
//   Offline: the Squads addresses against the SDK and against their seeds; the loader's SetAuthority and Upgrade
//   against the loader's own crate (when cargo has it); update_config against the program's source (lib.rs, state.rs);
//   the rehearsal's wallets; what the commands refuse (a weak multisig on mainnet, a member who signed no key check, a
//   buffer the vault does not hold or that is not BUILD's, an admin no one can sign for, CbAjrr… with SEND=1, a key
//   file in the repository, ...); how a proposal is read out to its voters; the priority price; the confirmation's
//   patience with a stumbling node; the RPC URL hidden from the CLI's errors; and the refusals of the script itself,
//   run as child processes with a test key made here. Nothing here runs multisig.mjs with SEND=1.
//   On devnet (OFFLINE=1 skips it): simulations signed by no one, against the live program (PROGRAM, CbAjrr… by
//   default) with its upgrade authority (AUTHORITY, the devnet wallet by default) as the payer: create, the handoff,
//   the loader's Upgrade, the whole road in one transaction (create, hand over, propose, two votes, execute), the key
//   check's road, and a buffer's close by the KEYPAIR and by the vault. The refusals that need the chain run there too.
//   MAINNET=1 also simulates create against mainnet's Squads, through the public node, and refuses a create for a
//   PROGRAM that is not on mainnet.
//
//   node check-multisig.mjs
//   OFFLINE=1 node check-multisig.mjs
//   MAINNET=1 node check-multisig.mjs
//   PROGRAM=<id> AUTHORITY=<its upgrade authority> node check-multisig.mjs

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import * as squads from "@sqds/multisig";
import * as M from "./multisig.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "multisig.mjs");
const POOL_SRC = join(HERE, "../pool/src");
const PROGRAM = new PublicKey(process.env.PROGRAM ?? "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK");
const AUTHORITY = new PublicKey(process.env.AUTHORITY ?? "7f2MiAuyJ1Aaiheo9ctLgJmzGDWoDceyHEEuVB2mhPAA");
/** Read on devnet and on mainnet: the account exists at this address on both. */
const KNOWN_PROGRAM_CONFIG = "BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr";

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const note = (text) => console.log(`       ${text}`);
const refusedWith = (fn, words) => { try { fn(); return false; } catch (err) { return err instanceof M.Refusal && String(err.message).includes(words); } };
const sha256 = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest(); };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const seed = (s) => Buffer.from(s);
const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];

// A made-up secret, the same on every run: it stands for the KEYPAIR's key in the derivations and is no one's key.
const TEST_SECRET = createHash("sha512").update("nox check-multisig test secret").digest();

/* ---------------- 1. Squads addresses ---------------- */

console.log("Squads addresses: multisig.mjs, the SDK and the seeds of the Squads program");
{
  const createKey = M.createKeyFor(TEST_SECRET, PROGRAM).publicKey;
  const ms = pda([seed("multisig"), seed("multisig"), createKey.toBuffer()], M.SQUADS);
  line(ms.equals(M.multisigAddress(createKey)) && ms.equals(squads.getMultisigPda({ createKey })[0]), `multisig ["multisig", "multisig", create key]: ${ms.toBase58()}`);
  const vault = pda([seed("multisig"), ms.toBuffer(), seed("vault"), Buffer.from([0])], M.SQUADS);
  line(vault.equals(M.vaultAddress(ms)) && vault.equals(squads.getVaultPda({ multisigPda: ms, index: 0 })[0]), `vault 0 ["multisig", multisig, "vault", 0]: ${vault.toBase58()}`);
  const tx = pda([seed("multisig"), ms.toBuffer(), seed("transaction"), u64(7)], M.SQUADS);
  line(tx.equals(M.transactionAddress(ms, 7)) && tx.equals(squads.getTransactionPda({ multisigPda: ms, index: 7n })[0]), "transaction 7 [\"multisig\", multisig, \"transaction\", u64 7]");
  const proposal = pda([seed("multisig"), ms.toBuffer(), seed("transaction"), u64(7), seed("proposal")], M.SQUADS);
  line(proposal.equals(M.proposalAddress(ms, 7)) && proposal.equals(squads.getProposalPda({ multisigPda: ms, transactionIndex: 7n })[0]), "proposal 7 [\"multisig\", multisig, \"transaction\", u64 7, \"proposal\"]");
  const pc = pda([seed("multisig"), seed("program_config")], M.SQUADS);
  line(pc.toBase58() === KNOWN_PROGRAM_CONFIG && pc.equals(M.programConfigAddress()), `program config ["multisig", "program_config"]: ${pc.toBase58()}, the account found on devnet and mainnet`);
  line(M.SQUADS.toBase58() === "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", "the SDK's program id is Squads v4's");
}

/* ---------------- 2. The loader's instructions ---------------- */

console.log("\nThe upgradeable loader: SetAuthority and Upgrade");
const program = PROGRAM, current = Keypair.generate().publicKey, next = Keypair.generate().publicKey;
const programData = pda([program.toBuffer()], M.LOADER);
const flags = (k) => `${k.isWritable ? "w" : "-"}${k.isSigner ? "s" : "-"}`;
{
  const set = M.setUpgradeAuthorityIx(program, current, next);
  line(set.programId.equals(M.LOADER) && set.data.toString("hex") === "04000000", "SetAuthority: the loader's instruction 4, as a u32, and nothing after");
  line(set.keys.length === 3 && set.keys[0].pubkey.equals(programData) && set.keys[1].pubkey.equals(current) && set.keys[2].pubkey.equals(next)
    && set.keys.map(flags).join(" ") === "w- -s --", "SetAuthority's accounts: programdata (writable), current authority (signer), new authority (neither)");
  const buffer = Keypair.generate().publicKey, spill = Keypair.generate().publicKey;
  const up = M.upgradeIx({ program, buffer, spill, authority: next });
  line(up.programId.equals(M.LOADER) && up.data.toString("hex") === "03000000", "Upgrade: the loader's instruction 3, with no trailing close_buffer byte (read as true: the buffer is closed)");
  line(up.keys.map((k) => k.pubkey.toBase58()).join() === [programData, program, buffer, spill, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY, next].map(String).join()
    && up.keys.map(flags).join(" ") === "w- w- w- w- -- -- -s", "Upgrade's accounts: programdata, program, buffer, spill (writable), rent, clock, authority (signer)");

  // The loader's own crate, when cargo has fetched one: the enum's order and the builders' account lists.
  const registry = join(homedir(), ".cargo/registry/src");
  const crates = existsSync(registry) ? readdirSync(registry).flatMap((d) => readdirSync(join(registry, d))
    .filter((c) => c.startsWith("solana-loader-v3-interface-")).map((c) => join(registry, d, c))) : [];
  const version = (p) => p.split("-").pop().split(".").map(Number);
  crates.sort((a, b) => { const x = version(a), y = version(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  if (!crates.length) note("skipped: no solana-loader-v3-interface crate in ~/.cargo/registry to compare against");
  else {
    const src = readFileSync(join(crates.at(-1), "src/instruction.rs"), "utf8");
    const body = src.slice(src.indexOf("pub enum UpgradeableLoaderInstruction {"));
    const variants = [...body.slice(0, body.indexOf("\n}\n")).matchAll(/^ {4}([A-Z]\w*)\s*[{,]/gm)].map((m) => m[1]);
    line(variants.indexOf("Upgrade") === 3 && variants.indexOf("SetAuthority") === 4 && variants.indexOf("SetAuthorityChecked") === 7,
      `the loader's crate (${crates.at(-1).split("/").pop()}): Upgrade is variant 3, SetAuthority 4, SetAuthorityChecked 7`);
    // SIMD-0430 gave Upgrade a trailing close_buffer byte; a crate from before it has none, and closes the buffer always.
    const upgradeDoc = body.slice(body.indexOf("    Upgrade"), body.indexOf("    SetAuthority,"));
    line(!/close_buffer/.test(upgradeDoc) || /trailing byte is absent, this\s+\/\/\/\s+decodes to `true`/.test(upgradeDoc),
      `the crate reads an Upgrade with no close_buffer byte as the upgrade that closes the buffer${/close_buffer/.test(upgradeDoc) ? " (close_buffer = true, SIMD-0430)" : ""}`);
    const metas = (fn) => {
      const start = src.indexOf(`pub fn ${fn}(`);
      const text = src.slice(start, src.indexOf("\n}\n", start));
      return [...text.matchAll(/AccountMeta::(new|new_readonly)\(\s*([^,]+?),\s*(true|false)\s*\)/g)]
        .map(([, kind, name, signer]) => `${name.replace(/^\*/, "").replace(/_address$/, "")}:${kind === "new" ? "w" : "-"}${signer === "true" ? "s" : "-"}`);
    };
    const want = "programdata:w-,program:w-,buffer:w-,spill:w-,sysvar::rent::id():--,sysvar::clock::id():--,authority:-s";
    line(metas("upgrade").join() === want, `the crate's upgrade(): ${metas("upgrade").join(" ")}`);
    line(metas("set_upgrade_authority").join() === "programdata:w-,current_authority:-s,address:--", `the crate's set_upgrade_authority(): ${metas("set_upgrade_authority").join(" ")}`);
    line(metas("set_buffer_authority").join() === "buffer:w-,current_authority:-s,new_authority:--" && variants.indexOf("Close") === 5,
      `the crate's set_buffer_authority(): ${metas("set_buffer_authority").join(" ")}, as setBufferAuthorityIx; Close is variant 5`);
    line(metas("close_any").join() === "close:w-,recipient:w-,authority:-s,program:w-", `the crate's close_any(): ${metas("close_any").join(" ")} (closeBufferIx gives the first three: a buffer has no program)`);
  }
  const buf = Keypair.generate().publicKey, holder = Keypair.generate().publicKey, vault = Keypair.generate().publicKey;
  const give = M.setBufferAuthorityIx(buf, holder, vault), close = M.closeBufferIx(buf, holder, vault);
  line(give.data.toString("hex") === "04000000" && give.keys.map(flags).join(" ") === "w- -s --" && give.keys.map((k) => k.pubkey.toBase58()).join() === [buf, holder, vault].join(),
    "SetAuthority on a buffer: instruction 4, buffer (writable), current authority (signer), new authority");
  line(close.data.toString("hex") === "05000000" && close.keys.map(flags).join(" ") === "w- w- -s" && close.keys.map((k) => k.pubkey.toBase58()).join() === [buf, holder, vault].join(),
    "Close of a buffer: instruction 5, buffer and recipient (writable), authority (signer)");
  const k = Keypair.generate().publicKey;
  line(M.base58(k.toBytes()) === k.toBase58() && M.base58(new Uint8Array(32)) === PublicKey.default.toBase58(), "base58, for a signature printed before it is sent: as web3.js writes keys");
}

/* ---------------- 3. update_config against the program's source ---------------- */

console.log("\nupdate_config, against programs/pool/src");
{
  const lib = readFileSync(join(POOL_SRC, "lib.rs"), "utf8"), state = readFileSync(join(POOL_SRC, "state.rs"), "utf8"), math = readFileSync(join(POOL_SRC, "math.rs"), "utf8");
  const fields = (src, name) => {
    const m = src.match(new RegExp(`pub struct ${name}(?:<'info>)? \\{([\\s\\S]*?)\\n\\}`));
    return m ? [...m[1].matchAll(/^\s*pub (\w+): ([\w<>', ]+),/gm)].map(([, n, t]) => [n, t.trim()]) : [];
  };
  const args = fields(lib, "ConfigArgs");
  const expected = "admin:Pubkey,launcher:Pubkey,treasury:Pubkey,launch_fee:u64,min_fee_bps:u16,treasury_share_bps:u16,launches_open:bool";
  line(args.map(([n, t]) => `${n}:${t}`).join() === expected, `ConfigArgs in lib.rs: ${args.map(([n, t]) => `${n} ${t}`).join(", ")}`);
  const size = { Pubkey: 32, u64: 8, u16: 2, bool: 1 };
  line(args.reduce((s, [, t]) => s + size[t], 0) === M.CONFIG_ARGS_LEN, `ConfigArgs is ${M.CONFIG_ARGS_LEN} bytes of borsh`);

  // The same args encoded from lib.rs's field list, field by field, and by multisig.mjs: the bytes must match.
  const vault = M.vaultAddress(M.multisigAddress(M.createKeyFor(TEST_SECRET, PROGRAM).publicKey));
  const sample = { admin: vault, launcher: AUTHORITY, treasury: current, launchFee: 123_456_789n, minFeeBps: 100, treasuryShareBps: 5000, launchesOpen: true };
  const camel = (n) => n.replace(/_(\w)/g, (_, c) => c.toUpperCase());
  const borsh = Buffer.concat(args.map(([n, t]) => {
    const v = sample[camel(n)];
    if (t === "Pubkey") return v.toBuffer();
    const b = Buffer.alloc(size[t]);
    if (t === "u64") b.writeBigUInt64LE(v); else if (t === "u16") b.writeUInt16LE(v); else b[0] = v ? 1 : 0;
    return b;
  }));
  const ix = M.updateConfigIx(PROGRAM, vault, sample);
  const discriminator = sha256("global:update_config").subarray(0, 8);
  line(ix.data.equals(Buffer.concat([discriminator, borsh])), `update_config's data: sha256("global:update_config")[..8] ${discriminator.toString("hex")}, then the args, admin = the vault`);
  line(!/discriminator\s*=/.test(lib), "lib.rs sets no custom discriminator, so Anchor's sha256 one holds");
  const roundTrip = M.decodeConfigArgs(ix.data, 8);
  line(M.sameConfig(roundTrip, sample), "decoding the args gives them back");
  const accounts = fields(lib, "UpdateConfig");
  const block = lib.match(/pub struct UpdateConfig<'info> \{([\s\S]*?)\n\}/)[1];
  const mut = (n) => new RegExp(`#\\[account\\(mut[^\\n]*\\)\\]\\s*(?:///[^\\n]*\\s*)*pub ${n}:`).test(block);
  line(accounts.map(([n]) => n).join() === "admin,config,treasury" && /Signer/.test(accounts[0][1]) && !mut("admin") && mut("config") && mut("treasury"),
    "UpdateConfig in lib.rs: admin (Signer), config (mut), treasury (mut)");
  line(ix.keys.map(flags).join(" ") === "-s w- w-" && ix.keys[0].pubkey.equals(vault) && ix.keys[1].pubkey.equals(M.configAddress(PROGRAM)) && ix.keys[2].pubkey.equals(current),
    "update_config's accounts: the vault signs, the config and the treasury the args name are written");
  line(M.configAddress(PROGRAM).equals(pda([seed("config")], PROGRAM)) && /CONFIG_SEED: &\[u8\] = b"config"/.test(state), "the config is at [\"config\"], CONFIG_SEED in state.rs");
  const config = fields(state, "Config").map(([n]) => n).join();
  line(config === `${args.map(([n]) => n).join()},bump`, "Config in state.rs: the ConfigArgs fields in the same order, then bump, as decodeConfig reads it");
  const account = Buffer.concat([sha256("account:Config").subarray(0, 8), borsh, Buffer.from([254])]);
  line(M.sameConfig(M.decodeConfig(account), sample) && M.decodeConfig(Buffer.concat([Buffer.alloc(8), borsh, Buffer.from([254])])) === null,
    "decodeConfig reads a Config account and refuses one without Config's discriminator");
  const constant = (src, name) => (src.match(new RegExp(`pub const ${name}: \\w+ = ([^;]+);`)) ?? [])[1];
  const sol = (state.match(/const SOL: u64 = ([\d_]+);/) ?? [])[1];
  line(constant(state, "MAX_FEE_BPS") === String(M.MAX_FEE_BPS) && constant(state, "MAX_LAUNCH_FEE") === "SOL" && sol === "1_000_000_000"
    && constant(math, "BPS") === "10_000" && M.BPS === 10_000
    && M.MAX_LAUNCH_FEE === 1_000_000_000n, "the bounds propose-config checks are the program's: MAX_FEE_BPS 300, MAX_LAUNCH_FEE 1 SOL, BPS 10 000");
}

/* ---------------- 4. The rehearsal's wallets ---------------- */

console.log("\nThe rehearsal's wallets and the create key");
{
  const by = (label) => Keypair.fromSeed(createHash("sha256").update(TEST_SECRET).update(label).digest()).publicKey;
  const members = [1, 2, 3].map((n) => M.rehearsalMember(TEST_SECRET, n).publicKey);
  line(members.every((m, i) => m.equals(by(`nox rehearsal member ${i + 1}`))), "member n is Keypair.fromSeed(sha256(secret + \"nox rehearsal member n\")), as seats-check.mjs makes its wallets");
  line(new Set(members.map(String)).size === 3 && members.every((m) => ![1, 2, 3, 4, 5, 6].some((n) => by(`nox seats-check ${n}`).equals(m))),
    "the three differ from one another and from seats-check.mjs's six wallets");
  const ck = M.createKeyFor(TEST_SECRET, PROGRAM).publicKey;
  line(ck.equals(by(`nox multisig create key ${PROGRAM.toBase58()}`)) && ck.equals(M.createKeyFor(TEST_SECRET, PROGRAM).publicKey), "the create key is the same on every run for one KEYPAIR and PROGRAM");
  line(!ck.equals(M.createKeyFor(TEST_SECRET, Keypair.generate().publicKey).publicKey) && !ck.equals(M.createKeyFor(Buffer.alloc(64, 7), PROGRAM).publicKey) && !members.some((m) => m.equals(ck)),
    "another PROGRAM or another KEYPAIR gives another create key, and no member is the create key");
}

/* ---------------- 5. What the commands refuse ---------------- */

console.log("\nRefusals, checked in the functions");
const members = [1, 2, 3].map((n) => M.rehearsalMember(TEST_SECRET, n).publicKey);
{
  const base = { PROGRAM: PROGRAM.toBase58() };
  line(refusedWith(() => M.settings("create", { ...base, CLUSTER: "mainnet", RPC_URL: "https://x.example", KEYPAIR: "k", REHEARSAL: "1" }), "devnet only"), "REHEARSAL=1 on mainnet");
  line(refusedWith(() => M.settings("create", { ...base, CLUSTER: "mainnet", KEYPAIR: "k" }), "needs RPC_URL"), "mainnet with no RPC_URL");
  line(refusedWith(() => M.settings("create", { ...base, CLUSTER: "mainnet", RPC_URL: "https://x.example" }), "needs KEYPAIR"), "mainnet with no KEYPAIR (no devnet default there)");
  line(refusedWith(() => M.settings("create", { CLUSTER: "devnet" }), "PROGRAM="), "no PROGRAM");
  line(refusedWith(() => M.settings("approve", { ...base, MEMBER: "2" }), "needs REHEARSAL=1"), "MEMBER=n outside a rehearsal");
  line(refusedWith(() => M.settings("create", { ...base, SEND: "yes" }), "SEND is 1 or 0"), "SEND=yes (only 1 sends)");
  line(refusedWith(() => M.settings("deploy", base), "usage"), "an unknown command");
  const shape = (o) => M.checkShape({ cluster: "devnet", members, threshold: 2, timelock: 60, ...o });
  line(shape({ threshold: 4 }).refusals.some((r) => r.includes("more than the 3 members")), "THRESHOLD 4 with 3 members");
  line(shape({ threshold: 0 }).refusals.length > 0, "THRESHOLD 0");
  line(shape({ members: [members[0], members[1], members[0]] }).refusals.some((r) => r.includes("listed twice")), "a member listed twice");
  line(shape({ members: [members[0], M.vaultAddress(members[0])] }).refusals.some((r) => r.includes("could never sign")), "a member that is an address of a program (no key can sign for it)");
  line(shape({ timelock: M.MAX_TIMELOCK + 1 }).refusals.length > 0 && !shape({ timelock: M.MAX_TIMELOCK }).refusals.length, "TIMELOCK over 90 days, and 90 days exactly passes");
  // Mainnet: a weak multisig is refused at create, as check-deploy.mjs fails it afterwards (it only warned before).
  const weakCreate = M.checkShape({ cluster: "mainnet", members, threshold: 1, timelock: 0, payer: members[0] }).refusals;
  line(weakCreate.some((r) => r.includes("threshold is 1")) && weakCreate.some((r) => r.includes("timelock is 0")) && weakCreate.some((r) => r.includes("KEYPAIR is one of its members"))
    && !M.checkShape({ cluster: "devnet", members, threshold: 1, timelock: 0 }).refusals.length
    && !M.checkShape({ cluster: "mainnet", members, threshold: 2, timelock: 86_400, payer: AUTHORITY }).refusals.length,
  "create on mainnet refuses THRESHOLD 1, TIMELOCK 0 and the KEYPAIR as a member; devnet takes them; a 2 of 3 with a day passes");
  line(refusedWith(() => M.parseKeys("abc,0OIl", "MEMBERS"), "is not a public key"), "MEMBERS with something that is not a public key");
  // Called with send = true in the function only: nothing here ever runs multisig.mjs with SEND=1.
  const wallets = [1, 2, 3].map((n) => M.rehearsalMember(TEST_SECRET, n));
  line(refusedWith(() => M.expectedMembersFor({}, { rehearsal: false, send: true }), "needs MEMBERS") && M.expectedMembersFor({}, { rehearsal: false, send: false }) === null
    && M.sameKeys(M.expectedMembersFor({ MEMBERS: members.join(",") }, { rehearsal: false, send: true }), members)
    && M.sameKeys(M.expectedMembersFor({}, { rehearsal: true, send: true, rehearsalWallets: wallets }), members)
    && refusedWith(() => M.expectedMembersFor({ MEMBERS: members.join(",") }, { rehearsal: true, send: false, rehearsalWallets: wallets }), "leave MEMBERS out"),
  "a handoff that sends needs the expected members (MEMBERS, or the rehearsal's), on every cluster; a dry run may go without");
  line(refusedWith(() => M.configOverrides({ LAUNCH_FEE: "1000000001" }), "LAUNCH_FEE") && refusedWith(() => M.configOverrides({ MIN_FEE_BPS: "301" }), "MIN_FEE_BPS")
    && refusedWith(() => M.configOverrides({ TREASURY_SHARE_BPS: "10001" }), "TREASURY_SHARE_BPS") && refusedWith(() => M.configOverrides({ ADMIN: "11111111111111111111111111111111" }), "lock the config"),
  "propose-config past the program's bounds, or with ADMIN = the empty address");

  // The handoff's verdict on every kind of state.
  const address = M.multisigAddress(M.createKeyFor(TEST_SECRET, PROGRAM).publicKey), vault = M.vaultAddress(address);
  const ms = { threshold: 2, timeLock: 60, configAuthority: PublicKey.default, rentCollector: vault, members: members.map((key) => ({ key, mask: 7 })) };
  const cfg = { admin: AUTHORITY, launcher: AUTHORITY, treasury: AUTHORITY, launchFee: 0n, minFeeBps: 100, treasuryShareBps: 5000, launchesOpen: false };
  const verdict = (o) => M.checkHandoff({ cluster: "devnet", address, found: { ms }, vault, expectedVault: null, expectedMembers: members, proven: members, payer: AUTHORITY, authority: AUTHORITY, config: cfg, ...o });
  const good = verdict({});
  line(!good.refusals.length && good.parts.authority && good.parts.config, "a handoff from the KEYPAIR to vault 0 of a working multisig with the expected members: both parts to do, nothing refused");
  line(verdict({ expectedVault: Keypair.generate().publicKey }).refusals.some((r) => r.includes("is not vault 0")), "VAULT that is not vault 0 of MULTISIG");
  line(verdict({ found: M.decodeMultisig(null) }).refusals.some((r) => r.includes("does not exist")), "a MULTISIG that does not exist");
  const systemAccount = { owner: new PublicKey("11111111111111111111111111111111"), data: Buffer.alloc(0), lamports: 1, executable: false };
  line(verdict({ found: M.decodeMultisig(systemAccount) }).refusals.some((r) => r.includes("not a Squads v4 account")), "a MULTISIG that is a wallet (say, the vault passed by mistake)");
  const proposalLike = { owner: M.SQUADS, data: Buffer.from(squads.accounts.proposalDiscriminator), lamports: 1, executable: false };
  line(verdict({ found: M.decodeMultisig(proposalLike) }).refusals.some((r) => r.includes("not a multisig")), "a Squads account that is not a multisig");
  line(verdict({ expectedMembers: [members[0], members[1], Keypair.generate().publicKey] }).refusals.some((r) => r.includes("not the ones expected")), "a multisig whose members are not the ones expected");
  line(verdict({ found: { ms: { ...ms, members: ms.members.map((m) => ({ ...m, mask: 1 })) } } }).refusals.some((r) => r.includes("could never pass")), "a multisig with fewer voters than its threshold");
  line(verdict({ authority: Keypair.generate().publicKey }).refusals.some((r) => r.includes("not the KEYPAIR")), "an upgrade authority other than the KEYPAIR");
  line(verdict({ authority: null }).refusals.some((r) => r.includes("immutable")), "an immutable program");
  line(verdict({ config: { ...cfg, admin: Keypair.generate().publicKey } }).refusals.some((r) => r.includes("config's admin")), "a config admin other than the KEYPAIR");
  line(verdict({ config: null }).refusals.some((r) => r.includes("init-config first")), "a program with no config yet");
  const half = verdict({ authority: vault });
  line(!half.refusals.length && !half.parts.authority && half.parts.config, "a handoff done halfway: only the part left is done");
  const weak = verdict({ cluster: "mainnet", found: { ms: { ...ms, threshold: 1, timeLock: 0, configAuthority: members[2] } } }).refusals;
  line(weak.some((r) => r.includes("threshold is 1")) && weak.some((r) => r.includes("timelock is 0")) && weak.some((r) => r.includes("config authority")),
    "on mainnet the handoff refuses a threshold of 1, no timelock and a config authority (it only warned before)");
  line(verdict({ found: { ms: { ...ms, configAuthority: members[2] } } }).refusals.some((r) => r.includes("config authority")), "a config authority is refused on devnet too: it could swap the members alone");
  const withPayer = [members[0], members[1], AUTHORITY];
  const payerMember = (cluster) => verdict({ cluster, found: { ms: { ...ms, timeLock: 86_400, members: withPayer.map((key) => ({ key, mask: 7 })) } }, expectedMembers: withPayer, proven: withPayer });
  line(payerMember("mainnet").refusals.some((r) => r.includes("KEYPAIR is one of its members")) && !payerMember("devnet").refusals.length && payerMember("devnet").warnings.length > 0,
    "the KEYPAIR among the members: refused on mainnet (the deploy wallet keeps no say), a warning on devnet");
  line(verdict({ expectedThreshold: 3 }).refusals.some((r) => r.includes("not THRESHOLD 3")) && verdict({ expectedTimelock: 86_400 }).refusals.some((r) => r.includes("not TIMELOCK 86400"))
    && !verdict({ expectedThreshold: 2, expectedTimelock: 60 }).refusals.length, "THRESHOLD and TIMELOCK, when given to the handoff, must be the multisig's");
  // Called with send = true in the function only.
  line(refusedWith(() => M.expectedFor({ MEMBERS: members.join(",") }, { rehearsal: false, send: true, cluster: "mainnet" }), "THRESHOLD=n and TIMELOCK")
    && M.expectedFor({ MEMBERS: members.join(","), THRESHOLD: "2", TIMELOCK: "86400" }, { rehearsal: false, send: true, cluster: "mainnet" }).timelock === 86_400
    && M.expectedFor({ MEMBERS: members.join(",") }, { rehearsal: false, send: true, cluster: "devnet" }).threshold === null,
  "a mainnet handoff that sends needs THRESHOLD and TIMELOCK too (a rehearsal's 60 s would slip by otherwise); devnet goes without");
  // A timelock under an hour on mainnet: check-deploy.mjs fails it after the handoff, which can't be undone, so create
  // and the handoff refuse it first (they only warned before). MIN_TIMELOCK moves the line, as in check-deploy.mjs.
  const typo = M.checkShape({ cluster: "mainnet", members, threshold: 2, timelock: 864, payer: AUTHORITY }).refusals;
  line(typo.some((r) => r.includes("under 3600")) && !M.checkShape({ cluster: "mainnet", members, threshold: 2, timelock: 3600, payer: AUTHORITY }).refusals.length
    && !M.checkShape({ cluster: "mainnet", members, threshold: 2, timelock: 864, payer: AUTHORITY, minTimelock: 600 }).refusals.length
    && verdict({ cluster: "mainnet" }).refusals.some((r) => r.includes("under 3600")) && M.MIN_MAINNET_TIMELOCK === 3600,
  "on mainnet, create and the handoff refuse a timelock under an hour (864 s for 86400, say), as check-deploy.mjs does; MIN_TIMELOCK moves it");
  // A handoff done: its key check may be executed and cleaned up since, so a run to see where things stand finds no proof.
  const done = verdict({ authority: vault, config: { ...cfg, admin: vault }, proven: [] });
  line(!done.refusals.length && !done.parts.authority && !done.parts.config && verdict({ proven: [] }).refusals.some((r) => r.includes("signed no key check")),
    "a handoff done already asks for no key check (its proposal may be cleaned up since); one still to do does");
  const mainBase = { ...base, CLUSTER: "mainnet", RPC_URL: "https://node.invalid", KEYPAIR: "/nowhere/deploy.json" };
  line(M.settings("status", { ...mainBase, PRICE: "700000" }).priority === 700_000n && M.settings("status", { ...mainBase, PRIORITY_FEE: "800000" }).priority === 800_000n
    && refusedWith(() => M.settings("status", { ...mainBase, PRICE: "700000", PRIORITY_FEE: "800000" }), "two prices")
    && M.settings("status", { ...base, PRICE: "700000" }).priority === null,
  "PRICE, as deploy.sh and init-config.mjs call it, sets the priority price too; two different prices are refused; devnet pays none");

  // The key check: every member signs one before the handoff, so a mistyped member shows while nothing depends on it.
  const keycheck = (creator, approved, more = {}) => ({ index: 1n, vtx: { creator, instructions: [{ programId: M.MEMO, accounts: [], data: Buffer.from(M.KEYCHECK) }] },
    proposal: { status: "Active", approved, rejected: [], cancelled: [], ...more } });
  const otherMemo = { index: 2n, vtx: { creator: members[2], instructions: [{ programId: M.MEMO, accounts: [], data: Buffer.from("not the key check") }] }, proposal: { status: "Active", approved: [], rejected: [], cancelled: [] } };
  const proven = M.provenMembers([keycheck(members[0], [members[1]]), otherMemo]);
  line(M.sameKeys(proven, [members[0], members[1]]), "the key check counts its proposer and its voters; a proposal that is not the key check counts no one");
  const short = verdict({ proven }).refusals;
  line(short.length === 1 && short[0].includes("not every member") && short[0].includes(members[2].toBase58()), "the handoff refuses while a member has signed no key check, and names them");
  line(verdict({ proven: null }).refusals.some((r) => r.includes("not every member")), "and refuses when no key check was read at all");
  line(!verdict({ proven: M.provenMembers([keycheck(members[0], [members[1]]), keycheck(members[2], [], { status: "Approved" })]) }).refusals.length, "every member through two key checks: nothing refused");

  // The config's admin and launcher: someone must be able to sign as them.
  const other = M.multisigAddress(Keypair.generate().publicKey), otherVault = M.vaultAddress(other);
  line(M.checkConfigTargets({ ...cfg, ...M.configOverrides({ ADMIN: address.toBase58() }) }, { vault }).some((r) => r.includes("admin")),
    "ADMIN = the multisig's own address (not its vault): refused, no one could ever sign as it");
  const viaMultisig = M.configOverrides({ ADMIN_MULTISIG: other.toBase58() });
  line(viaMultisig.admin.equals(otherVault) && !M.checkConfigTargets({ ...cfg, ...viaMultisig }, { vault, otherVault }).length && M.checkConfigTargets({ ...cfg, ...viaMultisig }, { vault }).length === 1,
    "ADMIN_MULTISIG: the admin becomes that multisig's vault, taken only once that multisig is checked");
  line(refusedWith(() => M.configOverrides({ ADMIN: AUTHORITY.toBase58(), ADMIN_MULTISIG: other.toBase58() }), "one or the other"), "ADMIN and ADMIN_MULTISIG that disagree");
  line(M.checkConfigTargets({ ...cfg, launcher: otherVault }, { vault }).some((r) => r.includes("launcher")) && !M.checkConfigTargets(cfg, { vault }).length && !M.checkConfigTargets({ ...cfg, admin: vault }, { vault }).length,
    "LAUNCHER off the curve: refused; wallets, and this multisig's vault as admin, pass");

  // Pure calls only: settings() reads the variables and sends nothing.
  line(refusedWith(() => M.settings("handoff", { PROGRAM: "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK", SEND: "1" }), "the site runs on today")
    && M.settings("handoff", { PROGRAM: "CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK" }).send === false
    && M.settings("handoff", { PROGRAM: Keypair.generate().publicKey.toBase58(), SEND: "1" }).send === true,
  "SEND=1 for CbAjrr… (the site's devnet program) is refused; its dry run, and a send for another program, pass the settings");

  // create reads PROGRAM: the multisig is tied to it for good.
  const tie = (o) => M.checkCreateProgram({ cluster: "devnet", program: PROGRAM, state: { upgradeable: true, authority: AUTHORITY }, payer: AUTHORITY, vault, ...o });
  line(tie({ cluster: "mainnet", state: null }).refusals.some((r) => r.includes("does not exist")) && tie({ state: null }).warnings.some((w) => w.includes("does not exist")) && !tie({ state: null }).refusals.length,
    "create for a PROGRAM that is not there: refused on mainnet (deploy first), a warning on devnet");
  line(tie({ state: { upgradeable: true, authority: members[0] } }).refusals.some((r) => r.includes("not the KEYPAIR")) && tie({ state: { upgradeable: true, authority: null } }).refusals.length === 1
    && tie({ state: { upgradeable: false } }).refusals.length === 1 && !tie({}).refusals.length && !tie({ state: { upgradeable: true, authority: vault } }).refusals.length,
  "create for a PROGRAM held by someone else, immutable, or not a program: refused; held by the KEYPAIR or the vault: fine");

  // One open proposal per change; cleanup closes what Squads lets anyone close.
  const upInner = [M.upgradeIx({ program: PROGRAM, buffer: current, spill: AUTHORITY, authority: vault })];
  const held = (ixs) => ixs.map((ix) => ({ programId: ix.programId, accounts: ix.keys.map((x) => x.pubkey), data: Buffer.from(ix.data) }));
  const entry = (index, status, ixs = upInner) => ({ index, vtx: { creator: members[0], instructions: held(ixs) }, proposal: status ? { status, approved: [], rejected: [], cancelled: [] } : null });
  line(M.findTwin([entry(1n, "Active")], upInner)?.index === 1n && M.findTwin([entry(1n, "Approved")], upInner)?.index === 1n && !M.findTwin([entry(1n, "Executed")], upInner)
    && !M.findTwin([entry(1n, "Active")], upInner, { staleIndex: 1n }) && !M.findTwin([entry(1n, "Active", [M.keycheckIx()])], upInner),
  "a second proposal of a change still open (Active or Approved) is refused; an executed or stale one, or another change, is no twin");
  line(Boolean(M.findTwin([entry(1n, "Active", [M.keycheckIx()])], [M.keycheckIx()], { keycheck: true })) && !M.findTwin([entry(1n, "Approved", [M.keycheckIx()])], [M.keycheckIx()], { keycheck: true }),
    "an open key check is a twin; one that has passed is not (it takes no more signers)");
  line(M.closable(entry(1n, "Executed"), 0n) && M.closable(entry(1n, "Rejected"), 0n) && !M.closable(entry(1n, "Approved"), 5n) && !M.closable(entry(1n, "Active"), 0n) && M.closable(entry(1n, "Active"), 1n),
    "cleanup closes finished proposals, and stale ones never approved");

  // What a vote on an upgrade checks: the vault holds the buffer, and its bytes are BUILD's.
  const so = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), PROGRAM.toBuffer(), Buffer.alloc(100, 9)]);
  const buf = { authority: vault, bytes: Buffer.concat([so, Buffer.alloc(16)]) };
  line(!M.checkBuffer({ cluster: "mainnet", buffer: buf, vault, so, needBuild: true }).length, "a buffer the vault holds, with BUILD's bytes: nothing refused");
  line(M.checkBuffer({ cluster: "devnet", buffer: { ...buf, authority: AUTHORITY }, vault }).some((r) => r.includes("not the vault")), "a buffer someone else still holds (they could rewrite it after the vote): refused");
  line(M.checkBuffer({ cluster: "devnet", buffer: buf, vault, so: Buffer.concat([so, Buffer.from([1])]) }).some((r) => r.includes("are not BUILD's")), "a buffer whose bytes are not BUILD's: refused");
  line(M.checkBuffer({ cluster: "mainnet", buffer: buf, vault, needBuild: true }).some((r) => r.includes("BUILD=")) && !M.checkBuffer({ cluster: "devnet", buffer: buf, vault, needBuild: true }).length,
    "on mainnet a vote on an upgrade needs BUILD; devnet may go without");
  line(M.checkBuffer({ cluster: "devnet", buffer: null, vault }).some((r) => r.includes("gone")), "a buffer that is gone: refused");

  // How a proposal is read out to its voters, and what stops approve and execute without DANGER=1.
  const read = (programId, accounts, data) => M.explainInstruction({ programId, accounts, data }, { program: PROGRAM, vault, config: cfg });
  const readIx = (ix) => read(ix.programId, ix.keys.map((x) => x.pubkey), Buffer.from(ix.data));
  line(Boolean(read(M.LOADER, [programData, AUTHORITY, vault, PROGRAM], Buffer.from("05000000", "hex")).danger?.includes("closes a PROGRAM")), "the loader's Close of the program: named, and a danger");
  line(readIx(M.closeBufferIx(current, AUTHORITY, vault)).text.startsWith("close ") && !readIx(M.closeBufferIx(current, AUTHORITY, vault)).danger, "a buffer's Close: named, no danger");
  line(Boolean(read(M.LOADER, [programData, vault], Buffer.from("04000000", "hex")).danger?.includes("for good")), "SetAuthority with no new authority (immutable for good): a danger");
  line(Boolean(readIx(M.setUpgradeAuthorityIx(PROGRAM, vault, otherVault)).danger) && !readIx(M.setUpgradeAuthorityIx(PROGRAM, vault, AUTHORITY)).danger,
    "SetAuthority to an address of a program other than this vault: a danger; to a wallet: none");
  const up5 = read(M.LOADER, [programData, PROGRAM, current, AUTHORITY, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY, vault], Buffer.from("0300000000", "hex"));
  line(up5.upgrade?.closes === false && !up5.danger && readIx(upInner[0]).upgrade?.closes === true, "an Upgrade with the close_buffer byte (5 bytes) is read as an upgrade, one that keeps the buffer");
  line(read(M.LOADER, [programData, PROGRAM], Buffer.from("0600000000040000", "hex")).text.includes("by 1024 bytes"), "ExtendProgram: named, with its bytes");
  line(Boolean(read(new PublicKey("ComputeBudget111111111111111111111111111111"), [], Buffer.from([2, 0, 0, 0, 0])).danger) && !readIx(M.keycheckIx()).danger && readIx(M.keycheckIx()).text.includes("key check"),
    "an instruction this script can't read: a danger; the key check's memo: none");
  line(Boolean(readIx(M.updateConfigIx(PROGRAM, vault, { ...cfg, admin: address })).danger) && !readIx(M.updateConfigIx(PROGRAM, vault, { ...cfg, launchesOpen: true })).danger
    && readIx(M.updateConfigIx(PROGRAM, vault, { ...cfg, launchesOpen: true })).text.includes("launches_open false -> true"),
  "update_config with the multisig itself as admin: a danger; opening launches: named, no danger");

  // The priority price: the node's recent fees, as measured on mainnet, are all 0.
  line(M.pickPrice(Array(150).fill(0)).price === M.PRIORITY_FLOOR && M.pickPrice([]).why.includes("floor") && M.PRIORITY_FLOOR >= 500_000n,
    `priority: with the node's recent fees all 0, the floor (${M.PRIORITY_FLOOR}, check-deploy.mjs's), and the output says so`);
  line(M.pickPrice([0, 0, 2_000_000, 3_000_000, 4_000_000]).price === 3_000_000n && M.pickPrice([1e9]).price === M.PRIORITY_CAP, "a 75th percentile of the fees paid, kept under the cap");
  line(M.bumpPrice(M.PRIORITY_FLOOR) === 2n * M.PRIORITY_FLOOR && M.bumpPrice(M.PRIORITY_CAP) === M.PRIORITY_CAP, "after an expiry the price doubles, up to the cap");

  // The confirmation, with made-up nodes.
  let calls = 0;
  const flaky = {
    async getSignatureStatuses() { if (calls++ < 3) throw new Error("503 Service Unavailable"); return { value: [{ confirmationStatus: "confirmed" }] }; },
    async getBlockHeight() { return 0; }, async sendRawTransaction() { return ""; },
  };
  const dead = { async getSignatureStatuses() { throw new Error("timeout"); }, async getBlockHeight() { throw new Error("timeout"); }, async sendRawTransaction() { return ""; } };
  const gone = { async getSignatureStatuses() { return { value: [null] }; }, async getBlockHeight() { return 101; }, async sendRawTransaction() { return ""; } };
  const states = [await M.confirm(flaky, "sig", 100, Buffer.alloc(0), { pause: 1, patience: 5 }), await M.confirm(dead, "sig", 100, Buffer.alloc(0), { pause: 1, patience: 5 }),
    await M.confirm(gone, "sig", 100, Buffer.alloc(0), { pause: 1 })].map((s) => s.state);
  line(states.join() === "confirmed,unknown,expired", `confirmation: three node errors, then confirmed (${states[0]}); a node that never answers (${states[1]}: the signature is printed, nothing sent again); gone after its blockhash (${states[2]}: safe to send again)`);

  // The CLI prints the URL it could not reach, rewritten (a "/" before the "?"): what it prints is filtered.
  const scrub = M.makeScrub("https://leakcheck.example?api-key=LEAKCHECK-KEY-999");
  const cliError = "Error: AccountNotFound: error sending request for url (https://leakcheck.example/?api-key=LEAKCHECK-KEY-999)";
  line(!scrub(cliError).includes("LEAKCHECK-KEY-999") && !scrub(cliError).includes("leakcheck.example"), `the CLI's error with the URL in it, filtered: "${scrub(cliError)}"`);
  const wb = M.writeBufferArgs({ so: "/r/dex.so", bufferPath: "/k/buffer.json", url: "https://leakcheck.example?api-key=K", hideUrl: true, keypairPath: "/k/deploy.json", price: 500_000n });
  const shown = wb.shown.join(" ");
  line(wb.args.includes("https://leakcheck.example?api-key=K") && !shown.includes("api-key") && shown.includes("--url <RPC_URL>") && shown.includes("--max-sign-attempts 30")
    && shown.includes("--with-compute-unit-price 500000") && shown.includes("--use-rpc") && !M.writeBufferArgs({ ...wb, price: 0n }).args.includes("--with-compute-unit-price"),
  "write-buffer: the CLI gets the URL, the printed command shows <RPC_URL>, with the price and 30 sign attempts (no price at 0)");
  const direct = M.writeBufferArgs({ so: "/r/dex.so", bufferPath: "/k/buffer.json", url: "https://api.devnet.solana.com", hideUrl: false, keypairPath: "/k/deploy.json", price: 0n, useRpc: false });
  line(!direct.args.includes("--use-rpc") && M.useRpcFor("mainnet", {}) === true && M.useRpcFor("devnet", {}) === false
    && M.useRpcFor("devnet", { USE_RPC: "1" }) === true && M.useRpcFor("mainnet", { USE_RPC: "0" }) === false,
  "write-buffer: through the node on mainnet, straight to the validators on devnet (the public node turns writes away), USE_RPC overrides");

  // Key files: none from inside a git repository (a git add -A and a push would publish it).
  const repo = M.gitRepoAbove(join(HERE, "member-1.json"));
  line(Boolean(repo) && refusedWith(() => M.outsideRepo(join(HERE, "member-1.json"), "MEMBER_KEYPAIR"), "inside the git repository") && !M.gitRepoAbove(join(tmpdir(), "key.json")),
    `a key file inside the repository (${repo}) is refused; one in ${tmpdir()} is not`);
}

console.log("\nRefusals, through multisig.mjs itself (a child process with a test key; nothing of a key is printed)");
const dir = mkdtempSync(join(tmpdir(), "nox-check-multisig-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const testKey = join(dir, "test-keypair.json");
writeFileSync(testKey, JSON.stringify(Array.from(Keypair.generate().secretKey)));
const notAKey = join(dir, "not-a-key.json");
writeFileSync(notAKey, "[1, 2, 3, \"LEAKCHECK-FILE-CONTENT\"");
// A clean environment: no SEND or KEYPAIR leaks in from the shell that runs the check.
const child = (command, env) => {
  const r = spawnSync(process.execPath, [SCRIPT, command], { env: { PATH: process.env.PATH, HOME: process.env.HOME, KEYPAIR: testKey, PROGRAM: PROGRAM.toBase58(), ...env }, encoding: "utf8", timeout: 90_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const refuses = (label, command, env, words, also = () => true) => {
  const r = child(command, env);
  line(r.code === 1 && r.out.includes(words) && also(r.out), `${label}: exit ${r.code}, "${(r.out.split("\n").find((l) => l.includes(words)) ?? r.out.trim().split("\n").at(-1) ?? "").trim().slice(0, 150)}"`);
  return r;
};
{
  refuses("REHEARSAL=1 on mainnet", "create", { CLUSTER: "mainnet", RPC_URL: "https://rpc.invalid/", REHEARSAL: "1" }, "devnet only");
  refuses("mainnet with no RPC_URL", "status", { CLUSTER: "mainnet" }, "needs RPC_URL");
  refuses("THRESHOLD above the members", "create", { REHEARSAL: "1", THRESHOLD: "4" }, "more than the 3 members");
  refuses("MEMBERS repeated", "create", { MEMBERS: `${members[0]},${members[1]},${members[0]}`, TIMELOCK: "60" }, "listed twice");
  refuses("MEMBERS not keys", "create", { MEMBERS: "alice,bob", TIMELOCK: "60" }, "is not a public key");
  refuses("create with no TIMELOCK outside a rehearsal", "create", { MEMBERS: members.join(",") }, "needs TIMELOCK");
  const address = M.multisigAddress(M.createKeyFor(TEST_SECRET, PROGRAM).publicKey);
  refuses("handoff with the wrong VAULT", "handoff", { MULTISIG: address.toBase58(), VAULT: members[0].toBase58() }, "is not vault 0");
  refuses("a KEYPAIR path with no file", "status", { KEYPAIR: join(dir, "missing.json") }, "there is no file at");
  refuses("a KEYPAIR that is not a keypair", "status", { KEYPAIR: notAKey }, "is not a keypair file", (out) => !out.includes("LEAKCHECK"));
  refuses("MEMBER and MEMBER_KEYPAIR together", "approve", { REHEARSAL: "1", MEMBER: "1", MEMBER_KEYPAIR: testKey }, "not both");
  refuses("an unknown command", "deploy", {}, "usage");
  // package.json stands in for a key in the repository: it is refused before it is read.
  refuses("a KEYPAIR inside the git repository", "status", { KEYPAIR: join(HERE, "package.json") }, "inside the git repository");
  refuses("a MEMBER_KEYPAIR inside the git repository", "approve", { MULTISIG: address.toBase58(), INDEX: "1", MEMBER_KEYPAIR: join(HERE, "package.json") }, "inside the git repository");
  refuses("DANGER=yes (only 1 takes the risk)", "approve", { DANGER: "yes" }, "DANGER is 1 or 0");

  // BUILD: a .so built for PROGRAM (its id is in the binary), or build.json; made-up binaries here.
  const so = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60), PROGRAM.toBuffer(), Buffer.alloc(40, 3)]);
  const soFile = join(dir, "dex.so"), otherSo = join(dir, "other.so"), textSo = join(dir, "text.so");
  writeFileSync(soFile, so);
  writeFileSync(otherSo, Buffer.concat([so.subarray(0, 64), Keypair.generate().publicKey.toBuffer()]));
  writeFileSync(textSo, "not a binary");
  let n = 0;
  const buildJson = (o) => { const f = join(dir, `build-${n++}.json`); writeFileSync(f, JSON.stringify({ program: PROGRAM.toBase58(), file: "dex.so", sha256: sha256(so).toString("hex"), dirty: false, ...o })); return f; };
  const on = { program: PROGRAM, cluster: "mainnet" };
  line(M.loadBuild(soFile, on).sha === sha256(so).toString("hex") && M.loadBuild(buildJson({}), on).bytes.equals(so), "BUILD: a .so built for PROGRAM, or its build.json, is taken");
  line(refusedWith(() => M.loadBuild(otherSo, on), "not built for PROGRAM") && refusedWith(() => M.loadBuild(textSo, on), "not a program binary"), "BUILD: a .so built for another id, or no binary at all, is refused");
  line(refusedWith(() => M.loadBuild(buildJson({ program: AUTHORITY.toBase58() }), on), "a build for") && refusedWith(() => M.loadBuild(buildJson({ sha256: "00" }), on), "not the binary")
    && refusedWith(() => M.loadBuild(buildJson({ dirty: true }), on), "dirty") && !refusedWith(() => M.loadBuild(buildJson({ dirty: true }), { ...on, cluster: "devnet" }), "dirty")
    && refusedWith(() => M.loadBuild(notAKey, on), "not a build.json"),
  "BUILD: a build.json of another program, of another binary, dirty on mainnet (devnet takes it), or not JSON, is refused");
  refuses("propose-upgrade on mainnet with a BUFFER and no BUILD", "propose-upgrade", { CLUSTER: "mainnet", RPC_URL: "https://rpc.invalid/", MULTISIG: address.toBase58(), BUFFER: members[0].toBase58() }, "needs BUILD");
  // The node's error names the URL it could not reach; nothing of it may come out.
  const secret = "LEAKCHECK-API-KEY-12345";
  const leak = child("status", { CLUSTER: "mainnet", RPC_URL: `https://leakcheck-node.invalid/rpc/${secret}?api-key=${secret}` });
  line(leak.code === 1 && !leak.out.includes(secret) && !leak.out.includes("leakcheck-node"),
    `mainnet through a node that can't be reached: exit ${leak.code}, the RPC URL hidden ("${leak.out.trim().split("\n")[0].slice(0, 110)}")`);
}

/* ---------------- 6. Simulations on devnet ---------------- */

/** Signed by no one: the runtime skips the signatures and takes every signer in the message as signed. */
async function simulateAs(conn, payer, ixs, watch = []) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  let size;
  try { size = tx.serialize().length; } catch { return { size: Infinity, err: "too big for one transaction" }; }
  if (size > 1232) return { size, err: "too big for one transaction" };
  return { size, ...(await M.simulate(conn, tx, watch)) };
}

/** vault_transaction_execute for a message known here, before its vault transaction exists (the SDK's reads it from the chain). */
function executeIx({ address, index, member, inner }) {
  const vault = M.vaultAddress(address);
  const bytes = squads.utils.transactionMessageToMultisigTransactionMessageBytes({
    message: new TransactionMessage({ payerKey: vault, recentBlockhash: PublicKey.default.toBase58(), instructions: inner }), vaultPda: vault,
  });
  const [message] = squads.types.transactionMessageBeet.deserialize(Buffer.from(bytes));
  const remaining = message.accountKeys.map((pubkey, i) => ({
    pubkey, isWritable: squads.utils.isStaticWritableIndex(message, i), isSigner: squads.utils.isSignerIndex(message, i) && !pubkey.equals(vault),
  }));
  return squads.generated.createVaultTransactionExecuteInstruction({
    multisig: address, proposal: M.proposalAddress(address, index), transaction: M.transactionAddress(address, index), member, anchorRemainingAccounts: remaining,
  });
}

const simLine = (label, sim, expectOk = true) => line(expectOk ? !sim.err : Boolean(sim.err),
  `${label}: ${sim.err ? (typeof sim.err === "string" ? sim.err : `failed ${JSON.stringify(sim.err)}`) : "ok"}, ${sim.unitsConsumed ?? "-"} compute units, ${sim.size} bytes`);

if (process.env.OFFLINE !== "1") {
  try {
    console.log(`\nSimulations on devnet, signed by no one: PROGRAM ${PROGRAM.toBase58()}, its authority ${AUTHORITY.toBase58()} as the payer`);
    const conn = new Connection("https://api.devnet.solana.com", "confirmed");
    const squadsInfo = await conn.getAccountInfo(M.SQUADS);
    line(Boolean(squadsInfo?.executable), "Squads v4 is executable on devnet");
    const pcInfo = await conn.getAccountInfo(M.programConfigAddress());
    const [pc] = squads.accounts.ProgramConfig.fromAccountInfo(pcInfo);
    line(pcInfo.owner.equals(M.SQUADS), `its program config: creation fee ${M.sol(BigInt(pc.multisigCreationFee.toString()))}, treasury ${pc.treasury.toBase58()}`);
    const [p, pd, c] = await conn.getMultipleAccountsInfo([PROGRAM, programData, M.configAddress(PROGRAM)]);
    const data = pd && M.decodeProgramData(pd.data), config = c && M.decodeConfig(c.data);
    line(Boolean(p?.executable && data?.authority?.equals(AUTHORITY) && config), `PROGRAM is live, AUTHORITY is its upgrade authority, its config's admin is ${config?.admin.toBase58()}`);

    const createKey = M.createKeyFor(TEST_SECRET, PROGRAM).publicKey, address = M.multisigAddress(createKey), vault = M.vaultAddress(address);
    const create = M.createMultisigIx({ treasury: pc.treasury, payer: AUTHORITY, createKey, members, threshold: 2, timelock: 60 });
    const simCreate = await simulateAs(conn, AUTHORITY, [create], [address]);
    simLine("create: a 2 of 3 multisig with a 60 s timelock", simCreate);
    const made = simCreate.accounts?.[0] && M.decodeMultisig({ ...simCreate.accounts[0], owner: new PublicKey(simCreate.accounts[0].owner), data: Buffer.from(simCreate.accounts[0].data[0], "base64") });
    line(Boolean(made?.ms && made.ms.threshold === 2 && made.ms.timeLock === 60 && made.ms.members.every((m) => m.mask === 7) && made.ms.configAuthority.equals(PublicKey.default)
      && made.ms.rentCollector?.equals(vault)),
    `create: the simulated multisig has 3 members with every permission, 2 votes, 60 s, no config authority, the vault as rent collector; its rent ${M.sol(simCreate.accounts?.[0]?.lamports ?? 0)}`);

    const handoff = [M.updateConfigIx(PROGRAM, AUTHORITY, { ...config, admin: vault }), M.setUpgradeAuthorityIx(PROGRAM, AUTHORITY, vault)];
    const simHandoff = await simulateAs(conn, AUTHORITY, handoff, [programData, M.configAddress(PROGRAM)]);
    simLine("handoff: update_config (admin = the vault) and SetAuthority (to the vault) in one transaction", simHandoff);
    const after = simHandoff.accounts ?? [];
    const pdAfter = after[0] && M.decodeProgramData(Buffer.from(after[0].data[0], "base64")), cfgAfter = after[1] && M.decodeConfig(Buffer.from(after[1].data[0], "base64"));
    line(Boolean(pdAfter?.authority?.equals(vault) && cfgAfter && M.sameConfig(cfgAfter, { ...config, admin: vault })), "handoff: after it, the vault is the upgrade authority and the config's admin, the rest of the config unchanged");
    const verdict = M.checkHandoff({ cluster: "devnet", address, found: M.decodeMultisig(await conn.getAccountInfo(address)), vault, expectedVault: vault, expectedMembers: members, payer: AUTHORITY, authority: data.authority, config });
    line(verdict.refusals.length === 1 && verdict.refusals[0].includes("does not exist"), `handoff: multisig.mjs would refuse to send for one reason only: "${verdict.refusals[0]?.slice(0, 90)}…"`);

    const simUpgrade = await simulateAs(conn, AUTHORITY, [M.upgradeIx({ program: PROGRAM, buffer: programData, spill: AUTHORITY, authority: AUTHORITY })]);
    line(Boolean(simUpgrade.err) && (simUpgrade.logs ?? []).some((l) => l.includes("Invalid Buffer account")),
      "Upgrade with the program's data account as the buffer: the loader takes it for an Upgrade, checks the program and its data, then says \"Invalid Buffer account\"");

    // The whole road in one transaction: nothing of it persists, but every instruction runs on what the one before left.
    const [m1, m2] = members;
    const roadAuthority = [
      M.createMultisigIx({ treasury: pc.treasury, payer: AUTHORITY, createKey, members, threshold: 2, timelock: 0 }),
      M.setUpgradeAuthorityIx(PROGRAM, AUTHORITY, vault),
      ...M.proposeIxs({ address, index: 1n, proposer: m1, payer: AUTHORITY, inner: [M.setUpgradeAuthorityIx(PROGRAM, vault, AUTHORITY)] }),
      squads.instructions.proposalApprove({ multisigPda: address, transactionIndex: 1n, member: m1 }),
      squads.instructions.proposalApprove({ multisigPda: address, transactionIndex: 1n, member: m2 }),
      executeIx({ address, index: 1n, member: m1, inner: [M.setUpgradeAuthorityIx(PROGRAM, vault, AUTHORITY)] }),
    ];
    const road = await simulateAs(conn, AUTHORITY, roadAuthority, [programData, M.proposalAddress(address, 1n)]);
    simLine("the road, upgrade authority: create (no timelock), hand over, propose by member 1 (the payer pays the rent), votes of 1 and 2, execute", road);
    const back = road.accounts?.[0] && M.decodeProgramData(Buffer.from(road.accounts[0].data[0], "base64"));
    line(Boolean(back?.authority?.equals(AUTHORITY)), "the road: the vault, as upgrade authority, gave the authority back to AUTHORITY through the vote (so it can act as one)");

    // With update_config's 109 bytes of args twice, the road fits in one transaction only with a single member.
    const inner = [M.updateConfigIx(PROGRAM, vault, { ...config, admin: AUTHORITY, launchesOpen: !config.launchesOpen })];
    const roadConfig = await simulateAs(conn, AUTHORITY, [
      M.createMultisigIx({ treasury: pc.treasury, payer: AUTHORITY, createKey, members: [m1], threshold: 1, timelock: 0 }),
      M.updateConfigIx(PROGRAM, AUTHORITY, { ...config, admin: vault }),
      ...M.proposeIxs({ address, index: 1n, proposer: m1, payer: AUTHORITY, inner }),
      squads.instructions.proposalApprove({ multisigPda: address, transactionIndex: 1n, member: m1 }),
      executeIx({ address, index: 1n, member: m1, inner }),
    ], [M.configAddress(PROGRAM)]);
    if (roadConfig.err === "too big for one transaction") note(`the road for the config is ${roadConfig.size} bytes, too big for one transaction: the handoff simulation above covers update_config instead`);
    else {
      simLine("the road, config: create (1 of 1), hand the admin over, propose update_config (launches_open flipped, admin back), the vote, execute", roadConfig);
      const cfgBack = roadConfig.accounts?.[0] && M.decodeConfig(Buffer.from(roadConfig.accounts[0].data[0], "base64"));
      line(Boolean(cfgBack && cfgBack.admin.equals(AUTHORITY) && cfgBack.launchesOpen === !config.launchesOpen), "the road: the vault, as admin, changed the config through the vote");
    }

    // The key check's road: member 1 proposes the memo, members 2 and 3 approve. All three have then signed.
    const [, , m3] = members;
    const kcRoad = await simulateAs(conn, AUTHORITY, [
      M.createMultisigIx({ treasury: pc.treasury, payer: AUTHORITY, createKey, members, threshold: 2, timelock: 60 }),
      ...M.proposeIxs({ address, index: 1n, proposer: m1, payer: AUTHORITY, inner: [M.keycheckIx()] }),
      squads.instructions.proposalApprove({ multisigPda: address, transactionIndex: 1n, member: m2 }),
      squads.instructions.proposalApprove({ multisigPda: address, transactionIndex: 1n, member: m3 }),
    ], [M.proposalAddress(address, 1n), M.transactionAddress(address, 1n)]);
    simLine("the key check: create, member 1 proposes the memo, members 2 and 3 approve", kcRoad);
    const asInfo = (a) => a && { ...a, owner: new PublicKey(a.owner), data: Buffer.from(a.data[0], "base64") };
    const kcEntry = { index: 1n, proposal: M.decodeProposal(asInfo(kcRoad.accounts?.[0])), vtx: M.decodeVaultTransaction(asInfo(kcRoad.accounts?.[1])) };
    const kcProven = M.provenMembers([kcEntry]);
    const kcVerdict = M.checkHandoff({ cluster: "devnet", address, found: { ms: { threshold: 2, timeLock: 60, configAuthority: PublicKey.default, rentCollector: vault, members: members.map((key) => ({ key, mask: 7 })) } },
      vault, expectedMembers: members, proven: kcProven, payer: AUTHORITY, authority: AUTHORITY, config });
    line(kcEntry.proposal?.status === "Approved" && M.sameKeys(kcProven, members) && !kcVerdict.refusals.length,
      `the key check, read back from the simulation: ${kcEntry.proposal?.status}, all three members proven, and the handoff's verdict refuses nothing`);

    // A buffer made in the simulation itself (no key signs anything): closed by the KEYPAIR, then by the vault's vote.
    const bufferKey = Keypair.generate().publicKey;
    const bufferRent = await conn.getMinimumBalanceForRentExemption(37);
    const makeBuffer = [
      SystemProgram.createAccount({ fromPubkey: AUTHORITY, newAccountPubkey: bufferKey, lamports: bufferRent, space: 37, programId: M.LOADER }),
      new TransactionInstruction({ programId: M.LOADER, keys: [{ pubkey: bufferKey, isSigner: false, isWritable: true }, { pubkey: AUTHORITY, isSigner: false, isWritable: false }], data: Buffer.from("00000000", "hex") }),
    ];
    const ownClose = await simulateAs(conn, AUTHORITY, [...makeBuffer, M.closeBufferIx(bufferKey, AUTHORITY, AUTHORITY)], [bufferKey]);
    simLine("close-buffer by the KEYPAIR: a buffer made, then closed by its authority", ownClose);
    line(!ownClose.err && !(ownClose.accounts?.[0]?.lamports), "the buffer is gone after the KEYPAIR's Close, its SOL back");
    const closeInner = [M.closeBufferIx(bufferKey, AUTHORITY, vault)];
    const vaultClose = await simulateAs(conn, AUTHORITY, [
      M.createMultisigIx({ treasury: pc.treasury, payer: AUTHORITY, createKey, members: [m1], threshold: 1, timelock: 0 }),
      ...makeBuffer, M.setBufferAuthorityIx(bufferKey, AUTHORITY, vault),
      ...M.proposeIxs({ address, index: 1n, proposer: m1, payer: AUTHORITY, inner: closeInner }),
      squads.instructions.proposalApprove({ multisigPda: address, transactionIndex: 1n, member: m1 }),
      executeIx({ address, index: 1n, member: m1, inner: closeInner }),
    ], [bufferKey]);
    if (vaultClose.err === "too big for one transaction") note(`the vault's close road is ${vaultClose.size} bytes, too big for one transaction`);
    else {
      simLine("close-buffer by the vault: a buffer handed to the vault (SetAuthority), its Close proposed, voted and run by the vault", vaultClose);
      line(!vaultClose.err && !(vaultClose.accounts?.[0]?.lamports), "the buffer is gone after the vault's Close");
    }

    // propose-upgrade's own transaction while the KEYPAIR holds the buffer: the hand-over and the proposal together,
    // with mainnet's two compute budget instructions. It must fit in one transaction.
    const upBuffer = Keypair.generate().publicKey;
    const upInner = [M.upgradeIx({ program: PROGRAM, buffer: upBuffer, spill: AUTHORITY, authority: vault })];
    const proposeUp = [M.setBufferAuthorityIx(upBuffer, AUTHORITY, vault), ...M.proposeIxs({ address, index: 1n, proposer: m1, payer: AUTHORITY, inner: upInner })];
    const upSize = new VersionedTransaction(new TransactionMessage({
      payerKey: AUTHORITY, recentBlockhash: PublicKey.default.toBase58(),
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000n }), ...proposeUp],
    }).compileToV0Message()).serialize().length;
    line(upSize <= 1232, `propose-upgrade's transaction, the buffer's hand-over in it, with a priority price: ${upSize} bytes, under 1232`);
    const upRoad = await simulateAs(conn, AUTHORITY, [
      M.createMultisigIx({ treasury: pc.treasury, payer: AUTHORITY, createKey, members: [m1], threshold: 1, timelock: 0 }),
      SystemProgram.createAccount({ fromPubkey: AUTHORITY, newAccountPubkey: upBuffer, lamports: bufferRent, space: 37, programId: M.LOADER }),
      new TransactionInstruction({ programId: M.LOADER, keys: [{ pubkey: upBuffer, isSigner: false, isWritable: true }, { pubkey: AUTHORITY, isSigner: false, isWritable: false }], data: Buffer.from("00000000", "hex") }),
      ...proposeUp,
    ], [upBuffer, M.transactionAddress(address, 1n)]);
    simLine("propose-upgrade with the buffer still the KEYPAIR's: create (1 of 1), a buffer made, then the hand-over and the proposal in one go", upRoad);
    const upHeld = upRoad.accounts?.[0] && M.decodeBuffer(Buffer.from(upRoad.accounts[0].data[0], "base64"));
    const upVtx = M.decodeVaultTransaction(asInfo(upRoad.accounts?.[1]));
    const upRead = upVtx && M.explainInstruction(upVtx.instructions[0], { program: PROGRAM, vault, config });
    line(Boolean(upHeld?.authority?.equals(vault) && upRead?.upgrade?.buffer.equals(upBuffer) && !upRead.danger),
      "read back: the vault holds the buffer, and the proposal is the upgrade from it, read out as one");

    console.log("\nRefusals that need the chain, through multisig.mjs (the test key holds no SOL)");
    const nowhere = Keypair.generate().publicKey.toBase58();
    refuses("propose-upgrade with no BUFFER, for a multisig that does not exist: no command to give a buffer away", "propose-upgrade", { MULTISIG: nowhere }, "does not exist",
      (out) => !out.includes("set-buffer-authority") && !out.includes("solana program"));
    refuses("write-buffer for a multisig that does not exist: nothing written, no command", "write-buffer", { MULTISIG: nowhere, BUILD: join(dir, "dex.so"), NOX_RELEASE: dir }, "does not exist", (out) => !out.includes("command:"));
    const absent = child("create", { REHEARSAL: "1", PROGRAM: Keypair.generate().publicKey.toBase58() });
    line(absent.code === 1 && absent.out.includes("does not exist on devnet yet"), `create for a PROGRAM that is not there: "${(absent.out.split("\n").find((l) => l.includes("does not exist on devnet yet")) ?? "").trim().slice(0, 120)}"`);
    // A stranger's multisig on devnet, read only: the buffer is looked at before the KEYPAIR's membership is.
    const stranger = "11FoUQtwkN4SDk5VKDef4P1ndJHSWgAfNfLLXihW1Fd";
    if (!(await conn.getAccountInfo(new PublicKey(stranger)))) note(`skipped: the devnet multisig ${stranger} is gone`);
    else {
      const order = child("propose-upgrade", { MULTISIG: stranger, BUFFER: programData.toBase58() });
      line(order.code === 1 && order.out.includes("is not a buffer of the upgradeable loader") && !order.out.includes("is not a member"),
        "propose-upgrade checks the buffer before asking whether the KEYPAIR is a member (which on mainnet it never is)");
    }
    refuses("create with a payer short of SOL", "create", { REHEARSAL: "1" }, "the KEYPAIR holds 0 SOL", (out) => out.includes("plus the rent"));
    const testPayer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(testKey, "utf8")))).publicKey;
    refuses("handoff to a multisig that does not exist", "handoff", { MULTISIG: Keypair.generate().publicKey.toBase58() }, "does not exist");
    refuses("handoff to a wallet (the vault passed as MULTISIG, say)", "handoff", { MULTISIG: AUTHORITY.toBase58() }, "not a Squads v4 account");
    refuses("handoff from a KEYPAIR that is not the authority", "handoff", { MULTISIG: address.toBase58() }, `not the KEYPAIR ${testPayer.toBase58()}`);
    refuses("propose-upgrade with no multisig", "propose-upgrade", { MULTISIG: address.toBase58(), BUFFER: programData.toBase58() }, "does not exist");
    refuses("a PROGRAM that is not a program", "status", { PROGRAM: AUTHORITY.toBase58() }, "is not a program of the upgradeable loader");
    const st = child("status", { REHEARSAL: "1" });
    line(st.code === 0 && st.out.includes("does not exist") && st.out.includes("upgrade authority"), "status for a KEYPAIR with no multisig yet: exit 0, shows the program and says the multisig does not exist");
  } catch (err) {
    line(false, `the devnet part stopped: ${String(err?.message ?? err).slice(0, 300)}`);
  }
}

/* ---------------- 7. Mainnet's Squads, read and simulated ---------------- */

if (process.env.MAINNET === "1") {
  try {
    console.log("\nMainnet, through the public node: Squads v4 and a simulated create");
    const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
    const info = await conn.getAccountInfo(M.SQUADS);
    const pd = await conn.getAccountInfo(pda([M.SQUADS.toBuffer()], M.LOADER));
    line(Boolean(info?.executable) && M.decodeProgramData(pd.data)?.authority === null, "Squads v4 is executable on mainnet, and immutable (no upgrade authority)");
    const [pc] = squads.accounts.ProgramConfig.fromAccountInfo(await conn.getAccountInfo(M.programConfigAddress()));
    line(true, `its program config: creation fee ${M.sol(BigInt(pc.multisigCreationFee.toString()))}, treasury ${pc.treasury.toBase58()}`);
    // A funded wallet to stand as the payer, signed by no one: Squads' own treasury.
    const createKey = M.createKeyFor(TEST_SECRET, PROGRAM).publicKey, address = M.multisigAddress(createKey);
    const sim = await simulateAs(conn, pc.treasury, [M.createMultisigIx({ treasury: pc.treasury, payer: pc.treasury, createKey, members, threshold: 2, timelock: 86_400 })], [address]);
    simLine("create on mainnet's Squads (a 2 of 3 with a 1 day timelock, Squads' treasury standing in as the payer)", sim);
    refuses("create on mainnet for a PROGRAM that is not there (a wrong id would tie the multisig to it for good)", "create",
      { CLUSTER: "mainnet", RPC_URL: "https://api.mainnet-beta.solana.com", MEMBERS: members.join(","), THRESHOLD: "2", TIMELOCK: "86400", PROGRAM: Keypair.generate().publicKey.toBase58() },
      "deploy it first");
  } catch (err) {
    line(false, `the mainnet part stopped: ${String(err?.message ?? err).slice(0, 300)}`);
  }
}

console.log(failed ? `\n${failed} check(s) failed` : "\nevery multisig check passed");
process.exit(failed ? 1 : 0);
