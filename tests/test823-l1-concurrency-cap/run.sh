#!/usr/bin/env bash
# test823 — scripts/qa.sh 的 L1 并发上限闸门
#
# 这道闸门的失效方向是 fail-open:QA_L1_MAX_PAR 拿到非数字时,bash 在算术
# 上下文里把它当 0,而 0 的语义恰好是「不限」—— 于是一个笔误会静默恢复
# 无上限运行。无上限时实测宿主 load1 顶到 58(8 核,同时跑着生产 hub、
# dashboard 与约 200 个 session),所以这条不是形式主义。
#
# 🔴 本套件跑的是**真的 scripts/qa.sh**,不是逻辑副本。
#    做法:把 `docker` 换成 PATH 上的桩。qa.sh 的 dockerrun() 是
#    `bash -c "$*"`,所以它会解析到桩;真实的闸门代码原样执行。
#    在副本上测只能证明副本自洽 —— 那正是本仓反复栽过的坑。
#
# 峰值用**事件流**算,不用采样:每次桩调用写下精确的 START / END 纳秒
# 时间戳,事后排序求最大重叠。采样会漏掉峰值,事件流不会。
set -uo pipefail

ROOT=/workspace
SRC=${TEST823_SOURCE_COMMIT:-}
[[ "$SRC" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: TEST823_SOURCE_COMMIT 必须是一个完整的小写 SHA(收到 '${SRC}')" >&2; exit 1; }

# 🔴 光验格式不够 —— 任何 40 位十六进制都能通过,而报告里那个 SHA 可能
#    根本不含镜像里被测的文件。这正是 #801 上那条 P1 说的病,我建这个
#    套件时原样犯了一遍。
#    做法:构建时把 run.sh 在该 commit 下的 git blob 哈希作为 build-arg
#    传进来,这里就地重算镜像内文件的 blob 哈希并比对。git blob 哈希 =
#    sha1("blob <len>\0" + 内容),不需要容器里装 git。
EXPECT=${TEST823_RUNSH_BLOB:-}
[[ "$EXPECT" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: TEST823_RUNSH_BLOB 缺失或格式不对 —— 无法把 SOURCE_COMMIT 绑到被测字节" >&2; exit 1; }
self=/workspace/run.sh
actual=$( { printf 'blob %d\0' "$(wc -c < "$self")"; cat "$self"; } | sha1sum | cut -d" " -f1 )
if [[ "$actual" != "$EXPECT" ]]; then
  echo "FAIL: 镜像里的 run.sh 与 SOURCE_COMMIT=$SRC 声称的不是同一份" >&2
  echo "      期望 blob $EXPECT,实际 $actual" >&2
  exit 1
fi

BIN=/tmp/t823-bin
EV=/tmp/t823-events
mkdir -p "$BIN"

# ── docker 桩 ────────────────────────────────────────────────────────────
# build 是同步的,run 是后台的 —— 只有 run 会重叠。两者都记事件,
# 这样如果哪天 build 也被后台化,峰值会立刻反映出来。
cat > "$BIN/docker" <<'STUB'
#!/usr/bin/env bash
# build 是同步的、run 是后台的 —— 只有 run 会重叠。若两者同样耗时,
# run 之间几乎不重叠,峰值恒为 1,高上限下断言就失去分辨力(第一版如此)。
# 所以 build 尽量快,run 拉长,让并发真正显现出来。
# 只有真正的 `docker run` 才记事件。任何其它子命令(build/ps/rmi…)
# 都不该计入并发峰值 —— 否则峰值会被无关调用抬高,断言就不再是在测闸门。
[ "${1:-}" = "run" ] || exit 0
printf 'S %s %s\n' "$(date +%s%N)" "$$" >> "$T823_EV"
sleep 1.2
printf 'E %s %s\n' "$(date +%s%N)" "$$" >> "$T823_EV"
exit 0
STUB
chmod +x "$BIN/docker"

# npm 也要桩:qa.sh 会跑 `npm view … dist-tags.preview` 做 registry 快照。
# 容器是 --network none,真 npm 会一直等 DNS/连接超时,而不是快速失败 ——
# 第一版就是这么跑成超时的。桩掉它,让被测的闸门成为唯一的耗时来源。
cat > "$BIN/npm" <<'NPMSTUB'
#!/usr/bin/env bash
echo "0.0.0-stub"
exit 0
NPMSTUB
chmod +x "$BIN/npm"

export PATH="$BIN:$PATH"
export T823_EV="$EV"

peak() {                      # 从事件流算最大重叠
  sort -k2,2n "$1" | awk '
    $1=="S" { c++; if (c>m) m=c }
    $1=="E" { c-- }
    END     { print m+0 }'
}

nproc_val=$(nproc 2>/dev/null || echo 4)
fails=0
report=/tmp/report-test823.txt
: > "$report"

say() { echo "$*" | tee -a "$report"; }

say "# test823 — L1 concurrency cap gate"
say "source_commit=$SRC"
say "nproc=$nproc_val"
say ""

run_case() {                  # $1=用例名 $2=QA_L1_MAX_PAR 取值(空=不设)
  local name=$1 val=${2-}
  : > "$EV"
  local out=/tmp/t823-$name.log
  if [[ -n "${val:-}" || "${2+set}" == "set" ]]; then
    QA_L1_MAX_PAR="$val" bash "$ROOT/scripts/qa.sh" --l1 > "$out" 2>&1 || true
  else
    bash "$ROOT/scripts/qa.sh" --l1 > "$out" 2>&1 || true
  fi
  local p; p=$(peak "$EV")
  # 只取 `= ` 之后那个数。原来用 grep -oE '[0-9]+' 会先命中 "L1" 里的 1 ——
  # 判据没在已知输入上校准过,于是四个用例全部报 1。
  local eff; eff=$(sed -n 's/.*L1 并发上限 = \([0-9][0-9]*\).*/\1/p' "$out" | head -1)
  [[ -n "$eff" ]] || eff="?"
  local warned=0; grep -q '不是非负整数' "$out" && warned=1
  echo "$p|$eff|$warned"
}

check() {                     # $1=用例 $2=实测 $3=期望 $4=说明
  if [[ "$2" == "$3" ]]; then say "  ok   $1: $4 (= $2)"
  else say "  FAIL $1: $4 —— 期望 $3,实测 $2"; fails=$((fails+1)); fi
}

say "## 用例"

IFS='|' read -r p eff warned <<< "$(run_case cap2 2)"
say "- cap=2      峰值=$p 生效值=$eff 告警=$warned"
check cap2 "$eff" 2 "生效上限"
[[ "$p" -le 2 && "$p" -ge 1 ]] && say "  ok   cap2: 峰值 $p ≤ 2" || { say "  FAIL cap2: 峰值 $p 超过上限 2"; fails=$((fails+1)); }

IFS='|' read -r p eff warned <<< "$(run_case bad two)"
say "- 非法值 two  峰值=$p 生效值=$eff 告警=$warned"
check bad_warn "$warned" 1 "必须告警"
check bad_eff  "$eff" "$nproc_val" "退回默认(不是静默不限)"

IFS='|' read -r p eff warned <<< "$(run_case octal 08)"
say "- 前导零 08   峰值=$p 生效值=$eff 告警=$warned"
check octal_eff "$eff" 8 "按十进制解释,不是八进制报错/不限"

IFS='|' read -r p eff warned <<< "$(run_case zero 0)"
say "- 0(不限)   峰值=$p 生效值=$eff 告警=$warned"
check zero_eff "$eff" 0 "0 保留为「不限」的逃生口"
# 只断言"生效值是 0"不够 —— 那只证明它被这么解析,没证明它真的放开了并发。
# 拿 cap=2 的峰值当对照:不限时必须明显更高。
if [[ "$p" -gt 2 ]]; then say "  ok   zero_conc: 不限时峰值 $p > cap2 的 2,确实放开了并发"
else say "  FAIL zero_conc: 不限时峰值只有 $p,与 cap=2 无区别 —— 「不限」没有被验证"; fails=$((fails+1)); fi

say ""
say "failures=$fails"
if [[ "$fails" -eq 0 ]]; then say "RESULT: PASS"; else say "RESULT: FAIL"; fi
cat "$report"
[[ "$fails" -eq 0 ]]
