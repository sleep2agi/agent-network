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


def guard_condition(lines: list[str], target: int) -> str:
    """守这一行的 if 的**条件原文**（只归一化空白）。

    🔴 不抹变量名。第一版把 `*Match` 统一替换成 `M`，于是
       `netEventsMatch && method=GET` 与 `eventsMatch && method=GET` 变成了同一个字符串，
       报告会给出「同谓词 ⇒ 可抽象」的建议 —— 而它们匹配的是**两个不同的正则**。
       归一化抹掉的恰好是判别位，而判别位正是「能不能合并」的唯一依据。
    """
    g = guarding_if(lines, target)
    if g is None:
        return "<unknown>"
    line = lines[g - 1]
    m = re.search(r"if\s*\((.*)\)\s*\{", line)
    return re.sub(r"\s+", " ", (m.group(1) if m else line)).strip()


def group_report(lines: list[str], rows: list[dict]) -> dict:
    """按 path 分组，数**谓词种类**而不是出现次数。

    两种语义在这里必须分开（它们的处置相反）：

        同一判断被复制 N 次  ⇒ 可以抽象成一个谓词
        同一 path 有 N 个入口 ⇒ **可能必须分开保留**

    只看计数会把两者混成同一个数。区分它们不需要新读数：数谓词种类即可。
    注意 `api × 37` 这种：37 处并列第一，但谓词有 32 种 —— 它不是一个 37 次的复制，
    而是**提取器把正则路由的前缀压成了 `api`** ⇒ 分组粒度由提取器决定，不由逻辑决定。
    """
    by_path: dict[str, list[dict]] = {}
    for r in rows:
        by_path.setdefault(r.get("path") or "", []).append(r)

    groups = []
    for path, items in by_path.items():
        if len(items) < 2:
            continue
        kinds: dict[str, list[int]] = {}
        for r in items:
            kinds.setdefault(guard_condition(lines, r["line"]), []).append(r["line"])
        groups.append({
            "path": path,
            "rows": len(items),
            "predicate_kinds": len(kinds),
            "mergeable": len(kinds) == 1 and "<unknown>" not in kinds,
            "kinds": {k: v for k, v in sorted(kinds.items())},
        })
    groups.sort(key=lambda g: -g["rows"])
    return {
        "multi_path_groups": len(groups),
        "rows_in_groups": sum(g["rows"] for g in groups),
        "mergeable_groups": sum(1 for g in groups if g["mergeable"]),
        "groups": groups,
    }


# 分支覆盖读数的基线：**在测试里一次都没出现过路径字面量**的行数。
# 它只会随补测试而下降；上涨意味着新加了没人请求过的分支。
NEVER_REQUESTED_BASELINE = 5


def branch_coverage(rows: list[dict], lines: list[str]) -> dict:
    """每个分支**有没有被任何请求走过** —— 用测试里出现的路径字面量当代理。

    这条读数的意义：表可以「分支都记下来了」，而其中只有一个被走过。
    在 completeness 上这两件事同形，所以必须分开报。

    已知偏差（写在输出里，不写在文档里）：
      · 代理是「测试文件里出现过这个路径字面量」，不是「真的发过请求」⇒ **上界**。
      · 正则路由在表里被压成前缀（`api` / `events` / `ws`）⇒ 按路径查不到，
        这 40 行**判不了**，不是「没被走过」。判不了与没走过处置不同：
        前者要改提取器（用正则字面量而不是前缀），后者要补测试。
    """
    tests = [p.read_text() for p in sorted((REPO / "server" / "src").glob("*.test.ts"))]
    blob = "\n".join(tests)
    judgeable, covered, never, unjudgeable = [], [], [], []
    for r in rows:
        path = r.get("path") or ""
        if path in ("api", "events", "ws") or not path.startswith("/"):
            unjudgeable.append(r)
            continue
        judgeable.append(r)
        if f'"{path}"' in blob or f"'{path}'" in blob:
            covered.append(r)
        else:
            never.append(r)
    return {
        "rows": len(rows),
        "judgeable": len(judgeable),
        "covered": len(covered),
        "never_requested": len(never),
        "unjudgeable": len(unjudgeable),
        "never_sample": [{"line": r.get("line"), "path": r.get("path"), "method": r.get("method")}
                         for r in never[:8]],
    }


