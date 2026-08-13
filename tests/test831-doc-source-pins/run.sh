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
# 这三个数随 #831 的符号锚点改造逐批下降:106/70/141 → 106/53/107 → 106/27/53。
# mcp-tools.md 中英两版各 17 处 `[源码 ↗]` 行号链接换成了「文件链接 + grep 提示」。
# 这道断言本来就是设计成"变了要人确认"的:那次变化是逐条核过的(17/17 原本
# 都指错,漂移 35–1194 行),不是扫漏。
[[ "$files" -eq 106 ]] || fail "预期扫 106 个文档文件(= git ls-files 的结果),实际 $files"
[[ "$uniq"  -eq 27  ]] || fail "预期 27 个唯一 pin,实际 $uniq"
[[ "$occ"   -eq 53 ]] || fail "预期 53 处原始出现,实际 $occ"
echo "  OK  walk 路径与 git 路径给出同一份清单(106 文件 / 27 唯一 pin / 53 处)"

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
echo "[L3] witnessed-red: a baseline entry whose link no longer exists must turn it red"
cp "$BASELINE" /tmp/baseline.bak
printf 'server/src/auth.ts#L1\n' >> "$BASELINE"
set +e
mut2=$(python3 "$CHECK" "$ROOT" 2>&1); rc2=$?
set -e
cp /tmp/baseline.bak "$BASELINE"
[[ "$rc2" -ne 0 ]] || fail "基线里混进一条不失效的条目,门却是绿的"
# 注意文案:#843 的审查之后,判据改成「引用还在不在文档里」,不再是
# 「判据还标不标它」。塞进去的 auth.ts#L1 任何文档都没引用,所以走这条。
printf '%s' "$mut2" | grep -qF "对应的引用已经不在文档里了" \
  || fail "红了,但不是红在「基线条目对应的引用已不在文档里」上:$(printf '%s' "$mut2" | head -3)"
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

# ---------------------------------------------------------------------------
# L5 — #843 审查提的四条,各自一个断言。修了判据却没有断言,等于没修。
#      每条都用"注入 → 期望的红/绿 → 复原 → 回绿"的形状。
# ---------------------------------------------------------------------------
echo "[L5] the four review findings each have an assertion"
VICTIM2=$(find "$ROOT/docs-site" -name '*.md' | sort | head -1)
cp "$VICTIM2" /tmp/victim2.bak
restore2() { cp /tmp/victim2.bak "$VICTIM2"; }

# ① 钉了不可变 SHA 的引用不属于这道门 —— 注入一个"在 HEAD 上必然越界"的 SHA pin,
#    门必须**仍然绿**(它管的是会漂的 main 引用,不是历史链接)。
printf '\n[sha](https://github.com/sleep2agi/agent-network/blob/0123456789abcdef0123456789abcdef01234567/server/src/index.ts#L99999)\n' >> "$VICTIM2"
set +e; out5=$(python3 "$CHECK" "$ROOT" 2>&1); rc5=$?; set -e
restore2
[[ "$rc5" -eq 0 ]] || fail "① 钉 SHA 的引用被当成漂移失效了(rc=$rc5)—— 那会惩罚按本工具建议做出的修改"
printf '%s' "$out5" | grep -q "pins_on_immutable_ref=1" \
  || fail "① 钉 SHA 的引用没有被单独计数:$(printf '%s' "$out5" | grep pins_on_immutable || true)"
echo "  ① 不可变 ref 被排除且单独计数(pins_on_immutable_ref=1),门仍绿"

# ② #L0 必须判成越界。第一版只挡上界,content[-1] 会读到最后一行。
printf '\n[zero](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts#L0)\n' >> "$VICTIM2"
set +e; out6=$(python3 "$CHECK" "$ROOT" 2>&1); rc6=$?; set -e
restore2
[[ "$rc6" -ne 0 ]] || fail "② #L0 没被判成失效 —— 行号是 1-based,0 会读到最后一行"
printf '%s' "$out6" | grep -q "line-out-of-range" || fail "② #L0 红了但类别不是 line-out-of-range"
echo "  ② #L0 判为 line-out-of-range rc=$rc6"

# ④ 路径穿越:仓库外的文件不能被当成健康锚点。
printf '\n[esc](https://github.com/sleep2agi/agent-network/blob/main/../../etc/passwd#L1)\n' >> "$VICTIM2"
set +e; out7=$(python3 "$CHECK" "$ROOT" 2>&1); rc7=$?; set -e
restore2
[[ "$rc7" -ne 0 ]] || fail "④ ../../etc/passwd 被判成健康锚点了"
printf '%s' "$out7" | grep -q "path-escapes-repo" || fail "④ 红了但类别不是 path-escapes-repo"
echo "  ④ 仓库外路径判为 path-escapes-repo rc=$rc7"

