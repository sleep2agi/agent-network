#!/usr/bin/env bash
set -euo pipefail

# 🔴 不要用 `... | sort | head -1`。本文件顶上是 `set -euo pipefail`，而 `head -1`
#    读到第一行就退出、关掉管道，上游 `sort`/`grep` 拿到 SIGPIPE → 退出码 141
#    （128+13），pipefail 把它传出来，`set -e` 直接把脚本打死。
#    这不是假设:2026-08-19 CI 上真的这么红过一次 ——
#      [L5] the four review findings each have an assertion
#      ##[error]Process completed with exit code 141
#    L1–L4 全绿，死在 L5 的第一行，而那一行只是在挑一个夹具文件。
#    🔴 它是**时序相关**的，所以平时看起来一直是绿的；红的时候和真失败长得一样
#    （同一个 job 名、同样没有断言输出），最容易被当成"哪里真的坏了"去查。
first_md_under() {
  local _list
  _list=$(find "$1" -name '*.md' | sort)
  [ -n "$_list" ] || { echo "FAIL: $1 下一个 .md 都没有 —— 夹具取集塌了" >&2; exit 1; }
  printf '%s' "${_list%%$'\n'*}"
}

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
# 这三个数随 #831 的符号锚点改造逐批下降:106/70/141 → 106/53/107 → 106/27/53
# → 106/18/35 → 106/15/35。
# mcp-tools.md 中英两版各 17 处 `[源码 ↗]` 行号链接换成了「文件链接 + grep 提示」。
# 这道断言本来就是设计成"变了要人确认"的:那次变化是逐条核过的(17/17 原本
# 都指错,漂移 35–1194 行),不是扫漏。
#
# 2026-08-18:18 → 15。这次不是符号锚点改造,是 changelog 里三条引用**钉了提交**
# (#851 的 cli.ts#L61 / cli.ts#L2589,#834 的 server/src/index.ts#L253),
# 于是它们从 unique_pins 挪进了 pins_on_immutable_ref。逐条核过:
#
#     immutable: agent-network/bin/cli.ts#L61     -> 2 个文件(中/英 changelog)
#     immutable: agent-network/bin/cli.ts#L2589   -> 2 个文件
#     immutable: server/src/index.ts#L253         -> 2 个文件
#
# 正好 3 条,18 - 3 = 15。`occ` 仍是 35(钉提交不减少"出现次数",只改变引用形式),
# `files` 仍是 106 —— **只有一个数变了,而且变的原因能逐条指出来**。这正是这道
# 断言想逼出来的动作:数字变了要有人说清是进展还是扫漏,而不是把它改宽。
#
# 2026-08-18(第二次):15 → 11,35 → 28。#810 把 docs-site 中英两版 api/rest.md 里
# 4 个唯一 pin 的 `#L` 锚点去掉了(链接保留,只是不再钉行号),逐条数得出来:
#
#     server/src/tools.ts#L521   ×2(中/英)
#     server/src/tools.ts#L571   ×2
#     server/src/tools.ts#L286   ×2
#     server/src/auth.ts#L184    ×1
#     ─────────────────────────────
#     唯一 4 个,出现 7 处
#
# 15 − 4 = 11,35 − 7 = 28,`files` 仍 106。**加回来的锚点数是 0**(diff 的 `+` 侧
# 一个 `#L` 都没有),所以这是净减少,不是"挪了个位置"。
#
# 2026-08-19:106 → 108。新增两个文档文件:
#     docs-site/docs/guide/app-shells.md
#     docs-site/docs/en/guide/app-shells.md
# **只有 `files` 变了**,`uniq` 仍 11、`occ` 仍 28 —— 因为这两页一个 `#L` 都没有
# (它们指向的是另一个仓的目录与命令,不是本仓某个文件的某一行)。
# 这道断言正是这么用的:**加文档要把分母显式抬上来,而不能让它自己长**;
# 三个数里只动了该动的那一个,另外两个不变本身就是证据。
#
# 2026-08-19:108 → 110。新增两个文档文件:
#     docs-site/docs/troubleshooting/is-this-node-alive.md
#     docs-site/docs/en/troubleshooting/is-this-node-alive.md
# 又是**只有 `files` 变了**,`uniq` 仍 11、`occ` 仍 28。CI 上这道门实测报的是
# `FAIL: 预期扫 108 个文档文件(= git ls-files 的结果),实际 110` ——
# 它不是被绕过的,是先红了我才来抬这个数,顺序是对的。
#
# 2026-08-25:110 → 111。新增恢复事务证据文件:
#     docs/tests/report-test1178-codex-upgrade-recovery.txt
# 它没有新增源码行号 pin，所以仍然只有 files 增加，uniq=11、occ=28 不变。
#
# 抬的是**分母**(111 > 110),覆盖面变大不是变小。反过来那种「把数改小让门变绿」
# 的动作要当红线看:分母变小意味着有文件被移出取集,而假绿和真绿的输出逐字相同。
[[ "$files" -eq 111 ]] || fail "预期扫 111 个文档文件(= git ls-files 的结果),实际 $files"
[[ "$uniq"  -eq 11  ]] || fail "预期 11 个唯一 pin,实际 $uniq"
[[ "$occ"   -eq 28 ]] || fail "预期 28 处原始出现,实际 $occ"
echo "  OK  walk 路径与 git 路径给出同一份清单(111 文件 / 11 唯一 pin / 28 处)"

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
VICTIM=$(first_md_under "$ROOT/docs-site")
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
VICTIM2=$(first_md_under "$ROOT/docs-site")
cp "$VICTIM2" /tmp/victim2.bak
restore2() { cp /tmp/victim2.bak "$VICTIM2"; }

