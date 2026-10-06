#!/bin/sh
set -eu
[ -f /.dockerenv ] && [ "${TEST658_CONTAINER:-}" = 1 ] || { echo 'container opt-in required' >&2; exit 1; }
pass=0
fail=0
log=$(mktemp /tmp/remain-repeat.XXXXXX)
trap 'rm -f "$log"' EXIT
for n in $(seq 1 20); do
  if bun test tests/test658-codex-adopt-stop/collect.test.ts -t 'partial stop recovery: remain-on-exit' >"$log" 2>&1 &&
      grep -Eq '^[[:space:]]*1 pass$' "$log" && grep -Eq '^[[:space:]]*0 fail$' "$log"; then
    pass=$((pass+1))
  else
    fail=$((fail+1))
    echo "FAIL remain-on-exit iteration=$n"
    tail -30 "$log"
  fi
done
echo "remain-on-exit pass=$pass fail=$fail total=20"
[ "$fail" -eq 0 ]