# 「门」的 token 表 —— 它自己也是一个**识别器**，而识别器必须被写出来：
# 换一份 token 表，下面的数会变，而分母不动。所以输出里必须带 R 的定义。
GATE_TOKENS = {
    "userTokenRequired": r"userTokenRequired\(",
    "restAuth-bang": r"if \(!restAuth\)",
    "canRestWriteNetwork": r"canRestWriteNetwork\(",
    "canRestWriteNodeSecurity": r"canRestWriteNodeSecurity\(",
    "isAdmin": r"\bisAdmin\b",
    "role-owner-admin": r'role !== "owner"|role === "owner"',
    "canManage": r"\bcanManage\b",
}


def gate_tokens_by_row(lines: list[str], rows: list[dict]) -> dict:
    """每一行的**门 token**（来自它自己的 if 块，窗口 25 行）+ 读不到门的行数。

    判据边界同 guarding_if：门要记在**判定发生的那一行**，不能记在包的 if 上。
    读不到门 ≠ 没有门 —— 它可能是：门在 helper 里、用了别的写法、
    或 token 表里没有这个名字。三种成因处置不同，所以这里只报「读不到」的个数。
    """
    import re as _re
    compiled = {n: _re.compile(rx) for n, rx in GATE_TOKENS.items()}
    out: dict[int, list[str]] = {}
    none_rows = []
    for r in rows:
        ln = r.get("line")
        g = guarding_if(lines, ln) if ln else None
        block = lines[max(0, (g or ln or 1) - 1): (g or ln or 1) + 25]
        toks = sorted({n for n, rx in compiled.items() if any(rx.search(l) for l in block)})
        if not toks:
            none_rows.append({"line": ln, "path": r.get("path")})
        out[ln] = toks
    return {"by_row": out, "no_gate_tokens": none_rows,
            "recognizer": "GATE_TOKENS（7 个名字）—— 换表则数会变，分母不动"}


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


