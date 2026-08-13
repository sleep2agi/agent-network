#!/usr/bin/env bash
set -euo pipefail

# test831 —— 文档站源码行号 pin 的下限门(见 #831)
#
# 🔴 这道门证明的是「已知失效的那批不会变多」,不是「文档站的行号引用是对的」。
#    判据的召回率实测 5/10,边界写在 scripts/check-doc-source-pins.py 头部。
#    别在别处引用这道门的绿色去论证「#831 已解决」。

ROOT=/repo
CHECK="$ROOT/scripts/check-doc-source-pins.py"
BASELINE="$ROOT/docs/doc-source-pins-baseline.txt"

SOURCE_COMMIT=${TEST831_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "FAIL: SOURCE_COMMIT must be one full lowercase Git SHA" >&2; exit 1; }

# 与 test798 / test812 同:验 SHA 的格式不够,任何 40 位十六进制都能过。
# 把 run.sh 在该 commit 下的 git blob 哈希传进来就地重算比对。
RUNSH_BLOB=${TEST831_RUNSH_BLOB:-}
[[ "$RUNSH_BLOB" =~ ^[0-9a-f]{40}$ ]] || {
  echo "FAIL: TEST831_RUNSH_BLOB 缺失或格式不对 —— 无法把 SOURCE_COMMIT 绑到被测字节" >&2; exit 1; }
_self="$ROOT/tests/test831-doc-source-pins/run.sh"
_actual=$( { printf 'blob %d\0' "$(wc -c < "$_self")"; cat "$_self"; } | sha1sum | cut -d' ' -f1 )
[[ "$_actual" == "$RUNSH_BLOB" ]] || {
  echo "FAIL: 镜像里的 run.sh 与 SOURCE_COMMIT=$SOURCE_COMMIT 声称的不是同一份" >&2
  echo "      期望 blob $RUNSH_BLOB,实际 $_actual" >&2; exit 1; }

echo "# test831 — doc source-pin floor gate"
echo "source_commit=$SOURCE_COMMIT"
echo "runsh_blob=$_actual"
echo "python=$(python3 -V 2>&1)"

