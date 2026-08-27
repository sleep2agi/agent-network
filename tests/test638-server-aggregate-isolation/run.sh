#!/usr/bin/env bash
set -euo pipefail

EXPECTED_SOURCE_COMMIT="${EXPECTED_SOURCE_COMMIT:-}"
if [[ -z "${TEST639_SOURCE_COMMIT:-}" || -z "$EXPECTED_SOURCE_COMMIT" || "$TEST639_SOURCE_COMMIT" != "$EXPECTED_SOURCE_COMMIT" ]]; then
  echo "FAIL: source provenance mismatch image=${TEST639_SOURCE_COMMIT:-unset} expected=${EXPECTED_SOURCE_COMMIT:-unset}"
  exit 1
fi

cd /work
SHARED_DB=/tmp/test638-shared-must-not-open.db
RUN1=/tmp/test638-run1
RUN2=/tmp/test638-run2
RUN3=/tmp/test638-run3
OUT1=/tmp/test638-run1.out
OUT2=/tmp/test638-run2.out
OUT3=/tmp/test638-run3.out
TRACE1=/tmp/test638-run1.openat
PROBES=(
  server/src/test638-nonzero.test.ts
  server/src/test638-timeout.test.ts
  server/src/test638-signal.test.ts
  server/src/test639-missing-summary.test.ts
  server/src/test639-collision.test.ts
  server/src/test639/collision.test.ts
  server/scripts/test-aggregate-mutation.ts
)
cleanup() {
  rm -f -- "${PROBES[@]}"
  rmdir server/src/test639 2>/dev/null || true
}
trap cleanup EXIT
dump_agg_failure() {
  # #1274: aggregate 失败时把诊断吐给 CI —— 否则 set -e 无声死，红无任何指名信息
  local label="$1" output="$2" rc="$3"
  echo "FAIL: $label aggregate exited rc=$rc — offending files:"
  grep '^TEST_FILE_RESULT' "$output" \
    | awk -F'\t' '{bad=0; for(i=1;i<=NF;i++){if($i=="timeout=true")bad=1; if($i ~ /^exit=/ && $i!="exit=0")bad=1}; if(bad)print}' || true
  # #1319: 上面那行能报出**是哪个文件**,但接着的 `tail -40` 吐的是整份聚合输出的
  # 尾巴 —— 实测里那 40 行全是后续文件的 (pass),失败用例名根本不在范围内。
  # 于是「文件名有了、用例名没了」,查的人只能猜。
  #
  # bun 把断言详情打在 `(fail)` 行**之前**,所以往前取上下文。实测(bun 1.3.14,
  # 各造一份不同断言深度的失败输出):
  #   源码上下文固定 6 行(断言在文件第 6 行和第 152 行,输出都是 6 行)
  #   error: → (fail) 距离:toBe 断言 6 行;toEqual 对象断言 13 行
  # 🔴 -B30 是「够用」,**不是保证**:变量是 diff 长度,而对象越大 diff 越长,
  #    没有上限。真正的兜底是把整份 $output 传成 artifact(见 ARTIFACT_DIR 一段)。
  echo "--- failing cases in $output ---"
  if grep -q '^(fail)' "$output"; then
    grep -B30 '^(fail)' "$output" || true
  else
    echo "  (没有 '(fail)' 行 —— 这次失败不是用例级断言,"
    echo "   可能是文件级 crash / import 失败 / 进程被杀,看下面的 tail)"
  fi
  # 保留原有的 tail:两者互补 —— 上面给用例名,下面给文件级 crash 的现场。
  echo "--- last 40 lines of $output ---"
  tail -40 "$output" || true
  # 兜底,不依赖任何输出格式假设。ARTIFACT_DIR 是本仓既有约定(test225/234/697
  # 都在用)。⚠️ 目前 qa.yml 的 hub-semantics 矩阵是 `docker run --rm`,没有取出
  # 步骤,所以这几份现在只落在容器里 —— 取出需要照 test225 的做法
  # (`--name` + `docker cp` + `docker rm -f`,qa.yml:745-755)。先写,取出另议。
  if [ -n "${ARTIFACT_DIR:-}" ]; then
    mkdir -p "$ARTIFACT_DIR" 2>/dev/null || true
    cp -- "$output" "$ARTIFACT_DIR/$(basename "$output")" 2>/dev/null \
      && echo "--- saved full output to \$ARTIFACT_DIR/$(basename "$output") ---" || true
  fi
}

