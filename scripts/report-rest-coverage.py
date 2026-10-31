#!/usr/bin/env python3
"""REST 侧的覆盖率分母 —— 「94 条路由里有几条被测试碰过」。

2026-10-31 起因（卡 #3214）：
    MCP 侧有注册表（`server.tool("name")` ⇒ 88 个，可穷举），所以覆盖率算得出 35/88；
    REST 侧按 `url.pathname` 手写匹配，**没有注册点** ⇒ 「有断言的端点 / 全部端点」在这半边是 0/0，
    而 0/0 与「全部覆盖」在每一份报告里长得一样。

本脚本做的不是重构，只把**分母**先立起来：
    分母 = docs/rest-route-table.json 里的路由条数（那是从 server.ts 生成、并由
           scripts/check-rest-route-table.py 守着不许漂移的清单）
    分子 = 路径字面量在 `server/src/*.test.ts` 里出现过几条

判据必须诚实：
    「测试里出现过这个路径」 ≠ 「这个端点的响应形状被断言过」。
    前者只说明**有人打过它**（哪怕只断言了 401）。所以这里报两档：
      referenced   —— 测试里出现过路径字面量
      unreferenced —— **一条测试都没有**（这是最强的缺口，也是唯一能当红用的那一档）

用法：
    python3 scripts/report-rest-coverage.py            # 人读
    python3 scripts/report-rest-coverage.py --json
    python3 scripts/report-rest-coverage.py --fail-on-unreferenced   # 有未引用端点 ⇒ exit 1

退出码：0 有读数且（默认）不管缺口；1 仅当 --fail-on-unreferenced 且存在未引用端点；2 没有分母。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TABLE = REPO / "docs" / "rest-route-table.json"
TEST_GLOB = "server/src/*.test.ts"

# 路由表里的 path 有两种形态：`/api/foo` 这类等值匹配，与带参数的正则前缀。
# 只对**等值**那些报「有没有测试引用」；正则前缀（如 `ws`、`/api/nodes/`）不逐个报，
# 否则会把「一个前缀覆盖多条路径」误算成多条缺口。
LITERAL = re.compile(r"^/[A-Za-z0-9_\-/.]+$")


def load_routes() -> list[dict] | None:
    if not TABLE.is_file():
        print(f"✗ 找不到 {TABLE.relative_to(REPO)} ⇒ 没有分母", file=sys.stderr)
        return None
    try:
        doc = json.loads(TABLE.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"✗ 路由表不是 JSON：{exc}", file=sys.stderr)
        return None
    rows = doc.get("rows") or []
    if not rows:
        print("✗ 路由表里 0 条 ⇒ 没有分母（空表不是「全覆盖」）", file=sys.stderr)
        return None
    return rows


def test_corpus() -> str:
    out: list[str] = []
    for p in sorted(REPO.glob(TEST_GLOB)):
        try:
            out.append(p.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
    return "\n".join(out)


def classify(rows: list[dict], corpus: str) -> dict:
    literal = [r for r in rows if isinstance(r.get("path"), str) and LITERAL.match(r["path"])]
    referenced, unreferenced = [], []
    for r in literal:
        # 用路径字面量做检索：模板串里写 `${id}` 的调用点不会命中，这是**已知漏报方向**
        # （宁可少算引用，也不要多算 —— 报出一个假的「已覆盖」比报一个假的缺口更糟）。
        key = r["path"]
        (referenced if key in corpus else unreferenced).append(key)
    return {
        "endpoints_total": len(rows),
        "endpoints_literal": len(literal),
        "prefix_rows": len(rows) - len(literal),
        "referenced": sorted(set(referenced)),
        "unreferenced": sorted(set(unreferenced)),
    }


def main(argv: list[str]) -> int:
    rows = load_routes()
    if rows is None:
        return 2
    res = classify(rows, test_corpus())

    if "--json" in argv:
        print(json.dumps({
            "instrument": "report-rest-coverage",
            "evidence_domain": "source",
            "counts": {
                "endpoints_total": res["endpoints_total"],
                "endpoints_literal": res["endpoints_literal"],
                "prefix_rows": res["prefix_rows"],
                "referenced": len(res["referenced"]),
                "unreferenced": len(res["unreferenced"]),
            },
            "unreferenced": res["unreferenced"],
            "covers": "REST 路由的**等值路径**在 server/src/*.test.ts 里是否被提到",
            "does_not_cover": [
                "模板串调用（`/api/nodes/${id}`）不会被算作引用 ⇒ 已知漏报方向",
                "被提到 ≠ 响应形状被断言（可能只断言了 401）",
                "正则前缀路由（ws 等）不逐个报",
            ],
        }, ensure_ascii=False, indent=2))
        if "--fail-on-unreferenced" in argv and res["unreferenced"]:
            return 1
        return 0

    print(f"REST-COVERAGE v1 endpoints={res['endpoints_total']} literal={res['endpoints_literal']} "
          f"prefix={res['prefix_rows']} referenced={len(res['referenced'])} "
          f"unreferenced={len(res['unreferenced'])}")
    if res["unreferenced"]:
        print("  一条测试都没有的端点（最强的缺口）：")
        for p in res["unreferenced"]:
            print(f"    · {p}")
    print("  口径：referenced = 路径字面量在 server/src/*.test.ts 里出现过；")
    print("        它不表示响应形状被断言过（可能只断言了 401），也不覆盖模板串拼出来的调用。")
    if "--fail-on-unreferenced" in argv and res["unreferenced"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
