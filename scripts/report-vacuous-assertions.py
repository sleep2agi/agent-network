#!/usr/bin/env python3
"""恒真断言扫描：`expect(X).toBe(X)` 这类**结构上不可能失败**的断言。

2026-10-31 —— 起因（外部复核，原话）：
    「同 (origin,code) 恒映射同一 status」是**永远不可能变红**的断言 ——
    结构上不可达的断言，和 ETag validator 同一盲法（validator 永远匹配不上，
    于是「304 没出现」既可能是 no-store 生效，也可能是它本来就不会出现）。

本脚本只查**能静态看见的一类**：断言两侧是同一个表达式（规范化后逐字符相同）。
    expect(body.error_id).toBe(body.error_id)          ⇒ 恒真
    expect(keys.sort().join(",")).toBe(keys.sort().join(","))  ⇒ 恒真

它查不到更隐蔽的那一类（两侧由同一个变量分别序列化/不同函数但同源），
那一类要靠人读 —— 所以这是读数，不是门；扫出来必须改，扫不出来不等于没有。

用法：python3 scripts/report-vacuous-assertions.py [--json]
退出码：0 = 没有命中；1 = 有命中；2 = 拿不到读数（扫描域为空）。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
# expect( <lhs> ).toBe( <rhs> ) / toEqual / toStrictEqual —— 只取单行形式（多行留给人工）
ASSERT = re.compile(r"expect\((.+?)\)\.(toBe|toEqual|toStrictEqual)\((.+?)\)\s*;?\s*$")

# 2026-10-31 —— 外部复核（原话）：
#   「`Object.keys(x).every(k => Object.hasOwn(x, k))` **恒真**（实测）
#     ⇒ 长得像正确形态的逃生口；正确形态必须由负数用例定义。」
# 这是「键集相等」的常见**假正确写法**：它只证明「迭代到的键在对象里」，而那正是迭代的来源。
TAUTOLOGY = re.compile(
    r"Object\.keys\(\s*([A-Za-z_$][\w.$]*)\s*\)\s*\.\s*every\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*"
    r"Object\.hasOwn(?:Property)?\(\s*\1\s*,\s*\2\s*\)\s*\)"
)


def norm(expr: str) -> str:
    """规范化：去掉所有空白与包裹的括号，只比「是不是同一个表达式」。"""
    e = re.sub(r"\s+", "", expr)
    while e.startswith("(") and e.endswith(")"):
        e = e[1:-1]
    return e


def tracked() -> list[Path]:
    try:
        out = subprocess.run(["git", "ls-files", "*.test.ts", "*.test.mjs"], cwd=REPO,
                             capture_output=True, text=True, timeout=60).stdout
        return [REPO / l for l in out.split("\n") if l.strip()]
    except Exception:  # noqa: BLE001
        return []


def scan() -> tuple[list[dict], int]:
    hits: list[dict] = []
    asserted = 0
    for p in tracked():
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for i, ln in enumerate(lines, 1):
            if ln.lstrip().startswith("//") or ln.lstrip().startswith("*"):
                continue
            m = ASSERT.search(ln.strip())
            if not m:
                continue
            asserted += 1
            lhs, matcher, rhs = m.group(1), m.group(2), m.group(3)
            if norm(lhs) and norm(lhs) == norm(rhs):
                # 2026-10-31 —— **函数调用两侧相同 ≠ 恒真**：
                # `expect(etagOf(body)).toBe(etagOf(body))` 测的是**确定性**，
                # 一个随机数实现就会红。只有「纯取值」（无调用）的那一类才结构上恒真。
                kind = "determinism" if "(" in norm(lhs) else "vacuous"
                hits.append({"file": str(p.relative_to(REPO)), "line": i, "kind": kind,
                             "matcher": matcher, "expr": norm(lhs)[:120]})
    return hits, asserted


def selftest(quiet: bool = False) -> int:
    """正反两个样本：一个必须命中、一个必须不命中。"""
    cases = [
        ("expect(body.error_id).toBe(body.error_id);", True),
        ("expect(a).toBe(b);", False),
        ('expect(Object.keys(x).sort()).toEqual([ "a", "b" ]);', False),
        # 函数调用两侧相同：确定性断言，必须**不命中**恒真档（见 scan() 的分档）。
        ("expect(etagOf(b)).toBe(etagOf(b));", False),
        ("expect(x).toBe(y);", False),
    ]
    bad = []
    for src, want in cases:
        m = ASSERT.search(src.strip())
        got = (bool(m) and norm(m.group(1)) == norm(m.group(3))
               and bool(norm(m.group(1))) and "(" not in norm(m.group(1)))
        if got != want:
            bad.append(f"{src!r}: 期望 hit={want}，实际 {got}")
        elif not quiet:
            print(f"✓ selftest {'命中' if want else '不命中'}: {src}")
    if bad:
        print("✗ 自检失败：", file=sys.stderr)
        for b in bad:
            print(f"    · {b}", file=sys.stderr)
        return 1
    if not quiet:
        print(f"✓ selftest {len(cases)} 例符合预期（含 1 个必须命中的恒真样本、1 个必须不命中的确定性样本）")
    return 0


SERIALIZED_ROUNDTRIP = re.compile(
    r"expect\(\s*JSON\.parse\(\s*JSON\.stringify\(\s*([A-Za-z_$][\w.$]*)\s*\)\s*\)\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)"
)


def scan_roundtrips() -> list[dict]:
    """`expect(JSON.parse(JSON.stringify(X))).toEqual(X)` —— 结构化的往返恒真。

    2026-10-31 —— 外部复核（原话）：
      「selftest 的夹具由 `safe_dump` 生成，序列化器会给所有含冒号标量加引号，
        **系统性地擦掉了这道门唯一脆弱的那类输入** ⇒ 这条自测结构上不可能看见该 bug。」

    同一个病在 JS 侧的形状是：先用序列化器造夹具、再断言序列化后仍相等。
    它不是「检查有没有坏」，而是「检查序列化器是不是它自己」。
    """
    hits: list[dict] = []
    for p in tracked():
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        for m in SERIALIZED_ROUNDTRIP.finditer(text):
            line = text[: m.start()].count("\n") + 1
            hits.append({"file": str(p.relative_to(REPO)), "line": line, "kind": "serializer_roundtrip", "text": m.group(0)[:100]})
    return hits


def scan_tautologies() -> list[dict]:
    """`Object.keys(X).every(k => Object.hasOwn(X, k))` —— 结构上恒真的键集检查。

    它看起来在「确认键都在」，实际只是把 Object.keys 的结果再问了一遍。
    真正要断的是**与另一个来源相等**，或由负数用例定义（少一个键要红）。
    """
    hits: list[dict] = []
    for p in tracked():
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        for m in TAUTOLOGY.finditer(text):
            line = text[: m.start()].count("\n") + 1
            hits.append({"file": str(p.relative_to(REPO)), "line": line, "kind": "tautological_keyset", "text": m.group(0)[:100]})
    return hits


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2
    files = tracked()
    if not files:
        print("扫描域为空：git ls-files 没有测试文件 ⇒ 没有读数", file=sys.stderr)
        return 2
    hits, asserted = scan()
    if asserted == 0:
        print("✗ 阳性对照失败：一个单行断言都没匹到 ⇒ 判据可能坏了", file=sys.stderr)
        return 2
    if "--json" in sys.argv:
        print(json.dumps({"object": "git ls-files *.test.ts/*.test.mjs", "files": len(files),
                          "single_line_assertions": asserted,
                          "vacuous": [h for h in hits if h["kind"] == "vacuous"],
                          "determinism": [h for h in hits if h["kind"] == "determinism"],
                          "tautological_keyset": scan_tautologies()},
                         ensure_ascii=False, indent=2))
        return 1 if any(h["kind"] == "vacuous" for h in hits) else 0
    print(f"对象：{len(files)} 个测试文件，识别到 {asserted} 条单行断言（阳性对照）")
    vac = [h for h in hits if h["kind"] == "vacuous"]
    det = [h for h in hits if h["kind"] == "determinism"]
    if det:
        print(f"· 两侧同一**函数调用** {len(det)} 条 ⇒ 这是确定性断言（随机数实现会红），不算恒真：")
        for h in det[:10]:
            print(f"    · {h['file']}:{h['line']}  {h['expr']}")
    if vac:
        print(f"✗ **恒真**断言 {len(vac)} 条（纯取值、两侧同一表达式 ⇒ 永远不会失败）：", file=sys.stderr)
        for h in vac[:20]:
            print(f"    · {h['file']}:{h['line']}  {h['expr']}", file=sys.stderr)
        return 1
    rt = scan_roundtrips()
    if rt:
        # 2026-10-31 —— **判红之前先看它是不是合法的**：
        # `expect(JSON.parse(JSON.stringify(X))).toEqual(X)` 在「X 可能含 BigInt/undefined 等
        # 非 JSON 安全值」时是一条**真实**断言（它证明往返无损）。本脚本看不出 X 的类型。
        # ⇒ 降为 advisory：只打印，不判红；判红会逼人删掉一条有效断言。
        print(f"· 序列化往返断言 {len(rt)} 条（**advisory**：值为 JSON 安全时它是恒真；含 BigInt 等时它有效）：")
        for h in rt[:10]:
            print(f"    · {h['file']}:{h['line']}  {h['text']}")
    taut = scan_tautologies()
    if taut:
        print(f"✗ **恒真的键集检查** {len(taut)} 条（Object.keys(X).every(k => hasOwn(X,k))）：", file=sys.stderr)
        for h in taut[:10]:
            print(f"    · {h['file']}:{h['line']}  {h['text']}", file=sys.stderr)
        print("  ⇒ 改写成与**另一个来源**相等，或用负数用例定义（少一个键必须红）。", file=sys.stderr)
        return 1
    print("✓ 没有「纯取值、两侧同一表达式」的恒真断言")
    print("✓ 也没有「Object.keys(X).every(k => hasOwn(X,k))」这种恒真的键集检查（本仓 0 处）")
    print("  局限：两侧由同一变量分别序列化、或不同函数但同源 —— 这两种静态查不出，只能人读。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