rm -rf -- /tmp/test638-run1 /tmp/test638-run2 /tmp/test638-run3
rm -f -- "$OUT1" "$OUT2" "$OUT3" "$TRACE1" "$SHARED_DB" "$SHARED_DB-wal" "$SHARED_DB-shm"

run_one() {
  local root="$1" output="$2" order="${3:-normal}"
  local args=()
  [[ "$order" == reverse ]] && args+=(--reverse)
  NODE_ENV=test DATABASE_URL='postgres://must-not-be-inherited.invalid/prod' COMMHUB_DB="$SHARED_DB" \
    ANET_SERVER_TEST_ROOT="$root" ANET_SERVER_TEST_KEEP_ROOT=1 \
    bun run --cwd server test "${args[@]}" >"$output" 2>&1
}

echo "L1: normal order under strace"
set +e
NODE_ENV=test DATABASE_URL='postgres://must-not-be-inherited.invalid/prod' COMMHUB_DB="$SHARED_DB" \
  ANET_SERVER_TEST_ROOT="$RUN1" ANET_SERVER_TEST_KEEP_ROOT=1 \
  strace -f -e trace=openat -o "$TRACE1" bun run --cwd server test >"$OUT1" 2>&1
rc1=$?
set -e
[[ $rc1 -eq 0 ]] || { dump_agg_failure "L1" "$OUT1" "$rc1"; exit 1; }

echo "L2: concurrent normal + reverse order"
set +e
run_one "$RUN2" "$OUT2" normal & p2=$!
run_one "$RUN3" "$OUT3" reverse & p3=$!
wait "$p2"; rc2=$?
wait "$p3"; rc3=$?
set -e
[[ $rc2 -eq 0 ]] || dump_agg_failure "L2-normal" "$OUT2" "$rc2"
[[ $rc3 -eq 0 ]] || dump_agg_failure "L2-reverse" "$OUT3" "$rc3"
[[ $rc2 -eq 0 && $rc3 -eq 0 ]] || { echo "FAIL: concurrent aggregate rc2=$rc2 rc3=$rc3"; exit 1; }

summary_key() {
  grep '^SERVER_AGGREGATE_RESULT ' "$1" | tail -1 \
    | sed -E 's/.*"files":([0-9]+).*"pass":([0-9]+).*"fail":([0-9]+).*"skip":([0-9]+).*"expects":([0-9]+).*"bad":(true|false).*/\1:\2:\3:\4:\5:\6/'
}
key1=$(summary_key "$OUT1")
key2=$(summary_key "$OUT2")
key3=$(summary_key "$OUT3")
[[ "$key1" == "$key2" && "$key1" == "$key3" ]] || { echo "FAIL: count drift $key1 / $key2 / $key3"; exit 1; }
[[ "$key1" =~ ^[0-9]+:[0-9]+:0:[0-9]+:[0-9]+:false$ ]] || { echo "FAIL: aggregate not green: $key1"; exit 1; }

