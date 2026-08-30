#!/usr/bin/env python3
"""`agent-node` 的类型错误只许减少,不许增加。

## 背景

`agent-node` 至今**没有 tsconfig、没有 typecheck 脚本、CI 里 0 处引用**(#1536) ——
也就是说它从来没有被类型检查过。它是被 bun/esbuild 直接执行的,类型注解在运行时
被剥掉,所以**类型错误不会让任何东西变红**,只会在运行时以别的形状出现。

已经吃掉的一个真实实例:`src/cli.ts` 里 `grokVersion: version,` 连同注释被逐字写了
两遍(TS1117)。那次两边赋的是同一个值,所以没造成故障 —— **但没有任何东西告诉过作者**。

## 判据

    src/**/*.ts 的 tsc 错误条数 <= BASELINE

`strict: true`,与两个兄弟包(`agent-network/tsconfig.json`、`server/tsconfig.json`)一致。

## 🔴 这道门最关键的一条:测不出来必须判红,不能判绿

一个只会数 `error TS` 行数的门有一个致命形状:**tsc 根本没跑起来时,行数也是 0**,
而 0 恰好等于"完美"。作者本人在 2026-08-30 建这道门时就先撞了一次 ——
`npx --yes typescript@5 tsc` 报 `could not determine executable to run`(正确写法要
`-p typescript@5.9.3`),而 `grep -c 'error TS'` 照样打印 `0`。

所以本门**不看行数就下结论**,而是先验证这次测量本身是否成立:

    rc == 0  且 count == 0   → 真·零错误
    rc in (1,2) 且 count > 0 → 真·有错误,拿去和基线比
    其它任何组合             → **测量失败,判红**(不是判绿)

## 这道门不管什么

不要求归零,不改任何行为,不阻止你写出有类型错误的代码 ——
**它只保证今天的数字是上限,不是起点。**

    python3 .github/scripts/check-agent-node-typecheck-ratchet.py --selftest
    python3 .github/scripts/check-agent-node-typecheck-ratchet.py
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

BASELINE = 82   # 2026-08-30, origin/main, strict:true, src/**/*.ts (排除 *.test.ts);
                # 环境须与 CI 一致:agent-node 下 npm install --no-save typescript@5.9.3 @types/node@20
TS_VERSION = "5.9.3"
TYPES_NODE_VERSION = "20"
ERROR_RE = re.compile(r"error TS\d+")

# 🔴 配置层错误:tsc 在**看任何一行源码之前**就退出。它们的表现是「错误数很少」,
#    而少恰好像好。作者建这道门时就撞了一次:漏了 @types/node ⇒ 只报 TS2688 一条
#    ⇒ 1 <= 93 ⇒ 门判绿,而**一个源文件都没被检查过**。
CONFIG_ERROR_RE = re.compile(r"error TS(2688|5023|5024|5025|5042|5053|5057|6053|6059|18002|18003)\b")

# 这道门至少必须真的检查到这么多个 agent-node/src 下的文件。
# 2026-08-30 实测 origin/main: 45 个(src/**/*.ts 排除 *.test.ts)。取一个有余量的下限。
FILES_FLOOR = 25

ROOT = Path(__file__).resolve().parents[2]
TSCONFIG = ROOT / "agent-node" / "tsconfig.json"


def count_errors(output: str) -> int:
    """一行可能含多个 `error TSxxxx`? 实测 tsc 一行一条,但按出现次数数更稳。"""
    return len(ERROR_RE.findall(output))


def classify(rc: int, count: int, output: str = "", files_checked: int | None = None) -> tuple[bool, str]:
    """返回 (测量是否成立, 说明)。见模块 docstring 的表。"""
    m = CONFIG_ERROR_RE.search(output)
    if m:
        return False, (f"tsc reported a CONFIG-level error ({m.group(0)}) — it exited before "
                       f"examining any source file. A config abort yields a small error count, "
                       f"and small looks good. Refusing to grade this run.")
    if files_checked is not None and files_checked < FILES_FLOOR:
        return False, (f"tsc only examined {files_checked} agent-node/src file(s), below the floor "
                       f"of {FILES_FLOOR} — the check did not cover the package, so its error "
                       f"count means nothing.")
    if rc == 0 and count == 0:
        return True, "tsc exited 0 with no errors"
    if rc in (1, 2) and count > 0:
        return True, f"tsc exited {rc} with {count} error(s)"
    return False, (f"tsc rc={rc} but parsed {count} error(s) — these disagree, so the "
                   f"measurement did not happen (a tsc that never ran also yields 0 errors)")


def selftest() -> int:
    fails = 0

    def check(label, got, want):
        nonlocal fails
        if got != want:
            print(f"  ✗ {label}: got {got!r}, want {want!r}")
            fails += 1
        else:
            print(f"  ✓ {label}")

    print("selftest — 判据层(数错误 + 判定测量是否成立)")
    check("counts one error", count_errors("src/cli.ts(1,1): error TS1117: dup"), 1)
    check("counts three", count_errors("error TS1\nerror TS2\nerror TS3"), 3)
    check("ignores prose", count_errors("no problems found"), 0)
    check("does not match bare 'error'", count_errors("error: something broke"), 0)

    # 🔴 这四条是这道门存在的理由:一个没跑起来的 tsc 必须判成"测量失败",不是"零错误"
    check("clean run is a valid measurement", classify(0, 0)[0], True)
    check("errors run is a valid measurement", classify(2, 93)[0], True)
    check("rc=127 (command not found) is NOT valid", classify(127, 0)[0], False)
    check("rc=0 but errors parsed is NOT valid", classify(0, 5)[0], False)
    check("rc=1 with zero parsed is NOT valid", classify(1, 0)[0], False)
    # 🔴 这两条正是作者亲手踩过的那个洞
    check("config-level TS2688 is NOT a valid measurement",
          classify(2, 1, "error TS2688: Cannot find type definition file for 'node'.")[0], False)
    check("too few files examined is NOT valid",
          classify(2, 93, "", files_checked=3)[0], False)
    check("enough files examined is valid",
          classify(2, 93, "", files_checked=45)[0], True)

    print("selftest — 取集层(扫的是哪些文件)")
    import json
    cfg = json.loads(TSCONFIG.read_text(encoding="utf-8"))
    check("tsconfig includes src/**/*.ts", cfg.get("include"), ["src/**/*.ts"])
    check("tsconfig excludes tests", cfg.get("exclude"), ["**/*.test.ts"])
    check("strict is on (matches sibling packages)",
          cfg.get("compilerOptions", {}).get("strict"), True)
    check("noEmit is on (a gate must not write build output)",
          cfg.get("compilerOptions", {}).get("noEmit"), True)

    print(f"\nselftest: {'PASS' if fails == 0 else f'FAIL ({fails})'}")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()

    if not TSCONFIG.exists():
        print(f"::error::{TSCONFIG} is missing — agent-node must carry a tsconfig for this gate to mean anything.")
        return 1

    # tsc 必须能在 agent-node/node_modules/@types 下找到 node 的类型 ——
    # `npx -p @types/node` **不行**:它把包放进 npx 的临时目录,而 tsc 找的是
    # 工程目录下的 node_modules/@types。所以这里要求先装好,装的动作交给调用方
    # (CI workflow 或开发者),这道门只负责测量,并在装漏时**明确判红**。
    local_tsc = ROOT / "agent-node" / "node_modules" / ".bin" / "tsc"
    if not local_tsc.exists():
        print(f"::error::{local_tsc} not found — this gate measures, it does not install. Run first:")
        print(f"::error::  (cd agent-node && npm install --no-save typescript@{TS_VERSION} @types/node@{TYPES_NODE_VERSION})")
        print("::error::Failing closed: without types, tsc aborts on TS2688 and reports ~1 error, "
              "which would look like a near-perfect result.")
        return 1
    cmd = [str(local_tsc), "-p", str(TSCONFIG), "--listFiles"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except FileNotFoundError:
        print("::error::npx not found — cannot run tsc, so this gate cannot report anything. "
              "Failing closed rather than printing a misleading 0.")
        return 1
    except subprocess.TimeoutExpired:
        print("::error::tsc timed out after 900s — measurement did not complete.")
        return 1

    output = (proc.stdout or "") + (proc.stderr or "")
    count = count_errors(output)
    src = str((ROOT / "agent-node" / "src").resolve())
    files_checked = sum(1 for ln in output.splitlines()
                        if ln.strip().startswith(src) and ln.strip().endswith(".ts"))
    ok, why = classify(proc.returncode, count, output, files_checked)

    if not ok:
        print(f"::error::{why}")
        print("--- first 20 lines of tsc output ---")
        for line in output.splitlines()[:20]:
            print(f"  {line}")
        return 1

    print(f"agent-node typecheck: {count} error(s) (baseline {BASELINE}) — {why}")
    if count > BASELINE:
        print(f"::error::agent-node type errors rose to {count}, above the baseline of {BASELINE}. "
              f"This gate does not require zero — it requires that the number not grow. "
              f"Fix the new error(s), or if you genuinely lowered the count, update BASELINE in "
              f"{Path(__file__).name} to the new value.")
        for line in output.splitlines():
            if ERROR_RE.search(line):
                print(f"  {line}")
        return 1

    if count < BASELINE:
        print(f"::notice::type errors dropped to {count} (baseline {BASELINE}). "
              f"Please lower BASELINE to {count} so the ratchet keeps its grip.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
