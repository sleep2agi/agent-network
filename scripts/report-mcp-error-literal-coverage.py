#!/usr/bin/env python3
"""错误字面量的**读数覆盖**：这 80 个值里，有 34 个在测试里一次都没出现过。

## 这条口径要回答的问题

`#3309` 的值域口径告诉我们「一个工具能返回哪几种 error」。它没有回答的是：
**这几种 error，每一种有没有一条输入，违反时能让某个断言变红。**

分界不在「有没有写进测试」，而在「违反时有没有读数」。所以这里分三格：

    near_expect    字面量出现在 `expect(` 同行或前后 3 行内   ← 最可能是被断言的
    mentioned_only 出现在测试文件里，但离 `expect(` 很远      ← 可能是注释/夹具/日志串
    never          一次都没出现                              ← 违反时**没有任何读数**

三格都是**上界**：`near_expect` 也可能是「断言了别的属性、恰好同一段里提到了它」。
所以这条口径只能用来排排查顺序，不能用来宣布「已覆盖」。

## 已知偏差（引用时必须带）

  · 只认双引号字面量（与值域口径同一取法）⇒ 动态 error 不进这个分母。
  · 「测试文件里出现」不区分注释 / 数据 / 断言 ⇒ 所以有 `mentioned_only` 这一格。
  · 覆盖率不是质量指标：一个 `never` 的 error 可能由集成测试间接覆盖（本脚本看不见）。

用法：
  python3 scripts/report-mcp-error-literal-coverage.py [--json] [--assert]
退出码：0 = 在基线内；1 = never 数增长；2 = 拿不到读数。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "server" / "src"
GEN = REPO / "scripts" / "report-mcp-outcome-domain.py"

# 基线：**一次都没出现过**的字面量个数。增长 ⇒ 又有一个 error 只在生产里才会被看见。
NEVER_BASELINE = 9


def domain() -> dict | None:
    out = subprocess.run([sys.executable, str(GEN), "--json"], cwd=REPO,
                         capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        print(f"exit 2: 值域脚本 exit={out.returncode}", file=sys.stderr)
        return None
    return json.loads(out.stdout)


def classify(literals: list[str], texts: list[str]) -> tuple[set[str], set[str]]:
    """返回 (mentioned, near_expect)。纯函数 —— selftest 直接喂夹具，不摸磁盘。"""
    mentioned: set[str] = set()
    near_expect: set[str] = set()
    for text in texts:
        lines = text.splitlines()
        for i, line in enumerate(lines):
            for e in literals:
                if f'"{e}"' not in line:
                    continue
                mentioned.add(e)
                lo, hi = max(0, i - 3), min(len(lines), i + 4)
                if "expect(" in line or any("expect(" in lines[j] for j in range(lo, hi)):
                    near_expect.add(e)
    return mentioned, near_expect


SELFTEST_CASES = [
    (
        "字面量与 expect 同行 ⇒ near_expect",
        ["err_one"],
        ['expect(r.error).toBe("err_one");'],
        "near_expect",
    ),
    (
        "字面量在 expect 前两行 ⇒ near_expect（±3 行窗口）",
        ["err_two"],
        ['const x = r.error;\n  // "err_two"\n  expect(x).toBeTruthy();'],
        "near_expect",
    ),
    (
        "字面量离 expect 很远 ⇒ mentioned_only（可能是注释/夹具）",
        ["err_three"],
        ['const s = "err_three";'] + ["// filler"] * 10 + ["expect(1).toBe(1);"],
        "mentioned_only",
    ),
    (
        "字面量一次都没出现 ⇒ never（违反时没有读数）",
        ["err_four"],
        ["expect(1).toBe(1);"],
        "never",
    ),
]


def selftest() -> int:
    bad = 0
    for label, literals, texts, want in SELFTEST_CASES:
        mentioned, near = classify(literals, texts)
        e = literals[0]
        got = "near_expect" if e in near else ("mentioned_only" if e in mentioned else "never")
        ok = got == want
        print(f"{'ok  ' if ok else 'FAIL'}  {label}")
        if not ok:
            bad += 1
            print(f"        got={got} want={want}")
    print(f"\nselftest: {len(SELFTEST_CASES) - bad}/{len(SELFTEST_CASES)}")
    return 1 if bad else 0


def measure(m: dict) -> dict:
    literals = sorted({e for r in m["rows"] for e in r["errors"]})
    by_literal_tools: dict[str, list[str]] = {}
    for r in m["rows"]:
        for e in r["errors"]:
            by_literal_tools.setdefault(e, []).append(r["tool"])

    mentioned, near_expect = classify(
        literals, [p.read_text() for p in sorted(SRC.glob("*.test.ts"))]
    )

    never = [e for e in literals if e not in mentioned]
    mentioned_only = [e for e in literals if e in mentioned and e not in near_expect]

    def tools_of(es: list[str]) -> dict[str, list[str]]:
        agg: dict[str, list[str]] = {}
        for e in es:
            for t in by_literal_tools[e]:
                agg.setdefault(t, []).append(e)
        return agg

    return {
        "literals": len(literals),
        "raw_occurrences": m.get("error_literal_occurrences", 0),
        "selectivity": (round(len(literals) / m["error_literal_occurrences"], 3)
                        if m.get("error_literal_occurrences") else 0.0),
        "near_expect": len(near_expect),
        "mentioned_only": len(mentioned_only),
        "never": len(never),
        "never_by_tool": tools_of(never),
        "mentioned_only_list": sorted(mentioned_only),
        "never_list": sorted(never),
        "visibility": "upper_bound",
        "note": "三格都是上界：出现 ≠ 断言；near_expect 也可能是断言了别的属性",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--assert", dest="assert_", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    m = domain()
    if m is None:
        return 2
    c = measure(m)

    if args.json:
        print(json.dumps(c, ensure_ascii=False, indent=1))
        return 0

    print(f"宽形状（`error: \"` 出现，occurrences）={c['raw_occurrences']}"
          f" ｜ 命中（去重后，values）={c['literals']} ｜ 比值={c['selectivity']:.2f}")
    print("  比值偏低是**去重**造成的（同一个 error 在多个工具里出现算一次），不是筛选。")
    print(f"错误字面量（去重）{c['literals']} 个")
    print(f"  在 expect 附近出现   {c['near_expect']:3d}   （**上界**，可能是断言别的属性）")
    print(f"  出现但离 expect 很远 {c['mentioned_only']:3d}   （注释 / 夹具 / 日志串）")
    print(f"  **一次都没出现**     {c['never']:3d}   （违反时没有任何读数）")
    if c["never_by_tool"]:
        print("\n没有任何读数的工具（按个数排序）：")
        for t, es in sorted(c["never_by_tool"].items(), key=lambda kv: -len(kv[1]))[:12]:
            print(f"  {t:30s} {len(es):2d} 个：{', '.join(sorted(es)[:4])}")
    if c["mentioned_only_list"]:
        print("\n出现了但离断言很远（最可疑的一类）：")
        for e in c["mentioned_only_list"][:8]:
            print("  ", e)
    print(f"\n基线：一次都没出现的 ≤ {NEVER_BASELINE}")

    if args.assert_:
        if c["never"] > NEVER_BASELINE:
            print(f"\n✗ 「没有读数」的字面量从基线 {NEVER_BASELINE} 涨到 {c['never']}：")
            for t, es in sorted(c["never_by_tool"].items(), key=lambda kv: -len(kv[1]))[:6]:
                print(f"    {t}: {', '.join(sorted(es))}")
            print("  ⇒ 要么给它一条会红的断言，要么把基线调高并在提交信息里写清为什么。")
            return 1
        print("✓ 在基线内")
    return 0


if __name__ == "__main__":
    sys.exit(main())
