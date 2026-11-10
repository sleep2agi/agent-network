#!/usr/bin/env python3
"""`expect(typeof x).toBe("string")` 这类**只钉类型、不钉值**的断言有多少条，各自的去处是什么。

2026-10-31 —— 起因：补 REST 形状时反复遇到同一种「看起来像在检查，其实什么也没约束」的行：
    expect(typeof body.txn_id).toBe("string");
它证明「这里有个字符串」，不证明「是本事务的 txid」。客户端拿错 id 一样通过。

本脚本不做判断，只把每条分到三类里，并把**最弱的那一类逐条列出来**：

    value_pinned  —— 同一个表达式在本文件 15 行内另有值级断言（toMatch/toBe(字面量)/toEqual/…）
                     ⇒ 类型断言是冗余的，但无害；不必改。
    type_only     —— 附近只有类型断言 ⇒ 这是「形状」的全部约束。
    narrowing     —— 出现在 `if (...)` / `for (...)` 的守卫里 ⇒ 是给类型收窄用的，不是断言。

判据必须诚实：
    「15 行内」是代理，可能把**同文件另一个字段**的值级断言算到它头上（已知误报面）。
    所以 type_only 的列表是「值得逐个看一眼」，不是「这些全都没覆盖」。

用法：
    python3 scripts/report-type-assertions.py            # 人读摘要 + type_only 全表
    python3 scripts/report-type-assertions.py --json
    python3 scripts/report-type-assertions.py --fail-on-type-only   # 有 type_only ⇒ exit 1

退出码：0 = 有读数；1 = 仅当 --fail-on-type-only 且有 type_only；2 = 拿不到读数（扫描域为空）。
"""
from __future__ import annotations

import hashlib
import json
import platform
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TEST_GLOB = "server/src/*.test.ts"
VALUE_TYPES = {"string", "number", "boolean", "object", "function", "undefined", "bigint"}

TYPE_ASSERT = re.compile(
    r"expect\(\s*typeof\s+([A-Za-z_$][\w$.\[\]()'\"]*)\s*\)\s*\.\s*toBe\(\s*[\"'](\w+)[\"']\s*\)"
)
# 值级断言的形状：同一个表达式后面跟在这些匹配器上
VALUE_MATCHER = re.compile(
    r"expect\(\s*([A-Za-z_$][\w$.\[\]()'\"]*)\s*\)\s*\.\s*"
    r"(toBe|toEqual|toStrictEqual|toMatch|toMatchObject|toContain|toHaveLength|toBeGreaterThan|toBeLessThan)\b"
)
GUARD = re.compile(r"\b(if|while)\s*\(|\bfor\s*\(")


def _measured_by() -> dict:
    try:
        digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:12]
    except OSError:
        digest = "unreadable"
    return {
        "script": Path(__file__).name,
        "sha256_12": digest,
        "interpreter": f"python{platform.python_version()}",
    }


def scan(window: int = 15) -> dict:
    rows: list[dict] = []
    files = 0
    for p in sorted(REPO.glob(TEST_GLOB)):
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        files += 1
        value_sites: list[tuple[int, str]] = []
        for i, line in enumerate(lines, 1):
            for m in VALUE_MATCHER.finditer(line):
                value_sites.append((i, m.group(1)))
        for i, line in enumerate(lines, 1):
            for m in TYPE_ASSERT.finditer(line):
                expr = m.group(1)
                if GUARD.search(line):
                    kind = "narrowing"
                else:
                    pinned = [
                        ln for ln, lhs in value_sites
                        if lhs == expr and abs(ln - i) <= window
                    ]
                    kind = "value_pinned" if pinned else "type_only"
                rows.append({
                    "file": p.name,
                    "line": i,
                    "expr": expr,
                    "type": m.group(2),
                    "kind": kind,
                    "text": line.strip(),
                })
    counts = {"value_pinned": 0, "type_only": 0, "narrowing": 0}
    for r in rows:
        counts[r["kind"]] += 1
    return {"files": files, "total": len(rows), "counts": counts, "rows": rows}


def main(argv: list[str]) -> int:
    res = scan()
    if res["files"] == 0:
        print("✗ 扫描域为 0 个测试文件 ⇒ 没有读数（不是「全部合格」）", file=sys.stderr)
        return 2
    type_only = [r for r in res["rows"] if r["kind"] == "type_only"]

    if "--json" in argv:
        print(json.dumps({
            "instrument": "report-type-assertions",
            "measured_by": _measured_by(),
            "evidence_domain": "source",
            "counts": {"files": res["files"], "total": res["total"], **res["counts"]},
            "type_only": [
                {k: r[k] for k in ("file", "line", "expr", "type", "text")} for r in type_only
            ],
            "covers": "测试里 `expect(typeof x).toBe(\"T\")` 这一形态的分类",
            "does_not_cover": [
                "15 行窗口是代理：同文件另一个字段的值级断言可能被算到这条头上（会把 type_only 少报）",
                "不判值级断言本身**是否够**：`toMatch(/^tok_/)` 也会被算作 value_pinned",
                "只扫单行；跨行写法的 typeof 断言看不到",
            ],
        }, ensure_ascii=False, indent=2))
    else:
        c = res["counts"]
        print(f"TYPE-ASSERTIONS v1 files={res['files']} total={res['total']} "
              f"value_pinned={c['value_pinned']} type_only={c['type_only']} narrowing={c['narrowing']}")
        if type_only:
            print(f"  只钉类型、没有值级约束的 {len(type_only)} 条（值得逐条看）：")
            for r in type_only:
                print(f"    {r['file']}:{r['line']}  {r['expr']} : {r['type']}")
        else:
            print("  0 条 type_only ⇒ 每条类型断言旁边都另有值级约束（或只是守卫）")

    if "--fail-on-type-only" in argv and type_only:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
