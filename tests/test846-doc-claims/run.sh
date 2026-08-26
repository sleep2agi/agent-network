#!/usr/bin/env bash
set -euo pipefail

# test846 —— 文档行号断言门(见 #846)
#
# 🔴 绿只说明 docs/stale-issue-review.md 引的源码断言仍可唯一定位。
#    正文的结论对不对,这道门不检查 —— 别拿它的绿去论证那份文档的判定是对的。

ROOT=/repo
CHECK="$ROOT/scripts/check-doc-claims.py"
DOC="$ROOT/docs/stale-issue-review.md"

SOURCE_COMMIT=${TEST846_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "FAIL: SOURCE_COMMIT must be one full lowercase Git SHA" >&2; exit 1; }
RUNSH_BLOB=${TEST846_RUNSH_BLOB:-}
[[ "$RUNSH_BLOB" =~ ^[0-9a-f]{40}$ ]] || {
  echo "FAIL: TEST846_RUNSH_BLOB 缺失或格式不对 —— 无法把 SOURCE_COMMIT 绑到被测字节" >&2; exit 1; }
_self="$ROOT/tests/test846-doc-claims/run.sh"
_actual=$( { printf 'blob %d\0' "$(wc -c < "$_self")"; cat "$_self"; } | sha1sum | cut -d' ' -f1 )
[[ "$_actual" == "$RUNSH_BLOB" ]] || {
  echo "FAIL: 镜像里的 run.sh 与 SOURCE_COMMIT 声称的不是同一份" >&2
  echo "      期望 blob $RUNSH_BLOB,实际 $_actual" >&2; exit 1; }

echo "# test846 — doc claim freshness"
echo "source_commit=$SOURCE_COMMIT"
echo "runsh_blob=$_actual"
echo "python=$(python3 -V 2>&1)"
fail() { echo "FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# L0 — 分母。抽不到断言就红:0 条全过和压根没抽到,打印出来是同一片绿。
# ---------------------------------------------------------------------------
echo "[L0] denominator"
out=$(python3 "$CHECK" "$ROOT") || fail "干净树上这道门就红了:$(printf '%s' "$out" | tail -4)"
printf '%s\n' "$out" | sed 's/^/  /'
n=$(printf '%s' "$out" | sed -nE 's/^claims_checked=([0-9]+)$/\1/p')
[[ "${n:-0}" -ge 8 ]] || fail "只抽到 ${n:-0} 条断言,少于预期的 8 条 —— 清单被删了还是块标记坏了"
echo "  OK claims_checked=$n"

# ---------------------------------------------------------------------------
# L1 — witnessed-red ①:破坏清单里的唯一源码子串,必须红在 not-found 上
# ---------------------------------------------------------------------------
echo "[L1] witnessed-red: a missing source substring must turn it red"
cp "$DOC" /tmp/doc.bak
python3 - "$DOC" <<'PYX'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
t = p.read_text(encoding="utf-8")
old = "server/src/db.ts :: `ALTER TABLE nodes ADD COLUMN team TEXT`,"
assert t.count(old) == 1, "清单里的锚点不唯一,变异会不准"
p.write_text(t.replace(old, "server/src/db.ts :: `ALTER TABLE nodes ADD COLUMN missing_team TEXT`,"), encoding="utf-8")
PYX
set +e; mut=$(python3 "$CHECK" "$ROOT" 2>&1); rc=$?; set -e
cp /tmp/doc.bak "$DOC"
[[ "$rc" -ne 0 ]] || fail "源码子串改错之后这道门仍然绿"
printf '%s' "$mut" | grep -q '\[not-found\]' || fail "红了但类别不是 not-found:$(printf '%s' "$mut" | head -3)"
echo "  MUTATION_RED not-found rc=$rc"
python3 "$CHECK" "$ROOT" >/dev/null || fail "复原之后没有回绿"
echo "  复原后回绿 ✓"

# ---------------------------------------------------------------------------
# L2 — witnessed-red ②:清单被清空必须红(分母承重),而不是「0 条全过」
# ---------------------------------------------------------------------------
echo "[L2] witnessed-red: an empty manifest must turn it red, not pass vacuously"
python3 - "$DOC" <<'PYX'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1])
t = p.read_text(encoding="utf-8")
t2 = re.sub(r"^```doc-claims\s*$.*?^```\s*$", "```doc-claims\n```", t, count=1, flags=re.M | re.S)
assert t2 != t
p.write_text(t2, encoding="utf-8")
PYX
set +e; mut2=$(python3 "$CHECK" "$ROOT" 2>&1); rc2=$?; set -e
cp /tmp/doc.bak "$DOC"
[[ "$rc2" -ne 0 ]] || fail "清单清空后这道门竟然绿了 —— 分母没承重"
printf '%s' "$mut2" | grep -q '没有 ```doc-claims 块,或块是空的' \
  || fail "红了但不是红在空清单上:$(printf '%s' "$mut2" | head -3)"
echo "  MUTATION_RED empty-manifest rc=$rc2"
python3 "$CHECK" "$ROOT" >/dev/null || fail "复原之后没有回绿"
echo "  复原后回绿 ✓"

# ---------------------------------------------------------------------------
# L3 — 路径穿越:清单里写仓外路径必须红,而不是去读那个文件
# ---------------------------------------------------------------------------
echo "[L3] a manifest entry pointing outside the repo must be rejected"
python3 - "$DOC" <<'PYX'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
t = p.read_text(encoding="utf-8")
old = "server/src/db.ts :: `ALTER TABLE nodes ADD COLUMN team TEXT`,"
p.write_text(t.replace(old, old + "\n../../etc/passwd :: 1 :: root"), encoding="utf-8")
PYX
set +e; mut3=$(python3 "$CHECK" "$ROOT" 2>&1); rc3=$?; set -e
cp /tmp/doc.bak "$DOC"
[[ "$rc3" -ne 0 ]] || fail "清单里的仓外路径没被拒"
printf '%s' "$mut3" | grep -q 'path-escapes-repo' || fail "红了但类别不是 path-escapes-repo"
echo "  MUTATION_RED path-escapes-repo rc=$rc3"
python3 "$CHECK" "$ROOT" >/dev/null || fail "复原之后没有回绿"
echo "  复原后回绿 ✓"

echo "RESULT: PASS"
