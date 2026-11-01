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
import re
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "server" / "src"
GEN = REPO / "scripts" / "report-mcp-outcome-domain.py"

# 基线：**一次都没出现过**的字面量个数。增长 ⇒ 又有一个 error 只在生产里才会被看见。
NEVER_BASELINE = 3

# 登记为「不做」的：**造不出真实状态**，而不是「懒得写」。
# 判据：理由必须说明「为什么造出来的绿等于假绿」，而不是「暂时没空」。
NOT_TESTED_BY_DESIGN: dict[str, str] = {
    "request_vanished": (
        "代码自己标着 'Should never happen given the earlier row read' —— "
        "要触发它必须先读到行、再让行消失，只能伪造一个不可能的中间态。"
        "伪造出来的绿证明不了真实系统的任何东西。"
    ),
    "finalize_tx_failed": (
        "要求事务里的 SQL 真的失败，而本仓没有可注入的失败点。"
        "造一个假抛的 mock 只能证明 catch 分支存在，证明不了它会在什么条件下被走到。"
    ),
}


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
    # 精度读数的识别器也要能被证伪：两种写法各命中一次，第三种不命中。
    import tempfile, pathlib as _pl
    tmp = _pl.Path(tempfile.mkdtemp())
    (tmp / "a.test.ts").write_text('expect(Object.keys(x).sort()).toEqual(["a"]);')
    (tmp / "b.test.ts").write_text('function expectKeys(o, w) {}\nexpectKeys(x, ["a"]);')
    (tmp / "c.test.ts").write_text('expect(x).toMatchObject({ a: 1 });')
    global REPO
    _old = REPO
    REPO = tmp.parent if False else _old
    # 直接测正则，不走磁盘（避免改 REPO 全局）
    ok = (len(KEYSET_ASSERT.findall((tmp / "a.test.ts").read_text())) == 1
          and not KEYSET_ASSERT.search((tmp / "c.test.ts").read_text()))
    print(f"{'ok  ' if ok else 'FAIL'}  精度识别器：内联写法命中、toMatchObject 不命中")
    if not ok:
        bad += 1
    total = len(SELFTEST_CASES) + 1
    print(f"\nselftest: {total - bad}/{total}")
    return 1 if bad else 0


KEYSET_ASSERT = re.compile(r"Object\.keys\([^)]*\)\.sort\(\)\s*\)?\.?\s*to(Equal|Be)\(")
HELPER_DEF = re.compile(r"function expectKeys\(")


def precision_reading() -> dict:
    """另一个读数：**形状钉得多精确**。

    覆盖率口径数的是「这条 error 有没有被断言过」，它对「断言有多精确」完全无感 ——
    把字段级换成精确键集，覆盖率分子不动，于是「这一轮做了什么」在曲线上看不见。
    ⇒ 所以另立一个读数，并写明它的单位是**断言处数**，不是 error 数量：
    两者分母不同，不能相除。

    ⚠ 已知偏差：只认 `Object.keys(...).sort()` 与本地 `expectKeys(` 辅助两种写法；
    其他等价写法（`toEqual(Object.keys(...))`、快照）不计 ⇒ **下界**。
    """
    files = sorted((REPO / "server" / "src").glob("*.test.ts"))
    inline = 0
    helpers = 0
    files_with = []
    for f in files:
        body = f.read_text()
        n_inline = len(KEYSET_ASSERT.findall(body))
        n_helper_def = len(HELPER_DEF.findall(body))
        # 用了本地辅助函数时，调用点也算 —— 否则「提取成函数」会让读数下降（假倒退）
        n_helper_calls = len(re.findall(r"expectKeys\(", body)) - n_helper_def if n_helper_def else 0
        if n_inline or n_helper_calls:
            files_with.append(f.name)
        inline += n_inline
        helpers += n_helper_calls
    return {"inline_assertions": inline, "helper_calls": helpers,
            "files": len(files_with), "sample": files_with[:8],
            "unit": "assertions"}


def measure(m: dict) -> dict:
    literals = sorted({e for r in m["rows"] for e in r["errors"]})
    by_literal_tools: dict[str, list[str]] = {}
    for r in m["rows"]:
        for e in r["errors"]:
            by_literal_tools.setdefault(e, []).append(r["tool"])

    mentioned, near_expect = classify(
        literals, [p.read_text() for p in sorted(SRC.glob("*.test.ts"))]
    )

    never_all = [e for e in literals if e not in mentioned]
    never = [e for e in never_all if e not in NOT_TESTED_BY_DESIGN]
    by_design = [e for e in never_all if e in NOT_TESTED_BY_DESIGN]
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
        "never_all": len(never_all),
        "by_design": by_design,
        "by_design_reasons": {e: NOT_TESTED_BY_DESIGN[e] for e in by_design},
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
    print(f"  **一次都没出现**     {c['never_all']:3d}   "
          f"= 待补 {c['never']} + 登记不做 {len(c['by_design'])}")
    pr = precision_reading()
    print(f"\n形状精度（单位 {pr['unit']}，**与上面的 never 分母不同，不能相除**）：")
    print(f"  精确键集断言 {pr['inline_assertions'] + pr['helper_calls']} 处"
          f"（内联 {pr['inline_assertions']} + 本地辅助调用 {pr['helper_calls']}），分布在 {pr['files']} 个测试文件")
    print("  ⇒ 这一格存在的理由：覆盖率对「断言有多精确」无感，")
    print("     所以把字段级换成精确键集时，覆盖率不动 —— 那不等于「没做事」。")
    if pr["sample"]:
        print(f"  例：{', '.join(pr['sample'][:5])}")

    if c["by_design"]:
        print("\n登记为「不做」的（造不出真实状态，理由写在这里）：")
        for e in c["by_design"]:
            print(f"  · {e} —— {c['by_design_reasons'][e]}")
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
