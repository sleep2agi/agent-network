#!/usr/bin/env bash
set -euo pipefail

# test798 — server 的聚合单测门
#
# server/src 下有 69 个 *.test.ts,而在这之前 CI 只点名跑其中 6 个
# (scripts/qa.sh 的 L0_TESTS 5 个 + test686 引用 1 个),另外 63 个没有任何
# CI job 会碰。server 是 hub 本体 —— 认证、token、网络隔离都在这里。
#
# 形状抄 tests/test745-agent-network-unit-ci。

ROOT=/workspace
SOURCE_COMMIT=${TEST798_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "FAIL: SOURCE_COMMIT must be one full lowercase Git SHA" >&2
  exit 1
}

# 🔴 红线:COMMHUB_DB 不设的话默认指向生产库。容器里够不到宿主的库,
# 但不能靠"够不到"来保证 —— 显式钉到容器内临时路径,并断言它真的被钉住了。
# 31/69 个 server 测试引用了 sqlite/COMMHUB_DB,这条不是形式主义。
export COMMHUB_DB=/tmp/test798-server-unit.db
[[ "$COMMHUB_DB" == /tmp/* ]] || {
  echo "FAIL: COMMHUB_DB must point inside the container tmpdir, got '$COMMHUB_DB'" >&2
  exit 1
}

echo "# test798 — complete server unit domain"
echo "source_commit=$SOURCE_COMMIT"
echo "bun=$(bun --version) node=$(node --version) uid=$(id -u node)"
echo "commhub_db=$COMMHUB_DB"

test_files=$(find "$ROOT/server/src" -type f -name '*.test.ts' | wc -l | tr -d ' ')
echo "test_files=$test_files"
# 🔴 绝对下限,不是 > 0。`executed >= discovered` 只能抓「runner 跳过了文件」,
# 抓不到「文件消失了」—— 分母会跟着现实自动缩水。
# 实测:删掉 69 个里的 59 个(保留 mutation 靶点所在的 auth-validate),
# 这道门报 test_files=10 / executed=10 / failed=0 / MUTATION_RED / RESULT: PASS,
# rc=0 —— 也就是放行了一个删掉 85% server 单测的改动。
#
# 下限要**故意**改:真删了测试就在这里调,并在 PR 里说明为什么。
# 合并 main 时重算:本 PR 写下时 server/src 有 69 个,现在是 72(#798 之后又进了
# rest-write-network-resolution 等)。floor 60 对 72 意味着**可以静默删掉 12 个**——
# 而删测试正是这道门唯一挡得住的事。floor 抬到 70:留 2 个的合并余量,再多就必须
# 在 PR 里显式改这一行。
SERVER_TEST_FLOOR=70
[[ "$test_files" -ge "$SERVER_TEST_FLOOR" ]] || {
  echo "FAIL: only $test_files server test file(s) under src/, floor is $SERVER_TEST_FLOOR" >&2
  echo "      若确实删除/迁移了测试,请连同本 floor 一起改,并在 PR 里说明。" >&2
  exit 1
}

# 逐文件跑,每个文件一个独立 DB —— 这是 server 测试的既有契约:
# scripts/qa.sh 的 L0 就是 `COMMHUB_DB=/tmp/qa-l0-$name.db bun test <one-file>`。
# 用一个共享 DB 聚合跑会红 4 条(admin-networks 的 global-admin 可见性、
# scheduled-tasks 的三条),而这 4 条单跑全绿 —— 是跨文件状态污染,不是产品坏。
# 所以这道门按契约逐文件跑,而不是把"聚合能不能跑"这个它从没承诺过的性质当门。
#
# cwd 必须是仓根:task-lifecycle-watcher 用 process.cwd() 拼 ./server/src/db.js,
# scheduled-tasks-http 按仓根相对路径 import tests/test601-.../race-worker.ts。
echo "[L0] every server/src unit file, one DB each, as non-root (cwd=repo root)"
ran=0; failed=0; failed_names=""
while IFS= read -r f; do
  rel=${f#"$ROOT"/}
  name=$(basename "$f" .test.ts)
  db="/tmp/test798-$name.db"
  rm -f "$db"
  if runuser -u node -- env HOME=/home/node COMMHUB_DB="$db" \
       bash -lc "cd $ROOT && bun test '$rel'" >"/tmp/test798-$name.log" 2>&1; then
    ran=$((ran+1))
  else
    ran=$((ran+1)); failed=$((failed+1)); failed_names="$failed_names $name"
    echo "--- FAILED: $rel ---"
    tail -25 "/tmp/test798-$name.log"
  fi
done < <(find "$ROOT/server/src" -type f -name '*.test.ts' | sort)

echo "executed_files=$ran discovered_files=$test_files failed_files=$failed"

# 分母承重:跑过的文件数必须等于磁盘上的数。少一个都说明 find 的范围塌了,
# 而"跑了 2 个全绿"和"跑了 69 个全绿"打印出来是同一片绿色。
[[ "$ran" -eq "$test_files" ]] || {
  echo "FAIL: executed $ran file(s) but $test_files exist under server/src" >&2
  exit 1
}
[[ "$failed" -eq 0 ]] || {
  echo "FAIL: $failed file(s) failed:$failed_names" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# witnessed-red:证明这道门真的在跑 server 的测试,而不是空转。
# 靶点是注册时的密码下限 —— 把 `< 8` 改成 `< 1`,7 位密码就会被接受。
# 这是一条真的安全回退,不是随手改个字符串。
# ---------------------------------------------------------------------------
echo "[L1] witnessed-red: weaken the registration password floor"
TARGET='if (!password || password.length < 8) return `${label} must be at least 8 characters`;'
MUTATED='if (!password || password.length < 1) return `${label} must be at least 8 characters`;'
SRC="$ROOT/server/src/auth.ts"
before=$(sha256sum "$SRC" | cut -d' ' -f1)
python3 - "$SRC" "$TARGET" "$MUTATED" <<'__MUT__'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
target, replacement = sys.argv[2], sys.argv[3]
if source.count(target) != 1:
    raise SystemExit("mutation target count changed")
path.write_text(source.replace(target, replacement, 1))
__MUT__
after=$(sha256sum "$SRC" | cut -d' ' -f1)
[ "$before" != "$after" ] || { echo "FAIL: mutation was a byte no-op" >&2; exit 1; }

rm -f /tmp/test798-mut.db
set +e
runuser -u node -- env HOME=/home/node COMMHUB_DB=/tmp/test798-mut.db \
  bash -lc "cd $ROOT && bun test server/src/auth-validate.test.ts" \
  >/tmp/test798-mutation.log 2>&1
mutation_rc=$?
set -e
[ "$mutation_rc" -ne 0 ] || {
  cat /tmp/test798-mutation.log
  echo "FAIL: password-floor mutation survived" >&2
  exit 1
}
# 红必须落在指名的那条行为上,而不是红在导入失败之类的别处。
#
# 🔴 必须锚在 (fail) 行上。bun test 对每个用例都打 `(pass) <名字>` 或
# `(fail) <名字>` —— 只 grep 名字的话,那条用例**通过**时也会命中,
# 断言就只证明了「这条用例存在」,而不是「红落在它身上」。
# 这是宽容断言:配上 mutation_rc != 0 看起来很像样,但如果 mutation 实际
# 打红的是别的用例,这一对断言照样全过。
grep -Eq '^\(fail\).*rejects 7-char password' /tmp/test798-mutation.log || {
  cat /tmp/test798-mutation.log
  echo "FAIL: mutation red did not reach the named password-floor assertion" >&2
  exit 1
}

echo "MUTATION_RED registration-password-floor-weakened rc=$mutation_rc"
echo "RESULT: PASS"
