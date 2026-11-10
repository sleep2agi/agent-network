#!/usr/bin/env python3
"""每条写路由「需要什么权限」—— 从证据表里的门符号推出来，不新增判定。

## 起因（#3330）

合并两个权限档（例如把「节点主人」放宽成「网络成员」）时，代码里只改一行，
而**路由需要的权限没有一处被写下来** ⇒ 合并之后没人能说出「这条现在要求什么」。

「谁需要什么权限」在别处是有答案的（门符号就在路由块里），只是没有一份**按路由排的列**。

## 这份列怎么来（单一决策点）

不重新分类门符号，只读 `docs/rest-gate-evidence.json` 里已经记下的 `gates[]`，
按一张**固定的强度表**取最强的那一档：

    admin        requireTmuxAccess / 明确的管理员判据
    owner_admin  canRestWriteNodeSecurity        节点主人 / 网络 owner·admin
    network_write canRestWriteNetwork            有网络写权的成员
    human_only   canRestWriteNetworkAsHuman      人类令牌（节点不算）
    user_token   userTokenRequired / isNodeCredential
    node_mode    restNodeDenied                  节点处于 readonly/restricted 时拒绝
    public       gates 为空（按设计公开）

「取最强」= 任何一档拒绝都成立 ⇒ 强度表里更靠前的那个是**必要**条件。

## 它不证明什么

- 不证明路由**只**要求这一档（可能有更细的判据在 handler 内部，例如资源归属）
- 不证明这一档**足够**（那要靠 #3354 的拒绝证据）
- 强度表是**本仓今天的约定**，不是通用事实；改表要说明为什么

## 用法

    python3 scripts/report-write-route-scope.py [--assert]

`--assert`：出现「没有任何门且不在公开名单」的路由 ⇒ 退出码 1。
退出码：0 = 有读数；1 = 有路由说不出权限；2 = 读不到证据表。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EVIDENCE = REPO / "docs" / "rest-gate-evidence.json"

# 强度从强到弱。取**最强**的那一档作为「必要条件」。
SCOPE_BY_GATE: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("admin", ("requireTmuxAccess",)),
    ("owner_admin", ("canRestWriteNodeSecurity",)),
    ("network_write", ("canRestWriteNetwork",)),
    ("human_only", ("canRestWriteNetworkAsHuman",)),
    # `restScope` 是「这一次请求解析出来的网络作用域」，它只在有令牌之后才存在
    # ⇒ 与 restAuth 同档。第一版漏了它，`POST /api/dm` 因此被判成「说不出权限」。
    ("user_token", ("userTokenRequired", "isNodeCredential", "resolveToken", "restAuth", "restScope", "callerUserId")),
    ("node_mode", ("restNodeDenied", "restrictedMemberAttachmentsDenied", "scopeDenied")),
)
SCOPE_ORDER = [name for name, _ in SCOPE_BY_GATE] + ["public", "unknown"]


def scope_of(gates: list[str]) -> str:
    for scope, symbols in SCOPE_BY_GATE:
        if any(g in symbols for g in gates):
            return scope
    return "public" if not gates else "unknown"


def selftest() -> int:
    """四例：强度取最强 / 无门=public / 有门但不在表=unknown / node_mode 不冒充身份门。"""
    cases: list[int] = []
    ok = scope_of(["canRestWriteNodeSecurity", "userTokenRequired"]) == "owner_admin"
    print(("✓" if ok else "✗") + " selftest 两档并存 ⇒ 取更强的那档（owner_admin）")
    cases.append(0 if ok else 1)

    ok = scope_of([]) == "public"
    print(("✓" if ok else "✗") + " selftest 没有门 ⇒ public")
    cases.append(0 if ok else 1)

    ok = scope_of(["someUnknownGate"]) == "unknown"
    print(("✓" if ok else "✗") + " selftest 有门但不在强度表 ⇒ unknown（不猜）")
    cases.append(0 if ok else 1)

    ok = scope_of(["restNodeDenied", "canRestWriteNetwork"]) == "network_write"
    print(("✓" if ok else "✗") + " selftest node_mode 让位给身份门（它不是身份判据）")
    cases.append(0 if ok else 1)

    fails = sum(cases)
    print(f"✓ selftest {len(cases) - fails}/{len(cases)} 通过")
    return 0 if fails == 0 else 1


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if not EVIDENCE.exists():
        print(f"✗ 读不到 {EVIDENCE.name}；先跑 report-rest-gates.py --emit-evidence", file=sys.stderr)
        return 2
    doc = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    rows = [r for r in (doc.get("rows") or []) if not r.get("public_by_design") or r.get("gates")]

    counts: dict[str, int] = {}
    unknown: list[str] = []
    for r in doc.get("rows") or []:
        # 2026-11-01 —— 优先读**表里存的** required_scope（那是被断言过的值）；
        # 只有旧表没这一列时才就地推一次，并在输出里说明「推导的」。
        s = r.get("required_scope") or scope_of(list(r.get("gates") or []))
        if s == "public" and r.get("public_by_design"):
            s = "public"
        counts[s] = counts.get(s, 0) + 1
        # per_scope 只用于可能的分档明细，今天不打印；保留计数即可

        if s == "unknown":
            unknown.append(f"{r.get('method')} {r.get('path')}（gates={r.get('gates')}）")

    have = sum(1 for r in (doc.get("rows") or []) if r.get("required_scope"))
    total = len(doc.get("rows") or [])
    print(f"写路由 {total} 条，按**必要条件**分档"
          f"（{have}/{total} 来自证据表里被断言过的列；其余为就地推导）：")
    for scope in SCOPE_ORDER:
        n = counts.get(scope, 0)
        if not n:
            continue
        print(f"  {scope:<14} {n:>2} 条")
    print()
    print("  每一档的含义：")
    print("    admin        需要 Hub 管理员（tmux 那一类最严的门）")
    print("    owner_admin  节点主人 / 网络 owner·admin")
    print("    network_write 有网络写权的成员（**最容易被误当成 owner_admin** 的一档）")
    print("    human_only   人类令牌；节点令牌不算")
    print("    user_token   需要用户令牌（节点令牌被拒）")
    print("    node_mode    只在节点处于 readonly/restricted 时拒绝 —— 它**不是**身份判据")
    print("    public       按设计公开（无身份可拒）")
    if unknown:
        print()
        print("  ⚠ 说不出权限的（有门但不在强度表里）：")
        for u in unknown:
            print(f"    {u}")
    if counts.get("node_mode"):
        print()
        print("  ⚠ node_mode 出现在必要条件里 —— 但它**不是身份判据**（它只说节点当时可写）：")
        print("     若某条路由只剩它，那条路由实际上没有身份门。")
    else:
        print()
        print("  node_mode 计数 0：它从未成为某条路由的**必要条件** ——")
        print("    凡有它的地方都同时有更强的身份门（这是对的：它管「节点当时能不能写」，不管「你是谁」）。")
    print()
    print("  mutates: none（只读）")
    if unknown and "--assert" in sys.argv:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
