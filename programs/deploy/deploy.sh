#!/bin/bash
# The pool program's first deploy, at a new address. Run it from Linux or WSL.
#
# Without SEND=1 it only reads: it builds the program for the address (build.sh), then shows what the deploy costs,
# what the wallet holds, what is missing, and the exact command it would run. With SEND=1 it runs that command and then
# check-deploy.mjs. It never upgrades: once the program exists, a new binary goes through the multisig
# (multisig.mjs propose-upgrade), so a program already at the address is a stop.
#
#   CLUSTER=devnet KEYPAIR=~/.config/solana/devnet.json bash programs/deploy/deploy.sh                    (shows)
#   SEND=1 PROGRAM=<id> CLUSTER=devnet KEYPAIR=~/.config/solana/devnet.json bash programs/deploy/deploy.sh (deploys)
#   CLUSTER=mainnet KEYPAIR=<deploy wallet> bash programs/deploy/deploy.sh    (RPC_URL exported first: MAINNET.md)
#
# CLUSTER            devnet or mainnet. The node must be of it (its genesis hash), whatever RPC_URL says.
# KEYPAIR            pays for everything, and is the program's first upgrade authority.
# PROGRAM            the program's address, which can never change once deployed: SEND=1 needs it, the same the dry run
#                    showed, so the send cannot land on another key than the one that was read and costed.
# PROGRAM_KEYPAIR    the program's key: $NOX_RELEASE/<cluster>/program.json unless given. Only its address is ever
#                    printed. A dry run makes it there when missing, on devnet, unless deployed.json (below) says a
#                    program was deployed from this folder already; on mainnet only with NEW_PROGRAM=1, or put one there
#                    first (a grind, MAINNET.md). Keep it: without it, a later run would make another address.
# BUFFER_KEYPAIR     the account the binary is written into before the deploy: $NOX_RELEASE/<cluster>/buffer.json,
#                    made by a dry run when missing. Being a file, a deploy that stopped goes on from it, and the CLI
#                    never makes up a buffer of its own and prints its recovery phrase.
# RPC_URL            the node. Required on mainnet: a paid one, whose URL carries its key, so it is never printed (every
#                    line the CLI prints is filtered for it, sol.sh). Devnet uses the public node unless given.
# PRICE              the priority fee, in micro-lamports per compute unit. 0 on devnet. On mainnet, unless given, the
#                    75th percentile of what paying transactions paid in the node's recent slots, kept between 500000
#                    and 10000000 (check-deploy.mjs recentPrice, PRICE_FLOOR, PRICE_CAP). The node shows 0 for nearly
#                    every slot, so in practice it is the floor: under congestion, give the paid node's own estimate.
#                    A write uses about 3,000 units: at the cap, the whole deploy's priority fees come to about 0.015 SOL.
# MAX_LEN            the program's room, in bytes. Unless given: on mainnet the binary's size plus ROOM_PCT percent (25),
#                    on devnet the size alone. A later upgrade to a larger binary has to extend the program first, which
#                    only the upgrade authority (the multisig) will be able to do once the network turns on
#                    ExtendProgramChecked; room taken now costs rent now (about 0.33 SOL for each 64 KB).
# MAX_SIGN_ATTEMPTS  how many times the CLI signs again the writes still unconfirmed when their blockhash runs out
#                    (about a minute each): 30 unless given.
# USE_RPC            1 sends the writes through the node (--use-rpc), 0 straight to the validators. 1 on mainnet (the
#                    paid node), 0 on devnet unless given: the public devnet node turns most of 500 writes away (429),
#                    and a deploy through it stalled at 7% in the rehearsal, while the validators took them.
# NOX_RELEASE        where builds and these keypairs live: ~/nox-release unless given. Never inside the repository,
#                    which is public, nor any other: a key file there is a stop, even one git ignores.
# NEW_PROGRAM=1      allows a new program address: on mainnet, and wherever deployed.json names a program already.
#
# After a deploy, $NOX_RELEASE/<cluster>/deployed.json records the program, the payer, the commit and the build. Run on
# a program the payer still holds (a deploy whose CLI stopped after its last transaction landed), it says "deployed
# already", records it and runs check-deploy.mjs. Once the program is the multisig's, it stops: there is nothing left for
# it to do, and check-deploy.mjs and multisig.mjs take over.
#
# If it stops halfway (the node, the network, the SOL): run the very same command again. The program is not there
# yet, the buffer is; the CLI compares what the buffer holds with the binary, writes only what differs, then deploys.
# Keep buffer.json until the deploy is done. To give up instead, take the buffer's SOL back:
#   CLUSTER=<cluster> bash programs/deploy/sol.sh program close <buffer address> --keypair <KEYPAIR>
# or every buffer of that wallet at once, with --buffers in place of the address (program show --buffers, through
# sol.sh too, lists them). A deploy that went through leaves no buffer: its SOL became the program's rent.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
. "$here/sol.sh"

