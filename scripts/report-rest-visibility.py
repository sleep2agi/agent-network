#!/usr/bin/env python3
"""路线清单的**可见性**读数：这 94 行是下界，不是全集。

## 为什么需要它

`docs/rest-route-table.json` 是按「源码里出现的字面路径」枚举出来的。于是它有一个
**不随路径均匀分布**的盲区：字面量一条条写 ⇒ 看得见；前缀常量 / 循环注册 / 批量注册
⇒ 完全看不见。后者通常数量最多、也最容易出安全问题，而读者会拿「可见 N 条」去做
比例外推 —— 外推的方向正好与缺失方向相反。

所以本脚本报三个数，并且**「下界」两个字与那个数同处一行**：

    enumerated_rows           表里有多少行（下界）
    non_literal_path_judgments 有多少处 pathname 判定拿的不是字面量（看不见的那一类）
    rows_without_owner        有多少行找不到归属的 if 块（分组前必须为 0）

## 为什么需要「归属」字段

判「两处是不是同一个分支」需要控制流信息，而行号不含控制流。只有行号时，
「同在 `if (… && method === "PUT")` 里」与「一个在 if、一个在 else」会被判成同组，
于是分组会稳定地产出错误的合并建议。所以每一处都要带「被哪个 if 包着」。

用法：
  python3 scripts/report-rest-visibility.py            # 报告（人读）
  python3 scripts/report-rest-visibility.py --json      # 报告（机读）
  python3 scripts/report-rest-visibility.py --assert    # 门：看不见的那一类不许增长
退出码：0 = 在基线内；1 = 增长了 / 有行找不到归属；2 = 拿不到输入。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "server" / "src" / "server.ts"
TABLE = REPO / "docs" / "rest-route-table.json"

# 基线：`pathname` 判定里 RHS 不是字面量的处数。增长 ⇒ 清单又多了一个看不见的入口。
NON_LITERAL_BASELINE = 0  # 由 --write-baseline 写入（本文件里的常量就是基线）

PATHNAME_JUDGMENT = re.compile(
    r"url\.pathname\s*(?:===|!==|==|!=|\?|\.startsWith\(|\.match\(|\.endsWith\()"
)
LITERAL_RHS = re.compile(
    r"""url\.pathname\s*(?:===|!==|==|!=)\s*(["\'])"""
)
LITERAL_MATCH = re.compile(r"""url\.pathname\.match\(\s*/|url\.pathname\.match\(\s*["']""")
LITERAL_STARTS = re.compile(r"""url\.pathname\.startsWith\(\s*["'`]""")


ASSIGN_MATCH = re.compile(r"const\s+(\w+)\s*=\s*url\.pathname")


def guarding_if(lines: list[str], target: int) -> int | None:
    r"""**守住**这一处判定的那个 `if` 的行号。

    关键事实（本轮实测出来的，不是我预期的）：清单里的 `line` 是**字面量**所在行，
    而守它的 `if` 可能在下一行、也可能是「一个 if 守多个字面量」。三种写法都真实存在：

        if (url.pathname === "/x" && req.method === "GET") {          ← 同一行
        const m = url.pathname.match(/^\/ws\/…$/);
        if (m) {                                                      ← if 在下一行（顺变量走一步）
        const a = url.pathname.match(/…/);  const b = url.pathname.match(/…/);
        if (a || b) {                                                 ← **一个 if 守两处**
        const cat = url.pathname === "/a" ? "a"
          : url.pathname === "/b" ? "b" : null;
        if (cat && req.method === "GET") {                            ← 三元链：字面量不在 const 那一行

    所以「行号 ⇒ 同一分支」这条推理对后三种都失效 —— 这正是分组前必须先补归属的原因。
    """
    def find_forward(var: str, start: int, span: int = 8) -> int | None:
        pat = re.compile(rf"if\s*\([^)]*\b{re.escape(var)}\b")
        for j in range(start, min(len(lines), start + span)):
            if pat.search(lines[j]):
                return j + 1
        return None

    line = lines[target - 1] if 0 < target <= len(lines) else ""
    if "if (" in line:
        return target

    # ① 这一行自己开了一个 `const x = url.pathname…`
    m = ASSIGN_MATCH.search(line)
    if m:
        hit = find_forward(m.group(1), target)
        if hit:
            return hit

    # ② 这一行是续行（三元链 / 多行 match）：往前找最近的那个 const
    for back in range(1, 6):
        if target - 1 - back < 0:
            break
        m = ASSIGN_MATCH.search(lines[target - 1 - back])
        if m:
            hit = find_forward(m.group(1), target - 1)
            if hit:
                return hit
            break

    return enclosing_if(lines, target)


def enclosing_if(lines: list[str], target: int) -> int | None:
    """target（1-based 行号）被哪一个 `if (` 包着：返回该 if 的行号。

    做法：从头扫一遍维护「未闭合的 if 栈」——遇到含 `if (` 的行且该行含 `{`，
    就把它的行号压栈；每到一个块结束（`}` 让深度归零到那一层的起点）出栈。
    简单但足够：本仓的这些路由都是 `if (cond) {` 形态，没有把 if 写在多行的情况
    （若出现多行 if，owner 会为空 —— **报出来**，而不是猜）。
    """
    stack: list[tuple[int, int]] = []  # (if_line, brace_depth_at_open)
    depth = 0
    for i, line in enumerate(lines, start=1):
        opens = line.count("{")
        closes = line.count("}")
        # 路由行自己就是一个 `if (…pathname…) {` ⇒ 它**包着自己**。
        # 先压栈再比较：否则每一行都只能报「外层的那个 if」，而那个 if 对
        # 「是不是同一个分支」毫无用处（它是请求总入口）。
        if "if (" in line and opens > 0:
            stack.append((i, depth))
        if i == target:
            return stack[-1][0] if stack else None
        depth += opens - closes
        while stack and depth <= stack[-1][1]:
            stack.pop()
    return None


def measure() -> dict:
    table = json.loads(TABLE.read_text())
    return measure_text(SERVER.read_text(), table.get("rows", []))


def measure_text(src: str, rows: list[dict]) -> dict:
    lines = src.splitlines()
    judgments = 0
    literal = 0
    non_literal: list[dict] = []
    for i, line in enumerate(lines, start=1):
        if not PATHNAME_JUDGMENT.search(line):
            continue
        judgments += 1
        if LITERAL_RHS.search(line) or LITERAL_MATCH.search(line) or LITERAL_STARTS.search(line):
            # ⚠ 反引号里带 ${…} 的**不是**字面量：它的路径由变量拼出来，
            # 而枚举器看不见。第一版把它算进字面量，等于把盲区数成了 0。
            backticked = re.search(r"`([^`]*)`", line)
            if backticked and "${" in backticked.group(1):
                non_literal.append({"line": i, "text": line.strip()[:110]})
                continue
            literal += 1
            continue
        non_literal.append({"line": i, "text": line.strip()[:110]})

    owners = {}
    without_owner = []
    for r in rows:
        ln = r.get("line")
        owner = guarding_if(lines, ln) if ln else None
        if owner is None:
            without_owner.append({"path": r.get("path"), "line": ln})
        else:
            owners.setdefault(owner, []).append(r.get("path"))

    shared = {str(k): v for k, v in owners.items() if len(v) > 1}

    return {
        "enumerated_rows": len(rows),
        "owners_shared_by_multiple_rows": shared,
        "visibility": "lower_bound",
        "pathname_judgments": judgments,
        "literal_judgments": literal,
        "non_literal_path_judgments": len(non_literal),
        "non_literal_sample": non_literal[:12],
        "rows_without_owner": len(without_owner),
        "rows_without_owner_sample": without_owner[:8],
        "owners": {str(k): len(v) for k, v in sorted(owners.items())},
        "source": "server/src/server.ts",
        "note": "「下界」与 enumerated_rows 同处一行 —— 写在文末等于没写。",
    }


SELFTEST_CASES = [
    (
        "字面量与 if 同行 ⇒ 归属就是本行",
        'if (url.pathname === "/x" && req.method === "GET") {\n  ok();\n}\n',
        [{"path": "/x", "line": 1}],
        1,
        0,
    ),
    (
        "`const m = …match(…)` 后下一行才 if ⇒ 归属是那个 if（顺变量走一步）",
        'const m = url.pathname.match(/^\\/ws\\/([^/]+)$/);\nif (m) {\n  ok();\n}\n',
        [{"path": "ws", "line": 1}],
        1,
        0,
    ),
    (
        "一个 if 守两个字面量 ⇒ 两行**同一个归属**（按 path 分组会把它们切开）",
        'const a = url.pathname.match(/^\\/a$/);\nconst b = url.pathname.match(/^\\/b$/);\nif (a || b) {\n  ok();\n}\n',
        [{"path": "/a", "line": 1}, {"path": "/b", "line": 2}],
        2,
        0,
    ),
    (
        "三元链：字面量不在 const 那一行 ⇒ 也要找到同一个 if",
        'const cat = url.pathname === "/a" ? "a"\n  : url.pathname === "/b" ? "b" : null;\nif (cat) {\n  ok();\n}\n',
        [{"path": "/a", "line": 1}, {"path": "/b", "line": 2}],
        2,
        0,
    ),
    (
        "反引号带 ${…} ⇒ **不是字面量**（盲区），不能被数成看得见",
        'if (url.pathname.startsWith(`/api/${kind}/x`)) {\n  ok();\n}\n',
        [{"path": "api", "line": 1}],
        1,
        1,
    ),
]


def selftest() -> int:
    bad = 0
    for label, src, rows, want_owner_rows, want_nonliteral in SELFTEST_CASES:
        m = measure_text(src, rows)
        ok = (
            m["rows_without_owner"] == 0
            and m["non_literal_path_judgments"] == want_nonliteral
            and len(rows) == want_owner_rows
        )
        # 同一 if 守多行这一格：两条都归到同一个 if 行
        if ok and len(rows) > 1 and "一个 if" in label:
            owners = list(m["owners_shared_by_multiple_rows"].items())
            ok = len(owners) == 1 and len(owners[0][1]) == len(rows)
        if ok and "三元链" in label:
            ok = len(m["owners_shared_by_multiple_rows"]) == 1
        print(f"{'ok  ' if ok else 'FAIL'}  {label}")
        if not ok:
            bad += 1
            print(f"        got={ {k: m[k] for k in ('rows_without_owner', 'non_literal_path_judgments')} }")
    print(f"\nselftest: {len(SELFTEST_CASES) - bad}/{len(SELFTEST_CASES)}")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--assert", dest="assert_", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if not SERVER.exists() or not TABLE.exists():
        print("exit 2: 读不到 server.ts 或 rest-route-table.json —— 这不是「没有问题」")
        return 2

    m = measure()

    if args.json:
        print(json.dumps(m, ensure_ascii=False, indent=1))
        return 0

    print(f"已枚举 {m['enumerated_rows']} 行（**下界**，不是全集） ← {m['source']} 的字面路径")
    print(f"pathname 判定 {m['pathname_judgments']} 处：字面量 {m['literal_judgments']} / "
          f"**非字面量 {m['non_literal_path_judgments']}**（看不见的那一类）")
    print(f"找不到归属 if 的行：{m['rows_without_owner']} / {m['enumerated_rows']}"
          "（分组前必须为 0 —— 行号不含控制流）")
    if m["non_literal_sample"]:
        print("\n盲区集中在「批量/常量拼」这一类（不会均匀分布在路径上）：")
        for s in m["non_literal_sample"]:
            print(f"  L{s['line']:<6} {s['text']}")
    if m["owners_shared_by_multiple_rows"]:
        print("\n**一个 if 守多行**（这些行是同一分支里的不同入口 —— 按 path 分组会把它们切开）：")
        for ln, paths in sorted(m["owners_shared_by_multiple_rows"].items(), key=lambda kv: int(kv[0])):
            print(f"  if@L{ln:<6} 守 {len(paths)} 行：{', '.join(str(x) for x in paths)}")
    if m["rows_without_owner_sample"]:
        print("\n没有归属的行（无法判断是否同一分支）：")
        for s in m["rows_without_owner_sample"]:
            print(f"  {s['path']}  L{s['line']}")
    print(f"\n基线：非字面量判定 ≤ {NON_LITERAL_BASELINE}")

    if args.assert_:
        if m["non_literal_path_judgments"] > NON_LITERAL_BASELINE:
            print(f"✗ 非字面量 pathname 判定从 {NON_LITERAL_BASELINE} 涨到 "
                  f"{m['non_literal_path_judgments']} —— 清单又多了一个看不见的入口")
            return 1
        if m["rows_without_owner"]:
            print(f"✗ {m['rows_without_owner']} 行找不到归属 if —— 分组会稳定地产出错误的合并建议")
            return 1
        print("✓ 在基线内，且每一行都有归属")
    return 0


if __name__ == "__main__":
    sys.exit(main())