# ③ 基线语义:条目只在"文档里那个引用没了"时才该删。
#    造法:把一条基线条目对应的引用留在文档里,但让判据标不出它 ——
#    直接往基线里塞一条指向非平凡行、且文档里确实引用着的 pin。
#    期望:不红(它没消失),但要出现 drifted 警告。
DRIFT_PIN=$(python3 - "$ROOT" <<'PYX'
import re,sys,pathlib
root=pathlib.Path(sys.argv[1])
PIN=re.compile(r"blob/main/([^\s)#\"']+)#L(\d+)")
base={l.strip() for l in (root/'docs/doc-source-pins-baseline.txt').read_text(encoding='utf-8').splitlines()
      if l.strip() and not l.lstrip().startswith('#')}
for f in (root/'docs-site').rglob('*.md'):
    for m in PIN.finditer(f.read_text(encoding='utf-8')):
        k=f"{m.group(1)}#L{m.group(2)}"
        if k not in base:
            print(k); sys.exit(0)
PYX
)
[[ -n "$DRIFT_PIN" ]] || fail "③ 找不到一个「文档引用着但不在基线里」的 pin 来造场景"
cp "$BASELINE" /tmp/baseline2.bak
printf '%s\n' "$DRIFT_PIN" >> "$BASELINE"
set +e; out8=$(python3 "$CHECK" "$ROOT" 2>&1); rc8=$?; set -e
cp /tmp/baseline2.bak "$BASELINE"
[[ "$rc8" -eq 0 ]] || fail "③ 引用仍在文档里、只是判据标不出来,不该红(rc=$rc8):$(printf '%s' "$out8" | head -3)"
printf '%s' "$out8" | grep -qF "仍被文档引用" \
  || fail "③ 没有给出 drifted 警告 —— 这条会被悄悄当成'修好了'"
echo "  ③ 引用仍在文档里时不判为可删,并给出 drifted 警告(pin=$DRIFT_PIN)"

python3 "$CHECK" "$ROOT" >/dev/null || fail "L5 复原之后没有回绿"
echo "  复原后回绿 ✓"

# ---------------------------------------------------------------------------
# L6 — 符号锚点是否落在它声称的那个 tool 段。
#
#      #831 把行号锚点换成了「文件链接 + 可 grep 的串」,解决了行号会漂,却引入
#      一个更隐蔽的失效:**锚串确实存在,只是落在别的 tool 段**。「锚串存在」
#      这个检查放行不了它。#845 里连着出了两例,都不是靠工具发现的:
#        reassign_task 段 → 锚到 send_message / cancel_task 里的串
#        broadcast    段 → 锚到 "ack_inbox"
#      第一例我自己抓到就改了、没做全量审计,于是第二例由审查者发现。
#      这一层就是那次审计固化下来的 —— 一次性脚本抓到的错,下次还会漏。
# ---------------------------------------------------------------------------
echo "[L6] symbol anchors land in the tool section they claim"
SYMCHECK="$ROOT/scripts/check-doc-symbol-anchors.py"
[[ -f "$SYMCHECK" ]] || fail "L6 的脚本不在镜像里:$SYMCHECK"
out9=$(python3 "$SYMCHECK" "$ROOT") || fail "干净树上 L6 就红了:$(printf '%s' "$out9" | tail -4)"
printf '%s\n' "$out9" | sed 's/^/  /'
anch=$(printf '%s' "$out9" | sed -nE 's/^anchors_checked=([0-9]+)$/\1/p')
regs=$(printf '%s' "$out9" | sed -nE 's/^tool_registrations=([0-9]+)$/\1/p')
[[ "${anch:-0}" -gt 0 ]] || fail "L6 一条锚串都没检查到 —— 分母塌了"
[[ "${regs:-0}" -gt 0 ]] || fail "L6 没解析出任何 tool 注册点 —— 分母塌了"

# witnessed-red:把 #845 里真实发生过的那个错重新注入 —— broadcast 段的参数表
# 锚到 "ack_inbox"。必须红,且红在 broadcast 那一行上。
BC=$(grep -n '^#\{2,4\} \?`\?broadcast`\?$' "$ROOT/docs-site/docs/api/mcp-tools.md" | head -1 | cut -d: -f1)
[[ -n "$BC" ]] || fail "找不到 broadcast 章节,无法造 L6 的变异"
cp "$ROOT/docs-site/docs/api/mcp-tools.md" /tmp/mcp.bak
python3 - "$ROOT/docs-site/docs/api/mcp-tools.md" "$BC" <<'PYX'
import sys, pathlib
path, start = pathlib.Path(sys.argv[1]), int(sys.argv[2])
lines = path.read_text(encoding="utf-8").split("\n")
# 在 broadcast 章节里插一条锚到 ack_inbox 的引用 —— 这正是 #845 的原错
lines.insert(start, '参数（verify [`tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 搜 `"ack_inbox"`）：')
path.write_text("\n".join(lines), encoding="utf-8")
PYX
set +e; out10=$(python3 "$SYMCHECK" "$ROOT" 2>&1); rc10=$?; set -e
cp /tmp/mcp.bak "$ROOT/docs-site/docs/api/mcp-tools.md"
[[ "$rc10" -ne 0 ]] || fail "把 broadcast 的锚串写成 \"ack_inbox\" 之后 L6 仍然绿"
printf '%s' "$out10" | grep -qF "MISMATCH" || fail "L6 红了但没打出 MISMATCH"
printf '%s' "$out10" | grep -q "broadcast" || fail "L6 红了但没指出是 broadcast 那条"
echo "  MUTATION_RED broadcast-anchored-to-ack-inbox rc=$rc10"

python3 "$SYMCHECK" "$ROOT" >/dev/null || fail "L6 复原之后没有回绿"
echo "  复原后回绿 ✓  (anchors_checked=$anch, tool_registrations=$regs)"

echo "RESULT: PASS"
