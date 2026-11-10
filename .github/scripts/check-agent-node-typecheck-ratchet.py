#!/usr/bin/env python3
"""`agent-node` 的类型错误只许减少,不许增加。

## 背景

`agent-node` 至今**没有 tsconfig、没有 typecheck 脚本、CI 里 0 处引用**(#1536) ——
也就是说它从来没有被类型检查过。它是被 bun/esbuild 直接执行的,类型注解在运行时
被剥掉,所以**类型错误不会让任何东西变红**,只会在运行时以别的形状出现。

已经吃掉的一个真实实例:`src/cli.ts` 里 `grokVersion: version,` 连同注释被逐字写了
两遍(TS1117)。那次两边赋的是同一个值,所以没造成故障 —— **但没有任何东西告诉过作者**。

## 判据

    src/**/*.ts 的 tsc 错误**集合** == agent-node/typecheck-baseline.txt

## 2026-10-31 —— 为什么从「计数」换成「集合」

这道门原来是 `错误条数 <= 81`。它今天连着红了 100 次（8b1d71c5 之后 3 条新错误，
84 > 81）—— 而 84 与 81 的差别在日志里是一行数字，**看不出是哪三条**，
于是没人修，红了 100 次就等于不存在。

更糟的是这个形状本身：**修好 3 条 + 新增 3 条 ⇒ 81 ⇒ 绿**。
与 test-inventory 那次「删两条加两条 ⇒ 31 => 31 ⇒ 看起来没变」是同一条：
**计数相同 ≠ 覆盖相同。** 所以基线必须存**身份**（file + TS 码 + 消息），
而不是一个整数。

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
BASELINE_FILE = ROOT / "agent-node" / "typecheck-baseline.txt"


def count_errors(output: str) -> int:
    """一行可能含多个 `error TSxxxx`? 实测 tsc 一行一条,但按出现次数数更稳。"""
    return len(ERROR_RE.findall(output))


ERR_LINE_RE = re.compile(r"^(\S.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$")


def fingerprint(line: str, root: Path) -> str | None:
    """从一行 tsc 输出取**身份**：`相对路径|TS码|消息`（丢掉行列号）。

    丢行列号是为了让「文件里别处加了几行」不触发重写基线；
    保留消息是为了分清同一文件同一码的多个错误（child-env.ts 有 4 条 TS2365）。
    """
    m = ERR_LINE_RE.match(line.strip())
    if not m:
        return None
    path, _ln, _col, code, msg = m.groups()
    try:
        rel = str(Path(path).resolve().relative_to(root))
    except ValueError:
        rel = path
    return f"{rel}|{code}|{re.sub(r'\\s+', ' ', msg).strip()}"


def fingerprints(output: str, root: Path) -> list[str]:
    out = []
    for line in output.splitlines():
        fp = fingerprint(line, root)
        if fp:
            out.append(fp)
    return out


def load_baseline(path: Path) -> dict[str, int] | None:
    """基线是 `身份<TAB>条数`。

    🔴 为什么还要条数：81 行错误只collapse成 40 个身份（同一文件同一码同一消息会有多份，
       例如 `Cannot find name 'Bun'.` 在同一个文件里出现 3 次）。只存身份的话，
       「同一条错误又复制了一份」是看不见的 —— 那正是把尺子换粗一档。
    """
    if not path.exists():
        return None
    out: dict[str, int] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        ln = raw.strip()
        if not ln or ln.startswith("#"):
            continue
        if "\t" not in ln:
            raise ValueError(f"基线行缺少条数（应为 `身份<TAB>n`）：{ln!r}")
        ident, n = ln.rsplit("\t", 1)
        out[ident] = int(n)
    return out


def count_by_identity(items: list[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for it in items:
        out[it] = out.get(it, 0) + 1
    return out


def diff_sets(now: dict[str, int], base: dict[str, int]) -> dict[str, list[str]]:
    """四个方向分开报，因为处置不同：

    added   身份从无到有        ⇒ **红**（这才是「新增了一个错误」）
    grew    同一身份条数变多    ⇒ **红**（同一条错误又被复制了一份，身份集合看不出来）
    removed 身份消失            ⇒ 提示（基线比现实宽）
    shrank  同一身份条数变少    ⇒ 提示
    """
    added = sorted(k for k in now if k not in base)
    grew = sorted(f"{k}\t{base[k]}→{now[k]}" for k in now if k in base and now[k] > base[k])
    removed = sorted(k for k in base if k not in now)
    shrank = sorted(f"{k}\t{base[k]}→{now[k]}" for k in now if k in base and now[k] < base[k])
    return {"added": added, "grew": grew, "removed": removed, "shrank": shrank}


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

    print("selftest — 集合层(身份而不是计数)")
    root = Path("/repo")
    base_lines = [
        "/repo/agent-node/src/a.ts(10,5): error TS1234: Type 'x' is not assignable.",
        "/repo/agent-node/src/a.ts(99,1): error TS1234: Type 'x' is not assignable.",
    ]
    base_fps = [f for f in (fingerprint(ln, root) for ln in base_lines) if f]
    check("同一行号不同位置 ⇒ 同一身份", len(set(base_fps)), 1)
    base = count_by_identity(base_fps)
    d = diff_sets(count_by_identity(base_fps + [f for f in [fingerprint(
        "/repo/agent-node/src/b.ts(1,1): error TS9999: boom", root)] if f]), base)
    check("新增一条被点出来", len(d["added"]), 1)
    check("新增时无 removed", len(d["removed"]), 0)
    d2 = diff_sets({}, base)
    check("修好后 added 为空", len(d2["added"]), 0)
    check("修好后 removed 被点出来（基线比现实宽）", len(d2["removed"]), 1)
    # 🔴 计数版藏得住的那一格：删一条 + 加一条，条数不变
    swapped = count_by_identity(base_fps[:1] + [f for f in [fingerprint(
        "/repo/agent-node/src/c.ts(3,3): error TS0001: new", root)] if f])
    check("条数相同但身份不同 ⇒ 仍然点出新增", len(diff_sets(swapped, base)["added"]), 1)
    # 🔴 只存身份会藏住的那一格：同一条错误又复制了一份
    dup = count_by_identity(base_fps + [f for f in [fingerprint(
        "/repo/agent-node/src/a.ts(200,1): error TS1234: Type 'x' is not assignable.", root)] if f])
    dd = diff_sets(dup, base)
    check("同一身份多一份 ⇒ added 为空但 grew 有值", (len(dd["added"]), len(dd["grew"])), (0, 1))

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

    now = fingerprints(output, ROOT)
    if len(now) != count:
        print(f"::error::parsed {count} error line(s) but extracted {len(now)} fingerprint(s) — "
              f"the set view disagrees with the count, so neither is readable.")
        return 1

    if "--update" in sys.argv:
        fresh = count_by_identity(now)
        old = load_baseline(BASELINE_FILE) or {}
        d = diff_sets(fresh, old)
        added, removed = d["added"], d["removed"]
        BASELINE_FILE.write_text(
            "# agent-node 的类型错误**身份**基线：`文件|TS码|消息<TAB>条数`（丢行列号）。\n"
            "# 由 `python3 .github/scripts/check-agent-node-typecheck-ratchet.py --update` 重写。\n"
            "# 规则：新增身份 / 同一身份变多 ⇒ 红；消失 / 变少 ⇒ 提示，跑 --update 收缩。\n"
            "# 为什么存条数：81 行错误只 collapse 成 40 个身份 —— 只存身份就看不见「又复制了一份」。\n"
            + "".join(f"{k}\t{v}\n" for k, v in sorted(fresh.items())), encoding="utf-8")
        print(f"基线已重写：{len(fresh)} 个身份 / {sum(fresh.values())} 行 ｜ "
              f"+{len(added)} / -{len(removed)}")
        for a in added:
            print(f"  + {a}")
        for r in removed:
            print(f"  - {r}")
        return 0

    base = load_baseline(BASELINE_FILE)
    if base is None:
        print(f"::error::{BASELINE_FILE} 不存在 —— 没有基线就没有判据（不等于零错误）。")
        print("::error::首次建立：python3 .github/scripts/check-agent-node-typecheck-ratchet.py --update")
        return 1

    d = diff_sets(count_by_identity(now), base)
    print(f"agent-node typecheck: {count} 行 / {len(set(now))} 个身份 ｜ 基线 {len(base)} 身份 / "
          f"{sum(base.values())} 行 ｜ 新增 {len(d['added'])} ｜ 变多 {len(d['grew'])} ｜ "
          f"消失 {len(d['removed'])} ｜ 变少 {len(d['shrank'])} — {why}")

    if d["added"] or d["grew"]:
        if d["added"]:
            print(f"::error::{len(d['added'])} 个**新的**类型错误身份"
                  f"（不是「条数涨了」——是这几条从没被接受过）：")
            for a in d["added"]:
                print(f"::error::  + {a}")
        if d["grew"]:
            print(f"::error::{len(d['grew'])} 个已接受的错误**又复制了一份**"
                  f"（身份集合看不出来，所以基线存了条数）：")
            for g in d["grew"]:
                print(f"::error::  × {g}")
        print("::error::修掉它们；若确实是设计决定，必须同时改基线并说明为什么接受。")
        return 1

    if d["removed"] or d["shrank"]:
        print(f"::notice::{len(d['removed'])} 个身份 + {len(d['shrank'])} 处条数已经不存在/变少。"
              f"跑 --update 收缩基线，否则基线比现实宽（宽出来的位置可以让将来的一条新增错误不被点名）。")
        for r in d["removed"]:
            print(f"::notice::  - {r}")
        for r in d["shrank"]:
            print(f"::notice::  - {r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
