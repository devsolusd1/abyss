#!/bin/bash
# Builds the pool program from a commit, for one program id. The program's folder at HEAD is taken out of git into a
# folder outside the repository, its declare_id! line is set to the id given, and it is built there. What goes on
# chain is then a commit plus one line, which anyone can build again and compare with the chain (check-deploy.mjs).
# Run it from Linux or WSL. The first build compiles every dependency, which takes a few minutes.
#
#   programs/deploy/build.sh <program id>
#   COMMIT=<commit> programs/deploy/build.sh <program id>      (another commit than HEAD)
#
# Out: $NOX_RELEASE/<id>/dex.so and build.json (the commit, the id, the size, the sha256, whether the tree had changes
# git had not committed, and whether the commit is on origin/main). NOX_RELEASE is ~/nox-release unless set. A build
# already there for the same commit and id is kept, unless FORCE=1.
#
# It refuses when programs/pool has changes not committed: they would not be in the build, which takes HEAD only.
# ALLOW_DIRTY=1 builds HEAD anyway, for a test, and marks the build dirty; deploy.sh refuses a dirty build on mainnet.
# With COMMIT the working tree plays no part, so it is never dirty. COMMIT is for the upgrade test: the commit live on
# mainnet, built again for the id the tests load it at (MAINNET.md), since the binary refuses to run at any address but
# its own.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
# Before the cd below: a NOX_RELEASE given relative means the folder this was run from.
release="$(realpath -m "${NOX_RELEASE:-$HOME/nox-release}")"
cd "$(dirname "$0")"

id="${1:-}"
if ! [[ "$id" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; then
  echo "usage: build.sh <program id>   (a base58 address, such as the one deploy.sh prints)" >&2
  exit 2
fi

repo="$(git rev-parse --show-toplevel)"
commit="$(git -C "$repo" rev-parse --verify --quiet "${COMMIT:-HEAD}^{commit}")" \
  || { echo "COMMIT: no commit ${COMMIT:-HEAD} in this repository" >&2; exit 2; }
out="$release/$id"
src="$out/src"
# One target folder for every id: the dependencies build once, and only the program itself again for another id.
target="$release/target"
so="$out/dex.so"

dirty=false
if [ -z "${COMMIT:-}" ]; then
  changes="$(git -C "$repo" status --porcelain -- programs/pool)"
  if [ -n "$changes" ]; then
    if [ "${ALLOW_DIRTY:-}" != 1 ]; then
      echo "programs/pool has changes not committed:" >&2
      echo "$changes" >&2
      echo "The build takes HEAD only, so they would not be in it. Commit them first (or ALLOW_DIRTY=1 for a test)." >&2
      exit 1
    fi
    dirty=true
    echo "warning: programs/pool has changes not committed; this build is of HEAD without them, and is marked dirty"
  fi
fi
# As this clone last fetched it. deploy.sh refuses mainnet for a commit that is not there.
pushed=false
git -C "$repo" branch -r --contains "$commit" 2>/dev/null | grep -qE '^ *origin/main$' && pushed=true
if [ "$pushed" = false ]; then
  echo "warning: ${commit:0:7} is not on origin/main here: nobody else can build it again until it is pushed"
fi

# Kept when it is the same commit and id from a clean tree, and the binary is still the one build.json describes.
if [ "${FORCE:-}" != 1 ] && [ "$dirty" = false ] && [ -f "$so" ] && [ -f "$out/build.json" ] \
  && grep -qF "\"commit\": \"$commit\"," "$out/build.json" && grep -qF "\"program\": \"$id\"," "$out/build.json" \
  && grep -qF '"dirty": false,' "$out/build.json" \
  && grep -qF "\"sha256\": \"$(sha256sum "$so" | cut -d' ' -f1)\"," "$out/build.json"; then
  echo "already built: $so ($(stat -c %s "$so") bytes, commit ${commit:0:7}); FORCE=1 builds it again"
  exit 0
fi

# Only the program's folder at that commit, as git has it: nothing from the working tree gets in.
rm -rf "${src:?}" "$so" "$out/build.json"
mkdir -p "$src"
git -C "$repo" archive --format=tar "$commit:programs/pool" | tar -x -C "$src"
# git archive dates the files at the commit, which can be older than a build already in the shared target: touched,
# they make cargo build the crate again from them instead of trusting that build.
find "$src" -type f -exec touch {} +

# The one line that differs from the commit. Anything else than exactly one declare_id! in the crate is a stop: the id
# would not be the one the binary checks its accounts against.
pattern='^declare_id!\("[1-9A-HJ-NP-Za-km-z]{32,44}"\);$'
lib="$src/src/lib.rs"
found="$( (grep -rcE 'declare_id!' "$src/src" || true) | awk -F: '{ n += $NF } END { print n + 0 }')"
if [ "$found" != 1 ] || [ "$(grep -cE "$pattern" "$lib" || true)" != 1 ]; then
  echo "expected exactly one declare_id!(\"…\"); line, in src/lib.rs, at ${commit:0:7}; found $found in the crate" >&2
  exit 1
fi
before="$(grep -E "$pattern" "$lib")"
sed -i -E "s/$pattern/declare_id!(\"$id\");/" "$lib"
if [ "$(grep -cxF "declare_id!(\"$id\");" "$lib" || true)" != 1 ] || [ "$(grep -cE "$pattern" "$lib" || true)" != 1 ]; then
  echo "the declare_id! line did not change to $id exactly once" >&2
  exit 1
fi
echo "commit ${commit:0:7}: $before -> declare_id!(\"$id\");"

# --locked: the dependencies are the ones Cargo.lock names at that commit, never newer ones. cargo build-sbf also leaves
# a random dex-keypair.json in the target's deploy folder; it is not the program's key, and nothing uses it.
(cd "$src" && CARGO_TARGET_DIR="$target" cargo build-sbf --sbf-out-dir "$target/deploy" -- --locked)
cp "$target/deploy/dex.so" "$so"

size="$(stat -c %s "$so")"
sha="$(sha256sum "$so" | cut -d' ' -f1)"
tools="$(cargo build-sbf --version | tr '\n' ' ' | sed 's/ *$//')"
cat > "$out/build.json" <<EOF
{
  "program": "$id",
  "commit": "$commit",
  "dirty": $dirty,
  "on_origin_main": $pushed,
  "source": "$commit:programs/pool, with declare_id! set to the program",
  "file": "dex.so",
  "size": $size,
  "sha256": "$sha",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "toolchain": "$tools"
}
EOF
echo "built: $so"
echo "  $size bytes, sha256 $sha"
echo "  commit $commit$([ "$dirty" = true ] && echo ' (dirty)')"
