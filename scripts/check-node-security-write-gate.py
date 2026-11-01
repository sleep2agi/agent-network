#!/usr/bin/env python3
"""#3314 gate: 改「节点安全配置」的路由必须走**一个具名判据**。

背景：同一句授权语义曾以两种形式并存 —

    A. 手写四条件  !isAdmin && node.owner_user_id !== me && role !== "owner" && role !== "admin"
    B. 具名函数    canRestWriteNetwork(...)

两者在调用点长得一样，但强度差在被调函数里：canRestWriteNetwork 放行任何
非 viewer 成员，而改白名单等于改「这台节点还能做什么」。所以「统一写法」如果
方向选错，就是把 A 降到 B —— 一次纯粹变松的重构，而现有夹具（全是 owner/admin
探针）不会因此变红。

这条门钉三件事：
  1. 四条节点安全配置路由都必须调用 canRestWriteNodeSecurity(...)；
  2. 全文件不得再出现手写四条件（新增路由照抄它附近那一行，那正是回归入口）；
  3. 具名函数仍比「写网络」严（member 在它下面必须是 false）——
     靠 server/src/node-security-write-gate.test.ts 钉，这里只检查它存在且被接线。

三态：exit 0 = 三项都成立；exit 1 = 有违反（逐条打印）；
       exit 2 = 读不到输入（文件缺失/形状变了）——不是「没有问题」。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_TS = ROOT / "server" / "src" / "server.ts"
SCOPE_TS = ROOT / "server" / "src" / "network-scope.ts"
TEST_TS = ROOT / "server" / "src" / "node-security-write-gate.test.ts"

# 这四条是「改这台节点还能做什么」的写路由。少一条就等于少一个受管对象，
# 所以清单是显式的：新增同类路由必须来这里登记，否则它不会被检查到。
# needle 用**字面量**而不是正则：路线一旦改名，本门要报 ROUTE_MISSING，
# 而不是因为正则写错而报同一个错——两者都红，但只有一种红是对的。
ROUTES = ["permission-mode", "tool-allowlist", "rest-allowlist", "peer-allowlist"]

NAMED_GATE = "canRestWriteNodeSecurity("
HANDWRITTEN = re.compile(
    r"!isAdmin\s*&&\s*\w+\.owner_user_id\s*!==\s*restAuth\.userId\s*&&\s*\w+\s*!==\s*\"owner\"\s*&&\s*\w+\s*!==\s*\"admin\""
)


def route_line(name: str) -> str:
    """路由在源码里的样子：pathname.match(…/<name>$/)。"""
    return f"/{name}$/"


def block_span(lines: list[str], start: int, limit: int = 120) -> tuple[int, int]:
    """从路由匹配行起，找出**这条路由自己的 if 块**的行范围 [start, end)。

    用行窗口猜边界是错的：窗口大一点会把下一条路由的判据算进来（假绿），
    小一点会把同一条路由的判据切掉（假红）。所以这里做花括号计数：
    块内判据才算这条路由的判据，块外的属于别人。
    """
    depth = 0
    opened = False
    for i in range(start, min(len(lines), start + limit)):
        depth += lines[i].count("{") - lines[i].count("}")
        if "{" in lines[i]:
            opened = True
        if opened and depth <= 0:
            return start, i + 1
    return start, min(len(lines), start + limit)


def check_source(src: str) -> list[str]:
    """返回违反清单；空列表 = 全部成立。"""
    problems: list[str] = []
    lines = src.splitlines()

    for name in ROUTES:
        needle = route_line(name)
        hits = [
            i
            for i, ln in enumerate(lines)
            if "pathname.match(" in ln and needle in ln
        ]
        if not hits:
            problems.append(f"ROUTE_MISSING: 找不到路由 {name} —— 路由被改名/移走，本门没有覆盖到它")
            continue
        if len(hits) > 1:
            problems.append(f"ROUTE_AMBIGUOUS: 路由 {name} 命中 {len(hits)} 处，本门只认一处")
            continue
        start = hits[0]
        b0, b1 = block_span(lines, start)
        block = "\n".join(lines[b0:b1])
        if NAMED_GATE not in block:
            problems.append(
                f"UNGATED: {name}（server.ts:{start + 1}）自己的 if 块（{b0 + 1}-{b1}）里没有 {NAMED_GATE}..."
            )

    for m in HANDWRITTEN.finditer(src):
        line_no = src.count("\n", 0, m.start()) + 1
        problems.append(
            f"HANDWRITTEN: server.ts:{line_no} 还是手写四条件 —— 改成 {NAMED_GATE.rstrip('(')} 调用"
        )

    return problems


def check_shape() -> list[str]:
    """具名函数与它的测试必须同时在，否则「有门」只是名字。"""
    problems: list[str] = []
    for path, needle, label in [
        (SCOPE_TS, f"export function {NAMED_GATE.rstrip('(')}", "network-scope.ts 里的具名函数"),
        (TEST_TS, NAMED_GATE.rstrip("("), "node-security-write-gate.test.ts"),
    ]:
        if not path.exists():
            problems.append(f"MISSING_INPUT: {label} 不存在（{path.relative_to(ROOT)}）")
            continue
        if needle not in path.read_text():
            problems.append(f"MISSING_SHAPE: {label} 里找不到 {needle}")
    return problems


SELFTEST_CASES = [
    (
        "四条路由都走具名门 ⇒ 0 问题",
        "\n".join(
            f'const m = url.pathname.match(/{route_line(n)});\n'
            f'if (m && req.method === "PUT") {{\n'
            f"  if (!canRestWriteNodeSecurity(restAuth, n.owner_user_id, role, isAdmin)) return 403;\n}}"
            for n in ROUTES
        ),
        None,
    ),
    (
        "少一条路由的判据 ⇒ UNGATED（且块内没有别人家的判据可借）",
        "\n".join(
            (
                f'const m = url.pathname.match(/{route_line(n)});\n'
                f'if (m && req.method === "PUT") {{\n'
                + (
                    '  if (!canRestWriteNodeSecurity(restAuth, n.owner_user_id, role, isAdmin)) return 403;\n'
                    if i
                    else "  return withCors(req, Response.json({ ok: false }, { status: 400 }));\n"
                )
                + "}"
            )
            for i, n in enumerate(ROUTES)
        ),
        "UNGATED",
    ),
    (
        "手写四条件残留 ⇒ HANDWRITTEN",
        'if (!isAdmin && node.owner_user_id !== restAuth.userId && role !== "owner" && role !== "admin") return 403;',
        "HANDWRITTEN",
    ),
    (
        "路由被改名/移走 ⇒ ROUTE_MISSING（不是静默通过）",
        "// 什么都没了",
        "ROUTE_MISSING",
    ),
    (
        "判据写在 if 块**外面**（下一条路由之前）⇒ 仍算 UNGATED",
        "\n".join(
            f'const m = url.pathname.match(/{route_line(n)});\n'
            f'if (m && req.method === "PUT") {{ return withCors(req, Response.json({{ ok: false }}, {{ status: 403 }})); }}\n'
            f"if (!canRestWriteNodeSecurity(restAuth, n.owner_user_id, role, isAdmin)) return 403;\n"
            for n in ROUTES
        ),
        "UNGATED",
    ),
]


# 2026-11-01 —— 数量钉防删除，不防替换。这里再加一条**强度下界**：
# 期望「报错」的用例必须占多数，否则自检退化成「合法输入不报错」。
NEGATIVE_EXPECTED = 3


def selftest() -> int:
    bad = 0
    negative = sum(1 for _, _, exp in SELFTEST_CASES if exp is not None)
    if negative < NEGATIVE_EXPECTED:
        print(f"✗ 负例（期望报错的用例）只有 {negative} 个，应至少 {NEGATIVE_EXPECTED} 个")
        bad += 1
    for label, src, expect in SELFTEST_CASES:
        problems = check_source(src)
        if expect is None:
            ok = not problems
        else:
            ok = any(p.startswith(expect) for p in problems)
        print(f"{'ok  ' if ok else 'FAIL'}  {label}")
        if not ok:
            bad += 1
            for p in problems:
                print(f"        {p}")
    print(f"\nselftest: {len(SELFTEST_CASES) - bad}/{len(SELFTEST_CASES)}"
          f"（其中负例 {negative}/{NEGATIVE_EXPECTED}）")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--source", type=Path, default=None, help="覆盖 server.ts 路径（witnessed-red 用）")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    target = args.source or SERVER_TS
    if not target.exists():
        print(f"exit 2: 读不到 {target} —— 这不是「没有问题」")
        return 2

    problems = check_source(target.read_text()) + check_shape()
    if problems:
        for p in problems:
            print(p)
        print(f"\n{len(problems)} 处违反（共 4 条路由 / 1 类手写残留 / 2 个形状）")
        return 1
    print(f"ok: {len(ROUTES)} 条节点安全配置路由都走 {NAMED_GATE.rstrip('(')}；无手写四条件残留；具名函数与测试都在位")
    return 0


if __name__ == "__main__":
    sys.exit(main())