stop() { nox_stop "$@"; }
expand() { local p="$1"; [ "${p:0:2}" = "~/" ] && p="$HOME/${p:2}"; printf '%s' "$p"; }
# The absolute path a setting names, whether or not it exists yet: build.sh and this script run from other folders.
absolute() { realpath -m "$(expand "$1")"; }

case "${CLUSTER:-}" in
  devnet) cluster=devnet ;;
  mainnet|mainnet-beta) cluster=mainnet ;;
  *) stop "CLUSTER must be devnet or mainnet" ;;
esac
[ -n "${KEYPAIR:-}" ] || stop "KEYPAIR is the wallet that pays and holds the upgrade authority"
keypair="$(absolute "$KEYPAIR")"
release="$(absolute "${NOX_RELEASE:-$HOME/nox-release}")"
export NOX_RELEASE="$release"
send="${SEND:-}"

# The node. The CLI and node get its URL as an argument or from the environment, and nothing prints it.
nox_node "$cluster"
if [ "$cluster" = mainnet ] && [[ "${url,,}" == *api.mainnet-beta.solana.com* ]]; then
  stop "RPC_URL is the public mainnet node, which throttles a deploy's hundreds of writes: use a paid one"
fi
sol() { solana "$@" 2>&1 | redact; return "${PIPESTATUS[0]}"; }

# The repository is public: a key file inside it, or inside any git repository, is a stop, even one git ignores
# (.gitignore names this kit's key files, so asking it would let them through). The disk decides, not the spelling: on
# /mnt/c, /mnt/c/users/... is the same folder as /mnt/c/Users/..., so git is asked about the nearest folder above that
# exists, as multisig.mjs gitRepoAbove does.
outside_git() {
  local d top
  d="$(dirname "$2")"
  while [ ! -d "$d" ]; do d="$(dirname "$d")"; done
  top="$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)" || return 0
  stop "$1: $2 is inside the git repository $top, where a key can end up committed (this one is public). Keep keys outside it (~/nox-release, ~/nox-keys)"
}
outside_git KEYPAIR "$keypair"
outside_git NOX_RELEASE "$release/$cluster/program.json"
[ -f "$keypair" ] || stop "KEYPAIR: no file at $keypair"

# What this folder says was deployed already on this cluster.
deployed_file="$release/$cluster/deployed.json"
deployed_id=""
[ -f "$deployed_file" ] && deployed_id="$(grep -oE '"program": "[1-9A-HJ-NP-Za-km-z]+"' "$deployed_file" | cut -d'"' -f4 || true)"

# The two keypairs this deploy needs. Only a dry run makes one, only at its default place, and only an address prints.
# A path given that leads nowhere is a stop, not a new key: a typo would otherwise build for an address nobody meant.
made=""
make_key() {
  [ "$send" != 1 ] || stop "$1: no file at $2. SEND=1 never makes a key: run the dry run first, and read what it shows"
  mkdir -p "$(dirname "$2")"
  (umask 077 && solana-keygen new --no-bip39-passphrase --silent -o "$2" >/dev/null)
  made="$made $1"
}
if [ -n "${PROGRAM_KEYPAIR:-}" ]; then
  program_keypair="$(absolute "$PROGRAM_KEYPAIR")"
  outside_git PROGRAM_KEYPAIR "$program_keypair"
  [ -f "$program_keypair" ] || stop "PROGRAM_KEYPAIR: no file at $program_keypair"
