#!/usr/bin/env bash
set -Eeuo pipefail
source /work/tests/lib/safe-rm.sh
test -f /.dockerenv
test "$(id -u)" != 0
test -n "${SOURCE_COMMIT:-}"
test "$SOURCE_COMMIT" = "${EXPECTED_SOURCE_COMMIT:-}"
test "$BASE_COMMIT" = 5cb8db3d4d2d907d43a7fd47d926cf323fa1df41
unset DATABASE_URL COMMHUB_TEST_PG_URL
cd /work/server
echo "TEST-ONLY source=$SOURCE_COMMIT selected-baseline=$BASE_COMMIT"
fixture_dir=$(mktemp -d /tmp/qa1201.XXXXXXXX)
trap 'safe_rm_rf "$fixture_dir"' EXIT
files=(host-supervisor-identity-http.test.ts observer-avatar-http.test.ts requirements-http.test.ts)
mkdir "$fixture_dir/candidate"
for f in "${files[@]}"; do cp "src/$f" "$fixture_dir/candidate/$f"; cp "/baseline/$f" "src/$f"; done
for f in "${files[@]}"; do
  rc=0
  env NODE_ENV=test HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/base-$f.db" bun test "src/$f" >"$fixture_dir/base-$f.log" 2>&1 || rc=$?
  test "$rc" != 0
  python3 - "$f" "$fixture_dir/base-$f.log" <<'PY'
import pathlib,re,sys
name,path=sys.argv[1:];text=pathlib.Path(path).read_text()
patterns={
 'host-supervisor-identity-http.test.ts':r'\(fail\) (?:MCP|REST): null-network legacy heartbeat is accepted only for globally unique aliases',
 'observer-avatar-http.test.ts':r'\(fail\) #461 observer receives third-party traffic summaries > REST /api/task dispatch',
 'requirements-http.test.ts':r'\(fail\) requirements stay on the hub > due accepts date-only',
}
failed=[line for line in text.splitlines() if '(fail)' in line]
expected=2 if name.startswith('host-') else 1
if len(failed)!=expected or any(not re.search(patterns[name],line) for line in failed):
 print(text);raise RuntimeError('baseline failed outside exact expected assertions: '+name)
print('BASELINE_ASSERTION_RED',name,'expected-failures',expected)
PY
done
for f in "${files[@]}"; do cp "$fixture_dir/candidate/$f" "src/$f"; done
for f in "${files[@]}"; do
  echo "CANDIDATE $f"
  env NODE_ENV=test HOME="$fixture_dir" COMMHUB_DB="$fixture_dir/fixed-$f.db" bun test "src/$f"
done
echo "RESULT: selected baseline expected RED; candidate three full HTTP files PASS"
