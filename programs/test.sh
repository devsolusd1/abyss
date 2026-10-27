#!/bin/bash
# Builds the pool program and runs every test. Run it from Linux or WSL.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Cargo is slow on a Windows drive mounted in WSL, so build somewhere native.
target="${DEX_TARGET:-$HOME/dex-target}"
pool_so="$target/pool/deploy/dex.so"

(cd pool && CARGO_TARGET_DIR="$target/pool" cargo test --lib)
(cd pool && CARGO_TARGET_DIR="$target/pool" cargo build-sbf --sbf-out-dir "$target/pool/deploy")
(cd pool-tests && CARGO_TARGET_DIR="$target/pool-tests" POOL_SO="$pool_so" cargo test -- --nocapture)

echo "binary: $(stat -c %s "$pool_so") bytes at $pool_so"