else
  program_keypair="$release/$cluster/program.json"
  if [ ! -f "$program_keypair" ]; then
    if [ "${NEW_PROGRAM:-}" != 1 ]; then
      [ -z "$deployed_id" ] || stop "there is no $program_keypair, and $deployed_file says $deployed_id was deployed from here: going on would make a second program at a new address. Put that program.json back (or NEW_PROGRAM=1 if a second program is meant)"
      [ "$cluster" != mainnet ] || stop "there is no $program_keypair. On mainnet the program's address is made only on purpose: NEW_PROGRAM=1 makes a new one there, or put one there first (a grind: MAINNET.md)"
    fi
    make_key PROGRAM_KEYPAIR "$program_keypair"
  fi
fi
if [ -n "${BUFFER_KEYPAIR:-}" ]; then
  buffer_keypair="$(absolute "$BUFFER_KEYPAIR")"
  outside_git BUFFER_KEYPAIR "$buffer_keypair"
  [ -f "$buffer_keypair" ] || stop "BUFFER_KEYPAIR: no file at $buffer_keypair"
else
  buffer_keypair="$release/$cluster/buffer.json"
  [ -f "$buffer_keypair" ] || make_key BUFFER_KEYPAIR "$buffer_keypair"
fi
payer="$(solana address -k "$keypair")"
program="$(solana address -k "$program_keypair")"
buffer="$(solana address -k "$buffer_keypair")"
[ "$program" != "$payer" ] && [ "$buffer" != "$payer" ] && [ "$program" != "$buffer" ] \
  || stop "KEYPAIR, PROGRAM_KEYPAIR and BUFFER_KEYPAIR must be three different keys"

# The address is for good once deployed: the send takes it from PROGRAM, said by hand, and checks the key against it.
send_guard() {
  if [ -n "${PROGRAM:-}" ] && [ "$PROGRAM" != "$program" ]; then
    stop "PROGRAM is $PROGRAM, but the program keypair ($program_keypair) is $program: this is not the address that was meant"
  fi
  if [ "$send" = 1 ] && [ -z "${PROGRAM:-}" ]; then
    stop "SEND=1 needs PROGRAM=<the program id the dry run showed>. The program keypair ($program_keypair) is $program"
  fi
  if [ -n "$deployed_id" ] && [ "$deployed_id" != "$program" ]; then
    echo "warning: $deployed_file says $deployed_id was deployed from here already: this would be a second program"
    [ "$send" != 1 ] || [ "${NEW_PROGRAM:-}" = 1 ] || stop "a second program on $cluster needs NEW_PROGRAM=1"
  fi
  return 0
}
send_guard

echo "deploy on $cluster through $url_shown, $([ "$send" = 1 ] && echo SENDING || echo 'dry run: nothing is sent')"
echo "  payer and upgrade authority  $payer   ($keypair)"
echo "  program                      $program   ($program_keypair)$([[ "$made" == *PROGRAM_KEYPAIR* ]] && echo '   NEW: made just now')"
echo "  buffer                       $buffer   ($buffer_keypair)$([[ "$made" == *BUFFER_KEYPAIR* ]] && echo '   new: made just now')"

# What the chain says, before and after the build: node reads, through check-deploy.mjs's helpers, so the URL hides.
facts() {
  (cd "$here" && NOX_STEP="$1" NOX_PAYER="$payer" NOX_PROGRAM="$program" NOX_BUFFER="$buffer" NOX_SO="${2:-}" \
    NOX_MAX_LEN="${3:-0}" NOX_CLUSTER="$cluster" NOX_URL="$url" NOX_HIDE_URL="$([ "$url_shown" = "$url" ] || echo 1)" \
    node --input-type=module -e "$facts_js")
}
facts_js='
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import {
  guardOutput, secret, clusterError, LOADER, SYSTEM, parseBuffer, parseProgram, parseProgramdata, recentPrice, sol,
  priceNote as describePrice,
} from "./check-deploy.mjs";
const e = process.env;
if (e.NOX_HIDE_URL === "1") secret(e.NOX_URL);
guardOutput();
const conn = new Connection(e.NOX_URL, "confirmed");
const out = (k, v) => console.log(`${k}=${v}`);
if (e.NOX_STEP === "program") {
  // The node first: one of another cluster would apply the rules of one cluster to the chain of the other.
  const wrong = await clusterError(conn, e.NOX_CLUSTER);
  if (wrong) { out("cluster_error", wrong); process.exit(0); }
  // What is at the address: nothing, a program (its authority says whether this payer deployed it), or an account.
  const info = await conn.getAccountInfo(new PublicKey(e.NOX_PROGRAM));
  let state = "none";
  if (info && info.owner.equals(LOADER) && info.executable && parseProgram(info.data)) {
    const pdInfo = await conn.getAccountInfo(parseProgram(info.data).programdata);
    const pd = pdInfo ? parseProgramdata(pdInfo.data) : null;
    const authority = pd?.authority ? pd.authority.toBase58() : "none";
    state = authority === e.NOX_PAYER ? "ours" : `program:${authority}`;
  } else if (info) state = `taken:${info.owner.toBase58()}:${sol(info.lamports)}`;
  out("program_state", state);
  process.exit(0);
}

