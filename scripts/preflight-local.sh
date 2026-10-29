#!/usr/bin/env bash
# preflight-local.sh —— 本地把 CI 的「无依赖门」全跑一遍，合并前自查用。
#
# 🔴 为什么是「从 workflows 取」，不是「手写一份清单」：
#    我（2026-10-29）在本地跑了 mutation-pins / doc-symbol-pins / registration 三门，
#    全绿，然后 PR 上 `lint (home path baseline)` 红了 —— 因为那份清单是**我自己挑的**，
#    挑的依据是「上次哪个红过」。手写清单只会覆盖它写下的那几条，
#    而仓库里的门一直在增加：新加的门不会主动加入任何人的清单。
#
#    所以这里反过来：把 `.github/workflows/*.yml` 里所有**不依赖网络/Docker/npm**的
#    `run:` 命令抓出来跑。门增加时它自动跟上，不需要谁记得回来改这个脚本。
#
# 判据（全部满足才跑）：
#   · 命令以 python3 / bash 开头，且指向 .github/scripts/ 或 scripts/ 下的文件
#   · 不依赖 $GITHUB_OUTPUT 之类的 step 上下文
#   · 不访问网络（--verify-latest-from-npm 之类）
#   · 不需要 Docker / npm ci / bun install
#
# 用法：
#   bash scripts/preflight-local.sh          # 全跑，末尾给汇总
#   bash scripts/preflight-local.sh -q       # 只打失败项
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

QUIET=0
[ "${1:-}" = "-q" ] && QUIET=1

# 从 workflows 现取命令（去重、保序）。过滤规则写在 python 里，注释跟上。
mapfile -t CMDS < <(python3 - <<'PY'
import pathlib, re

SKIP_SUBSTR = [
    "GITHUB_OUTPUT",      # step 上下文
    "--verify-latest-from-npm",  # 访问 npm registry
    "ci-docs-only.py plan",      # 需要 GITHUB_OUTPUT
    ">>",
    "${{",          # matrix/step 占位符，本地无法展开
    "qa.sh",        # L0/L1 要 bun/Docker，属于「跑测试」而不是「跑门」
]
seen = set()
for wf in sorted(pathlib.Path(".github/workflows").glob("*.yml")):
    for line in wf.read_text(encoding="utf-8", errors="replace").split("\n"):
        if "run:" not in line:
            continue
        cmd = line.split("run:", 1)[1].strip().split("||")[0].strip()
        if not cmd.startswith(("python3 ", "bash ")):
            continue
        if not re.search(r"(?:\.github/scripts|scripts)/[\w.\-]+\.(?:py|sh)", cmd):
            continue
        if any(s in cmd for s in SKIP_SUBSTR):
            continue
        if cmd in seen:
            continue
        seen.add(cmd)
        print(cmd)
PY
)

if [ "${#CMDS[@]}" -eq 0 ]; then
  echo "🔴 没从 workflows 取到任何命令 —— 取集坏了，不当作通过" >&2
  exit 2
fi

pass=0
fail=0
skip=0
failed_names=()
skipped_names=()

for cmd in "${CMDS[@]}"; do
  name="$(echo "$cmd" | sed -E 's#^\S+ (\.github/scripts/|scripts/)##; s# # #g')"
  # 每条命令单独限时：某个门自己卡住时，不能让 preflight 变成新的阻塞点。
  out="$(timeout "${PREFLIGHT_TIMEOUT:-180}" bash -lc "$cmd" 2>&1)"
  rc=$?
  if [ $rc -eq 0 ]; then
    pass=$((pass + 1))
    [ $QUIET -eq 0 ] && printf '  ok   %s\n' "$name"
  else
    # 🔴 「本机没装这个工具」不等于「判据红」。把两者分开统计，
    #    否则第一次用这个脚本的人会看到一堆红，然后学会忽略它。
    if printf '%s' "$out" | grep -qE 'bun not installed|bun: command not found|tsc: not found|tsc not found|docker: command not found|command not found: bun|this gate measures, it does not install'; then
      skip=$((skip + 1))
      skipped_names+=("$name")
      printf '  SKIP %s  (本机缺工具链)\n' "$name"
      continue
    fi
    fail=$((fail + 1))
    failed_names+=("$name")
    if [ $rc -eq 124 ]; then
      printf '  TIMEOUT %s  (>%ss)\n' "$name" "${PREFLIGHT_TIMEOUT:-180}"
    else
      printf '  FAIL %s  (rc=%s)\n' "$name" "$rc"
    fi
    printf '%s\n' "$out" | tail -6 | sed 's/^/         /'
  fi
done

echo
echo "preflight: ${pass} passed · ${fail} failed · ${skip} skipped(缺工具链) · ${#CMDS[@]} 条命令（取自 workflows）"
if [ "$skip" -gt 0 ]; then
  echo "跳过（本机没装对应工具，CI 里会跑）："
  printf '  - %s\n' "${skipped_names[@]}"
fi
if [ "$fail" -gt 0 ]; then
  echo "失败项："
  printf '  - %s\n' "${failed_names[@]}"
  exit 1
fi
