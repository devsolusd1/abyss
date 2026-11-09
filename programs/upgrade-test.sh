#!/bin/bash
# Builds the pool program as it is live, and as it is now, and runs the upgrade tests: coins launched by the live binary
# keep trading once the current one replaces it at the same address (the ones it graduated to the lamport as before,
# the others along the one curve), and a batch under way lives through an upgrade. Run it from Linux or WSL. The first
# run builds the live version from nothing, which takes a few minutes.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# The version the upgrade starts from: the one live on devnet at CbAjrr…, whose program has not changed since the
# opening batch (611e948); 671ae17 is the last commit with it before the one curve. The tests write that version's
# formats and expect what it does, so they hold for this one upgrade only. Before an upgrade of a live program, set
# `old` to the live commit: it is built again here for the tests' address, which deploy/MAINNET.md ("Um upgrade
# depois") does with `COMMIT=<live commit> deploy/build.sh CbAjrr…`. A dump of the live binary does not do: it carries
# the live address in its declare_id! and refuses to run at any other (DeclaredProgramIdMismatch).
old=671ae17
# Cargo is slow on a Windows drive mounted in WSL, so the old source and both builds live somewhere native.
target="${DEX_TARGET:-$HOME/dex-target}"
old_src="${DEX_OLD_SRC:-$HOME/dex-old}"
pool_so="$target/pool/deploy/dex.so"
old_so="$target/old/deploy/dex.so"

# Only the program's folder at that commit, outside the repository. Taken out once, so cargo reuses the last build.
commit="$(git -C .. rev-parse "$old^{commit}")"
if [ "$(cat "$old_src/.commit" 2>/dev/null)" != "$commit" ]; then
  rm -rf "${old_src:?}"
  mkdir -p "$old_src"
  git -C .. archive --format=tar "$commit:programs/pool" | tar -x -C "$old_src"
  echo "$commit" > "$old_src/.commit"
fi

(cd "$old_src" && CARGO_TARGET_DIR="$target/old" cargo build-sbf --sbf-out-dir "$target/old/deploy")
(cd pool && CARGO_TARGET_DIR="$target/pool" cargo build-sbf --sbf-out-dir "$target/pool/deploy")
# Every test named for upgrades, with the one test.sh leaves out because it has no live binary.
(cd pool-tests && CARGO_TARGET_DIR="$target/pool-tests" POOL_SO="$pool_so" POOL_SO_LIVE="$old_so" \
  cargo test --test pool upgrade -- --include-ignored --nocapture)

echo "live binary: $(stat -c %s "$old_so") bytes ($old), current: $(stat -c %s "$pool_so") bytes"