fail() { echo "FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# L0 — 分母。镜像里没有 .git,checker 走的是目录遍历那条路径。
#      这里把它实际扫到的数字打出来并与预期比对 —— 否则「扫到 0 个文件」和
#      「0 个坏 pin」打印出来是同一片绿。
# ---------------------------------------------------------------------------
echo "[L0] denominator"
out=$(python3 "$CHECK" "$ROOT")
printf '%s\n' "$out" | sed 's/^/  /'

mode=$(printf '%s' "$out" | sed -nE 's/^listing_mode=(.*)$/\1/p')
files=$(printf '%s' "$out" | sed -nE 's/^scanned_doc_files=([0-9]+)$/\1/p')
uniq=$(printf '%s' "$out" | sed -nE 's/^unique_pins=([0-9]+)$/\1/p')
occ=$(printf '%s' "$out" | sed -nE 's/^pin_occurrences=([0-9]+)$/\1/p')
broken=$(printf '%s' "$out" | sed -nE 's/^broken_pins=([0-9]+)$/\1/p')

[[ "$mode" == "walk" ]] || fail "镜像里应当走目录遍历,实际 listing_mode=$mode"
[[ "${files:-0}" -gt 0 ]]  || fail "扫到 0 个文档文件 —— 分母塌了"
[[ "${uniq:-0}" -gt 0 ]]   || fail "扫到 0 个 pin —— 分母塌了"

# 容器内遍历得到的数字必须与仓库里 git ls-files 得到的一致,否则容器内外
# 扫的范围分叉,「容器里绿」就推不出「仓库里绿」。这两个数是写死的预期值,
# 变了要人来确认是真变了还是扫漏了。
# 这三个数在 #831 的符号锚点改造里从 106/70/141 变成了 106/53/107 ——
# mcp-tools.md 中英两版各 17 处 `[源码 ↗]` 行号链接换成了「文件链接 + grep 提示」。
# 这道断言本来就是设计成"变了要人确认"的:那次变化是逐条核过的(17/17 原本
# 都指错,漂移 35–1194 行),不是扫漏。
[[ "$files" -eq 106 ]] || fail "预期扫 106 个文档文件(= git ls-files 的结果),实际 $files"
[[ "$uniq"  -eq 53  ]] || fail "预期 53 个唯一 pin,实际 $uniq"
[[ "$occ"   -eq 107 ]] || fail "预期 107 处原始出现,实际 $occ"
echo "  OK  walk 路径与 git 路径给出同一份清单(106 文件 / 53 唯一 pin / 107 处)"

# ---------------------------------------------------------------------------
# L1 — 干净树上必须绿
# ---------------------------------------------------------------------------
echo "[L1] clean tree passes"
python3 "$CHECK" "$ROOT" >/dev/null || fail "干净树上这道门就红了"
echo "  OK rc=0  broken_pins=$broken(全部在基线里)"

# ---------------------------------------------------------------------------
# L2 — witnessed-red ①:新增一个坏 pin,必须红,且红在「新的失效 pin」上
# ---------------------------------------------------------------------------
echo "[L2] witnessed-red: a NEW broken pin must turn it red"
VICTIM=$(find "$ROOT/docs-site" -name '*.md' | sort | head -1)
[[ -n "$VICTIM" ]] || fail "找不到可用于变异的文档"
cp "$VICTIM" /tmp/victim.bak
before=$(sha256sum "$VICTIM" | cut -d' ' -f1)
# 指向一个必然越界的行号 —— server/src/index.ts 在 main 上只有十几行。
printf '\n[bogus](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L99999)\n' >> "$VICTIM"
after=$(sha256sum "$VICTIM" | cut -d' ' -f1)
[[ "$before" != "$after" ]] || fail "变异是字节 no-op"

set +e
mut=$(python3 "$CHECK" "$ROOT" 2>&1); rc=$?
set -e
cp /tmp/victim.bak "$VICTIM"
[[ "$rc" -ne 0 ]] || fail "新增坏 pin 之后这道门仍然绿"
printf '%s' "$mut" | grep -qF "个新的失效 pin" \
  || fail "红了,但不是红在「新的失效 pin」上:$(printf '%s' "$mut" | head -3)"
printf '%s' "$mut" | grep -qF "line-out-of-range" \
  || fail "红了,但没有把类别判成 line-out-of-range"
echo "  MUTATION_RED new-out-of-range-pin rc=$rc"

# 复原后必须回绿 —— 不然上面那个红可能是变异之外的东西造成的
python3 "$CHECK" "$ROOT" >/dev/null || fail "复原之后没有回绿,说明 L2 的红不止来自变异"
echo "  复原后回绿 ✓"

# ---------------------------------------------------------------------------
# L3 — witnessed-red ②:基线里塞一条并不失效的条目,必须红。
#      这一条守的是「基线只许缩小」:没有它,基线会慢慢变成坟场。
# ---------------------------------------------------------------------------
echo "[L3] witnessed-red: a baseline entry that is no longer broken must turn it red"
cp "$BASELINE" /tmp/baseline.bak
printf 'server/src/auth.ts#L1\n' >> "$BASELINE"
set +e
mut2=$(python3 "$CHECK" "$ROOT" 2>&1); rc2=$?
set -e
cp /tmp/baseline.bak "$BASELINE"
[[ "$rc2" -ne 0 ]] || fail "基线里混进一条不失效的条目,门却是绿的"
printf '%s' "$mut2" | grep -qF "已经不再失效" \
  || fail "红了,但不是红在「基线条目已不再失效」上"
echo "  MUTATION_RED stale-baseline-entry rc=$rc2"

python3 "$CHECK" "$ROOT" >/dev/null || fail "复原基线后没有回绿"
echo "  复原后回绿 ✓"

# ---------------------------------------------------------------------------
# L4 — 判据的边界要能被别人看见,而不是只写在源码注释里。
#      #831 里已人工确认失效、但这套机械判据抓不到的那几条,必须仍然判不出来。
#      这条断言存在的意义是:哪天有人"改进"了判据,这里会红,提醒他去更新
#      文档里那个 5/10 的召回率数字,而不是让边界悄悄漂移。
# ---------------------------------------------------------------------------
echo "[L4] the known blind spots are still blind (so the documented recall stays honest)"
blind_ok=0
for pin in "server/src/tools.ts#L286" "server/src/tools.ts#L646" "server/src/tools.ts#L911"; do
  path=${pin%%#*}; line=${pin##*#L}
  if grep -qxF "$pin" "$BASELINE"; then
    fail "$pin 出现在基线里 —— 它本应是判据抓不到的那一类,边界变了"
  fi
  [[ -f "$ROOT/$path" ]] || fail "$path 不在镜像里"
  blind_ok=$((blind_ok+1))
done
echo "  OK  $blind_ok 条已知盲区仍未被判据覆盖(与文档里 5/10 的召回率一致)"

echo "RESULT: PASS"
