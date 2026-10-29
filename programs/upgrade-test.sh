#!/bin/bash
# Builds the pool program as it was before the opening batch, and as it is now, and runs the upgrade tests: coins
# launched by the old binary keep trading once the current one replaces it at the same address, and a batch under
# way lives through an upgrade. Run it from Linux or WSL. The first run builds the old version from nothing, which
# takes a few minutes.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# The version the upgrade starts from: the last one before the opening batch. The test writes that version's launch
# (launch_ix_before_batch) and expects its errors, so it holds for this one upgrade only. Before an upgrade of a live
# program, set POOL_SO_LIVE to the live commit built again for the tests' address (deploy/MAINNET.md, "Um upgrade
# depois": COMMIT=<live commit> deploy/build.sh CbAjrr…): the upgrade in the middle of a batch then starts from it.
# A dump of the live binary does not do: it carries the live address in its declare_id! and refuses to run at any
# other (DeclaredProgramIdMismatch). Without POOL_SO_LIVE, that test has the current binary on both sides.
old=b73a4b1
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
# Every test named for upgrades, with the one test.sh leaves out because it has no old binary.
(cd pool-tests && CARGO_TARGET_DIR="$target/pool-tests" POOL_SO="$pool_so" POOL_SO_OLD="$old_so" \
  cargo test --test pool upgrade -- --include-ignored --nocapture)

echo "old binary: $(stat -c %s "$old_so") bytes ($old), current: $(stat -c %s "$pool_so") bytes"