# ① 钉了不可变 SHA 的引用不属于这道门 —— 注入一个"在 HEAD 上必然越界"的 SHA pin,
#    门必须**仍然绿**(它管的是会漂的 main 引用,不是历史链接)。
#
# 🔴 断言的是**增量**,不是绝对值。原来这里写死 `pins_on_immutable_ref=1`,
#    那只在「仓里一条钉 SHA 的引用都没有」时成立 —— 写下它的时候确实成立,
#    所以它当时是对的。2026-08-18 之后仓里有 6 条(#851 三条 ×2 语言、#834
#    一条 ×2 语言),注入第 7 条,写死的 1 就红了 —— 而红的原因是**别人按这
#    道门的建议把行号 pin 钉成了提交**,也就是它自己想要的进展。
#
#    一个「只有在某个背景事实恰好为 0 时才成立」的断言,和一个正确的断言,
#    在当时的输出上完全一样。所以先量基线,再断言恰好 +1。
base_imm=$(python3 "$CHECK" "$ROOT" 2>/dev/null | sed -nE 's/^pins_on_immutable_ref=([0-9]+)$/\1/p')
[[ -n "$base_imm" ]] || fail "① 拿不到注入前的 pins_on_immutable_ref 基线"
printf '\n[sha](https://github.com/sleep2agi/agent-network/blob/0123456789abcdef0123456789abcdef01234567/server/src/index.ts#L99999)\n' >> "$VICTIM2"
set +e; out5=$(python3 "$CHECK" "$ROOT" 2>&1); rc5=$?; set -e
restore2
[[ "$rc5" -eq 0 ]] || fail "① 钉 SHA 的引用被当成漂移失效了(rc=$rc5)—— 那会惩罚按本工具建议做出的修改"
after_imm=$(printf '%s' "$out5" | sed -nE 's/^pins_on_immutable_ref=([0-9]+)$/\1/p')
[[ "$after_imm" -eq $((base_imm + 1)) ]] \
  || fail "① 钉 SHA 的引用没有被单独计数:注入前 $base_imm,注入后 $after_imm(应为 $((base_imm + 1)))"