for output in "$OUT1" "$OUT2" "$OUT3"; do
  grep -F $'TEST_FILE_RESULT\tserver/src/api-host-supervisors-fallback.test.ts\tpass=8\tfail=0' "$output" >/dev/null
  grep -F $'TEST_FILE_RESULT\tserver/src/uploads-http.test.ts\tpass=15\tfail=0' "$output" >/dev/null
  grep -F $'TEST_FILE_RESULT\tserver/src/scheduled-tasks-http.test.ts\tpass=12\tfail=0' "$output" >/dev/null
  ! grep -Eqi 'connection refused|ECONNREFUSED|database safety guard|FAIL_SUITE|timeout=true' "$output"
  maps=$(grep -c '^TEST_DB_MAP' "$output")
  unique_maps=$(grep '^TEST_DB_MAP' "$output" | cut -f3 | sort -u | wc -l)
  [[ $maps -gt 0 && $maps -eq $unique_maps ]] || { echo "FAIL: DB map not one-to-one in $output ($maps/$unique_maps)"; exit 1; }
done

echo "L3: syscall DB scope + cross-suite fixtures"
[[ $(grep -F -c "$SHARED_DB" "$TRACE1" || true) -eq 0 ]] || { echo "FAIL: inherited shared DB was opened"; exit 1; }
outside=$(grep -oE '/tmp/[^" ]*commhub\.db' "$TRACE1" | grep -v "^$RUN1/" || true)
[[ -z "$outside" ]] || { echo "FAIL: DB opened outside per-file root: $outside"; exit 1; }

upload_db=$(grep -F $'TEST_DB_MAP\tserver/src/uploads-http.test.ts\t' "$OUT1" | cut -f3)
host_db=$(grep -F $'TEST_DB_MAP\tserver/src/api-host-supervisors-fallback.test.ts\t' "$OUT1" | cut -f3)
[[ -f "$upload_db" && -f "$host_db" && "$upload_db" != "$host_db" ]] || { echo "FAIL: fixture DB paths missing/not distinct"; exit 1; }
upload_shape=$(TEST638_DB="$upload_db" bun -e 'import {Database} from "bun:sqlite";const d=new Database(process.env.TEST638_DB,{readonly:true});const n=(p)=>d.query("SELECT COUNT(*) n FROM users WHERE username LIKE ?1").get(p).n;console.log(`${n("upload_admin_%")}:${n("solo_%")}`)')
host_shape=$(TEST638_DB="$host_db" bun -e 'import {Database} from "bun:sqlite";const d=new Database(process.env.TEST638_DB,{readonly:true});const n=(p)=>d.query("SELECT COUNT(*) n FROM users WHERE username LIKE ?1").get(p).n;console.log(`${n("upload_admin_%")}:${n("solo_%")}`)')
[[ "$upload_shape" =~ ^[1-9][0-9]*:0$ ]] || { echo "FAIL: upload fixture/cross-leak shape=$upload_shape"; exit 1; }
[[ "$host_shape" =~ ^0:[1-9][0-9]*$ ]] || { echo "FAIL: host fixture/cross-leak shape=$host_shape"; exit 1; }
[[ ! -e "$SHARED_DB" ]] || { echo "FAIL: shared DB exists"; exit 1; }

echo "L4: standalone real-server tests fail closed without explicit DB"
set +e
NODE_ENV=test DATABASE_URL= COMMHUB_DB= bun test server/src/uploads-http.test.ts >/tmp/test638-no-db-upload.out 2>&1; nodb1=$?
NODE_ENV=test DATABASE_URL= COMMHUB_DB= bun test server/src/api-host-supervisors-fallback.test.ts >/tmp/test638-no-db-host.out 2>&1; nodb2=$?
set -e
[[ $nodb1 -ne 0 && $nodb2 -ne 0 ]] || { echo "FAIL: naked suite accepted no DB"; exit 1; }
grep -F 'explicit_test_database_required' /tmp/test638-no-db-upload.out >/dev/null
grep -F 'explicit_test_database_required' /tmp/test638-no-db-host.out >/dev/null