const so = readFileSync(e.NOX_SO), len = so.length, room = Math.max(len, Number(e.NOX_MAX_LEN));
const [balance, programdataRent, programRent] = await Promise.all([
  conn.getBalance(new PublicKey(e.NOX_PAYER)),
  conn.getMinimumBalanceForRentExemption(45 + room),                 // the program data: what stays locked
  conn.getMinimumBalanceForRentExemption(36),                        // the program account
]);
// The buffer, if a deploy stopped halfway: the CLI goes on from it when it belongs to the payer and fits the binary.
const info = await conn.getAccountInfo(new PublicKey(e.NOX_BUFFER));
let bufferState = "none", written = 0, bufferLamports = info ? info.lamports : 0;
if (info) {
  const b = info.owner.equals(LOADER) ? parseBuffer(info.data) : null;
  if (!b) bufferState = info.owner.equals(SYSTEM) && info.data.length === 0 ? "wallet" : "foreign";
  else if (!b.authority || b.authority.toBase58() !== e.NOX_PAYER) bufferState = `authority:${b.authority ? b.authority.toBase58() : "none"}`;
  else if (b.bytes.length !== len) bufferState = `size:${b.bytes.length}`;
  else {
    bufferState = "resume";
    for (let at = 0; at < len; at += 1024) if (b.bytes.subarray(at, at + 1024).equals(so.subarray(at, at + 1024))) written += Math.min(1024, len - at);
  }
}
// The priority fee: given, 0 on devnet, or from the node on mainnet.
let price = e.PRICE, priceNote = "given";
if (price === undefined || price === "") {
  if (e.NOX_CLUSTER === "devnet") { price = 0; priceNote = "none on devnet"; }
  else {
    const r = await recentPrice(conn, [new PublicKey(e.NOX_PAYER), new PublicKey(e.NOX_BUFFER)]);
    price = r.price;
    priceNote = describePrice(r);
  }
}
price = Number(price);
if (!Number.isInteger(price) || price < 0) { console.error("PRICE must be a whole number of micro-lamports per compute unit"); process.exit(1); }
// The writes: about 960 bytes each (a packet less the transaction around them), one signature, about 3,000 compute
// units (the CLI sets each limit from a simulation). The first message makes the buffer, the last deploys (two
// signatures, and the binary checked, so a larger limit).
const chunk = price > 0 ? 960 : 972, units = 3_000;
const writes = Math.ceil((len - written) / chunk);
const writeFee = 5_000 + Math.ceil((price * units) / 1e6);
const fees = writes * writeFee + (bufferState === "resume" ? 0 : 5_000 + Math.ceil((price * 10_000) / 1e6)) + 10_000 + Math.ceil((price * 400_000) / 1e6);
// The CLI asks for the buffer rent up front (the program data rent; at the deploy the loader moves the buffer SOL
// back to the payer and takes the program data rent from it), plus the program account and the fees.
const needed = (bufferState === "resume" ? Math.max(0, programdataRent - bufferLamports) : programdataRent) + programRent + fees;
out("size", len); out("room", room); out("balance", balance); out("programdata_rent", programdataRent);
out("program_rent", programRent); out("buffer_state", bufferState); out("buffer_lamports", bufferLamports);
out("written", written); out("writes", writes); out("price", price); out("price_note", priceNote);
out("fees", fees); out("needed", needed); out("short", Math.max(0, needed - balance));
out("needed_sol", sol(needed)); out("balance_sol", sol(balance)); out("short_sol", sol(Math.max(0, needed - balance)));
out("programdata_rent_sol", sol(programdataRent)); out("program_rent_sol", sol(programRent)); out("fees_sol", sol(fees));
'
declare -A f
read_facts() { f=(); while IFS='=' read -r k v; do [ -n "$k" ] && f["$k"]="$v"; done < <(facts "$@" 2> >(redact >&2) | redact); }