echo "  ① 不可变 ref 被排除且单独计数(${base_imm} → ${after_imm}),门仍绿"

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
SYMCHECK="$ROOT/scripts/check-mcp-tool-anchor-sections.py"
[[ -f "$SYMCHECK" ]] || fail "L6 的脚本不在镜像里:$SYMCHECK"
out9=$(python3 "$SYMCHECK" "$ROOT") || fail "干净树上 L6 就红了:$(printf '%s' "$out9" | tail -4)"
printf '%s\n' "$out9" | sed 's/^/  /'
anch=$(printf '%s' "$out9" | sed -nE 's/^anchors_checked=([0-9]+)$/\1/p')
regs=$(printf '%s' "$out9" | sed -nE 's/^tool_registrations=([0-9]+)$/\1/p')
[[ "${anch:-0}" -gt 0 ]] || fail "L6 一条锚串都没检查到 —— 分母塌了"
[[ "${regs:-0}" -gt 0 ]] || fail "L6 没解析出任何 tool 注册点 —— 分母塌了"

# witnessed-red:把 #845 里真实发生过的那个错重新注入 —— broadcast 段的参数表
# 锚到 "ack_inbox"。必须红,且红在 broadcast 那一行上。
# grep -m1 自己就在第一处匹配后退出，不需要 head 去关管道（见顶部 SIGPIPE 说明）。
BC=$(grep -n -m1 '^#\{2,4\} \?`\?broadcast`\?$' "$ROOT/docs-site/docs/api/mcp-tools.md" | cut -d: -f1)
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

# ---------------------------------------------------------------------------
# L7 — --write-baseline 只许缩小。
#
#      起因:#810 / #834 这类 PR 会让基线里某些条目对应的引用消失,门于是红在
#      「请从基线里删掉」。让人手工数该删哪几条,是把一个机械操作交给记忆力。
#      加了 --write-baseline 之后,那一步变成一条命令。
#
#      但这个开关天然危险:它离「一键把门变绿」只差一个条件判断。所以这一层
#      两个方向都要断言 —— 该删的时候要删得对,不该写的时候要拒绝。
# ---------------------------------------------------------------------------
echo "[L7] --write-baseline shrinks only"
cp "$BASELINE" /tmp/bl7.bak
VICTIM3=$(first_md_under "$ROOT/docs-site")
cp "$VICTIM3" /tmp/v7.bak

# ① 干净树上无事可做
out11=$(python3 "$CHECK" "$ROOT" --write-baseline) || fail "干净树上 --write-baseline 竟然非零"
printf '%s' "$out11" | grep -qF "基线已经是最新的" \
  || fail "干净树上应报「基线已经是最新的」,实际:$(printf '%s' "$out11" | tail -3)"
cmp -s "$BASELINE" /tmp/bl7.bak || fail "① 干净树上它却改写了基线"
echo "  ① 干净树:不改写,报「已是最新」"

# ② 出现新失效时必须拒绝写 —— 这是这个开关最危险的方向
printf '\n[l7](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L99999)\n' >> "$VICTIM3"
set +e; out12=$(python3 "$CHECK" "$ROOT" --write-baseline 2>&1); rc12=$?; set -e
cp /tmp/v7.bak "$VICTIM3"
[[ "$rc12" -ne 0 ]] || fail "② 有新失效 pin 时 --write-baseline 竟然成功了"
printf '%s' "$out12" | grep -qF "拒绝写基线" || fail "② 红了但不是红在「拒绝写基线」上"
cmp -s "$BASELINE" /tmp/bl7.bak || fail "② 它拒绝了,却还是把基线写了"
echo "  MUTATION_RED write-baseline-refuses-new-failure rc=$rc12"

