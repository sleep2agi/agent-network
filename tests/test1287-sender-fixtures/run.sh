#!/usr/bin/env bash
set -euo pipefail
test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"
mode="${FIXTURE_CASE:-baseline}"
printf 'TEST-ONLY source=%s scope=original sender fixtures case=%s\n' "$SOURCE_COMMIT" "$mode"
mkdir -p /tmp/test1287
case "$mode" in
  baseline)
    COMMHUB_DB=/tmp/test1287/runtime.db bash /app/test8-run.sh
    bash /app/run.sh
    echo 'RESULT: PASS original runtime and network-scope baselines'
    ;;
  mutant-runtime)
    cp /app/test8-run.sh /tmp/test1287/fixed.sh
    python3 - <<'PYM'
from pathlib import Path
p=Path('/app/test8-run.sh');s=p.read_text();a='"task":"runtime layer2 task","priority":"high"';assert a in s;s=s.replace(a,'"task":"runtime layer2 task","from_session":"test8","priority":"high"');p.write_text(s)
PYM
    if COMMHUB_DB=/tmp/test1287/runtime.db bash /app/test8-run.sh >/tmp/test1287/mutant.log 2>&1; then
      cat /tmp/test1287/mutant.log
      echo 'MUTATION_FALSE_GREEN: original test8 spoofed sender'; exit 1
    fi
    cat /tmp/test1287/mutant.log
    python3 - <<'PYM'
import json
from pathlib import Path
found=False
for line in Path('/tmp/test1287/mutant.log').read_text().splitlines():
    if not line.startswith('data: '): continue
    try: p=json.loads(json.loads(line[6:])["result"]["content"][0]["text"])
    except (ValueError,KeyError,IndexError,TypeError): continue
    if p.get('error')=='from_session_identity_mismatch' and p.get('requested_from_session')=='test8': found=True
assert found, 'missing exact original positive-call sender mismatch'
PYM
    grep -q 'send_task did not reach SSE subscriber' /tmp/test1287/mutant.log
    cp /tmp/test1287/fixed.sh /app/test8-run.sh
    cmp /tmp/test1287/fixed.sh /app/test8-run.sh
    echo 'EXPECTED_RED: original test8 spoofed sender; restored bytes'
    ;;
  mutant-scope)
    cp /app/run.sh /tmp/test1287/fixed.sh
    python3 - <<'PYM'
from pathlib import Path
p=Path('/app/run.sh');s=p.read_text();a='task:"missing-network-id"}';assert a in s;s=s.replace(a,'task:"missing-network-id",from_session:"alice-dashboard"}');p.write_text(s)
PYM
    if bash /app/run.sh >/tmp/test1287/mutant.log 2>&1; then
      cat /tmp/test1287/mutant.log
      echo 'MUTATION_FALSE_GREEN: original scope spoofed sender'; exit 1
    fi
    cat /tmp/test1287/mutant.log
    grep -q 'from_session_identity_mismatch' /tmp/test1287/mutant.log
    grep -q '"requested_from_session":"alice-dashboard"' /tmp/test1287/mutant.log
    cp /tmp/test1287/fixed.sh /app/run.sh
    cmp /tmp/test1287/fixed.sh /app/run.sh
    echo 'EXPECTED_RED: original scope spoofed sender; restored bytes'
    ;;
  *) echo "unsupported fixture case"; exit 1;;
esac
