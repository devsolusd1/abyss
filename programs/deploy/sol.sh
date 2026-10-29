#!/bin/bash
# The Solana CLI on CLUSTER's node, with the node's URL kept out of everything it prints. A paid node's URL carries its
# key, and the CLI prints the whole URL in a network error ("error sending request for url (…)"), so every solana
# command MAINNET.md asks for goes through here. Run it from Linux or WSL.
#
#   CLUSTER=mainnet bash programs/deploy/sol.sh program show --buffers --keypair <KEYPAIR>   (RPC_URL exported first,
#                                                       with read -rsp as MAINNET.md shows: never on the command line)
#   CLUSTER=devnet bash programs/deploy/sol.sh program close <buffer> --keypair ~/.config/solana/devnet.json
#
# It adds --url itself: leave --url, -u and -v out (-v prints the URL). Before the command it asks the node for its
# genesis hash and stops when the node is not of CLUSTER, so an RPC_URL left in the shell from another step never runs a
# devnet command on mainnet, nor the other way round. Devnet takes the public node unless RPC_URL is given; mainnet
# needs RPC_URL.
#
# It runs the command it is given, as the CLI would: unlike the other scripts here, there is no dry run. Two commands it
# refuses: `config` (config set would save the node's URL, key and all, in the CLI's config file; every step here takes
# --keypair instead), and any command that writes to the program the devnet site runs on (CbAjrr…).
#
# deploy.sh sources this file for nox_node and redact.

nox_stop() { echo "stop: $*" >&2; exit 1; }

# Each cluster's genesis hash: a node of another cluster answers with another one (check-deploy.mjs GENESIS).
nox_genesis() { case "$1" in devnet) echo EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG ;; mainnet) echo 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d ;; esac; }

# Sets url (what the CLI gets) and url_shown (what may be printed) for a cluster, from RPC_URL.
nox_node() {
  if [ -n "${RPC_URL:-}" ]; then
    [[ "$RPC_URL" =~ ^[Hh][Tt][Tt][Pp][Ss]?:// ]] || nox_stop "RPC_URL must be an http(s) URL"
    url="$RPC_URL"; url_shown="<RPC_URL>"
  elif [ "$1" = mainnet ]; then
    nox_stop "CLUSTER=mainnet needs RPC_URL: a paid node (its URL is never printed)"
  else
    url="https://api.devnet.solana.com"; url_shown="$url"
  fi
}

# Every line the CLI prints comes through here. The CLI prints the URL as it parsed it (the host in lower case, a slash
# added), not as given, so matching the text given is not enough: any URL on the node's host goes whole, then the host,
# then each part of the path, query and user info six characters long or more, all ignoring case.
redact() {
  if [ "$url_shown" = "$url" ]; then cat; return; fi
  NOX_HIDE="$url" perl -pe 'BEGIN {
      $| = 1; $h = $ENV{NOX_HIDE};
      ($user, $host, $rest) = $h =~ m{^[a-z][a-z0-9+.-]*://(?:([^@/?#]*)@)?([^:/?#]*)(.*)$}i;
      @all = sort { length($b) <=> length($a) } grep { length($_) >= 6 } ($h, $host, split(m{[/?&=#:;]+}, "$rest:$user"));
    }
    s{[a-z][a-z0-9+.-]*://[^\s()<>"]*\Q$host\E[^\s()<>"]*}{<hidden>}gi if length $host;
    for my $s (@all) { s/\Q$s\E/<hidden>/gi }'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
  case "${CLUSTER:-}" in
    devnet) cluster=devnet ;;
    mainnet|mainnet-beta) cluster=mainnet ;;
    *) nox_stop "CLUSTER must be devnet or mainnet" ;;
  esac
  [ $# -gt 0 ] || nox_stop "usage: CLUSTER=<devnet|mainnet> bash sol.sh <solana arguments, without --url> (RPC_URL exported)"
  writes="" site=""
  for a in "$@"; do
    case "$a" in
      -u|-u?*|--url|--url=*) nox_stop "leave --url out: sol.sh adds CLUSTER's node itself" ;;
      -v|--verbose) nox_stop "-v prints the node's URL: leave it out" ;;
      config) nox_stop "config set would save the node's URL, key and all, in the CLI's config file: give --keypair instead" ;;
      close|deploy|upgrade|extend|write-buffer|set-upgrade-authority|set-buffer-authority|transfer) writes="$a" ;;
      CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK) site="$a" ;;
    esac
  done
  [ -z "$writes" ] || [ -z "$site" ] || nox_stop "$writes with CbAjrr…, the program the devnet site runs on: never from this kit"
  nox_node "$cluster"
  genesis="$(solana genesis-hash --url "$url" 2>&1 | redact)" || nox_stop "the node did not answer: $genesis"
  [ "$genesis" = "$(nox_genesis "$cluster")" ] || nox_stop "the node is not a $cluster node: its genesis hash is $genesis"
  solana "$@" --url "$url" 2>&1 | redact
  exit "${PIPESTATUS[0]}"
fi