# ③ 引用消失时要删对,并保留表头注释
# 🔴 `grep -c` 在计数为 0 时退出码是 1,而这一段 set -e 是开着的
# ⇒ `VAR=$(grep -c …)` 会**静默**终止整个脚本(没有任何 FAIL 输出)。
# 而计数为 0 恰恰是这道门**清干净了**才会出现的状态 —— 又一次「门赢了自己就坏」。
BL_BEFORE=$(grep -cv '^\s*#\|^\s*$' "$BASELINE" || true)
# 🔴 造场景用的 SHA 必须是**仓里不可能出现的**合成值,不能借用一个真实提交。
#    原来这里用 22ed1886 —— 而 #834 之后 changelog 里**真的**有
#    `blob/22ed1886/server/src/index.ts#L253`,于是下面的复原(全局把
#    22ed1886 换回 main)会把那条真实的、有意为之的提交钉**改回会漂的 main 引用**,
#    留下一个不在基线里的失效 pin,L7 末尾因此永远回不了绿。
#    「合成值恰好不与真实数据相撞」是一个会过期的巧合,不是一条性质。
#    另外把改过的文件名记下来,复原时只碰这些文件。
python3 - "$ROOT" <<'PYX'
import sys, pathlib
root = pathlib.Path(sys.argv[1])
FAKE = "0123456789abcdef0123456789abcdef01234567"   # 合成 SHA,仓里不会有
base = [l.strip() for l in (root/'docs/doc-source-pins-baseline.txt').read_text(encoding='utf-8').splitlines()
        if l.strip() and not l.lstrip().startswith('#')]
target = base[0]
old = f"blob/main/{target}"
new = f"blob/{FAKE}/{target}"
touched, n = [], 0
for f in (root/'docs-site').rglob('*.md'):
    t = f.read_text(encoding='utf-8')
    if old in t:
        n += t.count(old)
        f.write_text(t.replace(old, new), encoding='utf-8')
        touched.append(str(f))
(root/'.l7-touched').write_text("\n".join(touched), encoding='utf-8')
print(f"    (造场景:把 {target} 的 {n} 处引用改钉合成 SHA,涉及 {len(touched)} 个文件)")
PYX
out13=$(python3 "$CHECK" "$ROOT" --write-baseline) || fail "③ 有该删的条目时 --write-baseline 却非零"
printf '%s' "$out13" | grep -qF "已改写基线" || fail "③ 没报告改写"
BL_AFTER=$(grep -cv '^\s*#\|^\s*$' "$BASELINE" || true)
[[ "$BL_AFTER" -lt "$BL_BEFORE" ]] || fail "③ 基线没有变小($BL_BEFORE → $BL_AFTER)"
head -1 "$BASELINE" | grep -q '^#' || fail "③ 改写把表头注释弄丢了"
python3 "$CHECK" "$ROOT" >/dev/null || fail "③ 改写之后门没有转绿"
echo "  ③ 引用消失时删对了($BL_BEFORE → $BL_AFTER),表头保留,门转绿"

# 复原:文档与基线都还原
cd "$ROOT" && git status >/dev/null 2>&1 || true
python3 - "$ROOT" <<'PYX'
import sys, pathlib
root = pathlib.Path(sys.argv[1])
FAKE = "0123456789abcdef0123456789abcdef01234567"
listing = root/'.l7-touched'
files = [pathlib.Path(p) for p in listing.read_text(encoding='utf-8').split("\n") if p.strip()] if listing.exists() else []
for f in files:
    t = f.read_text(encoding='utf-8')
    f.write_text(t.replace(f"blob/{FAKE}/", "blob/main/"), encoding='utf-8')
if listing.exists():
    listing.unlink()
# 断言复原彻底:合成 SHA 在整个 docs-site 里必须一个都不剩。
left = [str(f) for f in (root/'docs-site').rglob('*.md') if FAKE in f.read_text(encoding='utf-8')]
if left:
    raise SystemExit(f"L7 复原不彻底,合成 SHA 仍残留于: {left}")
PYX
cp /tmp/bl7.bak "$BASELINE"
python3 "$CHECK" "$ROOT" >/dev/null || fail "L7 复原之后没有回绿"
echo "  复原后回绿 ✓"

echo "RESULT: PASS"