# What this folder keeps of a deploy done: the program, who paid, the build. A record of another program is kept aside.
record_deployed() {
  mkdir -p "$release/$cluster"
  if [ -n "$deployed_id" ] && [ "$deployed_id" != "$program" ]; then mv "$deployed_file" "$release/$cluster/deployed-$deployed_id.json"; fi
  local build_json="$release/$program/build.json" commit=""
  [ -f "$build_json" ] && commit="$(grep -oE '"commit": "[0-9a-f]+"' "$build_json" | cut -d'"' -f4 || true)"
  cat > "$deployed_file" <<EOF
{
  "program": "$program",
  "cluster": "$cluster",
  "program_keypair": "$program_keypair",
  "upgrade_authority_at_deploy": "$payer",
  "commit": "$commit",
  "build": "$build_json",
  "recorded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  echo "recorded in $deployed_file"
}
# The check after a deploy: the program, its authority and, when this folder has its build, the bytes.
check_deployed() {
  local args=(CLUSTER="$cluster" PROGRAM="$program" EXPECT_AUTHORITY="$payer" CONFIG=0 SITE=0)
  [ -f "$release/$program/build.json" ] && args+=(BUILD="$release/$program/build.json")
  (cd "$here" && env "${args[@]}" node check-deploy.mjs)
}

read_facts program
[ -z "${f[cluster_error]:-}" ] || stop "${f[cluster_error]}. CLUSTER is $cluster: check RPC_URL"
[ -n "${f[program_state]:-}" ] || stop "could not read the program's address from the node"
case "${f[program_state]}" in
  none) ;;
  ours)
    echo
    echo "deployed already: $program is a program, with the payer as its upgrade authority. Nothing to deploy; the check:"
    record_deployed
    check_deployed
    exit 0 ;;
  program:*)
    [ "$program" != "$deployed_id" ] || stop "$program was deployed from here ($deployed_file), and its upgrade authority is now ${f[program_state]#program:} (the multisig's vault, after the handoff): nothing left for this script. check-deploy.mjs reads it; upgrades go through multisig.mjs"
    stop "a program is already at $program, with upgrade authority ${f[program_state]#program:}. This script only makes new ones: upgrades go through the multisig (multisig.mjs propose-upgrade), and a program closed once can never come back at its address" ;;
  taken:*)
    rest="${f[program_state]#taken:}"
    stop "the address $program is taken by an account of ${rest%%:*} holding ${rest#*:} SOL, not a program: point PROGRAM_KEYPAIR at another key" ;;
esac

# The build, for this address.
bash "$here/build.sh" "$program"
so="$release/$program/dex.so"
build="$release/$program/build.json"
commit="$(grep -oE '"commit": "[0-9a-f]+' "$build" | cut -c12-)"
if grep -qF '"dirty": true,' "$build"; then
  [ "$cluster" = mainnet ] && stop "the build is dirty (programs/pool had changes not committed): mainnet takes only a clean build of a commit"
  echo "warning: a dirty build (fine for a devnet test only)"
fi
# On mainnet the commit must be on origin/main, as this clone last fetched it: a binary on chain whose source is
# nowhere else can never be built again and compared, nor rebuilt for the upgrade test.
if ! git -C "$repo" branch -r --contains "$commit" 2>/dev/null | grep -qE '^ *origin/main$'; then
  [ "$cluster" = mainnet ] && stop "commit ${commit:0:7} is not on origin/main (as this clone last fetched it): push it, git fetch, and run again"
  echo "warning: commit ${commit:0:7} is not on origin/main (fine for a devnet test only)"
