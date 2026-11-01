#!/usr/bin/env python3
"""#3309 第三条口径：**错误值域**（同一出口形状下的可区分失败结果）。

## 为什么形状维度不够

`report-mcp-shape-branches.py` 数的是 `JSON.stringify({ ok: true …)` 的**成功出口形状**。
于是 `start_node` 在它眼里只有 1 个出口 —— 而这个工具会返回 10 个不同的 `error`：

    codex_fork_outcome_unknown / daemon_child_mismatch / daemon_cross_tenant /
    daemon_not_found / …

失败出口在形状上是同一个（`ok: false` + `error`），在语义上是 10 个。所以：

    可区分结果数 ≈ 成功形状数 + 错误值域基数

只数形状时，「这个工具只有 1 条路径」与「它只有 1 个成功形状、10 条失败路径」
在报告里同形 —— 而后者恰恰是最需要断言的那一类。

## 口径（引用时必须带）

  按 `server.tool("name"` 切块；块边界先截到本工具自己的收尾 `\\n  );`（与形状口径同一修）；
  块内 `error:\\s*"…"` 的**字面量集合**记为该工具的错误值域。

已知偏差：
  · 只认**字面量**。`error: e.message` / `error: code` 这类动态值不进值域 ⇒ **下界**。
  · `errs` 里的值可能来自共享 helper（例如三个工具都调 `crossNetworkNode()`），
    所以「值域里有 cross_network_node」不等于「这个工具自己判了跨网络」。
  · 不是「需要补的断言数」：一个值域 10 的工具可能已经有 10 条断言，也可能只有 1 条。

用法：
  python3 scripts/report-mcp-outcome-domain.py          # 报告
  python3 scripts/report-mcp-outcome-domain.py --json    # 机读
退出码：0 = 有读数；2 = 一个工具都没切出来（扫描器坏了，不是「没有问题」）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TOOLS = REPO / "server" / "src" / "tools.ts"

# 基线：工具数不得下降（改名/移走会让扫描器「少切出几个」，而报告仍显示「全部合规」）；
# 错误字面量数不得下降（字面量被改成 `e.message` 这类动态值 ⇒ 值域变窄，下界更失真）。
TOOLS_BASELINE = 88
ERROR_LITERALS_BASELINE = 120

SHAPE = re.compile(r'JSON\.stringify\(\{\s*ok:\s*true([^}]{0,80})')
ERR = re.compile(r'error:\s*"([^"\\]{1,80})"')


def measure() -> dict:
    return measure_text(TOOLS.read_text())


def measure_text(text: str) -> dict:
    starts = [(m.start(), m.group(1)) for m in re.finditer(r'server\.tool\(\s*"([a-z_]+)"', text)]
    starts.append((len(text), None))

    rows = []
    for i in range(len(starts) - 1):
        s, name = starts[i]
        e = starts[i + 1][0]
        block = text[s:e]
        # 块边界：注册之后紧跟的辅助函数也会被算成这个工具的出口（同形状口径的修）
        tail = block.find("\n  );")
        if tail > 0:
            block = block[:tail]
        shapes = {re.sub(r"\s+", " ", m.group(1))[:40] for m in SHAPE.finditer(block)}
        errs = {m.group(1) for m in ERR.finditer(block)}
        rows.append({
            "tool": name,
            "ok_shapes": len(shapes),
            "error_domain": len(errs),
            "errors": sorted(errs),
            "distinguishable": len(shapes) + len(errs),
        })

    # 宽形状：源码里 `server.tool("` 的出现次数（单位 occurrences）。
    # 命中 = 切出来的工具数（单位 tools）。两者不同单位 —— 并列时必须各自带单位。
    wide = len(re.findall(r'server\.tool\(\s*"', text))
    total_shapes = sum(r["ok_shapes"] for r in rows)
    total_errs = sum(r["error_domain"] for r in rows)
    # 形状维度会低估的那些：成功形状 ≥1 且有 ≥2 个错误值
    blind = sorted(
        (r for r in rows if r["error_domain"] >= 2),
        key=lambda r: -r["error_domain"],
    )
    return {
        "tools": len(rows),
        "wide_shape_occurrences": wide,
        "error_literal_occurrences": len(ERR.findall(text)),
        "selectivity": round(len(rows) / wide, 3) if wide else 0.0,
        "ok_shapes_total": total_shapes,
        "error_literals_total": total_errs,
        "distinguishable_total": total_shapes + total_errs,
        "tools_with_error_domain_ge2": len(blind),
        "worst": blind[:12],
        "rows": rows,
        "visibility": "lower_bound",
        "note": "只认字面量 ⇒ 值域是下界；动态 error（e.message / code 变量）不进这个数",
    }


SELFTEST_CASES = [
    (
        "一个成功形状 + 三个错误值 ⇒ 可区分 4",
        'server.tool(\n  "t_one",\n  async () => {\n'
        '    if (a) return { ok: false, error: "e1" };\n'
        '    if (b) return { ok: false, error: "e2" };\n'
        '    if (c) return { ok: false, error: "e3" };\n'
        '    return new Response(JSON.stringify({ ok: true, node_id: x }));\n'
        '  },\n  );\n',
        1,
        1,
        3,
    ),
    (
        "块边界：注册之后紧跟的辅助函数不算这个工具的错误值",
        'server.tool(\n  "t_one",\n  async () => {\n'
        '    return new Response(JSON.stringify({ ok: true }));\n'
        '  },\n  );\n'
        'function helper() { return { ok: false, error: "not_mine" }; }\n',
        1,
        1,
        0,
    ),
    (
        "动态 error（e.message）不进值域 —— 所以值域是下界",
        'server.tool(\n  "t_one",\n  async () => {\n'
        '    if (a) return { ok: false, error: e.message };\n'
        '    return new Response(JSON.stringify({ ok: true }));\n'
        '  },\n  );\n',
        1,
        1,
        0,
    ),
    (
        "同一个 error 值出现两次只算一个（值域是集合，不是次数）",
        'server.tool(\n  "t_one",\n  async () => {\n'
        '    if (a) return { ok: false, error: "same" };\n'
        '    if (b) return { ok: false, error: "same" };\n'
        '    return new Response(JSON.stringify({ ok: true }));\n'
        '  },\n  );\n',
        1,
        1,
        1,
    ),
]


def selftest() -> int:
    bad = 0
    for label, src, want_tools, want_shapes, want_errs in SELFTEST_CASES:
        m = measure_text(src)
        ok = (m["tools"] == want_tools and m["ok_shapes_total"] == want_shapes
              and m["error_literals_total"] == want_errs)
        print(f"{'ok  ' if ok else 'FAIL'}  {label}")
        if not ok:
            bad += 1
            print(f"        got tools={m['tools']} shapes={m['ok_shapes_total']} errs={m['error_literals_total']}"
                  f" want {want_tools}/{want_shapes}/{want_errs}")
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

    if not TOOLS.exists():
        print("exit 2: 读不到 server/src/tools.ts —— 这不是「没有问题」")
        return 2

    m = measure()
    if m["tools"] == 0:
        print("exit 2: 一个工具都没切出来 —— 扫描器坏了，不是「全部合规」")
        return 2

    if args.json:
        print(json.dumps(m, ensure_ascii=False, indent=1))
        return 0

    print(f"宽形状（`server.tool(\"` 出现，occurrences）={m['wide_shape_occurrences']}"
          f" ｜ 命中（tools）={m['tools']} ｜ 比值={m['selectivity']:.2f}")
    print("  比值≈1 ⇒ 谓词没在筛（它就是在数同一件事）；比值<1 ⇒ 有工具用了别的注册写法，需人看。")
    print(f"工具 {m['tools']} 个")
    print(f"成功出口形状合计 {m['ok_shapes_total']}（形状口径的分子）")
    print(f"错误字面量合计   {m['error_literals_total']}**（下界）**（本口径的分子）")
    print(f"可区分结果数     {m['distinguishable_total']}（= 形状 + 值域；仍是下界）")
    print()
    print(f"形状维度会低估的工具：{m['tools_with_error_domain_ge2']} / {m['tools']}（错误值域 ≥2）")
    print(f"{'tool':32s} {'成功形状':>6s} {'错误值域':>6s}  例")
    for r in m["worst"]:
        ex = ", ".join(r["errors"][:3])
        print(f"{r['tool'][:32]:32s} {r['ok_shapes']:>6d} {r['error_domain']:>6d}  {ex}")
    print()
    print("判据：一个工具「只有 1 个出口」与「只有 1 个成功形状、N 条失败路径」在形状报告里同形，")
    print("      而后者正是最需要断言的那一类。所以两条口径必须一起引用，不能只引形状数。")

    if args.assert_:
        bad = 0
        if m["tools"] < TOOLS_BASELINE:
            print(f"\n✗ 工具数从基线 {TOOLS_BASELINE} 降到 {m['tools']} —— 扫描器少切出了工具，")
            print("  而报告仍会说「全部合规」。先查块边界/注册写法，不要改基线。")
            bad += 1
        if m["error_literals_total"] < ERROR_LITERALS_BASELINE:
            print(f"✗ 错误字面量从基线 {ERROR_LITERALS_BASELINE} 降到 {m['error_literals_total']} ——")
            print("  值域变窄 ⇒ 要么有人把字面量改成了动态值（可观测性下降），要么扫描器坏了。")
            bad += 1
        if not bad:
            print(f"\n✓ 在基线内：工具 {m['tools']}/{TOOLS_BASELINE}，"
                  f"错误字面量 {m['error_literals_total']}/{ERROR_LITERALS_BASELINE}")
        return 1 if bad else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
