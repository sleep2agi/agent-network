#!/bin/sh
set -eu
# Compiler and dependencies are cached; all compilation runs inside Docker.
state=$(mktemp -d /tmp/opencode/shared-fork-types-XXXXXX)
mkdir "$state/baseline"
git archive 7389e72c92095020e592b20b5d32b6cfcaf0b5d2 agent-node/src/runtime/session-source-evidence.ts agent-node/src/runtime/session-source-delivery.ts contracts/session-source-evidence.ts | tar -x -C "$state/baseline"
set +e
docker run --rm --init --network none --user 0 --workdir /work/agent-node \
  --mount type=bind,src=/tmp/opencode/tc-base/agent-node/node_modules/typescript,dst=/compiler,readonly \
  --entrypoint bun anet-shared-fork-final:local /compiler/bin/tsc --noEmit --pretty false >"$state/candidate.txt" 2>&1
candidate=$?
docker run --rm --init --network none --user 0 --workdir /work/agent-node \
  --mount type=bind,src=/tmp/opencode/tc-base/agent-node/node_modules/typescript,dst=/compiler,readonly \
  --mount type=bind,src="$state/baseline/agent-node/src/runtime/session-source-evidence.ts",dst=/work/agent-node/src/runtime/session-source-evidence.ts,readonly \
  --mount type=bind,src="$state/baseline/agent-node/src/runtime/session-source-delivery.ts",dst=/work/agent-node/src/runtime/session-source-delivery.ts,readonly \
  --mount type=bind,src="$state/baseline/contracts/session-source-evidence.ts",dst=/work/contracts/session-source-evidence.ts,readonly \
  --entrypoint bun anet-shared-fork-final:local /compiler/bin/tsc --noEmit --pretty false >"$state/baseline.txt" 2>&1
baseline=$?
set -e
printf 'TYPECHECK_STATE=%s candidate_exit=%s baseline_exit=%s\n' "$state" "$candidate" "$baseline"
python3 - "$state" <<'PY'
import pathlib,re,sys,json
p=pathlib.Path(sys.argv[1])
def diagnostics(name):
    return sorted(re.sub(r'\(\d+,\d+\)', '(LINE,COL)', x) for x in (p/name).read_text().splitlines() if 'error TS' in x)
a,b=diagnostics('candidate.txt'),diagnostics('baseline.txt')
print(json.dumps({'candidate_errors':len(a),'baseline_errors':len(b),'same_diagnostics':a==b,'new':list((__import__('collections').Counter(a)-__import__('collections').Counter(b)).elements())}))
sys.exit(0 if a==b and len(a)>0 else 1)
PY