echo "L5: nonzero, timeout, signal, missing summary, and spawn failure cannot greenwash"
printf '%s\n' 'import {test} from "bun:test";' 'test("nonzero",()=>{throw new Error("test638_expected_nonzero")});' > server/src/test638-nonzero.test.ts
set +e
bun run --cwd server test --file=server/src/test638-nonzero.test.ts >/tmp/test638-nonzero.out 2>&1; nonzero_rc=$?
set -e
[[ $nonzero_rc -ne 0 ]] || { echo "FAIL: nonzero child greenwashed"; exit 1; }
grep -F 'FAIL_SUITE server/src/test638-nonzero.test.ts' /tmp/test638-nonzero.out >/dev/null
rm -f -- server/src/test638-nonzero.test.ts

printf '%s\n' 'import {test} from "bun:test";' 'test("timeout",async()=>{await Bun.sleep(30000)});' > server/src/test638-timeout.test.ts
set +e
bun run --cwd server test --file=server/src/test638-timeout.test.ts --timeout-ms=200 >/tmp/test638-timeout.out 2>&1; timeout_rc=$?
set -e
[[ $timeout_rc -ne 0 ]] || { echo "FAIL: timed-out child greenwashed"; exit 1; }
grep -F 'timeout=true' /tmp/test638-timeout.out >/dev/null
rm -f -- server/src/test638-timeout.test.ts

printf '%s\n' 'import {test} from "bun:test";' 'test("signal",async()=>{await Bun.sleep(30000)});' > server/src/test638-signal.test.ts
bun run --cwd server test --file=server/src/test638-signal.test.ts >/tmp/test638-signal.out 2>&1 & signal_pid=$!
for _ in $(seq 1 100); do grep -q '^TEST_DB_MAP' /tmp/test638-signal.out 2>/dev/null && break; sleep 0.02; done
kill -TERM "$signal_pid"
set +e
wait "$signal_pid"; signal_rc=$?
set -e
[[ $signal_rc -eq 143 ]] || { echo "FAIL: signalled runner rc=$signal_rc"; exit 1; }
sleep 0.2
! ps -eo args | grep -F 'bun test server/src/test638-signal.test.ts' | grep -v grep >/dev/null
rm -f -- server/src/test638-signal.test.ts

printf '%s\n' 'process.exit(0);' > server/src/test639-missing-summary.test.ts
set +e
bun run --cwd server test --file=server/src/test639-missing-summary.test.ts >/tmp/test639-missing-summary.out 2>&1; missing_summary_rc=$?
set -e
[[ $missing_summary_rc -ne 0 ]] || { echo "FAIL: missing child summary greenwashed"; exit 1; }
grep -F $'TEST_FILE_RESULT\tserver/src/test639-missing-summary.test.ts\tpass=0\tfail=0\tskip=0' /tmp/test639-missing-summary.out >/dev/null
grep -F 'SERVER_AGGREGATE_RESULT' /tmp/test639-missing-summary.out | grep -F '"bad":true' >/dev/null
rm -f -- server/src/test639-missing-summary.test.ts

mkdir -p /tmp/test639-no-bun
set +e
PATH=/tmp/test639-no-bun /usr/local/bin/bun server/scripts/test-aggregate.ts \
  --file=server/src/db-adapter-guard.test.ts >/tmp/test639-spawn-fail.out 2>&1; spawn_fail_rc=$?
set -e
[[ $spawn_fail_rc -ne 0 ]] || { echo "FAIL: child spawn failure greenwashed"; exit 1; }
grep -F $'TEST_FILE_RESULT\tserver/src/db-adapter-guard.test.ts\tpass=0\tfail=0\tskip=0\texpects=0\texit=null' /tmp/test639-spawn-fail.out >/dev/null
grep -F 'SERVER_AGGREGATE_RESULT' /tmp/test639-spawn-fail.out | grep -F '"bad":true' >/dev/null

