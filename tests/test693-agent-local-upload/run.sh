#!/usr/bin/env bash
set -euo pipefail
echo "# test693 agent local upload bridge"
echo "SOURCE_COMMIT=${SOURCE_COMMIT:-unknown}"
echo "date=$(date -Iseconds)"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "L0 controlled-upload unit"
(cd "$ROOT/agent-node" && bun test src/controlled-upload.test.ts)

echo "L1 witnessed-red mutations"
MUT_ROOT=$(mktemp -d /tmp/test693-mut.XXXXXX)
cleanup() { rm -rf -- "${MUT_ROOT:?}"; }
trap cleanup EXIT

run_mut() {
  local name="$1" expr="$2"
  local dir="$MUT_ROOT/$name"
  mkdir -p "$dir"
  cp -a "$ROOT/agent-node/src/controlled-upload.ts" "$dir/"
  cp -a "$ROOT/agent-node/src/controlled-upload.test.ts" "$dir/"
  local before after
  before=$(sha256sum "$dir/controlled-upload.ts" | awk '{print $1}')
  sed -i "$expr" "$dir/controlled-upload.ts"
  after=$(sha256sum "$dir/controlled-upload.ts" | awk '{print $1}')
  if [ "$before" = "$after" ]; then
    echo "MUTATION_NOOP name=$name"
    exit 1
  fi
  set +e
  (cd "$dir" && bun test controlled-upload.test.ts) >"$MUT_ROOT/$name.log" 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_SURVIVED name=$name"
    tail -30 "$MUT_ROOT/$name.log"
    exit 1
  fi
  echo "witnessed-red name=$name rc=$rc"
}

run_mut path-boundary-removed \
  's/if (rel !== "" \&\& rel !== "\.\." \&\& !rel.startsWith(`\.\.${sep}`) \&\& !isAbsolute(rel))/if (true)/'

run_mut symlink-reject-removed \
  's/if (lst.isSymbolicLink())/if (false \&\& lst.isSymbolicLink())/'

run_mut size-cap-removed \
  's/CONTROLLED_UPLOAD_MAX_BYTES = 12 \* 1024 \* 1024/CONTROLLED_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024 * 1024/'

echo "L2 in-process hub integrate"
# require-explicit-test-db needs COMMHUB_DB or similar
export COMMHUB_DB="${COMMHUB_DB:-$(mktemp /tmp/test693-db.XXXXXX.sqlite)}"
export COMMHUB_SERVER=1
bun "$ROOT/tests/test693-agent-local-upload/integrate.ts"

echo "RESULT: PASS"