GROUP_SELFTEST_CASES = [
    (
        "同一 if 守两个字面量 ⇒ 1 组、1 种谓词、可抽象",
        'const a = url.pathname.match(/^\\/a$/);\nconst b = url.pathname.match(/^\\/b$/);\n'
        'if (a || b) {\n  ok();\n}\n',
        [{"path": "p", "line": 1}, {"path": "p", "line": 2}],
        1,
        True,
    ),
    (
        "同一 path 两个入口（GET / PUT）⇒ 2 种谓词、**不可合并**",
        'if (url.pathname === "/x" && req.method === "GET") {\n  ok();\n}\n'
        'if (url.pathname === "/x" && req.method === "PUT") {\n  ok();\n}\n',
        [{"path": "/x", "line": 1}, {"path": "/x", "line": 4}],
        2,
        False,
    ),
    (
        "🔴 两个不同的 match 变量 + 同一 method ⇒ 谓词**不同**（抹变量名会误判成可合并）",
        'const netEventsMatch = url.pathname.match(/^\\/net\\/events$/);\n'
        'if (netEventsMatch && req.method === "GET") {\n  ok();\n}\n'
        'const eventsMatch = url.pathname.match(/^\\/events$/);\n'
        'if (eventsMatch && req.method === "GET") {\n  ok();\n}\n',
        [{"path": "events", "line": 1}, {"path": "events", "line": 5}],
        2,
        False,
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
    for label, src, rows, want_kinds, want_mergeable in GROUP_SELFTEST_CASES:
        g = group_report(src.splitlines(), rows)
        grp = g["groups"][0] if g["groups"] else None
        ok = (grp is not None and grp["predicate_kinds"] == want_kinds
              and grp["mergeable"] == want_mergeable)
        print(f"{'ok  ' if ok else 'FAIL'}  {label}")
        if not ok:
            bad += 1
            print(f"        got kinds={grp and grp['predicate_kinds']} mergeable={grp and grp['mergeable']}"
                  f" want {want_kinds}/{want_mergeable}")
    # 分支覆盖：前缀路由必须落进 unjudgeable，而不是被悄悄算成「没走过」。
    bc = branch_coverage(
        [{"path": "api", "line": 1}, {"path": "/api/x", "line": 2}],
        [],
    )
    ok = bc["unjudgeable"] == 1 and bc["judgeable"] == 1
    print(f"{'ok  ' if ok else 'FAIL'}  前缀路由判不了（不等于「没走过」）")
    if not ok:
        bad += 1
        print(f"        got unjudgeable={bc['unjudgeable']} judgeable={bc['judgeable']}")
    total = len(SELFTEST_CASES) + len(GROUP_SELFTEST_CASES) + 1
    print(f"\nselftest: {total - bad}/{total}")
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
    g = group_report([SERVER.read_text().splitlines()][0], json.loads(TABLE.read_text()).get("rows", []))
    print(f"\n同一 path 出现多次：{g['multi_path_groups']} 组 / {g['rows_in_groups']} 处；"
          f"其中**谓词只有一种**（可抽象）的 {g['mergeable_groups']} 组")
    for grp in g["groups"][:10]:
        tag = "同谓词复制" if grp["mergeable"] else f"{grp['predicate_kinds']} 种谓词（不同入口）"
        print(f"  {grp['path'] or '(空)'[:28]:28s} × {grp['rows']:2d}  {tag}")
    print("  ⇒ 计数说的是「触及同一前缀几次」，谓词种类说的是「几次里有多少个其实是同一个」。")

    if m["rows_without_owner_sample"]:
        print("\n没有归属的行（无法判断是否同一分支）：")
        for s in m["rows_without_owner_sample"]:
            print(f"  {s['path']}  L{s['line']}")
    print(f"\n基线：非字面量判定 ≤ {NON_LITERAL_BASELINE}")

    bc = branch_coverage(json.loads(TABLE.read_text()).get("rows", []), SERVER.read_text().splitlines())
    print(f"\n分支覆盖（代理：测试里出现过路径字面量，**上界**）：")
    print(f"  可判 {bc['judgeable']} / {bc['rows']} 行：被请求过 {bc['covered']}、**从未出现 {bc['never_requested']}**")
    print(f"  判不了 {bc['unjudgeable']} 行 —— 正则路由被提取器压成了前缀，按路径查不到")
    print("  ⇒ 判不了 ≠ 没走过：前者要改提取器（用正则字面量），后者要补测试。")
    for x in bc["never_sample"]:
        print(f"     [从未] L{x['line']} {x['method']} {x['path']}")

    g = gate_tokens_by_row(SERVER.read_text().splitlines(),
                           json.loads(TABLE.read_text()).get("rows", []))
    print(f"\n门 token（R = {g['recognizer']}）：")
    print(f"  **读不到门**的行 {len(g['no_gate_tokens'])} / {len(g['by_row'])}"
          f" —— 不是「没有门」，是这份 token 表认不出：")
    for x in g["no_gate_tokens"][:8]:
        print(f"     L{x['line']} {x['path']}")

    if args.assert_:
        if m["non_literal_path_judgments"] > NON_LITERAL_BASELINE:
            print(f"✗ 非字面量 pathname 判定从 {NON_LITERAL_BASELINE} 涨到 "
                  f"{m['non_literal_path_judgments']} —— 清单又多了一个看不见的入口")
            return 1
        if bc["never_requested"] > NEVER_REQUESTED_BASELINE:
            print(f"✗ 「从未被请求过」从基线 {NEVER_REQUESTED_BASELINE} 涨到 {bc['never_requested']}"
                  f" —— 新增了一个没有请求走到的分支", file=sys.stderr)
            return 1
        if m["rows_without_owner"]:
            print(f"✗ {m['rows_without_owner']} 行找不到归属 if —— 分组会稳定地产出错误的合并建议")
            return 1
        print("✓ 在基线内，且每一行都有归属")
    return 0


if __name__ == "__main__":
    sys.exit(main())