echo "L5b: slug collisions fail before --file filtering"
printf '%s\n' 'import {test,expect} from "bun:test";' 'test("flat collision fixture",()=>expect(true).toBe(true));' > server/src/test639-collision.test.ts
mkdir -p server/src/test639
printf '%s\n' 'import {test,expect} from "bun:test";' 'test("nested collision fixture",()=>expect(true).toBe(true));' > server/src/test639/collision.test.ts
set +e
bun run --cwd server test --file=server/src/test639-collision.test.ts >/tmp/test639-slug-collision.out 2>&1; slug_collision_rc=$?
set -e
[[ $slug_collision_rc -ne 0 ]] || { echo "FAIL: colliding test paths shared a slug"; exit 1; }
grep -F 'test slug collision "server-src-test639-collision.test.ts"' /tmp/test639-slug-collision.out >/dev/null
grep -F 'server/src/test639-collision.test.ts' /tmp/test639-slug-collision.out >/dev/null
grep -F 'server/src/test639/collision.test.ts' /tmp/test639-slug-collision.out >/dev/null

cp server/scripts/test-aggregate.ts server/scripts/test-aggregate-mutation.ts
sed -i '/^[[:space:]]*assertUniqueSlugs(files);$/d' server/scripts/test-aggregate-mutation.ts
! grep -F 'assertUniqueSlugs(files);' server/scripts/test-aggregate-mutation.ts >/dev/null
set +e
bun server/scripts/test-aggregate-mutation.ts --file=server/src/test639-collision.test.ts >/tmp/test639-slug-mutation.out 2>&1; slug_mutation_rc=$?
set -e
[[ $slug_mutation_rc -eq 0 ]] || { echo "FAIL: slug-guard mutation did not bypass collision gate"; exit 1; }
grep -F $'TEST_FILE_RESULT\tserver/src/test639-collision.test.ts\tpass=1\tfail=0' /tmp/test639-slug-mutation.out >/dev/null
rm -f -- server/src/test639-collision.test.ts server/src/test639/collision.test.ts server/scripts/test-aggregate-mutation.ts
rmdir server/src/test639

echo "L6: deletion of per-file DB split is witnessed-red"
cp server/scripts/test-aggregate.ts server/scripts/test-aggregate-mutation.ts
sed -i 's/const suiteRoot = join(runRoot, slugFor(file));/const suiteRoot = join(runRoot, "shared");/' server/scripts/test-aggregate-mutation.ts
grep -F 'const suiteRoot = join(runRoot, "shared");' server/scripts/test-aggregate-mutation.ts >/dev/null
rm -rf -- /tmp/test638-mut
ANET_SERVER_TEST_ROOT=/tmp/test638-mut ANET_SERVER_TEST_KEEP_ROOT=1 \
  bun server/scripts/test-aggregate-mutation.ts \
  --file=server/src/uploads-http.test.ts \
  --file=server/src/api-host-supervisors-fallback.test.ts >/tmp/test638-mutation.out 2>&1 || true
mut_maps=$(grep '^TEST_DB_MAP' /tmp/test638-mutation.out | cut -f3 | sort -u | wc -l)
[[ $mut_maps -eq 1 ]] || { echo "FAIL: isolation mutation did not collapse DB paths"; exit 1; }
[[ "$upload_db" != "$host_db" ]] || { echo "FAIL: positive isolation precondition missing"; exit 1; }
rm -f -- server/scripts/test-aggregate-mutation.ts

echo "source_commit=$TEST639_SOURCE_COMMIT"
echo "aggregate_key=$key1"
echo "run1_db_maps=$(grep -c '^TEST_DB_MAP' "$OUT1")"
echo "cross_suite_shapes=upload[$upload_shape],host[$host_shape]"
echo "nonzero_rc=$nonzero_rc timeout_rc=$timeout_rc signal_rc=$signal_rc missing_summary_rc=$missing_summary_rc spawn_fail_rc=$spawn_fail_rc"
echo "slug_collision_rc=$slug_collision_rc slug_guard_mutation_rc=$slug_mutation_rc mutation_unique_db_paths=$mut_maps"
echo "RESULT: PASS"