fi
size="$(stat -c %s "$so")"
room_pct="${ROOM_PCT:-$([ "$cluster" = mainnet ] && echo 25 || echo 0)}"
[[ "$room_pct" =~ ^[0-9]+$ ]] || stop "ROOM_PCT must be a whole number of percent"
max_len="${MAX_LEN:-$(( size + (size * room_pct + 99) / 100 ))}"
[[ "$max_len" =~ ^[0-9]+$ ]] && [ "$max_len" -ge "$size" ] || stop "MAX_LEN must be a number of bytes, at least the binary's $size"
attempts="${MAX_SIGN_ATTEMPTS:-30}"
[[ "$attempts" =~ ^[1-9][0-9]*$ ]] || stop "MAX_SIGN_ATTEMPTS must be a whole number"
use_rpc="${USE_RPC:-$([ "$cluster" = mainnet ] && echo 1 || echo 0)}"
[[ "$use_rpc" =~ ^[01]$ ]] || stop "USE_RPC must be 0 or 1"

read_facts plan "$so" "$max_len"
[ -n "${f[needed]:-}" ] || stop "could not read the plan's numbers from the node"
case "${f[buffer_state]}" in
  none) buffer_line="new: the CLI makes it, writes the binary into it, and the deploy empties it into the program" ;;
  resume) buffer_line="there, the payer's, $(( ${f[written]} * 100 / ${f[size]} ))% of the binary already in it: the CLI writes the rest only" ;;
  wallet) stop "the buffer's address $buffer holds SOL as a plain wallet: point BUFFER_KEYPAIR at a new file" ;;
  size:*) stop "the buffer $buffer was made for a binary of ${f[buffer_state]#size:} bytes, this one has $size: close it (CLUSTER=$cluster bash programs/deploy/sol.sh program close $buffer --keypair $keypair) or point BUFFER_KEYPAIR at a new file" ;;
  authority:*) stop "the buffer $buffer belongs to ${f[buffer_state]#authority:}, not to the payer: point BUFFER_KEYPAIR at a new file" ;;
  *) stop "the buffer's address $buffer holds an account of another program: point BUFFER_KEYPAIR at a new file" ;;
esac

echo
echo "binary      $so"
echo "            $size bytes, commit ${commit:0:7}"
echo "room        $max_len bytes: $(( max_len - size )) for a larger binary later$([ "$max_len" = "$size" ] && echo ' (none: MAX_LEN or ROOM_PCT gives some)')"
echo "buffer      $buffer_line"
echo "costs       program data rent ${f[programdata_rent_sol]} SOL (stays locked in the program; it was the buffer's)"
echo "            program account rent ${f[program_rent_sol]} SOL"
echo "            fees about ${f[fees_sol]} SOL: ${f[writes]} writes at ${f[price]} micro-lamports per compute unit (${f[price_note]})"
echo "wallet      ${f[balance_sol]} SOL; the CLI wants about ${f[needed_sol]} SOL"
if [ "${f[short]}" != 0 ]; then echo "            SHORT by ${f[short_sol]} SOL: send it to $payer first"; fi

args=(program deploy "$so" --url "$url" --keypair "$keypair" --fee-payer "$keypair"
  --program-id "$program_keypair" --buffer "$buffer_keypair" --upgrade-authority "$keypair"
  --with-compute-unit-price "${f[price]}" --max-sign-attempts "$attempts" --commitment confirmed)
[ "$use_rpc" = 1 ] && args+=(--use-rpc)
[ "$max_len" != "$size" ] && args+=(--max-len "$max_len")
shown=("${args[@]}")
shown[4]="$url_shown"
echo
echo "command     solana ${shown[*]}"

if [ "$send" != 1 ]; then
  echo
  if [ "${f[short]}" != 0 ]; then echo "not ready: the wallet is short. Nothing was sent."; exit 1; fi
  echo "ready. Nothing was sent. To send, the same settings plus: SEND=1 PROGRAM=$program"
  echo "(it runs the command above, then check-deploy.mjs)"
  exit 0
fi
[ "${f[short]}" = 0 ] || stop "the wallet is short by ${f[short_sol]} SOL"

echo
if ! sol "${args[@]}"; then
  # The CLI can stop after its last transaction landed (a confirmation that timed out): the chain says which.
  read_facts program
  [ "${f[program_state]:-}" = ours ] || stop "the deploy stopped. Run the same command again: it goes on from the buffer ($buffer)"
  echo "the CLI stopped, but the program is there: its last transaction landed."
fi
echo
record_deployed
echo "deployed. The config comes next (init-config.mjs); until then check-deploy.mjs leaves it out (CONFIG=0)."
check_deployed
